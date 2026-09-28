/**
 * Conservative cleanup used by the Dashboard "清理试错" action.
 *
 * Cleanup may remove diagnostics/retries, but it must never infer that a
 * user-required business step is expendable merely because it is a later
 * navigation or an unscoped scroll. The persisted task checklist is the
 * business contract; cleanup aligns the current Runbook to that contract first
 * and protects the best matching reusable step for each checklist item.
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
  const checklist = Array.isArray(definition?.metadata?.taskChecklist) ? definition.metadata.taskChecklist : []
  const requiredActions = checklistActionCounts(checklist)
  const alignment = alignChecklistSteps(checklist, original)
  const protectedIndexes = new Set(alignment.matches.map(item => item.stepIndex))
  const pageReadIndexes = new Set(findLastToolIndices(original, 'browser_read_page', Math.max(needsPageOutput ? 1 : 0, requiredActions.read)))
  const screenshotIndexes = new Set([
    ...findLastToolIndices(original, 'browser_screenshot', Math.max(needsScreenshot ? 1 : 0, requiredActions.screenshot)),
    ...findLastToolIndices(original, 'desktop_screenshot', Math.max(needsScreenshot ? 1 : 0, requiredActions.screenshot)),
  ])
  const abandonedNavigationSteps = findAbandonedNavigationSteps(definition, original, protectedIndexes)

  const kept = original.filter((step, index) => {
    if (!step) return false
    if (step.kind === 'tool' && step.teaching?.status === 'unverified') return false
    if (step.kind === 'checkpoint') return true

    // A checklist-aligned business step is protected before any heuristic
    // cleanup. This is the key invariant that prevents "访问第二个系统" and
    // "向下滑动找到目标" from being mistaken for recovery noise.
    if (protectedIndexes.has(index)) return true
    if (abandonedNavigationSteps.has(index)) return false
    if (referenced.has(step.id)) return true
    if (step.expectation !== undefined) return true
    if (step.when !== undefined) return true
    if (hasUserNotes(step)) return true

    if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') return false
    if (step.tool === 'browser_login_state' || step.tool === 'browser_detect_auth_challenge') return false

    if (step.tool === 'browser_read_page') return pageReadIndexes.has(index)
    if (step.tool === 'browser_screenshot' || step.tool === 'desktop_screenshot') return screenshotIndexes.has(index)

    if (step.tool === 'browser_wait') {
      const selector = typeof step.arguments?.selector === 'string' ? step.arguments.selector.trim() : ''
      if (!selector) return false
    }

    if (step.tool === 'browser_scroll') {
      const selector = typeof step.arguments?.selector === 'string' ? step.arguments.selector.trim() : ''
      if (!selector) return false
    }

    if (isTypingTool(step.tool) && isSupersededTypingStep(original, index, step)) return false
    if (isRetryShapedStep(step) && hasLaterEquivalentRetryBeforeBoundary(original, index, step)) return false

    return true
  })

  renumberSteps(definition, kept)
  updateFlowHealth(definition)

  return {
    removedSteps: original.length - definition.steps.length,
    originalSteps: original.length,
    finalSteps: definition.steps.length,
    flowHealth: definition.metadata?.flowHealth,
    checklistCoverage: assessChecklistCoverage(definition, definition.steps),
  }
}

/**
 * Semantic, ordered checklist coverage used by cleanup hardening and tests.
 * It is deliberately stricter than raw action counts: four arbitrary clicks do
 * not satisfy four different business click requirements.
 */
export function assessChecklistCoverage(definition, steps = definition?.steps) {
  const checklist = Array.isArray(definition?.metadata?.taskChecklist) ? definition.metadata.taskChecklist : []
  const actualSteps = Array.isArray(steps) ? steps : []
  const alignment = alignChecklistSteps(checklist, actualSteps)
  return {
    required: checklist.length,
    matched: alignment.matches.length,
    missingItems: alignment.missingItems,
    matches: alignment.matches.map(item => ({
      checklistIndex: item.checklistIndex,
      stepIndex: item.stepIndex,
      checklistItem: checklist[item.checklistIndex],
      stepId: actualSteps[item.stepIndex]?.id,
      stepName: actualSteps[item.stepIndex]?.name,
      score: item.score,
    })),
  }
}

export function stepMatchesChecklistItem(step, item) {
  return semanticMatchScore(step, String(item || '')) >= MIN_SEMANTIC_SCORE
}

function updateFlowHealth(definition) {
  const steps = Array.isArray(definition?.steps) ? definition.steps : []
  const warnings = []
  const lastInput = findLastMatchingIndex(steps, step => step?.kind === 'tool' && isTypingTool(step.tool))
  if (lastInput >= 0) {
    const advances = steps.slice(lastInput + 1).some(step =>
      step?.kind === 'tool'
      && ['browser_click', 'browser_visual_click', 'browser_press', 'browser_select', 'browser_navigate',
        'desktop_click_target', 'desktop_click_ocr_text', 'desktop_click_coordinates', 'desktop_press',
        'desktop_press_target', 'desktop_hotkey', 'desktop_paste', 'desktop_paste_target',
        'desktop_drag', 'desktop_launch_app', 'desktop_open_path', 'desktop_activate_window'].includes(step.tool))
    if (!advances) {
      warnings.push('输入步骤之后没有任何已记录的提交/点击/选择/导航动作；流程缺少关键因果步骤，不能视为可复用成功流程。')
    }
  }

  const unverified = steps.filter(step =>
    step?.kind === 'tool'
    && ['browser_click', 'browser_visual_click'].includes(step.tool)
    && step.teaching?.status === 'unverified')
  if (unverified.length > 0) warnings.push(`仍包含 ${unverified.length} 个未验证点击。`)

  const checklist = Array.isArray(definition?.metadata?.taskChecklist) ? definition.metadata.taskChecklist : []
  if (checklist.length > 0) {
    const coverage = assessChecklistCoverage(definition, steps)
    if (coverage.missingItems.length > 0) {
      warnings.push(`任务清单缺少可复用步骤：${coverage.missingItems.join('；')}。`)
    }

    const required = checklistActionCounts(checklist)
    const actual = flowActionCounts(steps)
    for (const key of Object.keys(required)) {
      if ((actual[key] || 0) < required[key]) {
        warnings.push(`任务清单要求 ${required[key]} 个${actionLabel(key)}，清理后仅有 ${actual[key] || 0} 个。`)
      }
    }
  }

  if (!definition.metadata || typeof definition.metadata !== 'object') definition.metadata = {}
  definition.metadata.flowHealth = {
    complete: warnings.length === 0,
    warnings: [...new Set(warnings)],
    checkedAt: new Date().toISOString(),
  }
}

const CHECKLIST_ACTIONS = ['navigate', 'click', 'type', 'read', 'screenshot', 'wait']
const MIN_SEMANTIC_SCORE = 30
const GENERIC_TOKENS = new Set([
  '访问', '导航', '打开', '点击', '点开', '进入', '选择', '执行', '查看', '读取', '整理',
  '输入', '填写', '填入', '截图', '页面', '内容', '信息', '当前', '目标', '等待', '加载',
  '按钮', '链接', '搜索', '结果', '系统', '任务', '刷新', '滚动', '滑动',
  'visit', 'navigate', 'open', 'click', 'select', 'execute', 'view', 'read', 'inspect',
  'type', 'fill', 'capture', 'screenshot', 'page', 'content', 'current', 'target', 'wait',
  'load', 'button', 'link', 'search', 'result', 'system', 'task', 'refresh', 'scroll',
])

function alignChecklistSteps(checklist, steps) {
  if (!Array.isArray(checklist) || checklist.length === 0 || !Array.isArray(steps) || steps.length === 0) {
    return {
      matches: [],
      missingItems: Array.isArray(checklist) ? checklist.map(item => String(item || '')) : [],
    }
  }

  const m = checklist.length
  const n = steps.length
  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  const choice = Array.from({ length: m + 1 }, () => Array(n + 1).fill('none'))

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      let best = dp[i][j - 1]
      let selected = 'skip-step'
      if (dp[i - 1][j] > best) {
        best = dp[i - 1][j]
        selected = 'skip-item'
      }

      const score = semanticMatchScore(steps[j - 1], String(checklist[i - 1] || ''))
      if (score >= MIN_SEMANTIC_SCORE) {
        // Match count dominates semantic score. A tiny later-step preference
        // makes repeated teaching rounds converge on the latest successful
        // equivalent action instead of the first failed attempt.
        const matchValue = dp[i - 1][j - 1] + 100000 + score * 10 + j
        if (matchValue >= best) {
          best = matchValue
          selected = 'match'
        }
      }
      dp[i][j] = best
      choice[i][j] = selected
    }
  }

  const matches = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    const selected = choice[i][j]
    if (selected === 'match') {
      const score = semanticMatchScore(steps[j - 1], String(checklist[i - 1] || ''))
      matches.push({ checklistIndex: i - 1, stepIndex: j - 1, score })
      i -= 1
      j -= 1
    } else if (selected === 'skip-item') {
      i -= 1
    } else {
      j -= 1
    }
  }
  matches.reverse()
  const matchedChecklist = new Set(matches.map(item => item.checklistIndex))
  return {
    matches,
    missingItems: checklist
      .map((item, index) => ({ item: String(item || ''), index }))
      .filter(item => !matchedChecklist.has(item.index))
      .map(item => item.item),
  }
}

function semanticMatchScore(step, checklistItem) {
  if (!step || step.kind !== 'tool') return 0
  const item = normalizeSemanticText(checklistItem)
  if (!item) return 0

  const action = flowActionForStep(step)
  const expectedAction = checklistActionForText(item)
  let score = 0
  if (expectedAction !== 'other') {
    if (action === expectedAction) score += 22
    else if (!compatibleActions(action, expectedAction)) score -= 28
  }

  const taskHint = normalizeSemanticText(step.taskHint)
  const name = normalizeSemanticText(step.name)
  const locator = normalizeSemanticText(step.locator?.text)
  const targetHint = normalizeSemanticText(step.arguments?.targetHint)
  const learnedText = normalizeSemanticText(step.arguments?.learnedLocatorText)
  const candidates = [taskHint, name, locator, targetHint, learnedText].filter(Boolean)

  for (const candidate of candidates) {
    if (candidate === item) score = Math.max(score, 180)
    else if (candidate.includes(item) || item.includes(candidate)) {
      const min = Math.min(candidate.length, item.length)
      if (min >= 2) score = Math.max(score, 90 + Math.min(40, min))
    }
  }

  const itemTokens = businessTokens(item)
  const stepTokens = businessTokens(candidates.join(' '))
  let overlap = 0
  for (const token of itemTokens) {
    if (stepTokens.has(token)) overlap += Math.min(10, token.length)
  }
  score += overlap

  const itemConcepts = businessConcepts(item)
  const stepConcepts = businessConcepts(candidates.join(' '))
  for (const concept of itemConcepts) {
    if (stepConcepts.has(concept)) score += 18
  }

  if (step.tool === 'browser_navigate' && typeof step.arguments?.url === 'string') {
    const urlText = normalizeSemanticText(step.arguments.url)
    if (item && urlText.includes(item)) score += 40
  }
  return score
}

function compatibleActions(actual, expected) {
  if (actual === expected) return true
  if (expected === 'click' && actual === 'navigate') return false
  if (expected === 'navigate' && actual === 'click') return false
  return false
}

function normalizeSemanticText(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '').replace(/[，。；、,:：;()（）【】\[\]"']/g, '')
    : ''
}

function businessTokens(value) {
  const text = normalizeSemanticText(value)
  const out = new Set()
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._:-]{1,}/g)) {
    if (!GENERIC_TOKENS.has(match[0])) out.add(match[0])
  }
  const cjkRuns = text.match(/[\u3400-\u9fff]{2,}/g) || []
  for (const run of cjkRuns) {
    for (let size = 2; size <= Math.min(5, run.length); size += 1) {
      for (let index = 0; index + size <= run.length; index += 1) {
        const token = run.slice(index, index + size)
        if (!GENERIC_TOKENS.has(token)) out.add(token)
      }
    }
  }
  return out
}

function businessConcepts(value) {
  const text = normalizeSemanticText(value)
  const concepts = new Set()
  const add = (name, pattern) => {
    if (pattern.test(text)) concepts.add(name)
  }
  add('entry', /(入口|登录页|登陆页|loginpage|signinpage|首页入口)/i)
  add('account', /(用户名|用户账号|账号|账户|帐号|username|useraccount|account)/i)
  add('secret', /(密码|口令|password|passcode)/i)
  add('submit-login', /(登录|登陆|提交|login|signin|submit)/i)
  add('search-field', /(搜索栏|搜索框|搜索输入框|searchbox|searchfield)/i)
  add('search-submit', /(执行搜索|搜索按钮|googlesearch|submitsearch)/i)
  add('close-filter', /(关闭.*(?:任务|筛选|过滤)|移除.*(?:任务|筛选|过滤)|remove.*(?:filter|task)|close.*(?:filter|task))/i)
  return concepts
}

function checklistActionCounts(checklist) {
  const counts = { navigate: 0, click: 0, type: 0, read: 0, screenshot: 0, wait: 0 }
  for (const raw of checklist) {
    const action = checklistActionForText(String(raw || ''))
    if (action !== 'other') counts[action] += 1
  }
  return counts
}

function checklistActionForText(value) {
  const text = String(value || '')
  if (/(截图|screenshot|capture)/i.test(text)) return 'screenshot'
  if (/(输入|填写|填入|type|enter|fill|clipboard)/i.test(text)) return 'type'
  if (/(读取|整理|查看.*(?:信息|列表|内容)|识别|ocr|read|summar|inspect.*(?:list|content|info))/i.test(text)) return 'read'
  if (/(等待|等到|直到|直至|滚动|滑动|向上滑|向下滑|wait(?:\s+(?:for|until))?|scroll)/i.test(text)) return 'wait'
  if (/(访问|导航|刷新|重载|重新加载|navigate|visit|go to|refresh|reload)/i.test(text)) return 'navigate'
  if (/(点击|点开|进入|选择|发送|关闭|删除|粘贴|执行搜索|打开.*(?:入口|菜单|工单|详情)|click|select|send|close|delete|paste|search)/i.test(text)) return 'click'
  return 'other'
}

function flowActionCounts(steps) {
  const counts = { navigate: 0, click: 0, type: 0, read: 0, screenshot: 0, wait: 0 }
  for (const step of steps) {
    const action = flowActionForStep(step)
    if (action) counts[action] += 1
  }
  return counts
}

function flowActionForStep(step) {
  if (step?.kind !== 'tool') return undefined
  if (step.tool === 'browser_navigate'
    || step.tool === 'desktop_launch_app'
    || step.tool === 'desktop_open_path'
    || step.tool === 'desktop_activate_window') return 'navigate'
  if (step.tool === 'browser_click'
    || step.tool === 'browser_visual_click'
    || step.tool === 'browser_press'
    || step.tool === 'browser_select'
    || step.tool === 'desktop_click_target'
    || step.tool === 'desktop_click_ocr_text'
    || step.tool === 'desktop_click_coordinates'
    || step.tool === 'desktop_press'
    || step.tool === 'desktop_press_target'
    || step.tool === 'desktop_hotkey'
    || step.tool === 'desktop_paste'
    || step.tool === 'desktop_paste_target'
    || step.tool === 'desktop_drag'
    || step.tool === 'desktop_close_window'
    || step.tool === 'desktop_delete_path') return 'click'
  if (isTypingTool(step.tool)
    || step.tool === 'desktop_set_clipboard_text'
    || step.tool === 'desktop_set_clipboard_files') return 'type'
  if (step.tool === 'browser_read_page' || step.tool === 'desktop_snapshot' || step.tool === 'desktop_ocr') return 'read'
  if (step.tool === 'browser_screenshot' || step.tool === 'desktop_screenshot') return 'screenshot'
  if (step.tool === 'browser_wait' || step.tool === 'browser_scroll'
    || step.tool === 'desktop_wait' || step.tool === 'desktop_wait_for_target') return 'wait'
  return undefined
}

function actionLabel(key) {
  return ({
    navigate: '导航步骤',
    click: '点击/打开步骤',
    type: '输入步骤',
    read: '读取/整理步骤',
    screenshot: '截图步骤',
    wait: '等待/滚动步骤',
  })[key] || key
}

function findAbandonedNavigationSteps(definition, steps, protectedIndexes = new Set()) {
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
    for (let index = previous.index; index < current.index; index += 1) {
      if (!protectedIndexes.has(index)) discarded.add(index)
    }
  }

  if (String(definition?.status || '').toLowerCase() === 'draft' && navs.length > 0) {
    const last = navs[navs.length - 1]
    if (last.identity !== target) {
      const round = steps.slice(last.index)
      if (!roundHasBusinessEvidence(round) && sameNavigationOrigin(last.identity, target)) {
        for (let index = last.index; index < steps.length; index += 1) {
          if (!protectedIndexes.has(index)) discarded.add(index)
        }
      }
    }
  }
  return discarded
}

function sameNavigationOrigin(left, right) {
  try {
    return new URL(left).origin === new URL(right).origin
  } catch {
    return true
  }
}

function roundHasBusinessEvidence(steps) {
  return steps.some(step => {
    if (!step) return false
    if (step.kind === 'checkpoint') return true
    if (step.teaching?.status === 'unverified') return false
    if (step.when !== undefined || step.expectation !== undefined || step.teaching?.status === 'verified' || hasUserNotes(step)) return true
    if (isTypingTool(step.tool)) return true
    if (['browser_click', 'browser_visual_click', 'browser_press', 'browser_scroll'].includes(step.tool)) return true
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
    || step.tool === 'browser_visual_click'
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
  if (!['browser_click', 'browser_visual_click', 'browser_press'].includes(step.tool)) return false

  const text = [step.name, step.locator?.text, step.arguments?.selector, step.arguments?.key, step.arguments?.targetHint]
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
    if (next.kind === 'checkpoint'
      || next.tool === 'browser_navigate'
      || next.tool === 'browser_click'
      || next.tool === 'browser_visual_click'
      || next.tool === 'browser_press') return false
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
    || tool === 'desktop_type_text'
    || tool === 'desktop_type_target'
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

function findLastToolIndices(steps, tool, count) {
  if (!Number.isFinite(count) || count <= 0) return []
  const indexes = []
  for (let index = steps.length - 1; index >= 0 && indexes.length < count; index -= 1) {
    if (steps[index]?.kind === 'tool' && steps[index]?.tool === tool) indexes.push(index)
  }
  return indexes.reverse()
}

function findLastMatchingIndex(steps, predicate) {
  for (let index = steps.length - 1; index >= 0; index -= 1) if (predicate(steps[index])) return index
  return -1
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
