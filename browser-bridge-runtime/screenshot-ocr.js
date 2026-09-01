const MAX_SCREENSHOT_OCR_CHARS = 6000

export async function recognizeScreenshotText(dataUrl, options = {}) {
  if (process.platform !== 'win32') {
    return { status: 'unsupported-platform', text: '' }
  }

  const image = decodeDataUrl(dataUrl)
  const systemOcr = await import('@napi-rs/system-ocr')
  const recognize = systemOcr.recognize ?? systemOcr.default?.recognize
  const OcrAccuracy = systemOcr.OcrAccuracy ?? systemOcr.default?.OcrAccuracy
  if (typeof recognize !== 'function' || !OcrAccuracy) {
    return { status: 'unavailable', text: '' }
  }

  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en-US'
  // Alphanumeric image codes are frequently rendered with Latin glyphs even
  // on zh-CN Windows hosts. Keep the user's locale first, but always expose an
  // English recognizer fallback to Windows OCR as well.
  const languages = [...new Set([locale, 'en-US'])]
  const result = await recognize(image, OcrAccuracy.Accurate, languages, options.signal)
  const text = normalizeScreenshotOcrText(result?.text)
  return { status: text ? 'recognized' : 'empty', text }
}

export function normalizeScreenshotOcrText(value) {
  const lines = String(value ?? '')
    .replace(/\u0000/g, ' ')
    .split(/\r?\n/)
    .map(line => line.replace(/[\t ]+/g, ' ').trim())
    .filter(Boolean)
  const text = lines.join('\n')
  return text.length <= MAX_SCREENSHOT_OCR_CHARS
    ? text
    : `${text.slice(0, MAX_SCREENSHOT_OCR_CHARS)}…`
}

function decodeDataUrl(value) {
  const match = /^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(value || ''))
  if (!match?.[1]) throw new Error('screenshot OCR received an invalid image payload')
  const buffer = Buffer.from(match[1], 'base64')
  if (buffer.length === 0 || buffer.length > 20 * 1024 * 1024) {
    throw new Error('screenshot OCR image payload is empty or too large')
  }
  return buffer
}
