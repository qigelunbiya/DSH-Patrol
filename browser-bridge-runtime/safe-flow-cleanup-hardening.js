import { assessChecklistCoverage, compactFlowConservatively } from './safe-flow-cleanup.js'

/**
 * Dashboard "清理试错" hardening.
 *
 * The cleanup is transactional with respect to the user's task checklist:
 * heuristics may remove retry-shaped navigation/scroll noise, but if the
 * resulting graph loses ANY checklist item that was covered before cleanup,
 * the original graph is restored and the destructive cleanup is blocked.
 */
export function compactDashboardFlow(definition) {
  const originalSnapshot = clone(definition)
  const originalSteps = Array.isArray(definition?.steps) ? definition.steps.slice() : []
  const beforeCoverage = assessChecklistCoverage(definition, originalSteps)

  const first = compactFlowConservatively(definition)
  if (String(definition?.status || '').toLowerCase() === 'draft' && Array.isArray(definition?.steps)) {
    const currentCoverage = assessChecklistCoverage(definition, definition.steps)
    const protectedIndexes = new Set(currentCoverage.matches.map(item => item.stepIndex))
    const targetOrigin = navigationOrigin(definition?.target?.url)
    let firstNavigationSeen = false

    const before = definition.steps.slice()
    const kept = before.filter((step, index) => {
      if (!step || step.kind !== 'tool') return true
      if (protectedIndexes.has(index)) return true

      if (step.tool === 'browser_navigate') {
        const action = typeof step.arguments?.action === 'string' ? step.arguments.action : 'navigate'
        const url = typeof step.arguments?.url === 'string' ? step.arguments.url : ''
        const origin = navigationOrigin(url)

        if (!firstNavigationSeen && action === 'navigate') {
          firstNavigationSeen = true
          return true
        }

        // A different-origin navigation is a strong business phase boundary
        // (for example Google -> Odoo) and must never be treated as a guessed
        // same-site recovery merely because it is not the first navigation.
        if (origin && targetOrigin && origin !== targetOrigin) return true
        if (step.when !== undefined || hasUserNotes(step)) return true

        // Unprotected reload/back/forward and same-origin later navigations are
        // recovery candidates. They survive only when the checklist alignment
        // or explicit user-authored notes/conditions prove business intent.
        return false
      }

      if (step.tool === 'browser_scroll') {
        const selector = typeof step.arguments?.selector === 'string' ? step.arguments.selector.trim() : ''
        if (selector || step.when !== undefined || hasUserNotes(step)) return true
        return false
      }

      return true
    })

    if (kept.length !== before.length) renumberSteps(definition, kept)
  }

  const reassessed = compactFlowConservatively(definition)
  const afterCoverage = assessChecklistCoverage(definition, definition.steps)
  const lostItems = coveredItemsLost(beforeCoverage, afterCoverage)

  if (lostItems.length > 0) {
    restoreDefinition(definition, originalSnapshot)
    return {
      originalSteps: originalSteps.length,
      removedSteps: 0,
      finalSteps: originalSteps.length,
      flowHealth: definition.metadata?.flowHealth,
      checklistCoverage: beforeCoverage,
      blocked: true,
      warnings: [
        'Cleanup was rolled back because it would remove user-required business steps.',
        `Protected checklist item(s): ${lostItems.join('；')}`,
      ],
    }
  }

  return {
    originalSteps: first.originalSteps,
    removedSteps: first.originalSteps - definition.steps.length,
    finalSteps: definition.steps.length,
    flowHealth: reassessed.flowHealth,
    checklistCoverage: afterCoverage,
    blocked: false,
    warnings: [],
  }
}

function coveredItemsLost(before, after) {
  const beforeMissing = new Set(before?.missingItems || [])
  const afterMissing = new Set(after?.missingItems || [])
  const lost = []
  for (const match of before?.matches || []) {
    const item = String(match?.checklistItem || '')
    if (!item || beforeMissing.has(item)) continue
    if (afterMissing.has(item)) lost.push(item)
  }
  return [...new Set(lost)]
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

function navigationOrigin(value) {
  const text = typeof value === 'string' ? value.trim() : ''
  if (!text) return ''
  try {
    return new URL(text).origin
  } catch {
    return ''
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function restoreDefinition(target, snapshot) {
  for (const key of Object.keys(target || {})) delete target[key]
  Object.assign(target, clone(snapshot))
}
