import { recognizeScreenshotText } from './screenshot-ocr.js'
import { recognizeImageCodeWithDdddocr } from './image-code-ddddocr.js'
import { refreshCurrentImageCode } from './image-code-refresh-tool.js'

const IMAGE_CODE_INPUT_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|verify[-_ ]?code|verification[-_ ]?code|validation[-_ ]?code|check[-_ ]?code|auth[-_ ]?code|\bcode\b|验证码|校验码|图形码)/i
const VISUAL_NOISE_HINT = /(logo|brand|avatar|favicon|icon|qrcode|qr[-_ ]?code|二维码)/i
export const IMAGE_CODE_MIN_CONFIDENCE = 0.80
export const IMAGE_CODE_MAX_REFRESH_ATTEMPTS = 3
export const IMAGE_CODE_OCR_ENGINE_ENV = 'DSH_PATROL_IMAGE_CODE_OCR_ENGINE'
export const IMAGE_CODE_OCR_ENGINES = ['auto', 'windows', 'ddddocr']
export const WINDOWS_IMAGE_CODE_OCR_SCALE = 2

export function resolveImageCodeOcrEngine(env = process.env) {
  return normalizeImageCodeOcrEngine(env?.[IMAGE_CODE_OCR_ENGINE_ENV] ?? 'auto')
}

export function imageCodeOcrEngineOrder(mode = 'auto') {
  const normalized = normalizeImageCodeOcrEngine(mode)
  if (normalized === 'windows') return ['windows']
  if (normalized === 'ddddocr') return ['ddddocr']
  return ['windows', 'ddddocr']
}

export function imageCodeCaptureArgsForEngine(engine, args = {}) {
  const normalized = normalizeConcreteImageCodeOcrEngine(engine)
  const captureArgs = { ...args }
  if (normalized === 'windows') captureArgs.visualScale = WINDOWS_IMAGE_CODE_OCR_SCALE
  else delete captureArgs.visualScale
  return captureArgs
}

export async function runImageCodeOcrPolicy({ mode = 'auto', windowsOcr, ddddocrOcr } = {}) {
  for (const engine of imageCodeOcrEngineOrder(mode)) {
    const recognize = engine === 'windows' ? windowsOcr : ddddocrOcr
    if (typeof recognize !== 'function') continue
    const code = await recognize()
    if (isStrongImageCode(code)) return { engine, code }
  }
  return { engine: 'none', code: '' }
}

export async function tryFillImageCode(bridge, tabId, options = {}) {
  if (process.platform !== 'win32') return false

  const diagnostics = []
  const ocrMode = currentImageCodeOcrEngine(options)
  diagnostics.push(`ocr-mode=${ocrMode}; order=${imageCodeOcrEngineOrder(ocrMode).join('>')}`)
  let inputSelector = ''

  for (let refreshAttempt = 0; refreshAttempt <= IMAGE_CODE_MAX_REFRESH_ATTEMPTS; refreshAttempt += 1) {
    const current = await recognizeCurrentImageCode(bridge, tabId, options, diagnostics)
    if (current.inputSelector) inputSelector = current.inputSelector

    if (inputSelector && isPlausibleImageCode(current.code)) {
      const typed = await bridge.request('type', {
        selector: inputSelector,
        text: current.code,
        clear: true,
        tabId,
      }, options)
      if (!typed || typeof typed !== 'object' || typed.ok === false) {
        throw new Error(`recognized image code but browser typing failed: ${shortDiagnostic(typed?.error || 'invalid type result')}`)
      }

      // Recognition/fill only. The deterministic Runbook owns form submission.
      return true
    }

    if (refreshAttempt >= IMAGE_CODE_MAX_REFRESH_ATTEMPTS) break

    try {
      const refreshed = await refreshCurrentImageCode(bridge, {
        tabId,
        inputSelector,
        allowPageReload: false,
      }, options)
      if (!refreshed || refreshed.changed !== true) {
        diagnostics.push(`captcha refresh ${refreshAttempt + 1}: no independently refreshable image-code target changed`)
        break
      }
      inputSelector = refreshed.inputSelector || inputSelector
      diagnostics.push(`captcha refresh ${refreshAttempt + 1}: method=${refreshed.method}${refreshed.selector ? ` selector=${refreshed.selector}` : ''}; previous OCR guess discarded`)
    } catch (error) {
      diagnostics.push(`captcha refresh ${refreshAttempt + 1}: ${shortDiagnostic(error)}`)
      break
    }
  }

  throw new Error(`image-code recognition exhausted confidence-qualified paths after at most ${IMAGE_CODE_MAX_REFRESH_ATTEMPTS} CAPTCHA refreshes: ${diagnostics.filter(Boolean).slice(0, 32).join(' | ') || 'no diagnostic detail'}`)
}

async function recognizeCurrentImageCode(bridge, tabId, options, diagnostics) {
  const mode = currentImageCodeOcrEngine(options)
  let inputSelector = ''

  // Engine ordering is policy only. Every engine owns its entire capture and
  // recognition pipeline so image preparation for one OCR method cannot alter,
  // validate, veto, or otherwise influence another method.
  for (const engine of imageCodeOcrEngineOrder(mode)) {
    diagnostics.push(`${engine}: pipeline-start`)
    const current = await recognizeCurrentImageCodeWithEngine(bridge, tabId, engine, options, diagnostics)
    if (current.inputSelector) inputSelector = current.inputSelector
    if (isStrongImageCode(current.code)) {
      diagnostics.push(`${engine}: pipeline-success`)
      return current
    }
    diagnostics.push(`${engine}: pipeline-exhausted`)
  }

  return { inputSelector, code: '' }
}

async function recognizeCurrentImageCodeWithEngine(bridge, tabId, engine, options, diagnostics) {
  let inputSelector = ''
  let code = ''
  const captureArgs = imageCodeCaptureArgsForEngine(engine, { tabId })

  // Primary engine-owned capture. Windows OCR intentionally receives the same
  // 2x nearest-neighbour enlargement used by the previously working dedicated
  // Windows OCR tool. ddddocr receives the original CAPTCHA bytes because its
  // Python helper already owns its preprocessing/upscale ensemble.
  try {
    const captured = await bridge.request('captureImageCode', captureArgs, options)
    if (!captured || typeof captured !== 'object' || captured.ok === false) {
      diagnostics.push(`${engine}: primary-capture failed (${shortDiagnostic(captured?.error || 'invalid capture result')})`)
    } else if (typeof captured.dataUrl !== 'string' || typeof captured.inputSelector !== 'string') {
      diagnostics.push(`${engine}: primary-capture missing image bytes/input selector`)
    } else if (!await isExplicitImageCodeInput(bridge, captured.inputSelector, tabId, options)) {
      diagnostics.push(`${engine}: primary-capture input selector was not verified`)
    } else {
      inputSelector = captured.inputSelector
      const captureMode = typeof captured.captureMode === 'string' ? captured.captureMode : 'unknown'
      diagnostics.push(`${engine}: primary-capture mode=${captureMode}; scale=${engine === 'windows' ? WINDOWS_IMAGE_CODE_OCR_SCALE : 1}; bytes=${Number(captured.bytes || 0)}`)
      code = await recognizeCapturedImageCodeWithEngine(engine, captured.dataUrl, captureMode, options, diagnostics)
      if (!isStrongImageCode(code)) code = ''
    }
  } catch (error) {
    diagnostics.push(`${engine}: primary-capture exception (${shortDiagnostic(error)})`)
  }

  if (isStrongImageCode(code)) return { inputSelector, code }

  const alternative = await recognizeImageCodeFromVisualCandidatesWithEngine(
    bridge,
    tabId,
    engine,
    inputSelector,
    options,
    diagnostics,
  )
  if (alternative) return alternative

  const pageFallback = await recognizeImageCodeFromPageWithEngine(
    bridge,
    tabId,
    engine,
    inputSelector,
    options,
    diagnostics,
  )
  if (pageFallback) return pageFallback

  return { inputSelector, code: '' }
}

async function recognizeCapturedImageCodeWithEngine(engine, dataUrl, captureMode, options, diagnostics, knownText = '') {
  if (engine === 'windows') {
    return await recognizeCapturedImageCodeWithWindowsOcr(dataUrl, captureMode, options, diagnostics, knownText)
  }
  if (engine === 'ddddocr') {
    return await recognizeCapturedImageCodeWithDdddocr(dataUrl, captureMode, options, diagnostics, knownText)
  }
  throw new Error(`unsupported image-code OCR engine: ${engine}`)
}

export async function recognizeCapturedImageCodeWithWindowsOcr(dataUrl, captureMode = 'capture', options = {}, diagnostics = [], knownText = '') {
  try {
    const recognized = await recognizeScreenshotText(dataUrl, { signal: options.signal })
    if (recognized?.status !== 'recognized' || !recognized.text) {
      diagnostics.push(`windows-ocr(${captureMode}): status=${shortDiagnostic(recognized?.status || 'no-text')}`)
      return ''
    }
    const code = selectImageCodeCandidate(recognized.text, knownText)
    if (!isStrongImageCode(code)) {
      diagnostics.push(`windows-ocr(${captureMode}): OCR returned text but no strong standalone image-code candidate`)
      return ''
    }
    diagnostics.push(`windows-ocr(${captureMode}): strong standalone candidate accepted; rawChars=${String(recognized.text).length}`)
    return code
  } catch (error) {
    diagnostics.push(`windows-ocr(${captureMode}): exception=${shortDiagnostic(error)}`)
    return ''
  }
}

export async function recognizeCapturedImageCodeWithDdddocr(dataUrl, captureMode = 'capture', options = {}, diagnostics = [], knownText = '') {
  try {
    const ddddocr = await recognizeImageCodeWithDdddocr(dataUrl, options)
    if (ddddocr?.ok !== true || typeof ddddocr.text !== 'string') {
      diagnostics.push(`ddddocr(${captureMode}): ${shortDiagnostic(ddddocr?.error || 'no plausible text')}`)
      return ''
    }
    const code = normalizeImageCodeText(ddddocr.text)
    const confidence = imageCodeConfidence(ddddocr)
    const comparable = cleanupComparable(code)
    const unseen = !knownText || Boolean(comparable && !cleanupComparable(knownText).includes(comparable))
    if (!isStrongImageCode(code) || !unseen) {
      diagnostics.push(`ddddocr(${captureMode}): candidate rejected by standalone format/page-text checks; confidence=${confidence.toFixed(3)}; support=${Number(ddddocr.support || 0)}`)
      return ''
    }
    if (confidence < IMAGE_CODE_MIN_CONFIDENCE) {
      diagnostics.push(`ddddocr(${captureMode}): confidence=${confidence.toFixed(3)} below ${IMAGE_CODE_MIN_CONFIDENCE.toFixed(2)}; support=${Number(ddddocr.support || 0)}; variant=${shortDiagnostic(ddddocr.variant || 'unknown')}`)
      return ''
    }
    diagnostics.push(`ddddocr(${captureMode}): accepted independently; confidence=${confidence.toFixed(3)}; support=${Number(ddddocr.support || 0)}; variant=${shortDiagnostic(ddddocr.variant || 'unknown')}`)
    return code
  } catch (error) {
    diagnostics.push(`ddddocr(${captureMode}): exception=${shortDiagnostic(error)}`)
    return ''
  }
}

async function recognizeImageCodeFromVisualCandidatesWithEngine(bridge, tabId, engine, preferredInputSelector, options, diagnostics) {
  let snapshot
  try {
    snapshot = await bridge.request('snapshot', {
      maxElements: 300,
      includeHidden: false,
      tabId,
    }, options)
  } catch (error) {
    diagnostics.push(`${engine}: alternate-snapshot failed (${shortDiagnostic(error)})`)
    return undefined
  }

  const inputSelector = preferredInputSelector || findExplicitImageCodeInputSelector(snapshot)
  if (!inputSelector) {
    diagnostics.push(`${engine}: alternate-crops skipped (no explicit image-code input)`)
    return undefined
  }
  const selectors = findVisualImageCodeCandidateSelectors(snapshot, inputSelector).slice(0, 8)
  if (selectors.length === 0) {
    diagnostics.push(`${engine}: alternate-crops skipped (no visual candidates)`)
    return undefined
  }

  let captures = 0
  let recognized = 0
  let lastError = ''
  for (const imageSelector of selectors) {
    let captured
    try {
      captured = await bridge.request('captureImageCode', imageCodeCaptureArgsForEngine(engine, {
        tabId,
        inputSelector,
        imageSelector,
      }), options)
    } catch (error) {
      lastError = shortDiagnostic(error)
      continue
    }
    if (!captured || typeof captured !== 'object' || captured.ok === false || typeof captured.dataUrl !== 'string') {
      lastError = shortDiagnostic(captured?.error || 'invalid capture result')
      continue
    }
    captures += 1

    const captureMode = `alternate:${typeof captured.captureMode === 'string' ? captured.captureMode : 'element-crop'}`
    const candidate = await recognizeCapturedImageCodeWithEngine(engine, captured.dataUrl, captureMode, options, diagnostics)
    if (isStrongImageCode(candidate)) {
      recognized += 1
      diagnostics.push(`${engine}: alternate-crops success after ${captures}/${selectors.length} capture(s)`)
      return { inputSelector, code: candidate }
    }
  }

  diagnostics.push(`${engine}: alternate-crops exhausted candidates=${selectors.length}; captured=${captures}; recognized=${recognized}${lastError ? `; lastError=${lastError}` : ''}`)
  return undefined
}

async function recognizeImageCodeFromPageWithEngine(bridge, tabId, engine, preferredInputSelector, options, diagnostics = []) {
  let snapshot
  try {
    snapshot = await bridge.request('snapshot', {
      maxElements: 300,
      includeHidden: false,
      tabId,
    }, options)
  } catch (error) {
    diagnostics.push(`${engine}: page-fallback snapshot failed (${shortDiagnostic(error)})`)
    return undefined
  }

  const inputSelector = preferredInputSelector || findExplicitImageCodeInputSelector(snapshot)
  if (!inputSelector) {
    diagnostics.push(`${engine}: page-fallback skipped (no explicit image-code input)`)
    return undefined
  }

  let shot
  try {
    shot = await bridge.request('screenshot', { tabId, format: 'png' }, options)
  } catch (error) {
    diagnostics.push(`${engine}: page-fallback screenshot failed (${shortDiagnostic(error)})`)
    return undefined
  }
  if (!shot || typeof shot !== 'object' || shot.ok === false || typeof shot.dataUrl !== 'string') {
    diagnostics.push(`${engine}: page-fallback screenshot returned no PNG data`)
    return undefined
  }

  let knownText = snapshotText(snapshot)
  try {
    const page = await bridge.request('readPage', { maxChars: 16000, tabId }, options)
    if (page && typeof page === 'object' && page.ok !== false && typeof page.text === 'string') {
      knownText += `\n${page.text}`
    }
  } catch (error) {
    diagnostics.push(`${engine}: page-fallback readPage unavailable (${shortDiagnostic(error)})`)
  }

  const candidate = await recognizeCapturedImageCodeWithEngine(engine, shot.dataUrl, 'page', options, diagnostics, knownText)
  if (!isStrongImageCode(candidate)) {
    diagnostics.push(`${engine}: page-fallback produced no strong unseen candidate`)
    return undefined
  }
  diagnostics.push(`${engine}: page-fallback success`)
  return { inputSelector, code: candidate }
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

export function imageCodeConfidence(result) {
  const value = Number(result?.confidence)
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}

function currentImageCodeOcrEngine(options = {}) {
  if (options.imageCodeOcrEngine !== undefined) return normalizeImageCodeOcrEngine(options.imageCodeOcrEngine)
  return resolveImageCodeOcrEngine()
}

function normalizeImageCodeOcrEngine(value) {
  const requested = String(value ?? 'auto').trim().toLowerCase()
  if (!requested || requested === 'auto') return 'auto'
  if (requested === 'windows' || requested === 'windows-system-ocr') return 'windows'
  if (requested === 'ddddocr') return 'ddddocr'
  throw new Error(`Unsupported ${IMAGE_CODE_OCR_ENGINE_ENV} value "${requested}". Expected one of: ${IMAGE_CODE_OCR_ENGINES.join(', ')}.`)
}

function normalizeConcreteImageCodeOcrEngine(value) {
  const normalized = normalizeImageCodeOcrEngine(value)
  if (normalized === 'auto') throw new Error('imageCodeCaptureArgsForEngine requires a concrete OCR engine')
  return normalized
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
