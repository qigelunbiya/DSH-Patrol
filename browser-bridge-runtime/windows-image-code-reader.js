import { findExplicitImageCodeInputSelector, selectImageCodeCandidate } from './image-code.js'
import { recognizeScreenshotText } from './screenshot-ocr.js'

const STALE_TAB_ERROR = /no tab with id|page bridge unavailable|receiving end does not exist|could not establish connection|message port closed|frame with id .* was removed/i
const STRONG_IMAGE_CODE = /^[A-Za-z0-9]{3,8}$/

/**
 * Read the CURRENT conventional image-code CAPTCHA using Windows System OCR.
 *
 * This is intentionally shared by both the interactive TEST-mode reader and the
 * replay-time auth challenge solver. Keeping one implementation prevents the
 * two paths from drifting back to different OCR priorities.
 */
export async function readCurrentImageCodeWithWindowsOcr(bridge, args = {}, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const signal = config.signal
  if (process.platform !== 'win32') return emptyResult('unsupported-platform', args, args.tabId)

  const requestOptions = { timeoutMs, signal }
  const capture = async (tabId, visualScale) => await bridge.request('captureImageCode', {
    tabId,
    // Always rediscover the CURRENT target. Persisted image/input selectors can
    // become stale across reloads and are deliberately not forwarded here.
    visualScale,
  }, requestOptions)

  let captured
  let captureError = ''
  let currentTabId = args.tabId

  // Windows OCR is sensitive to tiny stylized glyphs. Keep the proven 2x PNG
  // rasterization first, then make one 3x retry before escalating to whole-page
  // OCR. This is still the same CURRENT CAPTCHA; no refresh occurs here.
  for (const visualScale of [2, 3]) {
    try {
      captured = await capture(currentTabId, visualScale)
      captureError = ''
    } catch (error) {
      captureError = error instanceof Error ? error.message : String(error)
      if (currentTabId !== undefined && STALE_TAB_ERROR.test(captureError)) {
        currentTabId = undefined
        try {
          captured = await capture(undefined, visualScale)
          captureError = ''
        } catch (retryError) {
          captureError = retryError instanceof Error ? retryError.message : String(retryError)
        }
      }
    }

    if (!captured || typeof captured !== 'object' || captured.ok === false || typeof captured.dataUrl !== 'string') continue
    try {
      const ocr = await recognizeScreenshotText(captured.dataUrl, { signal })
      const rawOcrText = typeof ocr?.text === 'string' ? ocr.text : ''
      const text = selectImageCodeCandidate(rawOcrText)
      if (ocr?.status === 'recognized' && STRONG_IMAGE_CODE.test(text)) {
        return resultForCandidate({
          text,
          confidence: 0.96,
          status: 'recognized-strong',
          captured,
          args,
          rawOcrText,
          resolvedTabId: currentTabId,
        })
      }
    } catch {
      // Try the next scale, then the page-level recovery below.
    }
  }

  const pageFallback = await recognizeFromCurrentPage(
    bridge,
    currentTabId,
    captured,
    args,
    requestOptions,
    signal,
  )
  if (pageFallback) return pageFallback

  return {
    ...emptyResult(captureError ? `capture-unavailable:${shortError(captureError)}` : 'empty', args, currentTabId),
    inputSelector: currentInputSelector(captured, args),
    imageSelector: currentImageSelector(captured, args),
    captureMode: currentCaptureMode(captured),
  }
}

async function recognizeFromCurrentPage(bridge, tabId, captured, args, requestOptions, signal) {
  let snapshot
  try {
    snapshot = await bridge.request('snapshot', {
      maxElements: 300,
      includeHidden: false,
      tabId,
    }, requestOptions)
  } catch {
    return undefined
  }
  if (!snapshot || typeof snapshot !== 'object' || snapshot.ok === false) return undefined

  const inputSelector = currentInputSelector(captured, args)
    || findExplicitImageCodeInputSelector(snapshot)
  if (!inputSelector) return undefined

  let knownText = snapshotText(snapshot)
  try {
    const page = await bridge.request('readPage', { maxChars: 16000, tabId }, requestOptions)
    if (page && typeof page === 'object' && page.ok !== false && typeof page.text === 'string') {
      knownText += `\n${page.text}`
    }
  } catch {}
  if (!knownText.trim()) return undefined

  let shot
  try {
    shot = await bridge.request('screenshot', { tabId, format: 'png' }, requestOptions)
  } catch {
    return undefined
  }
  if (!shot || typeof shot !== 'object' || shot.ok === false || typeof shot.dataUrl !== 'string') return undefined

  try {
    const ocr = await recognizeScreenshotText(shot.dataUrl, { signal })
    const rawOcrText = typeof ocr?.text === 'string' ? ocr.text : ''
    if (ocr?.status !== 'recognized' || !rawOcrText) return undefined
    const text = selectImageCodeCandidate(rawOcrText, knownText)
    if (!STRONG_IMAGE_CODE.test(text)) return undefined

    return {
      ok: true,
      status: 'recognized-strong-page-fallback',
      text,
      confidence: 0.94,
      inputSelector,
      imageSelector: currentImageSelector(captured, args),
      captureMode: 'legacy-page-screenshot-windows-ocr',
      rawOcrText: text,
      resolvedTabId: tabId,
    }
  } catch {
    return undefined
  }
}

function resultForCandidate({ text, confidence, status, captured, args, rawOcrText, resolvedTabId }) {
  return {
    ok: true,
    status,
    text,
    confidence,
    inputSelector: currentInputSelector(captured, args),
    imageSelector: currentImageSelector(captured, args),
    captureMode: currentCaptureMode(captured),
    rawOcrText,
    resolvedTabId,
  }
}

function emptyResult(status, args, resolvedTabId) {
  return {
    ok: false,
    status,
    text: '',
    confidence: 0,
    inputSelector: typeof args.inputSelector === 'string' ? args.inputSelector : '',
    imageSelector: typeof args.imageSelector === 'string' ? args.imageSelector : '',
    captureMode: '',
    rawOcrText: '',
    resolvedTabId,
  }
}

function currentInputSelector(captured, args) {
  return typeof captured?.inputSelector === 'string'
    ? captured.inputSelector
    : (typeof args.inputSelector === 'string' ? args.inputSelector : '')
}

function currentImageSelector(captured, args) {
  return typeof captured?.imageSelector === 'string'
    ? captured.imageSelector
    : (typeof args.imageSelector === 'string' ? args.imageSelector : '')
}

function currentCaptureMode(captured) {
  return typeof captured?.captureMode === 'string' ? captured.captureMode : ''
}

function snapshotText(snapshot) {
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : []
  return elements.map(element => [element?.text, element?.name, element?.value]
    .filter(value => typeof value === 'string')
    .join(' '))
    .filter(Boolean)
    .join('\n')
}

function shortError(error) {
  const text = error instanceof Error ? error.message : String(error || '')
  return text.replace(/\s+/g, ' ').trim().slice(0, 160) || 'unknown-error'
}
