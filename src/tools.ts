import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertSafeForStorage } from './security.ts'
import { summarizeReport } from './report.ts'
import { PatrolRunner } from './runner.ts'
import { PatrolStore } from './store.ts'
import type { AuthMode, CheckpointStep, InspectionDefinition, JsonValue, TextExpectation, ToolStep } from './types.ts'
import { asJsonObject, assertInspectionId } from './validation.ts'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export interface PatrolToolsOptions {
  maxSteps: number
}

export function registerPatrolTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolToolsOptions,
): () => void {
  const definitions = createDefinitions(store, runner, options)
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  return () => { for (const dispose of disposers) dispose() }
}

function createDefinitions(store: PatrolStore, runner: PatrolRunner, options: PatrolToolsOptions): ToolDefinition[] {
  const createDraft = defineTool({
    name: 'patrol_create_draft',
    description: 'Create inspection.json after the user has supplied the complete browser inspection requirements. Never put plaintext credentials in this tool.',
    parameters: {
      inspectionId: { type: 'string', required: true, description: 'Stable short id, e.g. prod-console-daily.' },
      name: { type: 'string', required: true, description: 'Human-readable inspection name.' },
      description: { type: 'string', required: true, description: 'What is being inspected and why.' },
      targetUrl: { type: 'string', required: true, description: 'Starting URL.' },
      expectedResult: { type: 'string', required: true, description: 'Overall successful outcome.' },
      authMode: { type: 'string', required: true, enum: ['none', 'existing-session', 'manual-checkpoint', 'secret-ref'], description: 'Authentication strategy. v0.1 recommends existing-session.' },
      artifacts: { type: 'array', items: { type: 'string' }, description: 'Requested outputs, e.g. markdown-report, raw-tool-output, screenshot.' },
      notes: { type: 'string', description: 'Non-secret notes and constraints.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      assertInspectionId(args.inspectionId)
      const now = new Date().toISOString()
      const definition: InspectionDefinition = {
        schemaVersion: '0.1',
        id: args.inspectionId,
        name: args.name,
        description: args.description,
        status: 'draft',
        target: { type: 'browser', url: args.targetUrl },
        expectedResult: args.expectedResult,
        artifacts: args.artifacts ?? ['markdown-report'],
        auth: {
          mode: args.authMode as AuthMode,
          ...(args.notes === undefined ? {} : { notes: args.notes }),
        },
        schedule: null,
        steps: [],
        metadata: { createdAt: now, updatedAt: now },
      }
      await store.create(definition)
      return `Created draft ${definition.id} at ${store.inspectionPath(definition.id)}. Start the teaching run and use patrol_execute_and_record for replayable browser actions.`
    },
  })

  const executeAndRecord = defineTool({
    name: 'patrol_execute_and_record',
    description: 'Execute one allowlisted browser tool through the real DSH tool runtime and, only if it succeeds, append the exact call to a draft runbook.',
    parameters: {
      inspectionId: { type: 'string', required: true, description: 'Draft inspection id.' },
      stepName: { type: 'string', required: true, description: 'Readable name for this replay step.' },
      tool: { type: 'string', required: true, description: 'Allowlisted tool name, normally browser_* in v0.1.' },
      arguments: { type: 'json', required: true, description: 'JSON object passed to the target tool. Never include plaintext secrets.' },
      expectedText: { type: 'string', description: 'Optional text assertion over this tool result.' },
      expectationMode: { type: 'string', enum: ['contains', 'not-contains'], description: 'Assertion mode; defaults to contains.' },
      caseSensitive: { type: 'boolean', description: 'Whether expectedText matching is case-sensitive. Defaults to false.' },
      sensitive: { type: 'boolean', description: 'Set true if arguments contain credentials/OTP. Patrol will refuse and require a manual checkpoint instead.' },
      notes: { type: 'string', description: 'Non-secret step notes.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (args.sensitive === true) {
        throw new Error('DSH Patrol refuses to execute-and-record sensitive input. Use an existing authenticated session or patrol_add_checkpoint instead.')
      }
      const definition = await store.load(args.inspectionId)
      assertDraft(definition)
      if (definition.steps.length >= options.maxSteps) throw new Error(`runbook reached maxSteps=${options.maxSteps}`)
      const jsonArguments = asJsonObject(args.arguments as JsonValue)
      assertSafeForStorage(jsonArguments)
      const dispatched = await runner.dispatch(args.tool, jsonArguments, exec)
      if (!dispatched.ok) {
        return `Teaching action failed and was NOT recorded. ${dispatched.error ?? 'Unknown tool error'}\n${dispatched.text}`
      }

      const expectation: TextExpectation | undefined = args.expectedText === undefined ? undefined : {
        mode: args.expectationMode ?? 'contains',
        value: args.expectedText,
        caseSensitive: args.caseSensitive ?? false,
      }
      const now = new Date().toISOString()
      const step: ToolStep = {
        id: nextStepId(definition.steps.length),
        kind: 'tool',
        name: args.stepName,
        tool: args.tool,
        arguments: jsonArguments,
        ...(expectation === undefined ? {} : { expectation }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        recordedAt: now,
      }
      definition.steps.push(step)
      definition.metadata.updatedAt = now
      await store.save(definition)
      return `Executed and recorded ${step.id} (${step.tool}). Tool output:\n${dispatched.text}`
    },
  })

  const addCheckpoint = defineTool({
    name: 'patrol_add_checkpoint',
    description: 'Append a human-controlled checkpoint for login, OTP, approval, or another action that must not be persisted as secret-bearing automation.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      prompt: { type: 'string', required: true, description: 'Instruction shown when replay pauses. Do not include secret values.' },
      reason: { type: 'string', required: true, enum: ['login', 'otp', 'approval', 'other'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const definition = await store.load(args.inspectionId)
      assertDraft(definition)
      if (definition.steps.length >= options.maxSteps) throw new Error(`runbook reached maxSteps=${options.maxSteps}`)
      const now = new Date().toISOString()
      const step: CheckpointStep = {
        id: nextStepId(definition.steps.length),
        kind: 'checkpoint',
        name: args.stepName,
        prompt: args.prompt,
        reason: args.reason,
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        recordedAt: now,
      }
      definition.steps.push(step)
      definition.metadata.updatedAt = now
      await store.save(definition)
      return `Recorded checkpoint ${step.id}: ${step.prompt}`
    },
  })

  const confirm = defineTool({
    name: 'patrol_confirm',
    description: 'Freeze a successfully taught draft as a ready runbook. Call only after the user explicitly confirms the recorded procedure is correct.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      confirmed: { type: 'boolean', required: true, description: 'Must be true only after explicit user confirmation.' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!args.confirmed) throw new Error('explicit confirmation is required')
      const definition = await store.load(args.inspectionId)
      assertDraft(definition)
      if (definition.steps.length === 0) throw new Error('cannot confirm an empty runbook')
      const now = new Date().toISOString()
      definition.status = 'ready'
      definition.metadata.updatedAt = now
      definition.metadata.validatedAt = now
      await store.save(definition)
      return `Runbook ${definition.id} is READY with ${definition.steps.length} steps. Future patrol_run calls will replay the recorded steps.`
    },
  })

  const run = defineTool({
    name: 'patrol_run',
    description: 'Replay a ready runbook deterministically through the DSH tool runtime and save report.json plus report.md.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      startAtStepId: { type: 'string', description: 'Optional step id to resume from after a manual checkpoint.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'ready') throw new Error(`inspection ${definition.id} is ${definition.status}; confirm it before replay`)
      const { report, paths } = await runner.run(definition, exec, args.startAtStepId)
      const waiting = report.results.find(item => item.status === 'waiting')
      let resumeHint = ''
      if (waiting !== undefined) {
        const waitingIndex = definition.steps.findIndex(step => step.id === waiting.stepId)
        const next = definition.steps[waitingIndex + 1]
        resumeHint = next === undefined
          ? '\nCheckpoint is the final step; after completing it, the runbook has no remaining automated steps.'
          : `\nAfter completing the checkpoint, resume with startAtStepId=${next.id}.`
      }
      return `${summarizeReport(report)}\nMarkdown report: ${paths.markdown}\nJSON report: ${paths.json}${resumeHint}`
    },
  })

  const show = defineTool({
    name: 'patrol_show',
    description: 'Show one stored inspection definition.',
    parameters: { inspectionId: { type: 'string', required: true } },
    output: TEXT_OUTPUT,
    async execute(args) {
      return JSON.stringify(await store.load(args.inspectionId), null, 2)
    },
  })

  const list = defineTool({
    name: 'patrol_list',
    description: 'List stored inspections and their draft/ready state.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute() {
      const definitions = await store.list()
      if (definitions.length === 0) return 'No inspections stored.'
      return definitions.map(item => `${item.id}\t${item.status}\t${item.steps.length} steps\t${item.name}`).join('\n')
    },
  })

  return [createDraft, executeAndRecord, addCheckpoint, confirm, run, show, list]
}

function assertDraft(definition: InspectionDefinition): void {
  if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}, not draft`)
}

function nextStepId(length: number): string {
  return `step-${String(length + 1).padStart(3, '0')}`
}
