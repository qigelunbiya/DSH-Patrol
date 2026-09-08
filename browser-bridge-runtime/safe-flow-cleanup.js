/**
 * Conservative cleanup used by the Dashboard "清理试错" action.
 *
 * A previous implementation removed only snapshot/count probes, which meant a
 * five-attempt login loop was visually reduced from e.g. 34 to 33 steps while
 * every failed submit remained in the Runbook. This version still refuses to
 * guess that a later navigation is a "better round", but it can deterministically
 * collapse retry-shaped login/confirm cycles before the next real workflow
 * boundary. This is intentionally narrower than patrol_finalize_flow: arbitrary
 * business clicks are never deduplicated just because their selectors match.
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
    if (hasMeaningfulNotes(step)) return true

    // Pure teaching probes may be discarded. They are useful while discovering
    // a page, but are not actions a deterministic replay needs to perform.
    if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') return false

    if (step.tool === 'browser_read_page') {
      return needsPageOutput && index === lastPageRead
    }
    if (step.tool === 'browser_screenshot') {
      return needsScreenshot && index === lastScreenshot
    }

    // A corrected value typed into the same field before any real interaction
    // supersedes the earlier value. Never cross a click/navigation boundary:
    // retyping after a failed submit or a page reload can be genuinely required.
    if (isTypingTool(step.tool) && isSupersededTypingStep(original, index, step)) return false

    // Login/CAPTCHA teaching commonly records cycles such as:
    //   detect challenge -> click 登录 -> observe -> detect -> click 登录 ...
    // Current one-time CAPTCHA characters are deliberately not persisted, so
    // without this rule the Dashboard cannot see which visible submit steps were
    // failed attempts. Keep only the last equivalent retry-shaped action before
    // the next durable workflow boundary (TOTP, navigation, business click, etc.).
    if (isRetryShapedStep(step) && hasLaterEquivalentRetryBeforeBoundary(original, index, step)) return false

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

function hasLaterEquivalentRetryBeforeBoundary(steps, index, step) {
  const signature = retrySignature(step)
  if (!signature) return false
  for (let cursor = index + 1; cursor < steps.length; cursor += 1) {
    const next = steps[cursor]
    if (!next) continue
    if (isProtectedSemanticStep(next)) return false
    if (isRetrySegmentBoundary(next)) return false
    if (isRetryShapedStep(next) && retrySignature(next) === signature) return true
  }
  return false
}

function isRetrySegmentBoundary(step) {
  if (step.kind === 'checkpoint') return true
  if (step.kind !== 'tool') return true
  if (step.tool === 'browser_navigate') return true
  if (isTypingTool(step.tool)) return true

  // Pure observations and retry-family actions do not end the segment. This is
  // what lets an earlier 登录 click be removed even when a detector/wait/read
  // probe sits between it and the final successful 登录 click.
  if (isPureObservation(step.tool) || isRetryShapedStep(step)) return false

  // Any other mutation is real workflow progress and therefore a hard boundary.
  return step.tool === 'browser_click'
    || step.tool === 'browser_press'
    || step.tool === 'browser_scroll'
    || step.tool.startsWith('browser_')
}

function isProtectedSemanticStep(step) {
  return step?.kind === 'checkpoint'
    || step?.when !== undefined
    || step?.expectation !== undefined
    || step?.artifact !== undefined
    || hasMeaningfulNotes(step)
}

function isPureObservation(tool) {
  return tool === 'browser_snapshot'
    || tool === 'browser_count'
    || tool === 'browser_read_page'
    || tool === 'browser_screenshot'
}

function isRetryShapedStep(step) {
  if (step?.kind !== 'tool') return false
  if (step.when !== undefined || step.expectation !== undefined || step.artifact !== undefined || hasMeaningfulNotes(step)) return false
  if (step.tool === 'browser_detect_auth_challenge' || step.tool === 'browser_login_state' || step.tool === 'browser_wait') return true
  if (step.tool !== 'browser_click' && step.tool !== 'browser_press') return false

  const text = [
    step.name,
    step.locator?.text,
    step.arguments?.selector,
    step.arguments?.key,
  ].filter(value => typeof value === 'string').join(' ')
  return /(登录|登陆|确定|确认|提交|验证|重试|login|log\s*in|sign\s*in|submit|confirm|verify|retry)/i.test(text)
}

function retrySignature(step) {
  if (!isRetryShapedStep(step)) return ''
  return JSON.stringify({
    tool: step.tool,
    arguments: stableArguments(step.arguments),
    locator: step.locator || null,
  })
}

function stableArguments(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value || {}
  // tabId is a teaching-session transport detail and current Patrol rejects it
  // from durable steps, but ignore it here as a compatibility measure for old
  // Runbooks created before that validation existed.
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => key !== 'tabId')
    .sort(([left], [right]) => left.localeCompare(right)))
}

function isSupersededTypingStep(steps, index, step) {
  const selector = typeof step.arguments?.selector === 'string' ? step.arguments.selector : ''
  if (!selector) return false
  for (let cursor = index + 1; cursor < steps.length; cursor += 1) {
    const next = steps[cursor]
    if (!next) continue
    if (next.kind === 'checkpoint' || next.tool === 'browser_navigate' || next.tool === 'browser_click' || next.tool === 'browser_press') return false
    if (next.kind !== 'tool' || !isTypingTool(next.tool)) continue
    if (next.arguments?.selector === selector) return true
  }
  return false
}

function isTypingTool(tool) {
  return tool === 'browser_type'
    || tool === 'browser_type_credential'
    || tool === 'browser_type_transient_ref'
    || tool === 'browser_type_totp_profile'
}

function hasMeaningfulNotes(step) {
  return typeof step?.notes === 'string' && step.notes.trim().length > 0
}

function findLastToolIndex(steps, tool) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'tool' && steps[index]?.tool === tool) return index
  }
  return -1
}
