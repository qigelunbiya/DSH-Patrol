import { alignChecklistRequirements } from './flow-task-alignment.js'
import { captureSuccessfulTeachingTrace } from './successful-teaching-trace.js'
import type { PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep } from './types.js'

const installedStores = new WeakSet<object>()

const ALWAYS_TRANSIENT_TOOLS = new Set([
  'browser_snapshot',
  'browser_count',
])

/**
 * Install the live-teaching persistence hook.
 *
 * The diagnostic successfulTeachingTrace remains lossless, but the visible
 * DRAFT Runbook is task-committed: it is continuously projected onto the
 * persisted taskChecklist. This lets Patrol try multiple methods without
 * turning every retry into a reusable flow step.
 */
export function installTeachingRunbookFilter(store: PatrolStore): void {
  if (installedStores.has(store)) return
  installedStores.add(store)

  const originalSave = store.save.bind(store)
  store.save = async (definition: InspectionDefinition): Promise<void> => {
    const previous = await store.exists(definition.id)
      ? await store.load(definition.id)
      : undefined

    // Keep every actually executed replayable success in a diagnostic journal.
    // The Runbook projection below decides which of those attempts currently
    // constitute the best checklist-constrained reusable route.
    captureSuccessfulTeachingTrace(previous, definition)
    filterDraftRunbookInPlace(definition)
    await originalSave(definition)
  }
}

/**
 * Keep only the current best replayable route for the persisted task checklist.
 *
 * Important properties:
 * - a compound checklist item may keep multiple atomic steps (type+submit,
 *   scroll+click, etc.);
 * - later equivalent successes replace earlier retries/false starts;
 * - failed/unverified clicks and pure probes never enter the Runbook;
 * - structural/manual edits are preserved because they are not members of the
 *   append-only successfulTeachingTrace;
 * - condition sources and required artifacts are retained automatically.
 */
export function filterDraftRunbookInPlace(definition: InspectionDefinition): void {
  if (definition.status !== 'draft' || definition.steps.length === 0) return

  const original = definition.steps.slice()
  const referenced = new Set<string>()
  for (const step of original) {
    if (step.when !== undefined) referenced.add(step.when.sourceStepId)
  }

  const eligibleEntries = original
    .map((step, originalIndex) => ({ step, originalIndex }))
    .filter(({ step }) => {
      if (step.kind === 'checkpoint') return false
      if (step.teaching?.status === 'unverified') return false
      if (ALWAYS_TRANSIENT_TOOLS.has(step.tool) && !referenced.has(step.id)) return false
      return true
    })

  const checklist = definition.metadata.taskChecklist ?? []
  const keepIndexes = new Set<number>()

  // Checkpoints are user-visible execution gates, not trial actions.
  for (let index = 0; index < original.length; index += 1) {
    if (original[index]?.kind === 'checkpoint') keepIndexes.add(index)
  }

  if (checklist.length === 0) {
    for (const entry of eligibleEntries) keepIndexes.add(entry.originalIndex)
  } else {
    const alignment = alignChecklistRequirements(
      checklist,
      eligibleEntries.map(entry => entry.step),
    )
    for (const match of alignment.matches) {
      const entry = eligibleEntries[match.stepIndex]
      if (entry !== undefined) keepIndexes.add(entry.originalIndex)
    }

    // Structural edit tools persist through saveRunbookEdit() and therefore do
    // not enter successfulTeachingTrace. Never erase such user-authored graph
    // rows when the next live teaching action is saved.
    const teachingTrace = definition.metadata.successfulTeachingTrace ?? []
    if (teachingTrace.length > 0) {
      const teachingTraceIds = new Set(teachingTrace.map(step => step.id))
      for (const entry of eligibleEntries) {
        if (!teachingTraceIds.has(entry.step.id)) keepIndexes.add(entry.originalIndex)
      }
    }

    keepRequiredArtifacts(definition, original, keepIndexes)
    keepAssertiveSteps(original, keepIndexes)
  }

  // Conditions are replay semantics. If a selected step depends on an earlier
  // source, retain the source transitively even when it is not itself a
  // checklist action.
  let changed = true
  while (changed) {
    changed = false
    for (const index of [...keepIndexes]) {
      const step = original[index]
      const sourceId = step?.when?.sourceStepId
      if (sourceId === undefined) continue
      const sourceIndex = original.findIndex(item => item.id === sourceId)
      if (sourceIndex >= 0 && !keepIndexes.has(sourceIndex)) {
        keepIndexes.add(sourceIndex)
        changed = true
      }
    }
  }

  const kept = original.filter((_step, index) => keepIndexes.has(index))
  if (sameSteps(original, kept)) return

  definition.steps = kept
  definition.metadata.updatedAt = new Date().toISOString()
  delete definition.metadata.flowHealth
}

function keepRequiredArtifacts(
  definition: InspectionDefinition,
  steps: readonly InspectionStep[],
  keepIndexes: Set<number>,
): void {
  const wantsScreenshot = definition.artifacts.some(item => item === 'screenshot')
  const wantsPageText = definition.artifacts.some(item => item === 'page-text' || item === 'page-summary')

  if (wantsScreenshot && ![...keepIndexes].some(index => {
    const step = steps[index]
    return step?.kind === 'tool' && (step.tool === 'browser_screenshot' || step.tool === 'desktop_screenshot')
  })) {
    keepLastMatching(steps, keepIndexes, step =>
      step.kind === 'tool' && (step.tool === 'browser_screenshot' || step.tool === 'desktop_screenshot'))
  }

  if (wantsPageText && ![...keepIndexes].some(index => {
    const step = steps[index]
    return step?.kind === 'tool' && step.tool === 'browser_read_page'
  })) {
    keepLastMatching(steps, keepIndexes, step => step.kind === 'tool' && step.tool === 'browser_read_page')
  }
}

function keepAssertiveSteps(steps: readonly InspectionStep[], keepIndexes: Set<number>): void {
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step?.kind !== 'tool') continue
    if (step.when !== undefined || step.expectation !== undefined) keepIndexes.add(index)
  }
}

function keepLastMatching(
  steps: readonly InspectionStep[],
  keepIndexes: Set<number>,
  predicate: (step: InspectionStep) => boolean,
): void {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step !== undefined && predicate(step)) {
      keepIndexes.add(index)
      return
    }
  }
}

function sameSteps(left: readonly InspectionStep[], right: readonly InspectionStep[]): boolean {
  return left.length === right.length && left.every((step, index) => step === right[index])
}
