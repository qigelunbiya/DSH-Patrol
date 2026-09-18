import type { InspectionDefinition, InspectionStep, ToolStep } from './types.js'

export interface FlowCompactionResult {
  removedSteps: number
  originalSteps: number
  finalSteps: number
}

export interface FlowSelectionResult extends FlowCompactionResult {
  autoKeptDependencies: number
}

type ChecklistAction = 'navigate' | 'click' | 'type' | 'read' | 'screenshot' | 'wait'

/**
 * Select the semantically successful route from a full conversational teaching
 * trace. Only verified semantic clicks are eligible. A click verified by an
 * automatic CURRENT-state change is as valid as one with an explicit expected
 * text; the teaching-only evidence is stripped from the reusable Runbook.
 */
export function selectSuccessfulTeachingPath(
  definition: InspectionDefinition,
  successfulStepIds: readonly string[],
): FlowSelectionResult {
  const original = definition.steps.slice()
  if (original.length === 0) throw new Error('cannot finalize an empty teaching trace')

  const byId = new Map(original.map(step => [step.id, step] as const))
  const keep = new Set<string>()
  for (const id of successfulStepIds) {
    if (typeof id !== 'string' || !byId.has(id)) throw new Error(`successful path references unknown step ${String(id)}`)
    keep.add(id)
  }
  if (keep.size === 0) throw new Error('successful path must keep at least one step')

  const requestedCount = keep.size
  for (const id of keep) {
    const step = byId.get(id)
    if (step?.kind !== 'tool' || step.tool !== 'browser_click') continue
    if (step.teaching?.status === 'unverified') {
      throw new Error(`successful path step ${id} (${step.name}) is explicitly unverified and cannot enter a reusable flow`)
    }
    if (step.locator?.text !== undefined && step.expectation === undefined && step.teaching?.status !== 'verified') {
      throw new Error(`successful path step ${id} (${step.name}) has no post-click verification evidence; reteach that semantic click and verify the CURRENT state before finalizing`)
    }
  }

  let changed = true
  while (changed) {
    changed = false
    for (const step of original) {
      if (!keep.has(step.id) || step.when === undefined || keep.has(step.when.sourceStepId)) continue
      if (!byId.has(step.when.sourceStepId)) throw new Error(`step ${step.id} depends on missing source ${step.when.sourceStepId}`)
      keep.add(step.when.sourceStepId)
      changed = true
    }
  }

  const requiredReads = requiredArtifactCount(
    definition,
    'read',
    definition.artifacts.includes('page-text') || definition.artifacts.includes('page-summary') ? 1 : 0,
  )
  for (const index of findLastToolIndices(original, 'browser_read_page', requiredReads)) keep.add(original[index]!.id)

  const requiredScreenshots = requiredArtifactCount(
    definition,
    'screenshot',
    definition.artifacts.includes('screenshot') ? 1 : 0,
  )
  const screenshotCandidates = [
    ...findLastToolIndices(original, 'browser_screenshot', requiredScreenshots),
    ...findLastToolIndices(original, 'desktop_screenshot', requiredScreenshots),
  ].sort((left, right) => right - left).slice(0, requiredScreenshots)
  for (const index of screenshotCandidates) keep.add(original[index]!.id)

  const selected = original.filter(step => keep.has(step.id))
  assertCausalBusinessPath(selected)
  assertChecklistCoverage(definition, selected)
  rewriteSteps(definition, selected, true)
  const compacted = compactTeachingFlow(definition)
  assertChecklistCoverage(definition, definition.steps)
  definition.metadata.flowHealth = {
    complete: true,
    warnings: [],
    checkedAt: new Date().toISOString(),
  }
  return {
    originalSteps: original.length,
    finalSteps: compacted.finalSteps,
    removedSteps: original.length - compacted.finalSteps,
    autoKeptDependencies: Math.max(0, compacted.finalSteps - requestedCount),
  }
}

/**
 * Deterministic fallback cleanup used by the dashboard and legacy teaching
 * flows. Cleanup is deliberately not a declaration of success: it removes
 * diagnostics/unverified actions, then records structural health warnings when
 * the surviving trace cannot plausibly advance after input.
 */
export function compactTeachingFlow(definition: InspectionDefinition): FlowCompactionResult {
  const original = definition.steps.slice()
  const referenced = new Set<string>()
  for (const step of original) {
    if (step.when !== undefined) referenced.add(step.when.sourceStepId)
  }

  const pageReadIndexes = new Set(findLastToolIndices(
    original,
    'browser_read_page',
    requiredArtifactCount(
      definition,
      'read',
      definition.artifacts.includes('page-text') || definition.artifacts.includes('page-summary') ? 1 : 0,
    ),
  ))
  const screenshotRequired = requiredArtifactCount(definition, 'screenshot', definition.artifacts.includes('screenshot') ? 1 : 0)
  const screenshotIndexes = new Set([
    ...findLastToolIndices(original, 'browser_screenshot', screenshotRequired),
    ...findLastToolIndices(original, 'desktop_screenshot', screenshotRequired),
  ].sort((left, right) => right - left).slice(0, screenshotRequired))
  const resetFloor = findSafeResetFloor(original, referenced)

  const kept = original.filter((step, index) => shouldKeepStep(
    original,
    step,
    index,
    referenced,
    pageReadIndexes,
    screenshotIndexes,
    resetFloor,
  ))

  rewriteSteps(definition, kept, false)
  bindChecklistTasks(definition)
  updateStructuralFlowHealth(definition)
  return {
    removedSteps: original.length - definition.steps.length,
    originalSteps: original.length,
    finalSteps: definition.steps.length,
  }
}

function shouldKeepStep(
  all: readonly InspectionStep[],
  step: InspectionStep,
  index: number,
  referenced: ReadonlySet<string>,
  pageReadIndexes: ReadonlySet<number>,
  screenshotIndexes: ReadonlySet<number>,
  resetFloor: number,
): boolean {
  if (index < resetFloor) return false
  if (step.kind === 'checkpoint') return true
  if (step.teaching?.status === 'unverified') return false
  if (referenced.has(step.id)) return true
  if (step.expectation !== undefined) return true

  if (step.tool === 'browser_snapshot' || step.tool === 'browser_count') {
    return stepHasMeaningfulNotes(step)
  }

  if (step.tool === 'browser_read_page') {
    if (stepHasMeaningfulNotes(step)) return true
    return pageReadIndexes.has(index)
  }

  if (step.tool === 'browser_screenshot' || step.tool === 'desktop_screenshot') {
    if (stepHasMeaningfulNotes(step)) return true
    return screenshotIndexes.has(index)
  }

  if ((step.tool === 'browser_wait' || step.tool === 'desktop_wait')
    && hasLaterUnassertedWaitBeforeBoundary(all, index, step.tool)) return false
  if (isTypingTool(step.tool) && isSupersededTypingStep(all, index, step)) return false
  if (isDuplicateRetryStep(all, index, step)) return false

  return true
}

function assertCausalBusinessPath(steps: readonly InspectionStep[]): void {
  const lastInput = findLastMatchingIndex(steps, step => step.kind === 'tool' && isTypingTool(step.tool))
  if (lastInput < 0) return
  const advancesAfterInput = steps.slice(lastInput + 1).some(step =>
    step.kind === 'tool' && [
      'browser_click', 'browser_press', 'browser_select', 'browser_navigate',
      'desktop_click_target', 'desktop_click_ocr_text', 'desktop_click_coordinates', 'desktop_press', 'desktop_press_target', 'desktop_hotkey',
      'desktop_paste', 'desktop_paste_target', 'desktop_drag', 'desktop_launch_app', 'desktop_open_path', 'desktop_activate_window',
    ].includes(step.tool),
  )
  if (!advancesAfterInput) {
    throw new Error('successful path is incomplete: recorded input is not followed by any verified action that advances/submits the business flow')
  }
}

function assertChecklistCoverage(definition: InspectionDefinition, steps: readonly InspectionStep[]): void {
  const warnings = checklistCoverageWarnings(definition, steps)
  if (warnings.length > 0) {
    throw new Error(`successful path does not cover the persisted task checklist: ${warnings.join('; ')}`)
  }
}

function updateStructuralFlowHealth(definition: InspectionDefinition): void {
  const warnings: string[] = []
  const steps = definition.steps
  const lastInput = findLastMatchingIndex(steps, step => step.kind === 'tool' && isTypingTool(step.tool))
  if (lastInput >= 0) {
    const advancesAfterInput = steps.slice(lastInput + 1).some(step =>
      step.kind === 'tool' && [
        'browser_click', 'browser_press', 'browser_select', 'browser_navigate',
        'desktop_click_target', 'desktop_click_ocr_text', 'desktop_click_coordinates', 'desktop_press', 'desktop_hotkey',
        'desktop_paste', 'desktop_drag', 'desktop_launch_app', 'desktop_open_path', 'desktop_activate_window',
      ].includes(step.tool),
    )
    if (!advancesAfterInput) {
      warnings.push('输入步骤之后没有任何已记录的提交/点击/选择/导航动作；该流程很可能缺少登录提交或后续业务点击。')
    }
  }
  const unverifiedClicks = steps.filter(step => step.kind === 'tool' && step.tool === 'browser_click' && step.teaching?.status === 'unverified')
  if (unverifiedClicks.length > 0) warnings.push(`仍有 ${unverifiedClicks.length} 个未验证点击，不可视为可复用成功路径。`)
  warnings.push(...checklistCoverageWarnings(definition, steps))
  definition.metadata.flowHealth = {
    complete: warnings.length === 0,
    warnings,
    checkedAt: new Date().toISOString(),
  }
}

function checklistCoverageWarnings(definition: InspectionDefinition, steps: readonly InspectionStep[]): string[] {
  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0) return []
  const required = checklistActionCounts(checklist)
  const actual = flowActionCounts(steps)
  const warnings: string[] = []
  for (const key of Object.keys(required) as ChecklistAction[]) {
    if (actual[key] < required[key]) {
      warnings.push(`任务清单要求 ${required[key]} 个${actionLabel(key)}，当前流程仅有 ${actual[key]} 个。`)
    }
  }
  return warnings
}

export function bindChecklistTasks(definition: InspectionDefinition): void {
  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0) return

  const tasksByAction = Object.fromEntries(
    (['navigate', 'click', 'type', 'read', 'screenshot', 'wait'] as ChecklistAction[]).map(action => [
      action,
      checklist.filter(item => checklistMatchesAction(item, action)),
    ]),
  ) as Record<ChecklistAction, string[]>
  const cursors: Record<ChecklistAction, number> = { navigate: 0, click: 0, type: 0, read: 0, screenshot: 0, wait: 0 }

  definition.steps = definition.steps.map(step => {
    if (step.kind !== 'tool') return step
    const action = flowActionForStep(step)
    if (action === undefined) return step
    const task = tasksByAction[action][cursors[action]]
    cursors[action] += 1
    if (step.taskHint !== undefined || task === undefined) return step
    return { ...step, taskHint: task }
  })
}

function checklistActionCounts(checklist: readonly string[]): Record<ChecklistAction, number> {
  const counts: Record<ChecklistAction, number> = { navigate: 0, click: 0, type: 0, read: 0, screenshot: 0, wait: 0 }
  for (const raw of checklist) {
    const text = String(raw || '')
    for (const action of Object.keys(counts) as ChecklistAction[]) {
      if (checklistMatchesAction(text, action)) counts[action] += 1
    }
  }
  return counts
}

function checklistMatchesAction(text: string, action: ChecklistAction): boolean {
  if (action === 'navigate') return /(访问|导航|启动|激活|打开.*(?:应用|软件|窗口|微信|WPS|网盘)|navigate|visit|go to|launch|activate)/i.test(text)
  if (action === 'click') return /(点击|点开|进入|选择|发送|关闭|删除|粘贴|打开.*(?:入口|菜单|工单|详情)|click|select|send|close|delete|paste|open .*?(?:menu|item|detail))/i.test(text)
  if (action === 'type') return /(输入|填写|填入|复制到剪贴板|放入剪贴板|type|enter|fill|clipboard)/i.test(text)
  if (action === 'read') return /(读取|整理|查看.*(?:信息|列表|内容)|识别|OCR|read|summar|inspect.*(?:list|content|info)|ocr)/i.test(text)
  if (action === 'wait') return /(等待|等到|直到|直至|wait(?:\s+(?:for|until))?)/i.test(text)
  return /(截图|screenshot|capture)/i.test(text)
}

function flowActionCounts(steps: readonly InspectionStep[]): Record<ChecklistAction, number> {
  const counts: Record<ChecklistAction, number> = { navigate: 0, click: 0, type: 0, read: 0, screenshot: 0, wait: 0 }
  for (const step of steps) {
    if (step.kind !== 'tool') continue
    const action = flowActionForStep(step)
    if (action !== undefined) counts[action] += 1
  }
  return counts
}

function flowActionForStep(step: ToolStep): ChecklistAction | undefined {
  if (step.tool === 'browser_navigate'
    || step.tool === 'desktop_launch_app'
    || step.tool === 'desktop_open_path'
    || step.tool === 'desktop_activate_window') return 'navigate'
  if (step.tool === 'browser_click'
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
  if (step.tool === 'browser_wait' || step.tool === 'desktop_wait' || step.tool === 'desktop_wait_for_target') return 'wait'
  if (step.tool === 'browser_screenshot' || step.tool === 'desktop_screenshot') return 'screenshot'
  return undefined
}

function actionLabel(key: ChecklistAction): string {
  return ({
    navigate: '导航步骤',
    click: '点击/打开步骤',
    type: '输入步骤',
    read: '读取/整理步骤',
    screenshot: '截图步骤',
    wait: '等待/就绪步骤',
  } as const)[key]
}

function requiredArtifactCount(definition: InspectionDefinition, action: 'read' | 'screenshot', fallback: number): number {
  const checklist = definition.metadata.taskChecklist ?? []
  const required = checklist.length === 0 ? 0 : checklistActionCounts(checklist)[action]
  return Math.max(fallback, required)
}

function hasLaterUnassertedWaitBeforeBoundary(
  all: readonly InspectionStep[],
  index: number,
  currentTool: 'browser_wait' | 'desktop_wait',
): boolean {
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    const next = all[cursor]!
    if (isInteractionBoundary(next)) return false
    if (next.kind !== 'tool' || referencedOrAssertive(next)) continue
    if (currentTool === 'browser_wait' && next.tool === 'browser_wait') return true
    if (currentTool === 'desktop_wait' && (next.tool === 'desktop_wait' || next.tool === 'desktop_wait_for_target')) return true
  }
  return false
}

function isDuplicateRetryStep(all: readonly InspectionStep[], index: number, step: ToolStep): boolean {
  if (!['browser_click', 'browser_press', 'browser_wait'].includes(step.tool)) return false
  if (referencedOrAssertive(step)) return false
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    const next = all[cursor]!
    if (next.kind === 'checkpoint' || next.tool === 'browser_navigate' || isTypingTool(next.tool) || next.tool === 'browser_detect_auth_challenge') {
      return false
    }
    if (next.kind !== 'tool' || next.tool !== step.tool || referencedOrAssertive(next)) continue
    if (step.name === next.name && JSON.stringify(step.arguments) === JSON.stringify(next.arguments)) return true
  }
  return false
}

function referencedOrAssertive(step: InspectionStep): boolean {
  return step.kind === 'tool' && (step.when !== undefined || step.expectation !== undefined || step.artifact !== undefined)
}

function findSafeResetFloor(
  steps: readonly InspectionStep[],
  referenced: ReadonlySet<string>,
): number {
  const navigations: Array<{ index: number; key: string }> = []
  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index]
    if (step?.kind !== 'tool' || step.tool !== 'browser_navigate') continue
    const key = typeof step.arguments.url === 'string' ? navigationIdentity(step.arguments.url) : ''
    if (key) navigations.push({ index, key })
  }
  if (navigations.length < 2) return 0

  for (let cursor = navigations.length - 1; cursor > 0; cursor -= 1) {
    const previous = navigations[cursor - 1]!
    const current = navigations[cursor]!
    if (previous.key !== current.key) continue
    const abandoned = steps.slice(previous.index + 1, current.index)
    const hasStrongSemanticStep = abandoned.some(step =>
      step.kind === 'checkpoint'
      || referenced.has(step.id)
      || (step.kind === 'tool' && (step.expectation !== undefined || step.teaching?.status === 'verified')),
    )
    if (!hasStrongSemanticStep) return current.index
  }
  return 0
}

function navigationIdentity(value: string): string {
  try {
    const url = new URL(value)
    if (url.pathname.startsWith('/com-sso/')) url.search = ''
    url.hash = ''
    return url.toString().replace(/\/$/, '')
  } catch {
    return normalizeUrl(value)
  }
}

function isSupersededTypingStep(all: readonly InspectionStep[], index: number, step: ToolStep): boolean {
  const identity = typingTargetIdentity(step)
  if (!identity) return false
  for (let cursor = index + 1; cursor < all.length; cursor += 1) {
    const next = all[cursor]!
    if (next.kind === 'tool' && isTypingTool(next.tool)) {
      if (typingTargetIdentity(next) === identity) return true
      // A targeted desktop input to a different control establishes its own
      // focus boundary. Do not collapse an earlier input across that action.
      if (next.tool === 'desktop_type_target') return false
      continue
    }
    if (isInteractionBoundary(next)) return false
  }
  return false
}

function typingTargetIdentity(step: ToolStep): string {
  if (step.tool.startsWith('browser_type')) {
    const selector = typeof step.arguments.selector === 'string' ? step.arguments.selector.trim() : ''
    return selector ? `browser:${selector}` : ''
  }
  if (step.tool === 'desktop_type_target') {
    const stable = ['processName', 'title', 'titleContains', 'name', 'automationId', 'controlType', 'className', 'index']
      .map(key => [key, step.arguments[key]] as const)
      .filter(([, value]) => typeof value === 'string' ? value.trim() !== '' : typeof value === 'number')
    return stable.length === 0 ? '' : `desktop-target:${JSON.stringify(Object.fromEntries(stable))}`
  }
  // desktop_type_text is intentionally focus-relative; without a stable target
  // it cannot be safely assumed to supersede an earlier input.
  return ''
}

function isInteractionBoundary(step: InspectionStep): boolean {
  if (step.kind === 'checkpoint') return true
  return step.tool === 'browser_click'
    || step.tool === 'browser_press'
    || step.tool === 'browser_navigate'
    || step.tool === 'browser_detect_auth_challenge'
    || step.tool === 'desktop_click_target'
    || step.tool === 'desktop_click_ocr_text'
    || step.tool === 'desktop_click_coordinates'
    || step.tool === 'desktop_press'
    || step.tool === 'desktop_press_target'
    || step.tool === 'desktop_hotkey'
    || step.tool === 'desktop_paste'
    || step.tool === 'desktop_type_target'
    || step.tool === 'desktop_launch_app'
    || step.tool === 'desktop_activate_window'
}

function isTypingTool(tool: string): boolean {
  return tool === 'browser_type'
    || tool === 'browser_type_credential'
    || tool === 'browser_type_transient_ref'
    || tool === 'browser_type_totp_profile'
    || tool === 'desktop_type_text'
    || tool === 'desktop_type_target'
}

function rewriteSteps(definition: InspectionDefinition, kept: readonly InspectionStep[], stripTeaching: boolean): void {
  const idMap = new Map<string, string>()
  kept.forEach((step, index) => idMap.set(step.id, `step-${String(index + 1).padStart(3, '0')}`))

  definition.steps = kept.map((step, index) => {
    const nextId = `step-${String(index + 1).padStart(3, '0')}`
    const when = step.when === undefined
      ? undefined
      : {
          ...step.when,
          sourceStepId: idMap.get(step.when.sourceStepId) ?? step.when.sourceStepId,
        }
    if (step.kind === 'checkpoint') {
      return {
        ...step,
        id: nextId,
        ...(when === undefined ? {} : { when }),
      }
    }
    const { teaching: _teaching, ...toolStep } = step
    return {
      ...toolStep,
      ...(stripTeaching ? {} : step.teaching === undefined ? {} : { teaching: step.teaching }),
      id: nextId,
      ...(when === undefined ? {} : { when }),
    }
  })
}

function normalizeUrl(value: string): string {
  try {
    const url = new URL(value)
    url.hash = ''
    const normalized = url.toString()
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized
  } catch {
    return value.trim().replace(/\/$/, '')
  }
}

function stepHasMeaningfulNotes(step: ToolStep): boolean {
  if (typeof step.notes !== 'string' || !step.notes.trim()) return false
  return step.notes
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .some(line => !/^(执行方法|execution method)[:：]/i.test(line))
}

function findLastToolIndices(steps: readonly InspectionStep[], tool: string, count: number): number[] {
  if (count <= 0) return []
  const out: number[] = []
  for (let index = steps.length - 1; index >= 0 && out.length < count; index -= 1) {
    const step = steps[index]
    if (step?.kind === 'tool' && step.tool === tool) out.push(index)
  }
  return out.reverse()
}

function findLastMatchingIndex(steps: readonly InspectionStep[], predicate: (step: InspectionStep) => boolean): number {
  for (let index = steps.length - 1; index >= 0; index -= 1) if (predicate(steps[index]!)) return index
  return -1
}
