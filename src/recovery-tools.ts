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
- Browser transport failures are not business-flow failures. If a patrol_* browser action reports managed browser unavailable, not connected, disconnected, browser command timeout, or stale transport, call patrol_browser_recover AT MOST ONCE for that recovery attempt. If it reports healthy, retry the same failed patrol_* business action once. If recovery still fails, STOP and report its managedError; do not call patrol_browser_recover repeatedly, do not delete/recreate the flow, and do not call direct browser_* diagnostics.
- If the CURRENT page is visibly stuck on the same splash/loading shell after a successful target navigation, re-observe once and use patrol_reload_current at most once. It is transient recovery and is not part of the Runbook. Never guess /login, /ssoclient, or another internal URL to replace a required click.
- After a recovery retry, inspect CURRENT evidence before repeating a mutating action. If the first click/type may already have succeeded, do not blindly issue it again.
- When patrol_run, patrol_validate, or patrol_resume_validation fails at a real Runbook step, do NOT restart teaching from navigation and do NOT delete/recreate unrelated successful steps.
- Call patrol_last_failure first. It returns the exact stable stepId, tool, and error from the latest run.
- Repair only that stable step: patrol_reteach_text for browser_type, patrol_reteach_credential for browser_type_credential, patrol_reteach_transient for browser_type_transient_ref, patrol_reteach_checkpoint for a checkpoint, or patrol_reteach_browser_step for other browser steps.
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
  if (failed.tool === 'browser_type_transient_ref') {
    return `Recovery: preserve every other step. The current-session sensitive reference probably expired. Call patrol_begin_edit, then patrol_reteach_transient for stepId=${failed.stepId} with the user-supplied value; validate once after that single repair.`
  }
  return `Recovery: preserve every other step. Call patrol_begin_edit, then patrol_reteach_browser_step for stepId=${failed.stepId}; validate once after that single repair. Do not delete and rebuild the Runbook.`
}
