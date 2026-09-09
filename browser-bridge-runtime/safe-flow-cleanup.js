/**
 * Conservative cleanup used by the Dashboard "清理试错" action.
 *
 * The key rule is that machine-generated `执行方法：...` notes are documentation,
 * not proof that a teaching step belongs in the final workflow. Older cleanup
 * treated those generated notes as user-authored semantic intent, which made
 * almost every modern Patrol step undeletable.
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
  const abandonedNavigationSteps = findAbandonedNavigationSteps(definition, original)

  const kept = original.filter((step, index) => {
    if (!step) return false
    if (abandonedNavigationSteps.has(index)) return false
    if (step.kind === 'checkpoint') return true
    if (referenced.has(step.id)) return true
    if (step.expectation !== undefined) return true
    if (step.when !== undefined) return true
    if (hasUserNotes(step)) return true

    // Pure teaching probes are discovery data, not replay actions. Generated
    // execution notes do not protect them from cleanup.
    if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') return false
    if (step.tool === 'browser_login_state' || step.tool === 'browser_detect_auth_challenge') {
      return false
    }

    // read_page defaults to producing a page-text teaching artifact, so artifact
    // alone cannot mean the user asked to keep every diagnostic read. Preserve
    // only the final required page output unless a semantic condition/expectation
    // above protected an earlier read.
    if (step.tool === 'browser_read_page') {
      return needsPageOutput && index === lastPageRead
    }

    // Screenshots are more commonly explicit user deliverables. Preserve the
    // final requested screenshot; finalized new flows use patrol_finalize_flow
    // to retain any earlier business screenshot that is genuinely required.
    if (step.tool === 'browser_screenshot') {
      return needsScreenshot && index === lastScreenshot
    }

    // A selector-less sleep is normally teaching/recovery noise. A selector wait
    // can be a deterministic replay dependency and is therefore kept.
    if (step.tool === 'browser_wait') {
      const selector = typeof step.arguments?.selector === 'string' ? step.arguments.selector.trim() : ''
      if (!selector) return false
    }

    // A corrected value typed into the same field before any real interaction
    // supersedes the earlier value. Never cross a click/navigation boundary:
    // retyping after a failed submit or page reload can be genuinely required.
    if (isTypingTool(step.tool) && isSupersededTypingStep(original, index, step)) return false

    // Login/CAPTCHA teaching commonly records equivalent submit/detect/wait
    // cycles. Keep only the last equivalent retry before the next durable
    // workflow boundary.
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

/**
 * Detect a narrow, deterministic class of guessed-navigation detours:
 *
 *   ... valid work ... -> navigate(other) -> wait/read/probe -> navigate(target)
 *
 * When the workflow returns to its declared target, the immediately preceding
 * non-target navigation round is abandoned if it contained no protected
 * business action. For a DRAFT, the same rule also removes a trailing non-target
 * navigation round that has no success evidence. This specifically avoids the
 * old "click failed, guess a URL, return, guess another URL" pollution without
 * deleting legitimate click/input work earlier in the flow.
 */
function findAbandonedNavigationSteps(definition, steps) {
  const discarded = new Set()
  const target = navigationIdentity(definition?.target?.url || '')
  if (!target) return discarded

  const navs = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step?.kind !== 'tool' || step.tool !== 'browser_navigate') continue
    const url = typeof step.arguments?.url === 'string' ? step.arguments.url : ''
    const identity = navigationIdentity(url)
    if (identity) navs.push({ index, identity })
  }

  // Every explicit return to the target can invalidate only the most recent
  // navigation round before it; earlier login/input work is left untouched.
  for (let cursor = 1; cursor < navs.length; cursor += 1) {
    const current = navs[cursor]
    const previous = navs[cursor - 1]
    if (current.identity !== target || previous.identity === target) continue
    const round = steps.slice(previous.index, current.index)
    if (roundHasBusinessEvidence(round)) continue
    for (let index = previous.index; index < current.index; index += 1) discarded.add(index)
  }

  // An interrupted DRAFT often ends on the last guessed URL because the model
  // never got back to the requested click. Remove that trailing round only when
  // nothing after the navigation proves real business progress.
  if (String(definition?.status || '').toLowerCase() === 'draft' && navs.length > 0) {
    const last = navs[navs.length - 1]
    if (last.identity !== target) {
      const round = steps.slice(last.index)
      if (!roundHasBusinessEvidence(round)) {
        for (let index = last.index; index < steps.length; index += 1) discarded.add(index)
      }
    }
  }
  return discarded
}

function roundHasBusinessEvidence(steps) {
  return steps.some(step => {
    if (!step) return false
    if (step.kind === 'checkpoint') return true
    if (step.when !== undefined || step.expectation !== undefined || hasUserNotes(step)) return true
    if (isTypingTool(step.tool)) return true
    if (step.tool === 'browser_click' || step.tool === 'browser_press') return true
    // A screenshot is evidence only when accompanied by a semantic assertion or
    // user note; diagnostic screenshots during URL guessing should not sanctify
    // an otherwise abandoned round.
    return false
  })
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

  if (isPureObservation(step.tool) || isRetryShapedStep(step)) return false

  return step.tool === 'browser_click'
    || step.tool === 'browser_press'
    || step.tool === 'browser_scroll'
    || step.tool.startsWith('browser_')
}

function isProtectedSemanticStep(step) {
  return step?.kind === 'checkpoint'
    || step?.when !== undefined
    || step?.expectation !== undefined
    || hasUserNotes(step)
}

function isPureObservation(tool) {
  return tool === 'browser_snapshot'
    || tool === 'browser_count'
    || tool === 'browser_read_page'
    || tool === 'browser_screenshot'
}

function isRetryShapedStep(step) {
  if (step?.kind !== 'tool') return false
  if (step.when !== undefined || step.expectation !== undefined || step.artifact !== undefined || hasUserNotes(step)) return false
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

function hasUserNotes(step) {
  if (typeof step?.notes !== 'string' || !step.notes.trim()) return false
  return step.notes
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .some(line => !/^(执行方法|execution method)[:：]/i.test(line))
}

function navigationIdentity(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    url.hash = ''
    // Query parameters frequently contain session/view state and are not a
    // durable identity for "returned to the declared target".
    url.search = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return text.split('#')[0].split('?')[0].replace(/\/$/, '')
  }
}

function findLastToolIndex(steps, tool) {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === 'tool' && steps[index]?.tool === tool) return index
  }
  return -1
}
