import { findUniqueHealingSelector } from './browser.js'
import type { InspectionDefinition, JsonValue, ToolStep } from './types.js'

export interface AdaptiveSelectorRecovery {
  selector: string
  reason: string
  task?: string
}

const USERNAME_HINT = /(username|user[-_ ]?name|account|login[-_ ]?name|email|用户名|账号|帐号|登录名|邮箱)/i
const PASSWORD_HINT = /(password|passwd|pwd|密码)/i
const SENSITIVE_CODE_HINT = /(captcha|验证码|动态码|otp|one[- ]?time|短信|sms|verification\s*code|code)/i
const FIELD_EXCLUDE_HINT = /(search|query|filter|captcha|验证码|otp|verification|code|password|passwd|pwd)/i
const TYPE_TASK_HINT = /(输入|填写|填入|type|enter|fill)/i
const CLICK_TASK_HINT = /(点击|点开|打开.*(?:入口|菜单|工单|详情)|click|open .*?(?:menu|item|detail))/i
const DANGEROUS_CLICK_TASK = /(删除|移除|注销|清空|支付|购买|授权|发送|发布|delete|remove|clear|pay|purchase|authorize|send|publish)/i
const GENERIC_CLICK_TARGET = /^(?:确定|确认|提交|继续|下一步|打开|点击|ok|confirm|submit|continue|next)$/i

export function isSelectorUnavailable(error: string | undefined): boolean {
  return typeof error === 'string'
    && /(?:element|selector).*(?:not found|no match|did not match|didn't match)|not found in any accessible frame|could not resolve.*selector/i.test(error)
}

/**
 * Low-risk adaptive recovery for selector drift on text-entry steps.
 *
 * This intentionally does not invent new business actions. It only chooses a
 * unique visible field whose semantics match the existing Runbook step and the
 * persisted business checklist. The candidate is used for this run only; the
 * Runbook is not mutated here.
 */
export function findAdaptiveSelectorRecovery(
  definition: InspectionDefinition,
  step: ToolStep,
  snapshot: JsonValue | undefined,
): AdaptiveSelectorRecovery | undefined {
  if (!['browser_type', 'browser_type_credential'].includes(step.tool)) return undefined
  const elements = snapshotElements(snapshot)
  if (elements.length === 0) return undefined

  const task = checklistTaskForStep(definition, step)
  const hint = [
    step.name,
    step.notes ?? '',
    typeof step.arguments.selector === 'string' ? step.arguments.selector : '',
    task ?? '',
  ].join(' ')

  // Never improvise OTP/CAPTCHA/verification targets. Those have dedicated
  // transient/challenge handling and must remain fail-closed.
  if (SENSITIVE_CODE_HINT.test(hint)) return undefined

  if (PASSWORD_HINT.test(hint)) {
    const candidates = elements.filter(item => item.tag === 'input' && item.type === 'password')
    return uniqueRecovery(candidates, 'unique visible password field', task)
  }

  if (USERNAME_HINT.test(hint)) {
    const candidates = elements.filter(item => {
      if (item.tag !== 'input' && item.tag !== 'textarea') return false
      if (item.type === 'password') return false
      const signature = [item.selector, item.name, item.text, item.type, item.placeholder, item.ariaLabel].join(' ')
      return USERNAME_HINT.test(signature) && !FIELD_EXCLUDE_HINT.test(signature)
    })
    return uniqueRecovery(candidates, 'unique visible username/account field', task)
  }

  return undefined
}

/**
 * Low-risk checklist fallback for a stale browser_click selector. This is only
 * allowed when the checklist names one concrete, non-destructive target and the
 * CURRENT snapshot exposes exactly one clickable semantic match. No extra menu
 * traversal or other structural action is invented here.
 */
export function findAdaptiveClickRecovery(
  definition: InspectionDefinition,
  step: ToolStep,
  snapshot: JsonValue | undefined,
): AdaptiveSelectorRecovery | undefined {
  if (step.tool !== 'browser_click') return undefined
  const task = checklistTaskForStep(definition, step)
  if (task === undefined || DANGEROUS_CLICK_TASK.test(task)) return undefined
  const target = clickTargetFromTask(task)
  if (target === undefined || GENERIC_CLICK_TARGET.test(target)) return undefined

  const clickable = snapshotElements(snapshot).filter(isClickableSnapshotElement)
  if (clickable.length === 0) return undefined
  const candidateSnapshot: JsonValue = {
    elements: clickable.map(item => ({
      selector: item.selector,
      text: item.text,
      role: item.role,
      tag: item.tag,
    })),
  }
  const selector = findUniqueHealingSelector(candidateSnapshot, { text: target })
  if (selector === undefined) return undefined
  return {
    selector,
    reason: `unique clickable target matching checklist instruction ${JSON.stringify(task)}`,
    task,
  }
}

/**
 * Resolve the business-checklist instruction for a concrete reusable step.
 *
 * Newer definitions may carry a persisted taskHint. Older definitions are
 * mapped deterministically by action order: the Nth replayed action maps to
 * the Nth checklist instruction of the same action category. Semantic matching
 * remains as a fallback for legacy text-entry traces whose counts do not line up.
 */
export function checklistTaskForStep(definition: InspectionDefinition, step: ToolStep): string | undefined {
  const explicit = step.taskHint?.trim()
  if (explicit) return explicit

  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0) return undefined

  const action = recoveryActionForTool(step.tool)
  if (action !== undefined) {
    const matchingSteps = definition.steps.filter((candidate): candidate is ToolStep => (
      candidate.kind === 'tool' && recoveryActionForTool(candidate.tool) === action
    ))
    const stepIndex = matchingSteps.findIndex(candidate => candidate.id === step.id)
    const matchingTasks = checklist.filter(item => checklistMatchesRecoveryAction(item, action))
    if (stepIndex >= 0 && stepIndex < matchingTasks.length) return matchingTasks[stepIndex]
  }

  return semanticChecklistTask(checklist, step)
}

function uniqueRecovery(
  candidates: readonly SnapshotElement[],
  reason: string,
  task: string | undefined,
): AdaptiveSelectorRecovery | undefined {
  const selectors = [...new Set(candidates.map(item => item.selector).filter(Boolean))]
  if (selectors.length !== 1) return undefined
  return {
    selector: selectors[0]!,
    reason,
    ...(task === undefined ? {} : { task }),
  }
}

interface SnapshotElement {
  tag: string
  selector: string
  type: string
  name: string
  text: string
  role: string
  placeholder: string
  ariaLabel: string
}

function snapshotElements(value: JsonValue | undefined): SnapshotElement[] {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') return []
  const raw = value.elements
  if (!Array.isArray(raw)) return []
  const result: SnapshotElement[] = []
  for (const item of raw) {
    if (item === null || Array.isArray(item) || typeof item !== 'object') continue
    const selector = stringValue(item.selector)
    if (!selector) continue
    result.push({
      tag: stringValue(item.tag).toLocaleLowerCase('en-US'),
      selector,
      type: stringValue(item.type).toLocaleLowerCase('en-US'),
      name: stringValue(item.name),
      text: stringValue(item.text),
      role: stringValue(item.role).toLocaleLowerCase('en-US'),
      placeholder: stringValue(item.placeholder),
      ariaLabel: stringValue(item.ariaLabel),
    })
  }
  return result
}

function isClickableSnapshotElement(item: SnapshotElement): boolean {
  if (item.tag === 'a' || item.tag === 'button') return true
  if (item.tag === 'input' && ['button', 'submit', 'reset'].includes(item.type)) return true
  return ['button', 'link', 'menuitem', 'tab', 'treeitem', 'option'].includes(item.role)
}

function clickTargetFromTask(task: string): string | undefined {
  const normalized = task
    .replace(/^\s*(?:\d+[.)、]|[-*•])\s*/, '')
    .replace(/^\s*(?:点击|点开|打开|进入|选择|click|open|select)\s*/i, '')
    .replace(/[“”‘’"']/g, '')
    .trim()
    .replace(/(?:按钮|链接|菜单|入口|选项|button|link|menu|entry)\s*$/i, '')
    .trim()
  return normalized.length >= 2 ? normalized : undefined
}

function semanticChecklistTask(checklist: readonly string[], step: ToolStep): string | undefined {
  const hint = [step.name, typeof step.arguments.selector === 'string' ? step.arguments.selector : ''].join(' ')
  const wanted = PASSWORD_HINT.test(hint) ? PASSWORD_HINT : (USERNAME_HINT.test(hint) ? USERNAME_HINT : undefined)
  if (wanted === undefined) return undefined
  const matches = checklist.filter(item => wanted.test(item) && !SENSITIVE_CODE_HINT.test(item))
  return matches.length === 1 ? matches[0] : undefined
}

type RecoveryAction = 'type' | 'click'

function recoveryActionForTool(tool: string): RecoveryAction | undefined {
  if (isTypingTool(tool)) return 'type'
  if (tool === 'browser_click') return 'click'
  return undefined
}

function checklistMatchesRecoveryAction(text: string, action: RecoveryAction): boolean {
  if (action === 'type') return TYPE_TASK_HINT.test(text)
  return CLICK_TASK_HINT.test(text)
}

function isTypingTool(tool: string): boolean {
  return tool === 'browser_type'
    || tool === 'browser_type_credential'
    || tool === 'browser_type_transient_ref'
    || tool === 'browser_type_totp_profile'
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}
