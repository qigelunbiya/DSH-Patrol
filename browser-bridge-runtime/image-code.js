import { recognizeScreenshotText } from './screenshot-ocr.js'
import { recognizeImageCodeWithDdddocr } from './image-code-ddddocr.js'

const IMAGE_CODE_INPUT_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|verify[-_ ]?code|verification[-_ ]?code|validation[-_ ]?code|check[-_ ]?code|auth[-_ ]?code|\bcode\b|验证码|校验码|图形码)/i
const VISUAL_NOISE_HINT = /(logo|brand|avatar|favicon|icon|qrcode|qr[-_ ]?code|二维码)/i

export async function tryFillImageCode(bridge, tabId, options = {}) {
  if (process.platform !== 'win32') return false

  let inputSelector
  let code = ''
  const diagnostics = []

  // Primary path: ask the extension for the cleanest visual captcha capture.
  // Newer extensions can return the original data:image bytes directly; older
  // ones return an element crop. Either way ddddocr gets a captcha-sized image
  // instead of a whole login-page screenshot.
  try {
    const captured = await bridge.request('captureImageCode', { tabId }, options)
    if (!captured || typeof captured !== 'object' || captured.ok === false) {
      diagnostics.push(`captureImageCode: ${shortDiagnostic(captured?.error || 'invalid capture result')}`)
    } else if (typeof captured.dataUrl !== 'string' || typeof captured.inputSelector !== 'string') {
      diagnostics.push('captureImageCode: missing image bytes or input selector')
    } else if (!await isExplicitImageCodeInput(bridge, captured.inputSelector, tabId, options)) {
      diagnostics.push(`captureImageCode: ${captured.inputSelector} was not verified as the explicit image-code input`)
    } else {
      inputSelector = captured.inputSelector
      const captureMode = typeof captured.captureMode === 'string' ? captured.captureMode : 'unknown'
      code = await recognizeCapturedImageCode(captured.dataUrl, captureMode, options, diagnostics)
      if (!isStrongImageCode(code)) {
        if (isPlausibleImageCode(code)) diagnostics.push(`${captureMode}: weak candidate rejected`)
        code = ''
      }
    }
  } catch (error) {
    diagnostics.push(`captureImageCode: ${shortDiagnostic(error)}`)
  }

  // Aggressive visual recovery: when the extension's single best guess is not
  // readable, enumerate other small visual regions from the same page and crop
  // them one-by-one against the already verified captcha input. This handles
  // legacy pages where the code is rendered as a generic image/background or
  // the nearest-media heuristic picks the wrong element.
  if (!isPlausibleImageCode(code)) {
    const alternative = await recognizeImageCodeFromVisualCandidates(bridge, tabId, inputSelector, options, diagnostics)
    if (alternative) {
      inputSelector = alternative.inputSelector
      code = alternative.code
    }
  }

  // Final recovery: whole-page system OCR. This remains useful for legacy
  // pages where the captcha input is explicit but all visual-element discovery
  // failed. The extension normally reaches this path only after direct source,
  // element crop, input-neighbor visual crop, and alternate visual crops fail.
  if (!inputSelector || !isPlausibleImageCode(code)) {
    const fallback = await recognizeImageCodeFromPage(bridge, tabId, options, diagnostics)
    if (fallback) {
      inputSelector = fallback.inputSelector
      code = fallback.code
    } else {
      diagnostics.push('page-level OCR: no plausible image-code candidate')
    }
  }

  if (!inputSelector || !isPlausibleImageCode(code)) {
    throw new Error(`image-code recognition exhausted automatic paths: ${diagnostics.filter(Boolean).slice(0, 12).join(' | ') || 'no diagnostic detail'}`)
  }

  const typed = await bridge.request('type', {
    selector: inputSelector,
    text: code,
    clear: true,
    tabId,
  }, options)
  if (!typed || typeof typed !== 'object' || typed.ok === false) {
    throw new Error(`recognized image code but browser typing failed: ${shortDiagnostic(typed?.error || 'invalid type result')}`)
  }

  // Recognition/fill only. The deterministic Runbook owns form submission.
  return true
}

async function recognizeCapturedImageCode(dataUrl, captureMode, options, diagnostics) {
  let code = ''
  try {
    const ddddocr = await recognizeImageCodeWithDdddocr(dataUrl, options)
    if (ddddocr?.ok === true && typeof ddddocr.text === 'string') {
      code = normalizeImageCodeText(ddddocr.text)
      if (!isPlausibleImageCode(code)) diagnostics.push(`ddddocr(${captureMode}): returned implausible text`)
    } else {
      diagnostics.push(`ddddocr(${captureMode}): ${shortDiagnostic(ddddocr?.error || 'no plausible text')}`)
    }
  } catch (error) {
    diagnostics.push(`ddddocr(${captureMode}): ${shortDiagnostic(error)}`)
  }

  if (!isPlausibleImageCode(code)) {
    try {
      const recognized = await recognizeScreenshotText(dataUrl, { signal: options.signal })
      code = selectImageCodeCandidate(recognized?.text ?? '')
      if (!isPlausibleImageCode(code)) {
        diagnostics.push(`windows-ocr(${captureMode}): ${shortDiagnostic(recognized?.status || 'no plausible text')}`)
      }
    } catch (error) {
      diagnostics.push(`windows-ocr(${captureMode}): ${shortDiagnostic(error)}`)
    }
  }
  return code
}

async function recognizeImageCodeFromVisualCandidates(bridge, tabId, preferredInputSelector, options, diagnostics) {
  let snapshot
  try {
    snapshot = await bridge.request('snapshot', {
      maxElements: 300,
      includeHidden: false,
      tabId,
    }, options)
  } catch (error) {
    diagnostics.push(`alternate visual snapshot: ${shortDiagnostic(error)}`)
    return undefined
  }

  const inputSelector = preferredInputSelector || findExplicitImageCodeInputSelector(snapshot)
  if (!inputSelector) return undefined
  const selectors = findVisualImageCodeCandidateSelectors(snapshot, inputSelector).slice(0, 8)
  if (selectors.length === 0) return undefined

  for (const imageSelector of selectors) {
    let captured
    try {
      captured = await bridge.request('captureImageCode', {
        tabId,
        inputSelector,
        imageSelector,
      }, options)
    } catch (error) {
      diagnostics.push(`alternate crop ${imageSelector}: ${shortDiagnostic(error)}`)
      continue
    }
    if (!captured || typeof captured !== 'object' || captured.ok === false || typeof captured.dataUrl !== 'string') {
      diagnostics.push(`alternate crop ${imageSelector}: invalid capture result`)
      continue
    }

    const captureMode = `alternate:${typeof captured.captureMode === 'string' ? captured.captureMode : 'element-crop'}`
    const candidate = await recognizeCapturedImageCode(captured.dataUrl, captureMode, options, diagnostics)
    if (isStrongImageCode(candidate)) return { inputSelector, code: candidate }
    if (isPlausibleImageCode(candidate)) diagnostics.push(`${captureMode}: weak candidate rejected`)
  }
  return undefined
}

async function recognizeImageCodeFromPage(bridge, tabId, options, diagnostics = []) {
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

  try {
    const recognized = await recognizeScreenshotText(shot.dataUrl, { signal: options.signal })
    if (recognized?.status === 'recognized' && recognized.text) {
      const code = selectImageCodeCandidate(recognized.text, knownText)
      if (isStrongImageCode(code)) return { inputSelector, code }
      if (isPlausibleImageCode(code)) diagnostics.push('page-level Windows OCR: weak candidate rejected')
    }
  } catch (error) {
    diagnostics.push(`page-level Windows OCR: ${shortDiagnostic(error)}`)
  }

  // Last resort: let the captcha-specific recognizer inspect the visible page
  // screenshot. It is deliberately accepted only with a strong, previously
  // unseen alphanumeric result to avoid typing ordinary login-page text.
  try {
    const ddddocr = await recognizeImageCodeWithDdddocr(shot.dataUrl, options)
    if (ddddocr?.ok === true && typeof ddddocr.text === 'string') {
      const code = normalizeImageCodeText(ddddocr.text)
      const comparable = cleanupComparable(code)
      if (isStrongImageCode(code) && comparable && !cleanupComparable(knownText).includes(comparable)) {
        return { inputSelector, code }
      }
      diagnostics.push('page-level ddddocr: returned no strong unseen candidate')
    } else {
      diagnostics.push(`page-level ddddocr: ${shortDiagnostic(ddddocr?.error || 'no plausible text')}`)
    }
  } catch (error) {
    diagnostics.push(`page-level ddddocr: ${shortDiagnostic(error)}`)
  }
  return undefined
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

export function findVisualImageCodeCandidateSelectors(snapshot, inputSelector = '') {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : []
  const scored = []
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    if (!element || typeof element !== 'object' || typeof element.selector !== 'string') continue
    if (element.selector === inputSelector) continue
    const text = String(element.text || '')
    const tag = String(element.tag || '').toLowerCase()
    if (!text.startsWith('visual:') && !['img', 'canvas', 'svg'].includes(tag)) continue

    const hint = `${element.selector} ${element.name || ''} ${text}`
    let score = 0
    if (IMAGE_CODE_INPUT_HINT.test(hint)) score += 18
    if (tag === 'canvas') score += 8
    else if (tag === 'img') score += 5
    else if (tag === 'svg') score += 3
    else if (text.startsWith('visual:')) score += 2

    const dimensions = /(\d{2,4})x(\d{2,4})(?:\s|$)/.exec(text)
    if (dimensions) {
      const width = Number(dimensions[1])
      const height = Number(dimensions[2])
      if (width >= 35 && width <= 500 && height >= 18 && height <= 220) score += 9
      if (width >= 60 && width <= 260 && height >= 24 && height <= 100) score += 5
    }
    if (VISUAL_NOISE_HINT.test(hint)) score -= 30
    if (score >= 8) scored.push({ selector: element.selector, score, index })
  }
  scored.sort((left, right) => right.score - left.score || left.index - right.index)
  return [...new Set(scored.map(item => item.selector))]
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

function isStrongImageCode(value) {
  return value.length >= 3
    && value.length <= 8
    && /^[A-Za-z0-9]+$/.test(value)
    && !/^(?:login|password|captcha|username|verify|code)$/i.test(value)
}

function isPlausibleImageCode(value) {
  return value.length >= 2
    && value.length <= 16
    && /[\p{L}\p{N}]/u.test(value)
}

function shortDiagnostic(value) {
  const text = value instanceof Error ? value.message : String(value || '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 220)
}
