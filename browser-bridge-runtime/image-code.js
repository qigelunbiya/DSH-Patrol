const IMAGE_CODE_INPUT_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|verify[-_ ]?code|verification[-_ ]?code|validation[-_ ]?code|check[-_ ]?code|auth[-_ ]?code|\bcode\b|验证码|校验码|图形码)/i

export async function tryFillImageCode(bridge, tabId, options = {}) {
  if (process.platform !== 'win32') return false

  const captured = await bridge.request('captureImageCode', { tabId }, options)
  if (!captured || typeof captured !== 'object' || captured.ok === false) return false
  if (typeof captured.dataUrl !== 'string' || typeof captured.inputSelector !== 'string') return false
  if (!await isExplicitImageCodeInput(bridge, captured.inputSelector, tabId, options)) return false

  const image = decodeDataUrl(captured.dataUrl)
  const systemOcr = await import('@napi-rs/system-ocr')
  const recognize = systemOcr.recognize ?? systemOcr.default?.recognize
  const OcrAccuracy = systemOcr.OcrAccuracy ?? systemOcr.default?.OcrAccuracy
  if (typeof recognize !== 'function' || !OcrAccuracy) throw new Error('Windows system OCR API is unavailable')

  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
  const result = await recognize(image, OcrAccuracy.Accurate, [locale], options.signal)
  const code = normalizeImageCodeText(result?.text)
  if (!isPlausibleImageCode(code)) return false

  const typed = await bridge.request('type', {
    selector: captured.inputSelector,
    text: code,
    clear: true,
    tabId,
  }, options)
  if (!typed || typeof typed !== 'object' || typed.ok === false) return false

  try {
    await bridge.request('press', {
      selector: captured.inputSelector,
      key: 'Enter',
      tabId,
    }, options)
  } catch {
    // Filling the field is still useful when a page intentionally disables
    // Enter-to-submit. The existing Patrol login flow may click submit next.
  }

  return true
}

export function normalizeImageCodeText(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(line => cleanupLine(line))
    .filter(Boolean)

  const plausible = lines
    .filter(line => line.length >= 2 && line.length <= 16)
    .sort((left, right) => scoreLine(right) - scoreLine(left))
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
  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : []
  const target = elements.find(element => element && typeof element === 'object' && element.selector === selector)
  if (!target) return false
  const hint = [target.selector, target.name, target.text, target.type]
    .filter(value => typeof value === 'string')
    .join(' ')
  return IMAGE_CODE_INPUT_HINT.test(hint)
}

function cleanupLine(value) {
  return String(value || '')
    .replace(/\s+/g, '')
    .replace(/^["'`“”‘’.,，。:：;；|]+|["'`“”‘’.,，。:：;；|]+$/g, '')
}

function scoreLine(value) {
  let alphaNumeric = 0
  let symbols = 0
  for (const char of value) {
    if (/^[\p{L}\p{N}]$/u.test(char)) alphaNumeric += 1
    else symbols += 1
  }
  return alphaNumeric * 4 - symbols * 2 - Math.abs(value.length - 5)
}

function isPlausibleImageCode(value) {
  return value.length >= 2
    && value.length <= 16
    && /[\p{L}\p{N}]/u.test(value)
}

function decodeDataUrl(value) {
  const match = /^data:image\/[a-z0-9.+-]+;base64,([A-Za-z0-9+/=]+)$/i.exec(value)
  if (!match) throw new Error('image-code capture did not return a base64 image')
  return Buffer.from(match[1], 'base64')
}
