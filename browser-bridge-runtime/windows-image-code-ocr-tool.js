import { defineTool } from '@deepseek-ai/dsh-tools'
import { findExplicitImageCodeInputSelector, selectImageCodeCandidate } from './image-code.js'
import { recognizeScreenshotText } from './screenshot-ocr.js'

const optStr = { type: 'string' }
const optInt = { type: 'integer' }
const STALE_TAB_ERROR = /no tab with id|page bridge unavailable|receiving end does not exist|could not establish connection|message port closed|frame with id .* was removed/i
const STRONG_IMAGE_CODE = /^[A-Za-z0-9]{3,8}$/

export function registerWindowsImageCodeOcrTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'patrol_windows_ocr_image_code',
    description: 'Read the CURRENT conventional image-code CAPTCHA with Windows System OCR. First OCR the tight CURRENT captcha crop. If that crop is empty/weak or cannot be captured, recover with the legacy CURRENT-page PNG Windows-OCR path: subtract CURRENT DOM/read-page text from screenshot OCR and accept only an unseen strong short candidate. Model vision is only a fallback after both Windows OCR paths are exhausted. The tool never types or submits a value.',
    parameters: {
      tabId: optInt,
      inputSelector: optStr,
      imageSelector: optStr,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          text: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
          inputSelector: { type: 'string', required: true },
          imageSelector: { type: 'string', required: true },
          captureMode: { type: 'string', required: true },
          rawOcrText: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Windows OCR image-code status=${value.status}; candidate=${value.text || '(none)'}; confidence=${Number(value.confidence || 0).toFixed(2)}`,
          `captureMode=${value.captureMode || 'unknown'}; inputSelector=${value.inputSelector || '(auto)'}; imageSelector=${value.imageSelector || '(auto)'}`,
          value.text && Number(value.confidence) >= 0.90
            ? 'Use patrol_type_current_image_code with this CURRENT candidate and confidence. The persisted taskChecklist format is still authoritative and may reject a mismatching candidate.'
            : 'Both Windows OCR paths did not produce a strong CURRENT candidate. Only now may browser_capture_image_code_visual be used; do not submit a guess.',
        ].join('\n'),
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Read current CAPTCHA with Windows OCR',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      return await readCurrentImageCodeWithWindowsOcr(bridge, args, exec, { timeoutMs })
    },
  })

  return ctx.tools.register(definition)
}

export async function readCurrentImageCodeWithWindowsOcr(bridge, args = {}, exec, config = {}) {
  const timeoutMs = config.timeoutMs ?? config.commandTimeoutMs ?? 60000
  if (process.platform !== 'win32') return emptyResult('unsupported-platform', args)

  const requestOptions = { timeoutMs, signal: exec?.signal }
  const capture = async tabId => await bridge.request('captureImageCode', {
    tabId,
    // Persisted selectors are deliberately not forwarded. Rediscover the CURRENT
    // input/image relationship and force a 2x browser-canvas PNG normalization so
    // Windows System OCR never receives stale selectors or unsupported source bytes.
    visualScale: 2,
  }, requestOptions)

  let captured
  let captureError = ''
  let currentTabId = args.tabId
  try {
    captured = await capture(currentTabId)
  } catch (error) {
    captureError = error instanceof Error ? error.message : String(error)
    if (currentTabId !== undefined && STALE_TAB_ERROR.test(captureError)) {
      currentTabId = undefined
      try {
        captured = await capture(undefined)
        captureError = ''
      } catch (retryError) {
        captureError = retryError instanceof Error ? retryError.message : String(retryError)
      }
    }
  }

  let tightText = ''
  let tightRawOcrText = ''
  let tightStatus = captureError ? 'capture-unavailable' : 'empty'

  if (captured && typeof captured === 'object' && captured.ok !== false && typeof captured.dataUrl === 'string') {
    try {
      const ocr = await recognizeScreenshotText(captured.dataUrl, { signal: exec?.signal })
      tightRawOcrText = typeof ocr?.text === 'string' ? ocr.text : ''
      tightText = selectImageCodeCandidate(tightRawOcrText)
      const strong = STRONG_IMAGE_CODE.test(tightText)
      tightStatus = ocr?.status === 'recognized' && tightText
        ? (strong ? 'recognized-strong' : 'recognized-weak')
        : String(ocr?.status || 'empty')
      if (strong) {
        return resultForCandidate({
          text: tightText,
          confidence: 0.96,
          status: 'recognized-strong',
          captured,
          args,
          rawOcrText: tightRawOcrText,
        })
      }
    } catch (error) {
      tightStatus = `tight-ocr-unavailable:${shortError(error)}`
    }
  }

  // Stable recovery used by the older working Patrol implementation. Tiny,
  // distorted glyphs can produce an empty tight-crop result in native OCR, while
  // the same glyphs remain detectable in a normal page PNG. OCR the CURRENT page,
  // subtract DOM/readPage text, and accept only an unseen strong short candidate.
  const pageFallback = await recognizeFromCurrentPage(
    bridge,
    currentTabId,
    captured,
    args,
    exec,
    timeoutMs,
  )
  if (pageFallback) return pageFallback

  return {
    ok: false,
    status: tightStatus,
    text: tightText,
    confidence: tightText ? 0.82 : 0,
    inputSelector: currentInputSelector(captured, args),
    imageSelector: currentImageSelector(captured, args),
    captureMode: currentCaptureMode(captured),
    rawOcrText: tightRawOcrText,
  }
}

async function recognizeFromCurrentPage(bridge, tabId, captured, args, exec, timeoutMs) {
  const requestOptions = { timeoutMs, signal: exec?.signal }
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
    const page = await bridge.request('readPage', {
      maxChars: 16000,
      tabId,
    }, requestOptions)
    if (page && typeof page === 'object' && page.ok !== false && typeof page.text === 'string') {
      knownText += `\n${page.text}`
    }
  } catch {
    // Snapshot text is sufficient to keep recovery filtered rather than blindly
    // trusting an arbitrary whole-page OCR token.
  }
  if (!knownText.trim()) return undefined

  let shot
  try {
    shot = await bridge.request('screenshot', { tabId, format: 'png' }, requestOptions)
  } catch {
    return undefined
  }
  if (!shot || typeof shot !== 'object' || shot.ok === false || typeof shot.dataUrl !== 'string') return undefined

  try {
    const ocr = await recognizeScreenshotText(shot.dataUrl, { signal: exec?.signal })
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
    }
  } catch {
    return undefined
  }
}

function resultForCandidate({ text, confidence, status, captured, args, rawOcrText }) {
  return {
    ok: true,
    status,
    text,
    confidence,
    inputSelector: currentInputSelector(captured, args),
    imageSelector: currentImageSelector(captured, args),
    captureMode: currentCaptureMode(captured),
    rawOcrText,
  }
}

function emptyResult(status, args) {
  return {
    ok: false,
    status,
    text: '',
    confidence: 0,
    inputSelector: typeof args.inputSelector === 'string' ? args.inputSelector : '',
    imageSelector: typeof args.imageSelector === 'string' ? args.imageSelector : '',
    captureMode: '',
    rawOcrText: '',
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
