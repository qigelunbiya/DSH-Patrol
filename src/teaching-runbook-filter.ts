import { captureSuccessfulTeachingTrace } from './successful-teaching-trace.js'
import type { PatrolStore } from './store.js'
import type { InspectionDefinition } from './types.js'

const installedStores = new WeakSet<object>()

/**
 * These are inspection probes rather than reusable business actions. They may
 * be dropped from the visible DRAFT unless another step explicitly depends on
 * them. Everything else that actually executed successfully stays in the DRAFT
 * until explicit finalization/compaction.
 */
const ALWAYS_TRANSIENT_TOOLS = new Set([
  'browser_snapshot',
  'browser_count',
])

/**
 * Install the live-teaching persistence hook.
 *
 * Historical versions aggressively matched every successful step against the
 * task checklist on EVERY store.save(). That made valid navigate/scroll/wait/
 * read/screenshot actions disappear while teaching was still in progress, and
 * could even delete freshly inserted structural steps the next time any live
 * action was recorded.
 *
 * The live DRAFT is now lossless for successful replayable actions. Cleanup is
 * reserved for patrol_finalize_flow / READY compaction, where the whole route
 * is available and can be reasoned about safely.
 */
export function installTeachingRunbookFilter(store: PatrolStore): void {
  if (installedStores.has(store)) return
  installedStores.add(store)

  const originalSave = store.save.bind(store)
  store.save = async (definition: InspectionDefinition): Promise<void> => {
    const previous = await store.exists(definition.id)
      ? await store.load(definition.id)
      : undefined

    // Capture newly executed successes BEFORE any transient probe filtering.
    // Structural edit tools use saveRunbookEdit(), so they cannot pollute the
    // append-only successful-teaching trace.
    captureSuccessfulTeachingTrace(previous, definition)
    filterDraftRunbookInPlace(definition)
    await originalSave(definition)
  }
}

/**
 * Minimal live-DRAFT filtering only.
 *
 * Never task-checklist-dedupe or route-compact here. Successful business
 * actions must remain visible immediately after teaching, even when their
 * wording does not exactly match the checklist. This is especially important
 * for browser_scroll/browser_wait and secondary navigations.
 */
export function filterDraftRunbookInPlace(definition: InspectionDefinition): void {
  if (definition.status !== 'draft' || definition.steps.length === 0) return

  const referenced = new Set<string>()
  for (const step of definition.steps) {
    if (step.when !== undefined) referenced.add(step.when.sourceStepId)
  }

  const kept = definition.steps.filter(step => {
    if (step.kind === 'checkpoint') return true
    if (step.teaching?.status === 'unverified') return false
    if (referenced.has(step.id)) return true
    if (ALWAYS_TRANSIENT_TOOLS.has(step.tool)) return false
    return true
  })

  if (kept.length === definition.steps.length
    && kept.every((step, index) => step === definition.steps[index])) return

  // Live DRAFT ids remain stable. Finalization is the only place allowed to
  // compact/renumber the reusable graph.
  definition.steps = kept
  definition.metadata.updatedAt = new Date().toISOString()
  delete definition.metadata.flowHealth
}
