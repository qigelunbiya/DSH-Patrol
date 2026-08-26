import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { renderRunReport } from './report.ts'
import type { InspectionDefinition, JsonObject, RunReport, SavedRunPaths, StepRunResult, TextExpectation } from './types.ts'
import { PatrolStore } from './store.ts'

export interface DispatchResult {
  ok: boolean
  text: string
  error?: string
}

export interface PatrolRunnerOptions {
  allowedToolPrefixes: string[]
  reportMaxChars: number
}

export class PatrolRunner {
  constructor(
    private readonly ctx: Context,
    private readonly store: PatrolStore,
    private readonly options: PatrolRunnerOptions,
  ) {}

  isToolAllowed(name: string): boolean {
    if (name.startsWith('patrol_')) return false
    return this.options.allowedToolPrefixes.some(prefix => name.startsWith(prefix))
  }

  async dispatch(tool: string, args: JsonObject, exec: ToolRunContext): Promise<DispatchResult> {
    if (!this.isToolAllowed(tool)) {
      return { ok: false, text: '', error: `tool ${tool} is outside the DSH Patrol allowlist (${this.options.allowedToolPrefixes.join(', ')})` }
    }

    const result = await this.ctx.tools.execute({
      callId: CallId(`patrol-${randomUUID()}`),
      name: tool,
      arguments: args,
      signal: exec.signal,
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      parent: exec.token,
    })
    const text = result.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
    if (result.isError) {
      return { ok: false, text, error: result.error.message }
    }
    return { ok: true, text }
  }

  async run(
    definition: InspectionDefinition,
    exec: ToolRunContext,
    startAtStepId?: string,
  ): Promise<{ report: RunReport; paths: SavedRunPaths }> {
    const startedAt = new Date().toISOString()
    const runId = `${startedAt.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`
    let startIndex = 0
    if (startAtStepId !== undefined) {
      startIndex = definition.steps.findIndex(step => step.id === startAtStepId)
      if (startIndex < 0) throw new Error(`unknown startAtStepId: ${startAtStepId}`)
    }

    const results: StepRunResult[] = []
    let status: RunReport['status'] = 'passed'

    for (const step of definition.steps.slice(startIndex)) {
      const stepStartedAt = new Date().toISOString()
      if (step.kind === 'checkpoint') {
        results.push({
          stepId: step.id,
          name: step.name,
          kind: 'checkpoint',
          status: 'waiting',
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
          output: step.prompt,
        })
        status = 'waiting'
        break
      }

      const dispatched = await this.dispatch(step.tool, step.arguments, exec)
      if (!dispatched.ok) {
        results.push({
          stepId: step.id,
          name: step.name,
          kind: 'tool',
          tool: step.tool,
          status: 'failed',
          startedAt: stepStartedAt,
          finishedAt: new Date().toISOString(),
          output: dispatched.text,
          ...(dispatched.error === undefined ? {} : { error: dispatched.error }),
        })
        status = 'failed'
        break
      }

      const expectationError = step.expectation === undefined ? undefined : evaluateExpectation(dispatched.text, step.expectation)
      results.push({
        stepId: step.id,
        name: step.name,
        kind: 'tool',
        tool: step.tool,
        status: expectationError === undefined ? 'passed' : 'failed',
        startedAt: stepStartedAt,
        finishedAt: new Date().toISOString(),
        output: dispatched.text,
        ...(expectationError === undefined ? {} : { error: expectationError }),
      })
      if (expectationError !== undefined) {
        status = 'failed'
        break
      }
    }

    const report: RunReport = {
      schemaVersion: '0.1',
      runId,
      inspectionId: definition.id,
      inspectionName: definition.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      status,
      ...(startAtStepId === undefined ? {} : { startedAtStepId: startAtStepId }),
      expectedResult: definition.expectedResult,
      results,
    }
    const markdown = renderRunReport(report, this.options.reportMaxChars)
    const paths = await this.store.saveRun(report, markdown)
    return { report, paths }
  }
}

export function evaluateExpectation(text: string, expectation: TextExpectation): string | undefined {
  const haystack = expectation.caseSensitive ? text : text.toLocaleLowerCase()
  const needle = expectation.caseSensitive ? expectation.value : expectation.value.toLocaleLowerCase()
  const found = haystack.includes(needle)
  if (expectation.mode === 'contains' && !found) return `expected tool output to contain ${JSON.stringify(expectation.value)}`
  if (expectation.mode === 'not-contains' && found) return `expected tool output not to contain ${JSON.stringify(expectation.value)}`
  return undefined
}
