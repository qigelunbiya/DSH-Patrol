import type { InspectionDefinition, InspectionStep, ToolStep } from './types.js'

export interface FlowCompactionResult {
  removedSteps: number
  originalSteps: number
  finalSteps: number
}

export interface FlowSelectionResult extends FlowCompactionResult {
  autoKeptDependencies: number
}

/**
 * Select the semantically successful route from a full conversational teaching
 * trace. The Agent supplies the ids because it observed the whole conversation
 * and can distinguish a real successful route from a browser command that
 * merely returned success while exploring the wrong branch.
 *
 * Conditions and final requested artifacts are restored automatically so a
 * model cannot accidentally leave a selected conditional step without its
 * source observation, or omit the final report/screenshot output.
 */
export function selectSuccessfulTeachingPath(
  definition: InspectionDefinition,
  successfulStepIds: readonly string[],
): FlowSelectionResult {
  const original = definition.steps.slice()
  if (original.length === 0) throw new Error('cannot finalize an empty teaching trace')

  const byId = new Map(original.map(step => [step.id, step] as const))
  const keep = new Set<string>()
  for (const id of successfulStepIds) {
    if (typeof id !== 'string' || !byId.has(id)) throw new Error(`successful path references unknown step ${String(id)}`)
    keep.add(id)
  }
  if (keep.size === 0) throw new Error('successful path must keep at least one step')

  const requestedCount = keep.size
  let changed = true
  while (changed) {
    changed = false
    for (const step of original) {
      if (!keep.has(step.id) || step.when === undefined || keep.has(step.when.sourceStepId)) continue
      if (!byId.has(step.when.sourceStepId)) throw new Error(`step ${step.id} depends on missing source ${step.when.sourceStepId}`)
      keep.add(step.when.sourceStepId)
      changed = true
    }
  }

  if (definition.artifacts.includes('page-text') || definition.artifacts.includes('page-summary')) {
    const index = findLastToolIndex(original, 'browser_read_page')
    if (index >= 0) keep.add(original[index]!.id)
  }
  if (definition.artifacts.includes('screenshot')) {
    const index = findLastToolIndex(original, 'browser_screenshot')
    if (index >= 0) keep.add(original[index]!.id)
  }

  rewriteSteps(definition, original.filter(step => keep.has(step.id)))
  return {
    originalSteps: original.length,
    finalSteps: definition.steps.length,
    removedSteps: original.length - definition.steps.length,
    autoKeptDependencies: Math.max(0, keep.size - requestedCount),
  }
}

/**
 * Deterministic fallback cleanup used by the dashboard and by legacy teaching
 * flows that were not semantically finalized by the Agent.
 *
 * This deliberately stays conservative around real clicks/navigation. It now
 * additionally removes abandoned same-target reset rounds and superseded input
 * corrections, two common sources of 100+ step teaching traces, while still
 * protecting condition sources, assertions, checkpoints and final outputs.
 */
export function compactTeachingFlow(definition: InspectionDefinition): FlowCompactionResult {
  const original = definition.steps.slice()
  const referenced = new Set<string>()
  for (const step of original) {
    if (step.when !== undefined) referenced.add(step.when.sourceStepId)
  }

  const lastPageRead = findLastToolIndex(original, 'browser_read_page')
  const lastScreenshot = findLastToolIndex(original, 'browser_screenshot')
  const needsPageOutput = definition.artifacts.includes('page-text') || definition.artifacts.includes('page-summary')
  const needsScreenshot = definition.artifacts.includes('screenshot')
  const resetFloor = findSafeResetFloor(original, definition.target.url, referenced)

  const kept = original.filter((step, index) => shouldKeepStep(
    original,
    step,
    index,
    referenced,
    lastPageRead,
    lastScreenshot,
    needsPageOutput,
    needsScreenshot,
    resetFloor,
  ))

  rewriteSteps(definition, kept)
  return {
    removedSteps: original.length - definition.steps.length,
    originalSteps: original.length,
    finalSteps: definition.steps.length,
  }
}

function shouldKeepStep(
  all: readonly InspectionStep[],
  step: InspectionStep,
  index: number,
  referenced: ReadonlySet<string>,
  lastPageRead: number,
  lastScreenshot: number,
  needsPageOutput: boolean,
  needsScreenshot: boolean,
  resetFloor: number,
): boolean {
  if (index < resetFloor) return false
  if (step.kind === 'checkpoint') return true
  if (referenced.has(step.id)) return true
  if (step.expectation !== undefined) return true

  if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') {
    return stepHasMeaningfulNotes(step)
  }

  if (step.tool === 'browser_read_page') {
    if (stepHasMeaningfulNotes(step)) return true
    return needsPageOutput && index === lastPageRead
  }

  if (step.tool === 'browser_screenshot') {
    if (stepHasMeaningfulNotes(step)) return true
    return needsScreenshot && index === lastScreenshot
  }

  if (isTypingTool(step.tool) && isSupersededTypingStep(all, index, step)) return false

  return true
}

function findSafeResetFloor(
  steps: readonly InspectionStep[],
  targetUrl: string,
  referenced: ReadonlySet<string>,
): number {
  const target = normalizeUrl(targetUrl)
  if (!target) return 0
  const navigations: number[] = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step?.kind !== 'tool' || step.tool !== 'browser_navigate') continue
    const url = typeof step.arguments.url === 'string' ? normalizeUrl(step.arguments.url) : ''
    if (url === target) navigations.push(index)
  }
  if (navigations.length < 2) return 0

  for (let cursor = navigations.length - 1; cursor > 0; cursor -= 1) {
    const previous = navigations[cursor - 1]!
    const current = navigations[cursor]!
    const abandoned = steps.slice(previous + 1, current)
    const hasStrongSemanticStep = abandoned.some(step =>
      step.kind === 'checkpoint'
      || referenced.has(step.id)
      || (step.kind === 'tool' && step.expectation !== undefined),
    )
    if (!hasStrongSemanticStep) return current
  }
  return 0
}

function isSupersededTypingStep(all: readonly InspectionStep[], index: number, step: ToolStep): boolean {
  const selector = typeof step.arguments.selector === 'string' ? step.arguments.selector : ''
  if (!selector) return false
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    const next = all[cursor]!
    if (isInteractionBoundary(next)) return false
    if (next.kind !== 'tool' || !isTypingTool(next.tool)) continue
    if (next.arguments.selector === selector) return true
  }
  return false
}

function isInteractionBoundary(step: InspectionStep): boolean {
  if (step.kind === 'checkpoint') return true
  return step.tool === 'browser_click'
    || step.tool === 'browser_press'
    || step.tool === 'browser_navigate'
    || step.tool === 'browser_detect_auth_challenge'
}

function isTypingTool(tool: string): boolean {
  return tool === 'browser_type'
    || tool === 'browser_type_credential'
    || tool === 'browser_type_transient_ref'
    || tool === 'browser_type_totp_profile'
}

function rewriteSteps(definition: InspectionDefinition, kept: readonly InspectionStep[]): void {
  const idMap = new Map<string, string>()
  kept.forEach((step, index) => idMap.set(step.id, `step-${String(index + 1).padStart(3, '0')}`))

  definition.steps = kept.map((step, index) => {
    const nextId = `step-${String(index + 1).padStart(3, '0')}`
    const when = step.when === undefined
      ? undefined
      : {
          ...step.when,
          sourceStepId: idMap.get(step.when.sourceStepId) ?? step.when.sourceStepId,
        }
    return {
      ...step,
      id: nextId,
      ...(when === undefined ? {} : { when }),
    } as InspectionStep
  })
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    const normalized = url.toString()
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  } catch {
    return value.trim().replace(/\/$/, '')
  }
}

function stepHasMeaningfulNotes(step: ToolStep): boolean {
  return typeof step.notes === 'string' && step.notes.trim().length > 0
}

function findLastToolIndex(steps: readonly InspectionStep[], tool: string): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step?.kind === 'tool' && step.tool === tool) return index
  }
  return -1
}
