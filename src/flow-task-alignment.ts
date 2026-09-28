import type { InspectionDefinition, InspectionStep, ToolStep } from './types.js'

export type ChecklistAction = 'navigate' | 'click' | 'type' | 'read' | 'screenshot' | 'wait' | 'other'

export interface ChecklistStepMatch {
  checklistIndex: number
  stepIndex: number
  score: number
}

export interface ChecklistAlignment {
  matches: ChecklistStepMatch[]
  missingItems: string[]
}

export interface ChecklistRequirementMatch extends ChecklistStepMatch {
  action: ChecklistAction
  requirementIndex: number
}

export interface ChecklistRequirementAlignment {
  matches: ChecklistRequirementMatch[]
  missing: Array<{ checklistIndex: number; action: ChecklistAction }>
}

const MIN_SEMANTIC_SCORE = 30
const MIN_REQUIREMENT_SCORE = 28
const GENERIC_TOKENS = new Set([
  '访问', '导航', '打开', '点击', '点开', '进入', '选择', '执行', '查看', '读取', '整理',
  '输入', '填写', '填入', '截图', '页面', '内容', '信息', '当前', '目标', '等待', '加载',
  '按钮', '链接', '搜索', '结果', '系统', '任务', '刷新', '滚动', '滑动',
  'visit', 'navigate', 'open', 'click', 'select', 'execute', 'view', 'read', 'inspect',
  'type', 'fill', 'capture', 'screenshot', 'page', 'content', 'current', 'target', 'wait',
  'load', 'button', 'link', 'search', 'result', 'system', 'task', 'refresh', 'scroll',
])

const ACTION_PATTERNS: Array<{ action: Exclude<ChecklistAction, 'other'>; pattern: RegExp }> = [
  { action: 'screenshot', pattern: /(截图|screenshot|capture)/i },
  { action: 'type', pattern: /(输入|填写|填入|type|enter|fill|clipboard)/i },
  { action: 'read', pattern: /(读取|整理|查看.*(?:信息|列表|内容)|识别|ocr|read|summar|inspect.*(?:list|content|info))/i },
  { action: 'wait', pattern: /(等待|等到|直到|直至|滚动|滑动|上滑|下滑|向上滑|向下滑|wait(?:\s+(?:for|until))?|scroll)/i },
  { action: 'navigate', pattern: /(访问|导航|刷新|重载|重新加载|navigate|visit|go to|refresh|reload)/i },
  { action: 'click', pattern: /(点击|点开|进入|选择|发送|关闭|删除|粘贴|执行搜索|打开.*(?:入口|菜单|工单|详情)|click|select|send|close|delete|paste|search)/i },
]

export function alignChecklistSteps(
  checklist: readonly string[],
  steps: readonly InspectionStep[],
): ChecklistAlignment {
  if (checklist.length === 0 || steps.length === 0) {
    return { matches: [], missingItems: [...checklist] }
  }

  const m = checklist.length
  const n = steps.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  const choice: string[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill('none'))

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      let best = dp[i]![j - 1]!
      let selected = 'skip-step'
      if (dp[i - 1]![j]! > best) {
        best = dp[i - 1]![j]!
        selected = 'skip-item'
      }

      const score = semanticChecklistMatchScore(steps[j - 1]!, checklist[i - 1]!)
      if (score >= MIN_SEMANTIC_SCORE) {
        const matchValue = dp[i - 1]![j - 1]! + 100000 + score * 10 + j
        if (matchValue >= best) {
          best = matchValue
          selected = 'match'
        }
      }
      dp[i]![j] = best
      choice[i]![j] = selected
    }
  }

  const matches: ChecklistStepMatch[] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    const selected = choice[i]![j]!
    if (selected === 'match') {
      matches.push({
        checklistIndex: i - 1,
        stepIndex: j - 1,
        score: semanticChecklistMatchScore(steps[j - 1]!, checklist[i - 1]!),
      })
      i -= 1
      j -= 1
    } else if (selected === 'skip-item') {
      i -= 1
    } else {
      j -= 1
    }
  }
  matches.reverse()
  const matched = new Set(matches.map(item => item.checklistIndex))
  return {
    matches,
    missingItems: checklist.filter((_item, index) => !matched.has(index)),
  }
}

/**
 * Expand a human checklist item into the ordered replay actions it actually
 * requires. A single business item may legitimately need multiple low-level
 * steps, e.g. "输入关键字并执行搜索" => type + click/press, or
 * "向下滑动找到伶仃洋并点击" => wait/scroll + click.
 */
export function checklistActionsForText(value: string): ChecklistAction[] {
  const text = String(value || '')
  const found: Array<{ action: ChecklistAction; index: number; order: number }> = []
  ACTION_PATTERNS.forEach((entry, order) => {
    const flags = entry.pattern.flags.replace('g', '')
    const match = new RegExp(entry.pattern.source, flags).exec(text)
    if (match?.index !== undefined) found.push({ action: entry.action, index: match.index, order })
  })
  if (found.length === 0) return ['other']
  found.sort((left, right) => left.index - right.index || left.order - right.order)
  return [...new Set(found.map(item => item.action))]
}

/**
 * Align atomic checklist requirements to the teaching route. Matching is
 * monotonic and strongly prefers covering more requirements; when two
 * candidates are otherwise equivalent the later successful teaching action is
 * preferred, which naturally replaces earlier retries/false starts.
 */
export function alignChecklistRequirements(
  checklist: readonly string[],
  steps: readonly InspectionStep[],
): ChecklistRequirementAlignment {
  const requirements = checklist.flatMap((item, checklistIndex) =>
    checklistActionsForText(item).map(action => ({ checklistIndex, action, item })),
  )
  if (requirements.length === 0 || steps.length === 0) {
    return {
      matches: [],
      missing: requirements.map(({ checklistIndex, action }) => ({ checklistIndex, action })),
    }
  }

  const m = requirements.length
  const n = steps.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0))
  const choice: string[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill('none'))

  for (let i = 1; i <= m; i += 1) {
    for (let j = 1; j <= n; j += 1) {
      let best = dp[i]![j - 1]!
      let selected = 'skip-step'
      if (dp[i - 1]![j]! > best) {
        best = dp[i - 1]![j]!
        selected = 'skip-requirement'
      }

      const requirement = requirements[i - 1]!
      const step = steps[j - 1]!
      const score = semanticChecklistRequirementScore(step, requirement.item, requirement.action)
      if (score >= MIN_REQUIREMENT_SCORE) {
        // Requirement coverage dominates, then prefer the later successful
        // attempt over an earlier retry. Semantic relevance remains a gate,
        // but minor wording differences must not keep stale retries alive.
        const matchValue = dp[i - 1]![j - 1]! + 100000 + score * 10 + j * 300
        if (matchValue >= best) {
          best = matchValue
          selected = 'match'
        }
      }
      dp[i]![j] = best
      choice[i]![j] = selected
    }
  }

  const matches: ChecklistRequirementMatch[] = []
  let i = m
  let j = n
  while (i > 0 && j > 0) {
    const selected = choice[i]![j]!
    if (selected === 'match') {
      const requirement = requirements[i - 1]!
      matches.push({
        checklistIndex: requirement.checklistIndex,
        action: requirement.action,
        requirementIndex: i - 1,
        stepIndex: j - 1,
        score: semanticChecklistRequirementScore(steps[j - 1]!, requirement.item, requirement.action),
      })
      i -= 1
      j -= 1
    } else if (selected === 'skip-requirement') {
      i -= 1
    } else {
      j -= 1
    }
  }
  matches.reverse()
  const matchedRequirementIndexes = new Set(matches.map(match => match.requirementIndex))
  return {
    matches,
    missing: requirements
      .map((requirement, requirementIndex) => ({ ...requirement, requirementIndex }))
      .filter(requirement => !matchedRequirementIndexes.has(requirement.requirementIndex))
      .map(({ checklistIndex, action }) => ({ checklistIndex, action })),
  }
}

export function semanticChecklistCoverageWarnings(
  definition: InspectionDefinition,
  steps: readonly InspectionStep[],
): string[] {
  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0) return []
  const alignment = alignChecklistRequirements(checklist, steps)
  const missingChecklistIndexes = new Set(
    alignment.missing
      .filter(item => item.action !== 'other')
      .map(item => item.checklistIndex),
  )
  const actionableMissing = checklist.filter((_item, index) => missingChecklistIndexes.has(index))
  return actionableMissing.length === 0
    ? []
    : [`任务清单缺少可复用步骤：${actionableMissing.join('；')}。`]
}

export function bindChecklistTasksSemantically(definition: InspectionDefinition): void {
  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0 || definition.steps.length === 0) return

  const alignment = alignChecklistRequirements(checklist, definition.steps)
  const matchByStep = new Map(alignment.matches.map(match => [match.stepIndex, match] as const))

  definition.steps = definition.steps.map((step, index) => {
    if (step.kind !== 'tool') return step
    const match = matchByStep.get(index)
    if (match === undefined) return step
    const task = checklist[match.checklistIndex]!

    if (step.taskHint !== undefined) {
      if (normalizeSemanticText(step.taskHint) === normalizeSemanticText(task)) return step

      const hintedChecklistIndex = checklistIndexForExistingHint(checklist, step.taskHint)
      if (hintedChecklistIndex < 0 || hintedChecklistIndex === match.checklistIndex) return step
    }

    return { ...step, taskHint: task }
  })
}

function checklistIndexForExistingHint(checklist: readonly string[], hint: string): number {
  const normalizedHint = normalizeSemanticText(hint)
  if (!normalizedHint) return -1
  for (let index = 0; index < checklist.length; index += 1) {
    const item = normalizeSemanticText(checklist[index])
    if (!item) continue
    if (item === normalizedHint) return index
    const min = Math.min(item.length, normalizedHint.length)
    if (min >= 6 && (item.includes(normalizedHint) || normalizedHint.includes(item))) return index
  }
  return -1
}

export function stepMatchesChecklistItem(step: InspectionStep, item: string): boolean {
  return semanticChecklistMatchScore(step, item) >= MIN_SEMANTIC_SCORE
}

export function checklistActionForText(value: string): ChecklistAction {
  return checklistActionsForText(value)[0] ?? 'other'
}

export function flowActionForStep(step: ToolStep): ChecklistAction {
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
  if (step.tool === 'browser_wait' || step.tool === 'browser_scroll'
    || step.tool === 'desktop_wait' || step.tool === 'desktop_wait_for_target') return 'wait'
  if (step.tool === 'browser_screenshot' || step.tool === 'desktop_screenshot') return 'screenshot'
  return 'other'
}

export function semanticChecklistMatchScore(step: InspectionStep, checklistItem: string): number {
  if (step.kind !== 'tool') return 0
  const item = normalizeSemanticText(checklistItem)
  if (!item) return 0

  const action = flowActionForStep(step)
  const expectedActions = new Set(checklistActionsForText(checklistItem))
  let score = 0
  if (!expectedActions.has('other')) {
    if (expectedActions.has(action)) score += 22
    else if (action !== 'other') score -= 28
  }

  return score + semanticTextScore(step, item)
}

function semanticChecklistRequirementScore(
  step: InspectionStep,
  checklistItem: string,
  requiredAction: ChecklistAction,
): number {
  if (step.kind !== 'tool') return 0
  const action = flowActionForStep(step)
  if (requiredAction !== 'other' && action !== requiredAction) return 0
  const base = requiredAction === 'other' ? 0 : 22
  return base + semanticTextScore(step, normalizeSemanticText(checklistItem))
}

function semanticTextScore(step: ToolStep, item: string): number {
  const candidates = [
    normalizeSemanticText(step.taskHint),
    normalizeSemanticText(step.name),
    normalizeSemanticText(step.locator?.text),
    normalizeSemanticText(stringArg(step, 'targetHint')),
    normalizeSemanticText(stringArg(step, 'learnedLocatorText')),
    normalizeSemanticText(stringArg(step, 'expectedVisualText')),
  ].filter(Boolean)

  let score = 0
  for (const candidate of candidates) {
    if (candidate === item) score = Math.max(score, 180)
    else if (candidate.includes(item) || item.includes(candidate)) {
      const min = Math.min(candidate.length, item.length)
      if (min >= 2) score = Math.max(score, 90 + Math.min(40, min))
    }
  }

  const itemTokens = businessTokens(item)
  const stepTokens = businessTokens(candidates.join(' '))
  for (const token of itemTokens) {
    if (stepTokens.has(token)) score += Math.min(10, token.length)
  }

  const itemConcepts = businessConcepts(item)
  const stepConcepts = businessConcepts(candidates.join(' '))
  for (const concept of itemConcepts) {
    if (stepConcepts.has(concept)) score += 18
  }
  return score
}

function businessConcepts(value: string): Set<string> {
  const text = normalizeSemanticText(value)
  const concepts = new Set<string>()
  const add = (name: string, pattern: RegExp) => {
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

function stringArg(step: ToolStep, key: string): string {
  const value = step.arguments[key]
  return typeof value === 'string' ? value : ''
}

function normalizeSemanticText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '').replace(/[，。；、,:：;()（）【】\[\]\"']/g, '')
    : ''
}

function businessTokens(value: string): Set<string> {
  const text = normalizeSemanticText(value)
  const out = new Set<string>()
  for (const match of text.matchAll(/[a-z0-9][a-z0-9._:-]{1,}/g)) {
    if (!GENERIC_TOKENS.has(match[0])) out.add(match[0])
  }
  const cjkRuns = text.match(/[\u3400-\u9fff]{2,}/g) ?? []
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

function isTypingTool(tool: string): boolean {
  return tool === 'browser_type'
    || tool === 'browser_type_focused'
    || tool === 'browser_type_credential'
    || tool === 'browser_type_transient_ref'
    || tool === 'browser_type_totp_profile'
    || tool === 'desktop_type_text'
    || tool === 'desktop_type_target'
}
