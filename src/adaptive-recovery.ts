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

  const task = matchingChecklistTask(definition, step)
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
      placeholder: stringValue(item.placeholder),
      ariaLabel: stringValue(item.ariaLabel),
    })
  }
  return result
}

function matchingChecklistTask(definition: InspectionDefinition, step: ToolStep): string | undefined {
  const checklist = definition.metadata.taskChecklist ?? []
  if (checklist.length === 0) return undefined
  const hint = [step.name, typeof step.arguments.selector === 'string' ? step.arguments.selector : ''].join(' ')
  const wanted = PASSWORD_HINT.test(hint) ? PASSWORD_HINT : (USERNAME_HINT.test(hint) ? USERNAME_HINT : undefined)
  if (wanted === undefined) return undefined
  const matches = checklist.filter(item => wanted.test(item) && !SENSITIVE_CODE_HINT.test(item))
  return matches.length === 1 ? matches[0] : undefined
}

function stringValue(value: JsonValue | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}
