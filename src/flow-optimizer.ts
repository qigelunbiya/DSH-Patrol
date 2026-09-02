import type { InspectionDefinition, InspectionStep, ToolStep } from './types.js'

export interface FlowCompactionResult {
  removedSteps: number
  originalSteps: number
  finalSteps: number
}

/**
 * Remove teaching-only probes before a draft becomes a reusable flow.
 *
 * Patrol teaching intentionally explores the current page. Those probes are
 * useful while the model is learning, but snapshots/counts and repeated page
 * reads should not become permanent replay work unless a later step depends on
 * them or they carry an explicit assertion/output requirement.
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

  const kept = original.filter((step, index) => shouldKeepStep(
    step,
    index,
    referenced,
    lastPageRead,
    lastScreenshot,
    needsPageOutput,
    needsScreenshot,
  ))

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

  return {
    removedSteps: original.length - definition.steps.length,
    originalSteps: original.length,
    finalSteps: definition.steps.length,
  }
}

function shouldKeepStep(
  step: InspectionStep,
  index: number,
  referenced: ReadonlySet<string>,
  lastPageRead: number,
  lastScreenshot: number,
  needsPageOutput: boolean,
  needsScreenshot: boolean,
): boolean {
  if (step.kind === 'checkpoint') return true
  if (referenced.has(step.id)) return true
  if (step.expectation !== undefined) return true

  if (step.tool === 'browser_snapshot') return false

  if (step.tool === 'browser_count') {
    return false
  }

  if (step.tool === 'browser_read_page') {
    if (step.artifact === 'page-text' && needsPageOutput && index === lastPageRead) return true
    return index === lastPageRead && needsPageOutput
  }

  if (step.tool === 'browser_screenshot') {
    if (!needsScreenshot) return stepHasMeaningfulNotes(step)
    return index === lastScreenshot || stepHasMeaningfulNotes(step)
  }

  return true
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
