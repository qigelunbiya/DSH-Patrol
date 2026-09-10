import type { InspectionDefinition, InspectionStep, ToolStep } from './types.js'
import type { PatrolStore } from './store.js'

const installedStores = new WeakSet<object>()

const ALWAYS_TRANSIENT_TOOLS = new Set([
  'browser_snapshot',
  'browser_count',
])

const CONTEXT_TOOLS = new Set([
  'browser_login_state',
  'browser_detect_auth_challenge',
])

const SUPPORT_TOOLS = new Set([
  'browser_wait',
  'browser_scroll',
])

const GENERIC_WORDS = new Set([
  '访问', '导航', '打开', '点击', '点开', '进入', '查看', '读取', '整理', '获取', '检查', '确认',
  '输入', '填写', '填入', '截图', '页面', '内容', '信息', '当前', '目标', '等待', '加载', '完成',
  'visit', 'navigate', 'open', 'click', 'enter', 'view', 'read', 'inspect', 'check', 'confirm',
  'type', 'fill', 'capture', 'screenshot', 'page', 'content', 'current', 'target', 'wait', 'load',
])

/**
 * Install once on the live Patrol store. The filter deliberately mutates only
 * DRAFT definitions with a persisted taskChecklist. It keeps the reusable
 * Runbook aligned with completed business checklist items while diagnostic
 * observation/recovery calls remain transient execution evidence.
 *
 * Existing READY runbooks and legacy drafts without taskChecklist are left
 * untouched for compatibility.
 */
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
  for (const step of definition.steps) {
    if (step.when !== undefined) referenced.add(step.when.sourceStepId)
  }

  const kept: InspectionStep[] = []
  for (const step of definition.steps) {
    if (step.kind === 'checkpoint') {
      kept.push(step)
      continue
    }
    if (shouldKeepToolStep(step, checklist, referenced)) kept.push(step)
  }

  const deduped = removeDuplicateResetNavigations(kept)
  if (deduped.length === definition.steps.length && deduped.every((step, index) => step === definition.steps[index])) return

  definition.steps = deduped
  renumberSteps(definition)
  definition.metadata.updatedAt = new Date().toISOString()
  delete definition.metadata.flowHealth
}

function shouldKeepToolStep(
  step: ToolStep,
  checklist: readonly string[],
  referenced: ReadonlySet<string>,
): boolean {
  if (step.teaching?.status === 'unverified') return false
  if (referenced.has(step.id)) return true
  if (step.expectation !== undefined || step.when !== undefined) return true

  if (ALWAYS_TRANSIENT_TOOLS.has(step.tool)) return false
  if (CONTEXT_TOOLS.has(step.tool)) return checklistExplicitlyMatches(step, checklist)
  if (SUPPORT_TOOLS.has(step.tool)) return checklistExplicitlyMatches(step, checklist)

  if (step.tool === 'browser_read_page' || step.tool === 'browser_screenshot') {
    return checklistExplicitlyMatches(step, checklist)
  }

  // Navigation, verified clicks, text/credential input, select/press and other
  // real mutations are already written only after their browser dispatch
  // succeeds. They represent business progress rather than observation noise.
  return true
}

function checklistExplicitlyMatches(step: ToolStep, checklist: readonly string[]): boolean {
  const stepAction = actionKindForTool(step.tool)
  const stepTokens = businessTokens(step.name)
  for (const item of checklist) {
    if (stepAction !== actionKindForChecklist(item)) continue
    const itemTokens = businessTokens(item)
    if (stepTokens.size === 0 || itemTokens.size === 0) continue
    let overlap = 0
    for (const token of stepTokens) if (itemTokens.has(token)) overlap += 1
    if (overlap > 0) return true
  }
  return false
}

type BusinessAction = 'navigate' | 'click' | 'type' | 'read' | 'screenshot' | 'wait' | 'context' | 'other'

function actionKindForTool(tool: string): BusinessAction {
  if (tool === 'browser_navigate') return 'navigate'
  if (tool === 'browser_click' || tool === 'browser_press' || tool === 'browser_select') return 'click'
  if (tool.startsWith('browser_type')) return 'type'
  if (tool === 'browser_read_page') return 'read'
  if (tool === 'browser_screenshot') return 'screenshot'
  if (tool === 'browser_wait' || tool === 'browser_scroll') return 'wait'
  if (tool === 'browser_login_state' || tool === 'browser_detect_auth_challenge') return 'context'
  return 'other'
}

function actionKindForChecklist(value: string): BusinessAction {
  const text = String(value || '')
  if (/(截图|screenshot|capture)/i.test(text)) return 'screenshot'
  if (/(输入|填写|填入|type|enter|fill)/i.test(text)) return 'type'
  if (/(读取|整理|查看.*(?:信息|列表|内容)|read|summar|inspect.*(?:list|content|info))/i.test(text)) return 'read'
  if (/(等待|wait|scroll|滚动)/i.test(text)) return 'wait'
  if (/(登录状态|认证状态|auth(?:entication)? state|login state|验证挑战|验证码类型)/i.test(text)) return 'context'
  if (/(点击|点开|打开.*(?:入口|菜单|工单|详情)|click|open .*?(?:menu|item|detail))/i.test(text)) return 'click'
  if (/(访问|导航|navigate|visit|go to)/i.test(text)) return 'navigate'
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
    const madeBusinessProgress = between.some(item => isDurableBusinessProgress(item))
    if (!madeBusinessProgress) continue
    out.push(step)
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
}

function renumberSteps(definition: InspectionDefinition): void {
  const idMap = new Map<string, string>()
  definition.steps.forEach((step, index) => idMap.set(step.id, `step-${String(index + 1).padStart(3, '0')}`))
  definition.steps = definition.steps.map((step, index) => {
    const id = `step-${String(index + 1).padStart(3, '0')}`
    if (step.when === undefined) return { ...step, id }
    const sourceStepId = idMap.get(step.when.sourceStepId)
    if (sourceStepId === undefined) return { ...step, id }
    return { ...step, id, when: { ...step.when, sourceStepId } }
  })
}
