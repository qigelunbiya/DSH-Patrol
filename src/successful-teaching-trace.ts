import type { InspectionDefinition, InspectionStep, ToolStep } from './types.js'

const TRACE_LIMIT = 512
const NON_REPLAYABLE_TEACHING_TOOLS = new Set([
  'browser_snapshot',
  'browser_count',
])

export interface SuccessfulTraceRestoreResult {
  traceSteps: number
  alreadyPresent: number
  restored: number
  restoredStepIds: string[]
  warnings: string[]
}

/**
 * Capture only newly persisted live-teaching actions.
 *
 * Structural edit tools use saveRunbookEdit() instead of save(), so they never
 * enter this journal. The journal therefore remains evidence of actions that
 * actually executed successfully during teaching, rather than a second copy of
 * whatever the model happened to draw in the Runbook.
 */
export function captureSuccessfulTeachingTrace(
  previous: InspectionDefinition | undefined,
  definition: InspectionDefinition,
): void {
  if (definition.status !== 'draft') return

  const existing = (definition.metadata.successfulTeachingTrace
    ?? previous?.metadata.successfulTeachingTrace
    ?? []).map(cloneStep)

  const knownEvents = new Set(existing.map(teachingEventKey))

  // When upgrading an already-existing DRAFT, seed the journal from its current
  // durable graph once. This cannot recover historical steps that were already
  // deleted by old builds, but it gives future edits a stable baseline.
  if (existing.length === 0 && previous !== undefined) {
    for (const step of previous.steps) {
      if (!isSuccessfulTeachingStep(step)) continue
      const key = teachingEventKey(step)
      if (knownEvents.has(key)) continue
      existing.push(cloneStep(step))
      knownEvents.add(key)
    }
  }

  const previousEvents = new Set((previous?.steps ?? []).map(teachingEventKey))
  for (const step of definition.steps) {
    if (!isSuccessfulTeachingStep(step)) continue
    const key = teachingEventKey(step)
    if (previousEvents.has(key) || knownEvents.has(key)) continue
    existing.push(cloneStep(step))
    knownEvents.add(key)
  }

  if (existing.length > TRACE_LIMIT) {
    existing.splice(0, existing.length - TRACE_LIMIT)
  }
  if (existing.length > 0) definition.metadata.successfulTeachingTrace = existing
}

/**
 * Restore missing live-teaching successes into the visible DRAFT without
 * deleting or reordering any existing Runbook step.
 *
 * Missing steps are inserted next to the nearest surviving trace neighbour.
 * Existing structural/manual steps remain untouched. Conditions are rebound to
 * the restored/current id of their original successful source step.
 */
export function restoreMissingSuccessfulTeachingSteps(
  definition: InspectionDefinition,
): SuccessfulTraceRestoreResult {
  const trace = definition.metadata.successfulTeachingTrace ?? []
  if (trace.length === 0) {
    return {
      traceSteps: 0,
      alreadyPresent: 0,
      restored: 0,
      restoredStepIds: [],
      warnings: ['No successful teaching trace is available for this flow yet.'],
    }
  }

  const currentIdForTraceIndex = new Map<number, string>()
  const traceIdToCurrentId = new Map<string, string>()
  const usedCurrent = new Set<number>()

  for (let traceIndex = 0; traceIndex < trace.length; traceIndex += 1) {
    const traceStep = trace[traceIndex]!
    const currentIndex = definition.steps.findIndex((step, index) =>
      !usedCurrent.has(index) && equivalentReplayStep(step, traceStep),
    )
    if (currentIndex < 0) continue
    usedCurrent.add(currentIndex)
    const current = definition.steps[currentIndex]!
    currentIdForTraceIndex.set(traceIndex, current.id)
    traceIdToCurrentId.set(traceStep.id, current.id)
  }

  const alreadyPresent = currentIdForTraceIndex.size
  const restoredStepIds: string[] = []
  const warnings: string[] = []

  for (let traceIndex = 0; traceIndex < trace.length; traceIndex += 1) {
    if (currentIdForTraceIndex.has(traceIndex)) continue
    const source = trace[traceIndex]!
    const restored = cloneStep(source)
    restored.id = nextStepId(definition.steps)

    if (restored.when !== undefined) {
      const rebound = traceIdToCurrentId.get(restored.when.sourceStepId)
      if (rebound === undefined) {
        warnings.push(
          `Skipped ${source.name}: successful trace condition source ${restored.when.sourceStepId} is not present/restorable yet.`,
        )
        continue
      }
      restored.when = { ...restored.when, sourceStepId: rebound }
    }

    const previousId = nearestMappedId(currentIdForTraceIndex, traceIndex, -1)
    const nextId = nearestMappedId(currentIdForTraceIndex, traceIndex, 1)
    const previousIndex = previousId === undefined
      ? -1
      : definition.steps.findIndex(step => step.id === previousId)
    const nextIndex = nextId === undefined
      ? -1
      : definition.steps.findIndex(step => step.id === nextId)

    let insertIndex = definition.steps.length
    if (previousIndex >= 0 && nextIndex >= 0) {
      if (previousIndex < nextIndex) insertIndex = previousIndex + 1
      else {
        // Existing user edits already disagree with the original successful
        // order. Do not reorder/delete them; place the recovered step next to
        // the later anchor and surface a warning.
        insertIndex = nextIndex
        warnings.push(
          `Existing Runbook order differs from successful trace around ${source.name}; restored without reordering existing steps.`,
        )
      }
    } else if (previousIndex >= 0) {
      insertIndex = previousIndex + 1
    } else if (nextIndex >= 0) {
      insertIndex = nextIndex
    }

    definition.steps.splice(insertIndex, 0, restored)
    currentIdForTraceIndex.set(traceIndex, restored.id)
    traceIdToCurrentId.set(source.id, restored.id)
    restoredStepIds.push(restored.id)
  }

  if (restoredStepIds.length > 0) {
    definition.schemaVersion = '0.2'
    definition.metadata.updatedAt = new Date().toISOString()
    delete definition.metadata.validatedAt
    delete definition.metadata.flowHealth
  }

  return {
    traceSteps: trace.length,
    alreadyPresent,
    restored: restoredStepIds.length,
    restoredStepIds,
    warnings,
  }
}

export function isSuccessfulTeachingStep(step: InspectionStep): boolean {
  if (step.kind === 'checkpoint') return true
  if (step.teaching?.status === 'unverified') return false
  if (NON_REPLAYABLE_TEACHING_TOOLS.has(step.tool)) return false
  return true
}

function nearestMappedId(
  mapped: ReadonlyMap<number, string>,
  from: number,
  direction: -1 | 1,
): string | undefined {
  for (
    let index = from + direction;
    index >= 0 && index <= TRACE_LIMIT;
    index += direction
  ) {
    const id = mapped.get(index)
    if (id !== undefined) return id
    if (direction === 1 && index > from + TRACE_LIMIT) break
  }
  return undefined
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match) max = Math.max(max, Number.parseInt(match[1] || '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}

function teachingEventKey(step: InspectionStep): string {
  if (step.kind === 'checkpoint') {
    return JSON.stringify([
      step.recordedAt,
      step.kind,
      step.name,
      step.prompt,
      step.reason,
    ])
  }
  return JSON.stringify([
    step.recordedAt,
    step.kind,
    step.name,
    step.tool,
    step.arguments,
    step.artifact ?? null,
  ])
}

function equivalentReplayStep(left: InspectionStep, right: InspectionStep): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'checkpoint' && right.kind === 'checkpoint') {
    return left.name === right.name
      && left.prompt === right.prompt
      && left.reason === right.reason
  }
  if (left.kind !== 'tool' || right.kind !== 'tool') return false
  return replayFingerprint(left) === replayFingerprint(right)
}

function replayFingerprint(step: ToolStep): string {
  return JSON.stringify({
    name: step.name,
    tool: step.tool,
    arguments: step.arguments,
    expectation: step.expectation ?? null,
    condition: step.when === undefined
      ? null
      : {
          mode: step.when.mode,
          value: step.when.value,
          caseSensitive: step.when.caseSensitive,
        },
    locator: step.locator ?? null,
    artifact: step.artifact ?? null,
    sensitive: step.sensitive ?? false,
    taskHint: step.taskHint ?? null,
  })
}

function cloneStep<T extends InspectionStep>(step: T): T {
  return JSON.parse(JSON.stringify(step)) as T
}
