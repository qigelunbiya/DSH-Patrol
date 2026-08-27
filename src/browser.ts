import type { JsonObject, SemanticLocator, ToolStep } from './types.js'

export const SAFE_BROWSER_TOOLS = [
  'browser_status',
  'browser_list_tabs',
  'browser_activate_tab',
  'browser_navigate',
  'browser_snapshot',
  'browser_read_page',
  'browser_click',
  'browser_type',
  'browser_type_credential',
  'browser_press',
  'browser_scroll',
  'browser_wait',
  'browser_screenshot',
] as const

export type SafeBrowserTool = typeof SAFE_BROWSER_TOOLS[number]

export const REPLAYABLE_BROWSER_TOOLS = [
  'browser_navigate',
  'browser_snapshot',
  'browser_read_page',
  'browser_click',
  'browser_type',
  'browser_type_credential',
  'browser_press',
  'browser_scroll',
  'browser_wait',
  'browser_screenshot',
] as const

export type ReplayableBrowserTool = typeof REPLAYABLE_BROWSER_TOOLS[number]

export const BROWSER_ACTIONS = [
  'navigate',
  'snapshot',
  'read-page',
  'click',
  'press',
  'scroll',
  'wait',
  'screenshot',
] as const

export type BrowserAction = typeof BROWSER_ACTIONS[number]

export const BROWSER_ACTION_TOOL: Record<BrowserAction, SafeBrowserTool> = {
  navigate: 'browser_navigate',
  snapshot: 'browser_snapshot',
  'read-page': 'browser_read_page',
  click: 'browser_click',
  press: 'browser_press',
  scroll: 'browser_scroll',
  wait: 'browser_wait',
  screenshot: 'browser_screenshot',
}

const SENSITIVE_TARGET = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|otp|one[-_ ]?time|verification|verify[-_ ]?code|captcha)/i

export function isSafeBrowserTool(name: string): name is SafeBrowserTool {
  return (SAFE_BROWSER_TOOLS as readonly string[]).includes(name)
}

export function isReplayableBrowserTool(name: string): name is ReplayableBrowserTool {
  return (REPLAYABLE_BROWSER_TOOLS as readonly string[]).includes(name)
}

export function browserToolForAction(action: BrowserAction): SafeBrowserTool {
  return BROWSER_ACTION_TOOL[action]
}

export function assertSafePlainTextInput(stepName: string, selector: string): void {
  if (SENSITIVE_TARGET.test(stepName) || SENSITIVE_TARGET.test(selector)) {
    throw new Error('This input looks credential-like. Use patrol_type_credential with a Harness credential reference, or a manual checkpoint; plaintext typing is not recordable here.')
  }
}

export function normalizeSemanticLocator(locator: SemanticLocator | undefined): SemanticLocator | undefined {
  if (locator === undefined) return undefined
  const out: SemanticLocator = {}
  if (locator.text !== undefined && locator.text.trim() !== '') out.text = locator.text.trim()
  if (locator.role !== undefined && locator.role.trim() !== '') out.role = locator.role.trim().toLowerCase()
  if (locator.tag !== undefined && locator.tag.trim() !== '') out.tag = locator.tag.trim().toLowerCase()
  return Object.keys(out).length === 0 ? undefined : out
}

export interface SnapshotElement {
  selector?: unknown
  text?: unknown
  role?: unknown
  tag?: unknown
}

export function findUniqueHealingSelector(snapshotValue: unknown, locator: SemanticLocator): string | undefined {
  if (snapshotValue === null || typeof snapshotValue !== 'object') return undefined
  const elements = (snapshotValue as { elements?: unknown }).elements
  if (!Array.isArray(elements)) return undefined

  const normalized = normalizeSemanticLocator(locator)
  if (normalized === undefined) return undefined

  const matches = elements.filter((item): item is SnapshotElement => {
    if (item === null || typeof item !== 'object') return false
    const element = item as SnapshotElement
    if (typeof element.selector !== 'string' || element.selector.length === 0) return false
    if (normalized.text !== undefined && String(element.text ?? '').trim() !== normalized.text) return false
    if (normalized.role !== undefined && String(element.role ?? '').trim().toLowerCase() !== normalized.role) return false
    if (normalized.tag !== undefined && String(element.tag ?? '').trim().toLowerCase() !== normalized.tag) return false
    return true
  })

  if (matches.length !== 1) return undefined
  return matches[0]?.selector as string
}

export function isScreenshotStep(step: ToolStep): boolean {
  return step.tool === 'browser_screenshot'
}

export function isPageReadStep(step: ToolStep): boolean {
  return step.tool === 'browser_read_page'
}

export function selectorFromArguments(args: JsonObject): string | undefined {
  return typeof args.selector === 'string' ? args.selector : undefined
}
