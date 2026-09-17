import { checklistTaskForStep, findAdaptiveClickRecovery } from './adaptive-recovery.js'
import type { InspectionDefinition, InspectionStep, JsonValue, ToolStep } from './types.js'

export interface AdaptiveClickPathPlan {
  previousTask: string
  missingTasks: string[]
  currentTask: string
}

const CLICK_TASK_HINT = /(点击|点开|打开|进入|click|open)/i
const STRUCTURAL_DISALLOWED_TASK = /(验证码|captcha|otp|动态码|短信|verification|登录|登陆|sign[- ]?in|login|确定|确认|提交|保存|发送|发布|支付|购买|授权|删除|移除|注销|清空|confirm|submit|save|send|publish|pay|purchase|authorize|delete|remove|clear)/i
const MAX_INSERTED_CLICK_TASKS = 2

/**
 * Find a small ordered click gap between two recorded Runbook clicks.
 *
 * This is deliberately narrower than a planner: the previous and current
 * recorded clicks anchor the business order, the persisted task checklist
 * supplies only the missing intermediate click instructions, and no recovery
 * is allowed across authentication/input/navigation boundaries.
 */
export function findAdaptiveClickPathPlan(
  definition: InspectionDefinition,
  step: ToolStep,
): AdaptiveClickPathPlan | undefined {
  if (step.tool !== 'browser_click') return undefined
  const checklist = definition.metadata.taskChecklist ?? []
  const clickTasks = checklist.filter(item => CLICK_TASK_HINT.test(item))
  if (clickTasks.length < 3) return undefined

  const stepIndex = definition.steps.findIndex(candidate => candidate.id === step.id)
  if (stepIndex <= 0) return undefined

  const previous = previousClickAnchor(definition.steps, stepIndex)
  if (previous === undefined) return undefined

  const previousTaskIndex = resolveClickTaskIndex(definition, previous.step, clickTasks)
  const currentTaskIndex = resolveClickTaskIndex(definition, step, clickTasks)
  if (previousTaskIndex < 0 || currentTaskIndex < 0) return undefined
  if (currentTaskIndex <= previousTaskIndex + 1) return undefined

  const missingTasks = clickTasks.slice(previousTaskIndex + 1, currentTaskIndex)
  if (missingTasks.length === 0 || missingTasks.length > MAX_INSERTED_CLICK_TASKS) return undefined

  const previousTask = clickTasks[previousTaskIndex]
  const currentTask = clickTasks[currentTaskIndex]
  if (previousTask === undefined || currentTask === undefined) return undefined
  if ([...missingTasks, currentTask].some(task => STRUCTURAL_DISALLOWED_TASK.test(task))) return undefined

  return {
    previousTask,
    missingTasks,
    currentTask,
  }
}

/**
 * Resolve the checklist task represented by an existing recorded click.
 *
 * A taskHint created by action-order binding is useful but not infallible when
 * an intermediate click was absent from the Runbook. A strong semantic match
 * from the recorded locator/name may therefore move the step forward to the
 * later checklist task it actually represents. This keeps ordinary stale-click
 * fallback from accidentally treating the missing task as the current step.
 */
export function resolveRecordedClickTask(
  definition: InspectionDefinition,
  step: ToolStep,
): string | undefined {
  if (step.tool !== 'browser_click') return undefined
  const checklist = definition.metadata.taskChecklist ?? []
  const clickTasks = checklist.filter(item => CLICK_TASK_HINT.test(item))
  const index = resolveClickTaskIndex(definition, step, clickTasks)
  return index < 0 ? undefined : clickTasks[index]
}

/**
 * Reuse the existing fail-closed click-target matcher for one checklist task.
 * The synthetic taskHint changes only the business instruction supplied to the
 * matcher; it does not mutate the stored Runbook step.
 */
export function findChecklistClickTargetForTask(
  definition: InspectionDefinition,
  step: ToolStep,
  task: string,
  snapshot: JsonValue | undefined,
) {
  return findAdaptiveClickRecovery(
    definition,
    { ...step, taskHint: task },
    snapshot,
  )
}

function previousClickAnchor(
  steps: readonly InspectionStep[],
  currentIndex: number,
): { index: number; step: ToolStep } | undefined {
  for (let index = currentIndex - 1; index >= 0; index -= 1) {
    const candidate = steps[index]
    if (candidate === undefined) return undefined
    if (isStructuralBoundary(candidate)) return undefined
    if (candidate.kind === 'tool' && candidate.tool === 'browser_click') {
      return { index, step: candidate }
    }
  }
  return undefined
}

function isStructuralBoundary(step: InspectionStep): boolean {
  if (step.kind === 'checkpoint') return true
  return [
    'browser_navigate',
    'browser_detect_auth_challenge',
    'browser_refresh_image_code',
    'browser_type',
    'browser_type_credential',
    'browser_type_transient_ref',
    'browser_type_totp_profile',
    'browser_press',
    'browser_select',
  ].includes(step.tool)
}

function resolveClickTaskIndex(
  definition: InspectionDefinition,
  step: ToolStep,
  clickTasks: readonly string[],
): number {
  const hinted = checklistTaskForStep(definition, step)
  const hintedIndex = hinted === undefined ? -1 : clickTasks.indexOf(hinted)
  const semanticIndex = semanticClickTaskIndex(step, clickTasks)

  // A strong semantic match from the recorded step itself is allowed to move
  // forward past an order-derived hint. This is exactly the signal that a
  // checklist task was skipped while the later recorded click survived.
  if (semanticIndex >= 0 && (hintedIndex < 0 || semanticIndex >= hintedIndex)) return semanticIndex
  return hintedIndex
}

function semanticClickTaskIndex(step: ToolStep, clickTasks: readonly string[]): number {
  const locator = normalizeBusinessText(step.locator?.text ?? '')
  const name = normalizeBusinessText(step.name)
  const selector = normalizeSelectorHint(
    typeof step.arguments.selector === 'string' ? step.arguments.selector : '',
  )

  let bestScore = 0
  let bestIndex = -1
  let tied = false

  for (let index = 0; index < clickTasks.length; index += 1) {
    const target = normalizeBusinessText(clickTasks[index] ?? '')
    if (target.length < 2) continue
    const score = Math.max(
      semanticScore(locator, target, 100, 82),
      semanticScore(name, target, 76, 62),
      semanticScore(selector, target, 48, 36),
    )
    if (score > bestScore) {
      bestScore = score
      bestIndex = index
      tied = false
    } else if (score > 0 && score === bestScore) {
      tied = true
    }
  }

  // Selector-only matches are too weak to justify structural invention. A
  // recorded accessible label or step name must identify the later task.
  return bestScore >= 60 && !tied ? bestIndex : -1
}

function semanticScore(
  observed: string,
  target: string,
  exactScore: number,
  containsScore: number,
): number {
  if (!observed || !target) return 0
  if (observed === target) return exactScore
  if (observed.length >= 2 && target.length >= 2 && (observed.includes(target) || target.includes(observed))) {
    return containsScore
  }
  return 0
}

function normalizeBusinessText(value: string): string {
  return value
    .replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, '')
    .replace(/^\s*(?:点击|点开|打开|进入|选择|click|open|select)\s*/i, '')
    .replace(/(?:按钮|链接|菜单|入口|选项|button|link|menu|entry|option)\s*$/i, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .toLocaleLowerCase('en-US')
}

function normalizeSelectorHint(value: string): string {
  return value
    .replace(/top-frame::/gi, '')
    .replace(/frame-url\([^)]*\)::/gi, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .toLocaleLowerCase('en-US')
}
