import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { selectSuccessfulTeachingPath } from './flow-optimizer.js'
import { PatrolStore } from './store.js'
import type { RunReport } from './types.js'
import { assertInspectionId } from './validation.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

type InteractivePatrolStore = PatrolStore & {
  beginTeachingRun?: (inspectionId: string, workspaceRoot?: string) => Promise<RunReport>
}

/**
 * Session-facing flow controls.
 *
 * patrol_select_flow deliberately has an inspectionId argument so the Harness
 * client can infer the current flow from normal tool history. For DRAFT flows
 * it also starts the interactive patrol lifecycle immediately, which guarantees
 * that conversational teaching has a WAITING history row before the first
 * browser step is recorded.
 *
 * patrol_finalize_flow is the semantic compaction boundary. The model has the
 * complete teaching conversation and is therefore in a much better position
 * than a syntax-only optimizer to distinguish the successful path from wrong
 * turns that happened to return a successful browser command result.
 */
export function registerPatrolFlowTools(ctx: Context, store: PatrolStore): () => void {
  const selectFlow = defineTool({
    name: 'patrol_select_flow',
    description: 'Select the Patrol flow that the current conversation is using. For a DRAFT this also creates/continues its in-progress conversational patrol record. For a READY flow, subsequent patrol requests should use patrol_run unless the user explicitly wants to edit/reteach it.',
    parameters: {
      inspectionId: { type: 'string', required: true },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      assertInspectionId(args.inspectionId)
      const definition = await store.load(args.inspectionId)
      const workspaceRoot = exec?.agent?.session.header.cwd
      if (workspaceRoot !== undefined && definition.metadata.workspaceRoot !== workspaceRoot) {
        definition.metadata.workspaceRoot = workspaceRoot
        // Selecting a flow is session context, not a semantic Runbook edit.
        // Do not change updatedAt merely because the user switched flows.
        await store.save(definition)
      }
      if (definition.status === 'draft') {
        const lifecycle = store as InteractivePatrolStore
        if (typeof lifecycle.beginTeachingRun === 'function') {
          await lifecycle.beginTeachingRun(definition.id, workspaceRoot ?? definition.metadata.workspaceRoot)
        }
        return `Selected DRAFT flow ${definition.id} (${definition.name}). A conversational patrol record is active for this flow. Record all patrol work with patrol_* tools, then call patrol_finalize_flow with only the successful reusable step ids before patrol_confirm.`
      }
      return `Selected READY flow ${definition.id} (${definition.name}). Treat this as the current flow. If the user asks to patrol it, call patrol_run so the execution is persisted under this flow's recent patrols and global patrol records. Use patrol_begin_edit only when the user asks to change/reteach the flow.`
    },
  })

  const finalizeFlow = defineTool({
    name: 'patrol_finalize_flow',
    description: 'Reduce a conversationally taught DRAFT to the successful reusable path before confirmation. Pass ONLY step ids that actually contributed to the final successful patrol; exclude wrong branches, exploratory clicks, retries, probes, stale inputs, and diagnostics. Required condition dependencies and final requested artifacts are restored automatically.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      successfulStepIds: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Ordered step ids from the current DRAFT that form the final successful reusable route.',
      },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      assertInspectionId(args.inspectionId)
      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}; only a DRAFT teaching trace can be finalized`)
      if (!Array.isArray(args.successfulStepIds) || args.successfulStepIds.length === 0) {
        throw new Error('successfulStepIds must contain the reusable successful path')
      }
      const result = selectSuccessfulTeachingPath(definition, args.successfulStepIds)
      definition.metadata.updatedAt = new Date().toISOString()
      await store.save(definition)
      return [
        `Finalized successful path for ${definition.id}: ${result.originalSteps} teaching steps -> ${result.finalSteps} reusable steps.`,
        `Removed ${result.removedSteps} exploratory/retry steps; automatically restored ${result.autoKeptDependencies} required dependency/artifact step(s).`,
        'Review the compact step list if needed, then patrol_confirm after the user has explicitly approved saving the flow.',
      ].join('\n')
    },
  })

  const disposers = [selectFlow, finalizeFlow].map(tool => ctx.tools.register(tool))
  return () => { for (const dispose of disposers) dispose() }
}
