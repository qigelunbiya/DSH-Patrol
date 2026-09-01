import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { redactLikelySecrets } from './security.js'
import { PatrolStore } from './store.js'
import type { RunReport, StepRunResult } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export const PATROL_TARGETED_RECOVERY_PROMPT = `Targeted failed-step recovery:
- When patrol_run, patrol_validate, or patrol_resume_validation fails, do NOT restart teaching from navigation and do NOT delete/recreate unrelated successful steps.
- Call patrol_last_failure first. It returns the exact stable stepId, tool, and error from the latest run.
- Repair only that stable step: patrol_reteach_text for browser_type, patrol_reteach_credential for browser_type_credential, patrol_reteach_checkpoint for a checkpoint, or patrol_reteach_browser_step for other browser steps.
- A failed step does not invalidate earlier successful steps. Preserve the Runbook, its step ids, conditions, screenshots, and page-read steps.
- After the one affected step is repaired, validate once end-to-end and confirm the edit. Do not enter a delete/re-add/revalidate loop.`

export function registerPatrolRecoveryTools(ctx: Context, store: PatrolStore): () => void {
  const lastFailure = defineTool({
    name: 'patrol_last_failure',
    description: 'Read the exact failed step from a Patrol run so recovery can target one stable step instead of restarting or deleting unrelated Runbook steps. When runId is omitted, the newest stored run is used.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      runId: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const runId = args.runId ?? await newestRunId(store, args.inspectionId)
      if (runId === undefined) return `Inspection ${args.inspectionId} has no stored runs.`
      const report = await store.loadRun(args.inspectionId, runId)
      return renderFailure(report)
    },
  })

  const dispose = ctx.tools.register(lastFailure)
  return () => dispose()
}

async function newestRunId(store: PatrolStore, inspectionId: string): Promise<string | undefined> {
  const root = join(store.root, 'runs', inspectionId)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  return entries
    .filter(entry => entry.isDirectory())
    .map(entry => entry.name)
    .sort((a, b) => b.localeCompare(a))[0]
}

function renderFailure(report: RunReport): string {
  const failed = report.results.find(result => result.status === 'failed')
  const passed = report.results.filter(result => result.status === 'passed').length
  if (failed === undefined) {
    return `Run ${report.runId}: status=${report.status}; passed steps=${passed}; no failed step is recorded.`
  }

  const lines = [
    `Run ${report.runId}: FAILED at stable step ${failed.stepId}.`,
    `Step name: ${failed.name}`,
    `Tool: ${failed.tool ?? failed.kind}`,
    `Earlier passed steps retained: ${passed}`,
    `Error: ${redactLikelySecrets(failed.error ?? '(no explicit error text)')}`,
  ]
  if (failed.output) lines.push(`Last safe output: ${redactLikelySecrets(failed.output).slice(0, 1600)}`)
  lines.push('', recoveryInstruction(failed))
  return lines.join('\n')
}

function recoveryInstruction(failed: StepRunResult): string {
  if (failed.kind === 'checkpoint') {
    return `Recovery: preserve every other step. Call patrol_begin_edit, then patrol_reteach_checkpoint for stepId=${failed.stepId}; validate once after that single repair.`
  }
  if (failed.tool === 'browser_type') {
    return `Recovery: preserve every other step. Call patrol_begin_edit, then patrol_reteach_text for stepId=${failed.stepId}; validate once after that single repair.`
  }
  if (failed.tool === 'browser_type_credential') {
    return `Recovery: preserve every other step. Call patrol_begin_edit, then patrol_reteach_credential for stepId=${failed.stepId}; validate once after that single repair.`
  }
  return `Recovery: preserve every other step. Call patrol_begin_edit, then patrol_reteach_browser_step for stepId=${failed.stepId}; validate once after that single repair. Do not delete and rebuild the Runbook.`
}
