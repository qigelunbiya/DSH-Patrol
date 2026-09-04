/**
 * Conservative cleanup used by the Dashboard "清理试错" action.
 *
 * This intentionally does NOT infer that a later repeated navigation is a
 * "better round" and does NOT drop all steps before it. Only explicit semantic
 * finalization (patrol_finalize_flow with chosen successful step ids) may make
 * that destructive decision.
 */
export function compactFlowConservatively(definition) {
  const original = Array.isArray(definition?.steps) ? definition.steps.slice() : []
  const referenced = new Set()
  for (const step of original) {
    if (step?.when?.sourceStepId) referenced.add(step.when.sourceStepId)
  }

  const artifacts = Array.isArray(definition?.artifacts) ? definition.artifacts : []
  const needsPageOutput = artifacts.includes('page-text') || artifacts.includes('page-summary')
  const needsScreenshot = artifacts.includes('screenshot')
  const lastPageRead = findLastToolIndex(original, 'browser_read_page')
  const lastScreenshot = findLastToolIndex(original, 'browser_screenshot')

  const kept = original.filter((step, index) => {
    if (!step) return false
    if (step.kind === 'checkpoint') return true
    if (referenced.has(step.id)) return true
    if (step.expectation !== undefined) return true

    // Pure teaching probes may be discarded.
    if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') return false

    // Page-read/screenshot outputs are collapsed only when they are pure
    // observations. Real navigation/click/type/login-state/wait/etc. actions
    // are never removed by this conservative cleanup.
    if (step.tool === 'browser_read_page') {
      if (step.artifact === 'page-text' && needsPageOutput) return index === lastPageRead
      return needsPageOutput && index === lastPageRead
    }
    if (step.tool === 'browser_screenshot') {
      if (hasMeaningfulNotes(step)) return true
      return needsScreenshot && index === lastScreenshot
    }

    return true
  })

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

function hasMeaningfulNotes(step) {
  return typeof step.notes === 'string' && step.notes.trim().length > 0
}

function findLastToolIndex(steps, tool) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'tool' && steps[index]?.tool === tool) return index
  }
  return -1
}
