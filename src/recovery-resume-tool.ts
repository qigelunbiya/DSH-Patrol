import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveFlowReference } from './flow-reference-tools.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type { InspectionDefinition } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

/**
 * Recovery workers get exactly one Patrol composite tool. They may use a small
 * direct browser capability set to clear a transient obstruction; once the
 * page is ready this tool hands control back to the deterministic runner at
 * the failed step. It never edits the Runbook.
 */
export function registerPatrolRecoveryResumeTool(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const resumeAfterRecovery = defineTool({
    name: 'patrol_resume_after_recovery',
    description: 'After clearing the current transient browser obstruction, resume the paused deterministic Patrol run from its failed step. Call exactly once; this never edits or reteaches the Runbook.',
    parameters: {
      flow: { type: 'string', required: true, description: 'Stable inspectionId, display name, or @name.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const resolution = resolveFlowReference(await store.list(), args.flow, exec.agent?.session.header.cwd)
      const definition = unique(args.flow, resolution)
      const beforeSteps = JSON.stringify(definition.steps)
      const beforeUpdatedAt = definition.metadata.updatedAt
      const { report, paths } = await runner.resumeAfterRecovery(clone(definition), exec)
      const stored = await store.load(definition.id)
      if (JSON.stringify(stored.steps) !== beforeSteps || stored.metadata.updatedAt !== beforeUpdatedAt) {
        throw new Error(`non-mutating recovery invariant violated for ${definition.id}: stored Runbook changed`)
      }
      const passed = report.results.filter(item => item.status === 'passed').length
      const failed = report.results.filter(item => item.status === 'failed').length
      const waiting = report.results.filter(item => item.status === 'waiting').length
      return [
        `Recovery handoff completed for ${definition.id}.`,
        `runId=${report.runId}`,
        `runStatus=${report.status}`,
        `steps=${passed} passed, ${failed} failed, ${waiting} waiting, ${report.results.length} total`,
        `report=${paths.markdown}`,
        `json=${paths.json}`,
      ].join('\n')
    },
  })

  return ctx.tools.register(resumeAfterRecovery)
}

function unique(
  query: string,
  result: ReturnType<typeof resolveFlowReference>,
): InspectionDefinition {
  if (result.kind === 'missing') throw new Error(`no Patrol flow matched ${JSON.stringify(query)}`)
  if (result.kind === 'ambiguous') {
    throw new Error(`flow reference ${JSON.stringify(query)} is ambiguous; matching inspectionIds: ${result.matches.map(item => item.id).join(', ')}`)
  }
  return result.definition
}

function clone(definition: InspectionDefinition): InspectionDefinition {
  return JSON.parse(JSON.stringify(definition)) as InspectionDefinition
}
