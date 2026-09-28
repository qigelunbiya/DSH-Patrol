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

const MIN_SEMANTIC_SCORE = 30
const GENERIC_TOKENS = new Set([
  '访问', '导航', '打开', '点击', '点开', '进入', '选择', '执行', '查看', '读取', '整理',
  '输入', '填写', '填入', '截图', '页面', '内容', '信息', '当前', '目标', '等待', '加载',
  '按钮', '链接', '搜索', '结果', '系统', '任务', '刷新', '滚动', '滑动',
  'visit', 'navigate', 'open', 'click', 'select', 'execute', 'view', 'read', 'inspect',
  'type', 'fill', 'capture', 'screenshot', 'page', 'content', 'current', 'target', 'wait',
  'load', 'button', 'link', 'search', 'result', 'system', 'task', 'refresh', 'scroll',
])

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

export function semanticChecklistCoverageWarnings(
  definition: InspectionDefinition,
  steps: readonly InspectionStep[],
): string[] {
  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0) return []
  const alignment = alignChecklistSteps(checklist, steps)
  const actionableMissing = alignment.missingItems.filter(item => checklistActionForText(item) !== 'other')
  return actionableMissing.length === 0
    ? []
    : [`任务清单缺少可复用步骤：${actionableMissing.join('；')}。`]
}

export function bindChecklistTasksSemantically(definition: InspectionDefinition): void {
  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0 || definition.steps.length === 0) return

  const alignment = alignChecklistSteps(checklist, definition.steps)
  const taskByStep = new Map<number, string>()
  for (const match of alignment.matches) {
    taskByStep.set(match.stepIndex, checklist[match.checklistIndex]!)
  }

  definition.steps = definition.steps.map((step, index) => {
    if (step.kind !== 'tool') return step
    const task = taskByStep.get(index)
    if (task === undefined) return step
    if (step.taskHint === task) return step
    return { ...step, taskHint: task }
  })
}

export function stepMatchesChecklistItem(step: InspectionStep, item: string): boolean {
  return semanticChecklistMatchScore(step, item) >= MIN_SEMANTIC_SCORE
}

export function checklistActionForText(value: string): ChecklistAction {
  const text = String(value || '')
  if (/(截图|screenshot|capture)/i.test(text)) return 'screenshot'
  if (/(输入|填写|填入|type|enter|fill|clipboard)/i.test(text)) return 'type'
  if (/(读取|整理|查看.*(?:信息|列表|内容)|识别|ocr|read|summar|inspect.*(?:list|content|info))/i.test(text)) return 'read'
  if (/(等待|等到|直到|直至|滚动|滑动|向上滑|向下滑|wait(?:\s+(?:for|until))?|scroll)/i.test(text)) return 'wait'
  if (/(访问|导航|刷新|重载|重新加载|navigate|visit|go to|refresh|reload)/i.test(text)) return 'navigate'
  if (/(点击|点开|进入|选择|发送|关闭|删除|粘贴|执行搜索|打开.*(?:入口|菜单|工单|详情)|click|select|send|close|delete|paste|search)/i.test(text)) return 'click'
  return 'other'
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
  const expectedAction = checklistActionForText(item)
  let score = 0
  if (expectedAction !== 'other') {
    if (action === expectedAction) score += 22
    else if (action !== 'other') score -= 28
  }

  const candidates = [
    normalizeSemanticText(step.taskHint),
    normalizeSemanticText(step.name),
    normalizeSemanticText(step.locator?.text),
    normalizeSemanticText(stringArg(step, 'targetHint')),
    normalizeSemanticText(stringArg(step, 'learnedLocatorText')),
  ].filter(Boolean)

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
  return score
}

function stringArg(step: ToolStep, key: string): string {
  const value = step.arguments[key]
  return typeof value === 'string' ? value : ''
}

function normalizeSemanticText(value: unknown): string {
  return typeof value === 'string'
    ? value.normalize('NFKC').toLocaleLowerCase().replace(/\s+/g, '').replace(/[，。；、,:：;()（）【】\[\]"']/g, '')
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
    || tool === 'browser_type_credential'
    || tool === 'browser_type_transient_ref'
    || tool === 'browser_type_totp_profile'
    || tool === 'desktop_type_text'
    || tool === 'desktop_type_target'
}
