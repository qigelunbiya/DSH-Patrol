/**
 * Conservative cleanup used by the Dashboard "清理试错" action.
 *
 * Cleanup removes teaching noise; it is NOT a success declaration. After
 * cleanup we write metadata.flowHealth so a trace that lost critical causal
 * actions (for example credentials with no submit click) is visibly marked
 * incomplete instead of looking like a valid reusable flow.
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
    if (step.kind === 'tool' && step.teaching?.status === 'unverified') return false
    if (step.kind === 'checkpoint') return true
    if (referenced.has(step.id)) return true
    if (step.expectation !== undefined) return true
    if (step.when !== undefined) return true
    if (hasUserNotes(step)) return true

    if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') return false
    if (step.tool === 'browser_login_state' || step.tool === 'browser_detect_auth_challenge') return false

    if (step.tool === 'browser_read_page') return needsPageOutput && index === lastPageRead
    if (step.tool === 'browser_screenshot') return needsScreenshot && index === lastScreenshot

    if (step.tool === 'browser_wait') {
      const selector = typeof step.arguments?.selector === 'string' ? step.arguments.selector.trim() : ''
      if (!selector) return false
    }

    if (isTypingTool(step.tool) && isSupersededTypingStep(original, index, step)) return false
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

  updateFlowHealth(definition)

  return {
    removedSteps: original.length - definition.steps.length,
    originalSteps: original.length,
    finalSteps: definition.steps.length,
    flowHealth: definition.metadata?.flowHealth,
  }
}

function updateFlowHealth(definition) {
  const steps = Array.isArray(definition?.steps) ? definition.steps : []
  const warnings = []
  const lastInput = findLastMatchingIndex(steps, step => step?.kind === 'tool' && isTypingTool(step.tool))
  if (lastInput >= 0) {
    const advances = steps.slice(lastInput + 1).some(step =>
      step?.kind === 'tool' && ['browser_click', 'browser_press', 'browser_select', 'browser_navigate'].includes(step.tool))
    if (!advances) {
      warnings.push('输入步骤之后没有任何已记录的提交/点击/选择/导航动作；流程缺少关键因果步骤，不能视为可复用成功流程。')
    }
  }

  const unverified = steps.filter(step => step?.kind === 'tool' && step.tool === 'browser_click' && step.teaching?.status === 'unverified')
  if (unverified.length > 0) warnings.push(`仍包含 ${unverified.length} 个未验证点击。`)

  // If a task checklist is available, expose unmatched action categories as a
  // diagnosis instead of silently claiming cleanup succeeded.
  const checklist = Array.isArray(definition?.metadata?.taskChecklist) ? definition.metadata.taskChecklist : []
  if (checklist.length > 0) {
    const required = checklistActionCounts(checklist)
    const actual = flowActionCounts(steps)
    for (const key of Object.keys(required)) {
      if ((actual[key] || 0) < required[key]) warnings.push(`任务清单要求 ${required[key]} 个${actionLabel(key)}，清理后仅有 ${actual[key] || 0} 个。`)
    }
  }

  if (!definition.metadata || typeof definition.metadata !== 'object') definition.metadata = {}
  definition.metadata.flowHealth = {
    complete: warnings.length === 0,
    warnings,
    checkedAt: new Date().toISOString(),
  }
}

function checklistActionCounts(checklist) {
  const counts = { navigate: 0, click: 0, type: 0, read: 0, screenshot: 0 }
  for (const raw of checklist) {
    const text = String(raw || '')
    if (/(访问|导航|navigate|visit|go to)/i.test(text)) counts.navigate += 1
    if (/(点击|点开|打开.*(?:入口|菜单|工单|详情)|click|open .*?(?:menu|item|detail))/i.test(text)) counts.click += 1
    if (/(输入|填写|填入|type|enter|fill)/i.test(text)) counts.type += 1
    if (/(读取|整理|查看.*(?:信息|列表|内容)|read|summar|inspect.*(?:list|content|info))/i.test(text)) counts.read += 1
    if (/(截图|screenshot|capture)/i.test(text)) counts.screenshot += 1
  }
  return counts
}

function flowActionCounts(steps) {
  const counts = { navigate: 0, click: 0, type: 0, read: 0, screenshot: 0 }
  for (const step of steps) {
    if (step?.kind !== 'tool') continue
    if (step.tool === 'browser_navigate') counts.navigate += 1
    else if (step.tool === 'browser_click' || step.tool === 'browser_press' || step.tool === 'browser_select') counts.click += 1
    else if (isTypingTool(step.tool)) counts.type += 1
    else if (step.tool === 'browser_read_page') counts.read += 1
    else if (step.tool === 'browser_screenshot') counts.screenshot += 1
  }
  return counts
}

function actionLabel(key) {
  return ({ navigate: '导航步骤', click: '点击/打开步骤', type: '输入步骤', read: '读取/整理步骤', screenshot: '截图步骤' })[key] || key
}

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

  for (let cursor = 1; cursor < navs.length; cursor += 1) {
    const current = navs[cursor]
    const previous = navs[cursor - 1]
    if (current.identity !== target || previous.identity === target) continue
    const round = steps.slice(previous.index, current.index)
    if (roundHasBusinessEvidence(round)) continue
    for (let index = previous.index; index < current.index; index += 1) discarded.add(index)
  }

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
    if (step.teaching?.status === 'unverified') return false
    if (step.when !== undefined || step.expectation !== undefined || step.teaching?.status === 'verified' || hasUserNotes(step)) return true
    if (isTypingTool(step.tool)) return true
    if (step.tool === 'browser_click' || step.tool === 'browser_press') return true
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
    || step?.teaching?.status === 'verified'
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
  if (step.when !== undefined || step.expectation !== undefined || step.teaching?.status === 'verified' || step.artifact !== undefined || hasUserNotes(step)) return false
  if (step.tool === 'browser_detect_auth_challenge' || step.tool === 'browser_login_state' || step.tool === 'browser_wait') return true
  if (step.tool !== 'browser_click' && step.tool !== 'browser_press') return false

  const text = [step.name, step.locator?.text, step.arguments?.selector, step.arguments?.key]
    .filter(value => typeof value === 'string').join(' ')
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

function findLastMatchingIndex(steps, predicate) {
  for (let index = steps.length - 1; index >= 0; index -= 1) if (predicate(steps[index])) return index
  return -1
}
