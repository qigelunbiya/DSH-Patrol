import { recognizeScreenshotText } from './screenshot-ocr.js'
import { recognizeImageCodeWithDdddocr } from './image-code-ddddocr.js'

const IMAGE_CODE_INPUT_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|verify[-_ ]?code|verification[-_ ]?code|validation[-_ ]?code|check[-_ ]?code|auth[-_ ]?code|\bcode\b|验证码|校验码|图形码)/i

export async function tryFillImageCode(bridge, tabId, options = {}) {
  if (process.platform !== 'win32') return false

  let inputSelector
  let code = ''

  // Primary path: let the extension identify and crop the small captcha image.
  // Prefer ddddocr on that clean crop because it is much better than general
  // Windows OCR on distorted 4-6 character legacy image codes. If the optional
  // ddddocr runtime is unavailable or uncertain, fall back to system OCR.
  try {
    const captured = await bridge.request('captureImageCode', { tabId }, options)
    if (captured
      && typeof captured === 'object'
      && captured.ok !== false
      && typeof captured.dataUrl === 'string'
      && typeof captured.inputSelector === 'string'
      && await isExplicitImageCodeInput(bridge, captured.inputSelector, tabId, options)) {
      inputSelector = captured.inputSelector

      try {
        const ddddocr = await recognizeImageCodeWithDdddocr(captured.dataUrl, options)
        if (ddddocr?.ok === true && typeof ddddocr.text === 'string') {
          code = normalizeImageCodeText(ddddocr.text)
        }
      } catch {
      }

      if (!isPlausibleImageCode(code)) {
        const recognized = await recognizeScreenshotText(captured.dataUrl, { signal: options.signal })
        code = selectImageCodeCandidate(recognized?.text ?? '')
      }
    }
  } catch {
    // Fall through to the page-level OCR recovery path below. A common legacy
    // layout has a clearly named #captcha input but a generic adjacent <img>
    // with no captcha/id/class hint. content.js now finds that image by spatial
    // proximity, but this whole-page recovery remains as a final fallback.
  }

  if (!inputSelector || !isPlausibleImageCode(code)) {
    const fallback = await recognizeImageCodeFromPage(bridge, tabId, options)
    if (!fallback) return false
    inputSelector = fallback.inputSelector
    code = fallback.code
  }

  if (!inputSelector || !isPlausibleImageCode(code)) return false
  const typed = await bridge.request('type', {
    selector: inputSelector,
    text: code,
    clear: true,
    tabId,
  }, options)
  if (!typed || typeof typed !== 'object' || typed.ok === false) return false

  // Do not press Enter here. Image-code solving owns only recognition/fill;
  // the deterministic Runbook keeps responsibility for the observed Login/
  // Submit button. This prevents OCR from unexpectedly submitting a partially
  // taught form or double-submitting before the recorded click step.
  return true
}

async function recognizeImageCodeFromPage(bridge, tabId, options) {
  let snapshot
  try {
    snapshot = await bridge.request('snapshot', {
      maxElements: 300,
      includeHidden: false,
      tabId,
    }, options)
  } catch {
    return undefined
  }

  const inputSelector = findExplicitImageCodeInputSelector(snapshot)
  if (!inputSelector) return undefined

  let shot
  try {
    shot = await bridge.request('screenshot', { tabId, format: 'png' }, options)
  } catch {
    return undefined
  }
  if (!shot || typeof shot !== 'object' || shot.ok === false || typeof shot.dataUrl !== 'string') return undefined

  let knownText = snapshotText(snapshot)
  try {
    const page = await bridge.request('readPage', { maxChars: 16000, tabId }, options)
    if (page && typeof page === 'object' && page.ok !== false && typeof page.text === 'string') {
      knownText += `\n${page.text}`
    }
  } catch {
  }

  let recognized
  try {
    recognized = await recognizeScreenshotText(shot.dataUrl, { signal: options.signal })
  } catch {
    return undefined
  }
  if (recognized?.status !== 'recognized' || !recognized.text) return undefined

  const code = selectImageCodeCandidate(recognized.text, knownText)
  return isPlausibleImageCode(code) ? { inputSelector, code } : undefined
}

export function findExplicitImageCodeInputSelector(snapshot) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : []
  const scored = []
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    if (!element || typeof element !== 'object' || typeof element.selector !== 'string') continue
    const hint = [element.selector, element.name, element.text, element.type]
      .filter(value => typeof value === 'string')
      .join(' ')
    if (!IMAGE_CODE_INPUT_HINT.test(hint)) continue
    const editable = !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(String(element.type || '').toLowerCase())
    if (!editable) continue
    let score = 10
    if (/captcha|验证码/i.test(String(element.selector))) score += 8
    if (/captcha|验证码/i.test(String(element.name || ''))) score += 5
    if (String(element.type || '').toLowerCase() === 'text') score += 2
    scored.push({ selector: element.selector, score, index })
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return scored[0]?.selector
}

export function selectImageCodeCandidate(value, knownText = '') {
  const rawLines = String(value || '')
    .replace(/\u0000/g, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
  const known = cleanupComparable(knownText)
  const candidates = []

  for (let index = 0; index < rawLines.length; index += 1) {
    const raw = rawLines[index]
    const compact = cleanupLine(raw)
    if (compact.length < 2 || compact.length > 16) continue
    if (!/[\p{L}\p{N}]/u.test(compact)) continue
    const comparable = cleanupComparable(compact)
    if (comparable.length >= 3 && known.includes(comparable)) continue
    candidates.push({ value: compact, score: scoreCandidate(compact, raw), index })
  }

  candidates.sort((left, right) => right.score - left.score || left.index - right.index)
  if (candidates[0]) return candidates[0].value

  return normalizeImageCodeText(value)
}

export function normalizeImageCodeText(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(line => cleanupLine(line))
    .filter(Boolean)
  const plausible = lines
    .filter(line => line.length >= 2 && line.length <= 16)
    .sort((left, right) => scoreCandidate(right, right) - scoreCandidate(left, left))
  if (plausible[0]) return plausible[0]
  const compact = cleanupLine(String(value || '').replace(/\s+/g, ''))
  return compact.length >= 2 && compact.length <= 16 ? compact : ''
}

async function isExplicitImageCodeInput(bridge, selector, tabId, options) {
  let snapshot
  try {
    snapshot = await bridge.request('snapshot', {
      maxElements: 300,
      includeHidden: false,
      tabId,
    }, options)
  } catch {
    return false
  }
  return findExplicitImageCodeInputSelector(snapshot) === selector
    || Array.isArray(snapshot?.elements) && snapshot.elements.some(element => {
      if (!element || typeof element !== 'object' || element.selector !== selector) return false
      const hint = [element.selector, element.name, element.text, element.type]
        .filter(value => typeof value === 'string')
        .join(' ')
      return IMAGE_CODE_INPUT_HINT.test(hint)
    })
}

function snapshotText(snapshot) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : []
  return elements.map(element => [element?.text, element?.name, element?.value]
    .filter(value => typeof value === 'string')
    .join(' '))
    .filter(Boolean)
    .join('\n')
}

function cleanupLine(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/^["'`“”‘’.,，。:：;；|_\-]+|["'`“”‘’.,，。:：;；|_\-]+$/g, '')
}

function cleanupComparable(value) {
  return String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]/gu, '')
    .toLocaleLowerCase()
}

function scoreCandidate(value, raw) {
  let score = 0
  const asciiAlpha = (value.match(/[A-Za-z]/g) || []).length
  const digits = (value.match(/[0-9]/g) || []).length
  const unicodeAlphaNumeric = (value.match(/[\p{L}\p{N}]/gu) || []).length
  const symbols = Math.max(0, value.length - unicodeAlphaNumeric)

  score += unicodeAlphaNumeric * 4
  score -= symbols * 5
  score -= Math.abs(value.length - 5) * 3
  if (value.length >= 4 && value.length <= 8) score += 14
  if (asciiAlpha > 0) score += 8
  if (digits > 0 && asciiAlpha > 0) score += 10
  if (asciiAlpha > 0 && value.replace(/[^A-Za-z]/g, '') === value.replace(/[^A-Za-z]/g, '').toUpperCase()) score += 5
  if (/^(?:[A-Za-z0-9]\s+){2,}[A-Za-z0-9]$/.test(String(raw).trim())) score += 12
  if (/^(?:login|password|captcha|username|verify|code|登录|密码|验证码)$/i.test(value)) score -= 40
  return score
}

function isPlausibleImageCode(value) {
  return value.length >= 2
    && value.length <= 16
    && /[\p{L}\p{N}]/u.test(value)
}
