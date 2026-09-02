export function compactTeachingFlow(definition) {
  const original = Array.isArray(definition?.steps) ? definition.steps.slice() : []
  const referenced = new Set()
  for (const step of original) {
    if (step?.when?.sourceStepId) referenced.add(step.when.sourceStepId)
  }

  const lastPageRead = findLastToolIndex(original, 'browser_read_page')
  const lastScreenshot = findLastToolIndex(original, 'browser_screenshot')
  const artifacts = Array.isArray(definition?.artifacts) ? definition.artifacts : []
  const needsPageOutput = artifacts.includes('page-text') || artifacts.includes('page-summary')
  const needsScreenshot = artifacts.includes('screenshot')

  const kept = original.filter((step, index) => shouldKeepStep(
    step,
    index,
    referenced,
    lastPageRead,
    lastScreenshot,
    needsPageOutput,
    needsScreenshot,
  ))

  const idMap = new Map()
  kept.forEach((step, index) => idMap.set(step.id, `step-${String(index + 1).padStart(3, '0')}`))
  definition.steps = kept.map((step, index) => ({
    ...step,
    id: `step-${String(index + 1).padStart(3, '0')}`,
    ...(step.when === undefined ? {} : {
      when: {
        ...step.when,
        sourceStepId: idMap.get(step.when.sourceStepId) || step.when.sourceStepId,
      },
    }),
  }))

  return {
    removedSteps: original.length - definition.steps.length,
    originalSteps: original.length,
    finalSteps: definition.steps.length,
  }
}

function shouldKeepStep(step, index, referenced, lastPageRead, lastScreenshot, needsPageOutput, needsScreenshot) {
  if (!step || step.kind === 'checkpoint') return Boolean(step)
  if (referenced.has(step.id)) return true
  if (step.expectation !== undefined) return true
  if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') return false
  if (step.tool === 'browser_read_page') return needsPageOutput && index === lastPageRead
  if (step.tool === 'browser_screenshot') {
    if (!needsScreenshot) return hasNotes(step)
    return index === lastScreenshot || hasNotes(step)
  }
  return true
}

function hasNotes(step) {
  return typeof step.notes === 'string' && step.notes.trim().length > 0
}

function findLastToolIndex(steps, tool) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'tool' && steps[index]?.tool === tool) return index
  }
  return -1
}
