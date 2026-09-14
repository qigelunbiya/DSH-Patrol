import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { JsonObject, JsonValue, TextExpectation } from './types.js'

export interface PostClickDispatchResult {
  ok: boolean
  text: string
  value?: JsonValue
  error?: string
}

export type PostClickDispatch = (
  tool: string,
  args: JsonObject,
  exec: ToolRunContext,
) => Promise<PostClickDispatchResult>

export interface PostClickVerificationResult {
  ok: boolean
  text: string
  attempts: number
  error?: string
}

const DEFAULT_RETRY_DELAYS_MS = [0, 140, 320, 700] as const

/**
 * A click can destroy the content-script context that executed it, or it can
 * return before an SPA/legacy portal has finished replacing its iframe/menu.
 * Login, SSO, location.replace(), delayed Angular handlers and iframe rebuilds
 * are common examples.
 *
 * Retry both transient transport errors AND a bounded sequence of successful
 * reads that still show the old state. Verification considers visible body text
 * together with the CURRENT page title and decoded URL. Detail pages opened in
 * a new tab often expose their strongest business identity in title/URL while
 * the body still contains only an application shell.
 */
export async function verifyPostClickExpectation(
  dispatch: PostClickDispatch,
  exec: ToolRunContext,
  expectation: TextExpectation,
  tabId?: number,
  retryDelaysMs: readonly number[] = DEFAULT_RETRY_DELAYS_MS,
): Promise<PostClickVerificationResult> {
  const delays = retryDelaysMs.length > 0 ? retryDelaysMs : [0]
  let lastError = 'post-click page could not be read'
  let lastText = ''

  for (let index = 0; index < delays.length; index += 1) {
    const delayMs = Math.max(0, Number(delays[index] ?? 0))
    if (delayMs > 0) await sleep(delayMs)

    const args: JsonObject = tabId === undefined ? {} : { tabId }
    const observed = await dispatch('browser_read_page', args, exec)
    if (!observed.ok) {
      lastError = observed.error ?? observed.text ?? 'browser_read_page failed'
      continue
    }

    const text = outputText(observed.value, observed.text)
    lastText = text
    const expectationError = evaluateTextExpectation(text, expectation)
    if (expectationError === undefined) {
      return { ok: true, text, attempts: index + 1 }
    }

    lastError = expectationError
  }

  return {
    ok: false,
    text: lastText,
    attempts: delays.length,
    error: lastText
      ? `${lastError} after ${delays.length} bounded post-click reads`
      : `post-click page remained unavailable after ${delays.length} bounded attempts: ${lastError}`,
  }
}

export function evaluateTextExpectation(text: string, expectation: TextExpectation): string | undefined {
  const haystack = expectation.caseSensitive ? text : text.toLocaleLowerCase()
  const needle = expectation.caseSensitive ? expectation.value : expectation.value.toLocaleLowerCase()
  const found = haystack.includes(needle)
  if (expectation.mode === 'contains' && !found) {
    return `expected post-click page to contain ${JSON.stringify(expectation.value)}`
  }
  if (expectation.mode === 'not-contains' && found) {
    return `expected post-click page not to contain ${JSON.stringify(expectation.value)}`
  }
  return undefined
}

function outputText(value: JsonValue | undefined, fallback: string | undefined): string {
  if (value !== null && value !== undefined && typeof value === 'object' && !Array.isArray(value)) {
    const object = value as JsonObject
    const text = typeof object.text === 'string' ? object.text : ''
    const title = typeof object.title === 'string' ? object.title : ''
    const url = typeof object.url === 'string' ? readableUrl(object.url) : ''
    const combined = [text, title, url].filter(Boolean).join('\n')
    if (combined) return combined
  }
  return fallback ?? ''
}

function readableUrl(value: string): string {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
