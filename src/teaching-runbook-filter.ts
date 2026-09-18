import type { PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep, ToolStep } from './types.js'

const installedStores = new WeakSet<object>()

const ALWAYS_TRANSIENT_TOOLS = new Set(['browser_snapshot', 'browser_count'])
const CONTEXT_TOOLS = new Set(['browser_login_state', 'browser_detect_auth_challenge'])
const SUPPORT_TOOLS = new Set(['browser_wait', 'browser_scroll'])
const DYNAMIC_IMAGE_CODE_SOLVER_NOTE = 'PATROL_DYNAMIC_IMAGE_CODE_SOLVER'
const GENERIC_WORDS = new Set([
  '访问', '导航', '打开', '点击', '点开', '进入', '查看', '读取', '整理', '获取', '检查', '确认',
  '输入', '填写', '填入', '截图', '页面', '内容', '信息', '当前', '目标', '等待', '加载', '完成',
  'visit', 'navigate', 'open', 'click', 'enter', 'view', 'read', 'inspect', 'check', 'confirm',
  'type', 'fill', 'capture', 'screenshot', 'page', 'content', 'current', 'target', 'wait', 'load',
])

type BusinessAction = 'navigate' | 'click' | 'type' | 'read' | 'screenshot' | 'wait' | 'context' | 'other'
type ChecklistMatch = { kind: 'none' } | { kind: 'available'; index: number } | { kind: 'exhausted' }

export function installTeachingRunbookFilter(store: PatrolStore): void {
  if (installedStores.has(store)) return
  installedStores.add(store)

  const originalSave = store.save.bind(store)
  store.save = async (definition: InspectionDefinition): Promise<void> => {
    filterDraftRunbookInPlace(definition)
    await originalSave(definition)
  }
}

export function filterDraftRunbookInPlace(definition: InspectionDefinition): void {
  if (definition.status !== 'draft') return
  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0 || definition.steps.length === 0) return

  const referenced = new Set<string>()
  for (const step of definition.steps) if (step.when !== undefined) referenced.add(step.when.sourceStepId)

  const kept = definition.steps.filter(step => {
    if (step.kind === 'checkpoint') return true
    return shouldKeepToolStep(step, checklist, referenced)
  })
  const checklistDeduped = removeRepeatedChecklistActions(kept, checklist, referenced)
  const deduped = removeDuplicateResetNavigations(checklistDeduped)
  if (deduped.length === definition.steps.length && deduped.every((step, index) => step === definition.steps[index])) return

  // A live DRAFT keeps stable ids. Recording tools return the id they just
  // created, so filtering must not renumber it behind the caller's back.
  // Finalization performs the canonical contiguous renumbering once.
  definition.steps = deduped
  definition.metadata.updatedAt = new Date().toISOString()
  delete definition.metadata.flowHealth
}

function shouldKeepToolStep(step: ToolStep, checklist: readonly string[], referenced: ReadonlySet<string>): boolean {
  if (step.teaching?.status === 'unverified') return false
  if (referenced.has(step.id)) return true
  if (step.expectation !== undefined || step.when !== undefined) return true

  if (ALWAYS_TRANSIENT_TOOLS.has(step.tool)) return false
  if (step.tool === 'browser_navigate') return checklistExplicitlyMatches(step, checklist)
  if (isDynamicImageCodeSolver(step)) return checklistExplicitlyMatches(step, checklist)
  if (CONTEXT_TOOLS.has(step.tool) || SUPPORT_TOOLS.has(step.tool)) return checklistExplicitlyMatches(step, checklist)
  if (step.tool === 'browser_read_page' || step.tool === 'browser_screenshot' || step.tool === 'desktop_snapshot' || step.tool === 'desktop_ocr' || step.tool === 'desktop_screenshot') {
    return checklistExplicitlyMatches(step, checklist)
  }

  return true
}

function checklistExplicitlyMatches(step: ToolStep, checklist: readonly string[]): boolean {
  return rankedChecklistIndexes(step, checklist).length > 0
}

function removeRepeatedChecklistActions(
  steps: readonly InspectionStep[],
  checklist: readonly string[],
  referenced: ReadonlySet<string>,
): InspectionStep[] {
  const claimed = new Set<number>()
  const out: InspectionStep[] = []

  for (const step of steps) {
    if (step.kind === 'checkpoint') {
      out.push(step)
      continue
    }
    if (referenced.has(step.id) || step.when !== undefined) {
      out.push(step)
      continue
    }
    const match = checklistMatch(step, checklist, claimed)
    if (match.kind === 'none') {
      out.push(step)
      continue
    }
    if (match.kind === 'exhausted') continue
    claimed.add(match.index)
    out.push(step)
  }
  return out
}

function checklistMatch(step: ToolStep, checklist: readonly string[], claimed: ReadonlySet<number>): ChecklistMatch {
  const ranked = rankedChecklistIndexes(step, checklist)
  if (ranked.length === 0) return { kind: 'none' }
  const available = ranked.find(index => !claimed.has(index))
  return available === undefined ? { kind: 'exhausted' } : { kind: 'available', index: available }
}

function rankedChecklistIndexes(step: ToolStep, checklist: readonly string[]): number[] {
  const stepAction = actionKindForStep(step)
  if (!['navigate', 'click', 'type', 'read', 'screenshot'].includes(stepAction)) return []
  const stepTokens = businessTokens(step.name)
  if (stepTokens.size === 0) return []

  const scored: Array<{ index: number; score: number }> = []
  for (let index = 0; index < checklist.length; index += 1) {
    const item = checklist[index] ?? ''
    if (stepAction !== actionKindForChecklist(item)) continue
    const itemTokens = businessTokens(item)
    let score = 0
    for (const token of stepTokens) if (itemTokens.has(token)) score += token.length
    if (score > 0) scored.push({ index, score })
  }
  if (scored.length === 0) return []
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  const bestScore = scored[0]!.score
  return scored.filter(item => item.score === bestScore).map(item => item.index)
}

function actionKindForStep(step: ToolStep): BusinessAction {
  if (isDynamicImageCodeSolver(step)) return 'type'
  return actionKindForTool(step.tool)
}

function isDynamicImageCodeSolver(step: ToolStep): boolean {
  return step.tool === 'browser_detect_auth_challenge'
    && typeof step.notes === 'string'
    && step.notes.includes(DYNAMIC_IMAGE_CODE_SOLVER_NOTE)
}

function actionKindForTool(tool: string): BusinessAction {
  if (tool === 'browser_navigate' || tool === 'desktop_launch_app' || tool === 'desktop_open_path' || tool === 'desktop_activate_window') return 'navigate'
  if (tool === 'browser_click' || tool === 'browser_press' || tool === 'browser_select'
    || tool === 'desktop_click_target' || tool === 'desktop_click_coordinates' || tool === 'desktop_press'
    || tool === 'desktop_hotkey' || tool === 'desktop_paste' || tool === 'desktop_drag'
    || tool === 'desktop_close_window' || tool === 'desktop_delete_path') return 'click'
  if (tool.startsWith('browser_type') || tool === 'desktop_type_text' || tool === 'desktop_set_clipboard_text' || tool === 'desktop_set_clipboard_files') return 'type'
  if (tool === 'browser_read_page' || tool === 'desktop_snapshot' || tool === 'desktop_ocr') return 'read'
  if (tool === 'browser_screenshot' || tool === 'desktop_screenshot') return 'screenshot'
  if (tool === 'browser_wait' || tool === 'browser_scroll' || tool === 'desktop_wait') return 'wait'
  if (tool === 'browser_login_state' || tool === 'browser_detect_auth_challenge') return 'context'
  return 'other'
}

function actionKindForChecklist(value: string): BusinessAction {
  const text = String(value || '')
  if (/(截图|screenshot|capture)/i.test(text)) return 'screenshot'
  if (/(输入|填写|填入|复制到剪贴板|放入剪贴板|type|enter|fill|clipboard)/i.test(text)) return 'type'
  if (/(读取|整理|查看.*(?:信息|列表|内容)|识别|OCR|read|summar|inspect.*(?:list|content|info)|ocr)/i.test(text)) return 'read'
  if (/(等待|wait|scroll|滚动)/i.test(text)) return 'wait'
  if (/(登录状态|认证状态|auth(?:entication)? state|login state|验证挑战|验证码类型)/i.test(text)) return 'context'
  if (/(点击|点开|发送|关闭|删除|粘贴|打开.*(?:入口|菜单|工单|详情)|click|send|close|delete|paste|open .*?(?:menu|item|detail))/i.test(text)) return 'click'
  if (/(访问|导航|启动|激活|打开.*(?:应用|软件|窗口|微信|WPS|网盘)|navigate|visit|go to|launch|activate)/i.test(text)) return 'navigate'
  return 'other'
}

function businessTokens(value: string): Set<string> {
  const text = String(value || '').toLocaleLowerCase()
  const out = new Set<string>()

  for (const match of text.matchAll(/[a-z0-9][a-z0-9._:-]{1,}/g)) {
    if (!GENERIC_WORDS.has(match[0])) out.add(match[0])
  }
  const cjkRuns = text.match(/[\u3400-\u9fff]{2,}/g) ?? []
  for (const run of cjkRuns) {
    for (let size = 2; size <= Math.min(5, run.length); size += 1) {
      for (let index = 0; index + size <= run.length; index += 1) {
        const token = run.slice(index, index + size)
        if (!GENERIC_WORDS.has(token)) out.add(token)
      }
    }
  }
  return out
}

function removeDuplicateResetNavigations(steps: readonly InspectionStep[]): InspectionStep[] {
  const out: InspectionStep[] = []
  for (const step of steps) {
    if (step.kind !== 'tool' || step.tool !== 'browser_navigate') {
      out.push(step)
      continue
    }
    const key = navigationKey(step)
    if (!key) {
      out.push(step)
      continue
    }
    const previousIndex = findLastNavigation(out, key)
    if (previousIndex < 0) {
      out.push(step)
      continue
    }
    const between = out.slice(previousIndex + 1)
    if (between.some(isDurableBusinessProgress)) out.push(step)
  }
  return out
}

function findLastNavigation(steps: readonly InspectionStep[], key: string): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    const step = steps[index]
    if (step?.kind === 'tool' && step.tool === 'browser_navigate' && navigationKey(step) === key) return index
  }
  return -1
}

function navigationKey(step: ToolStep): string {
  const value = typeof step.arguments.url === 'string' ? step.arguments.url : ''
  if (!value) return ''
  try {
    const url = new URL(value)
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return value.trim().replace(/\/$/, '')
  }
}

function isDurableBusinessProgress(step: InspectionStep): boolean {
  if (step.kind === 'checkpoint') return true
  return step.tool === 'browser_click'
    || step.tool === 'browser_press'
    || step.tool === 'browser_select'
    || step.tool.startsWith('browser_type')
    || step.tool === 'desktop_click_target'
    || step.tool === 'desktop_click_coordinates'
    || step.tool === 'desktop_press'
    || step.tool === 'desktop_hotkey'
    || step.tool === 'desktop_paste'
    || step.tool === 'desktop_type_text'
    || step.tool === 'desktop_set_clipboard_text'
    || step.tool === 'desktop_set_clipboard_files'
}
