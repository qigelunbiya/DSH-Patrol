import { compactFlowConservatively } from './safe-flow-cleanup.js'

/**
 * Dashboard cleanup adds one stricter DRAFT-only pass on top of the conservative
 * reusable-flow cleaner. A DRAFT is a teaching trace, so navigation retries and
 * blind scroll probes are not allowed to survive merely because the model gave
 * them a generated expectation/note.
 */
export function compactDashboardFlow(definition) {
  const first = compactFlowConservatively(definition)
  if (String(definition?.status || '').toLowerCase() !== 'draft' || !Array.isArray(definition?.steps)) {
    return first
  }

  const before = definition.steps.slice()
  let firstNavigationSeen = false
  const kept = before.filter(step => {
    if (!step || step.kind !== 'tool') return true

    if (step.tool === 'browser_navigate') {
      if (!firstNavigationSeen) {
        firstNavigationSeen = true
        return true
      }
      // During teaching, subsequent navigations are almost always recovery from
      // a failed click (guess URL, return home, re-enter target). A real reusable
      // workflow should express those transitions as the successful click that
      // caused them. Preserve only explicitly user-authored/conditional revisits.
      if (step.when !== undefined || hasUserNotes(step)) return true
      return false
    }

    if (step.tool === 'browser_scroll') {
      const selector = typeof step.arguments?.selector === 'string' ? step.arguments.selector.trim() : ''
      // A selector-less scroll is viewport exploration, not a deterministic
      // business action. Keep scoped/conditional/user-authored scrolls only.
      if (!selector && step.when === undefined && !hasUserNotes(step)) return false
    }

    return true
  })

  if (kept.length === before.length) return first
  renumberSteps(definition, kept)
  return {
    originalSteps: first.originalSteps,
    removedSteps: first.originalSteps - definition.steps.length,
    finalSteps: definition.steps.length,
  }
}

function renumberSteps(definition, steps) {
  const idMap = new Map()
  steps.forEach((step, index) => idMap.set(step.id, `step-${String(index + 1).padStart(3, '0')}`))
  definition.steps = steps.map((step, index) => ({
    ...step,
    id: `step-${String(index + 1).padStart(3, '0')}`,
    ...(step.when === undefined ? {} : {
      when: {
        ...step.when,
        sourceStepId: idMap.get(step.when.sourceStepId) || step.when.sourceStepId,
      },
    }),
  }))
}

function hasUserNotes(step) {
  if (typeof step?.notes !== 'string' || !step.notes.trim()) return false
  return step.notes
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .some(line => !/^(执行方法|execution method)[:：]/i.test(line))
}
