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
  const resetFloor = findSafeResetFloor(original, definition?.target?.url || '', referenced)

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

function shouldKeepStep(all, step, index, referenced, lastPageRead, lastScreenshot, needsPageOutput, needsScreenshot, resetFloor) {
  if (!step) return false
  if (index < resetFloor) return false
  if (step.kind === 'checkpoint') return true
  if (referenced.has(step.id)) return true
  if (step.expectation !== undefined) return true
  if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') return hasNotes(step)
  if (step.tool === 'browser_read_page') return hasNotes(step) || (needsPageOutput && index === lastPageRead)
  if (step.tool === 'browser_screenshot') return hasNotes(step) || (needsScreenshot && index === lastScreenshot)
  if (isTypingTool(step.tool) && isSupersededTypingStep(all, index, step)) return false
  return true
}

function findSafeResetFloor(steps, targetUrl, referenced) {
  const target = normalizeUrl(targetUrl)
  if (!target) return 0
  const navigations = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step?.kind !== 'tool' || step.tool !== 'browser_navigate') continue
    const url = typeof step.arguments?.url === 'string' ? normalizeUrl(step.arguments.url) : ''
    if (url === target) navigations.push(index)
  }
  if (navigations.length < 2) return 0

  for (let cursor = navigations.length - 1; cursor > 0; cursor -= 1) {
    const previous = navigations[cursor - 1]
    const current = navigations[cursor]
    const abandoned = steps.slice(previous + 1, current)
    const hasStrongSemanticStep = abandoned.some(step =>
      step?.kind === 'checkpoint'
      || referenced.has(step?.id)
      || (step?.kind === 'tool' && step.expectation !== undefined),
    )
    if (!hasStrongSemanticStep) return current
  }
  return 0
}

function isSupersededTypingStep(all, index, step) {
  const selector = typeof step.arguments?.selector === 'string' ? step.arguments.selector : ''
  if (!selector) return false
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    const next = all[cursor]
    if (isInteractionBoundary(next)) return false
    if (next?.kind !== 'tool' || !isTypingTool(next.tool)) continue
    if (next.arguments?.selector === selector) return true
  }
  return false
}

function isInteractionBoundary(step) {
  if (!step) return false
  if (step.kind === 'checkpoint') return true
  return step.tool === 'browser_click'
    || step.tool === 'browser_press'
    || step.tool === 'browser_navigate'
    || step.tool === 'browser_detect_auth_challenge'
}

function isTypingTool(tool) {
  return tool === 'browser_type'
    || tool === 'browser_type_credential'
    || tool === 'browser_type_transient_ref'
    || tool === 'browser_type_totp_profile'
}

function rewriteSteps(definition, kept) {
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
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value || ''))
    url.hash = ''
    const normalized = url.toString()
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  } catch {
    return String(value || '').trim().replace(/\/$/, '')
  }
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
