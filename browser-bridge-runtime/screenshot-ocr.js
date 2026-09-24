const MAX_SCREENSHOT_OCR_CHARS = 6000
const MAX_SCREENSHOT_OCR_LINES = 240

export async function recognizeScreenshotText(dataUrl, options = {}) {
  if (process.platform !== 'win32') {
    return { status: 'unsupported-platform', text: '', lines: [], languagesTried: [] }
  }

  const image = decodeDataUrl(dataUrl)
  const systemOcr = await import('@napi-rs/system-ocr')
  const recognize = systemOcr.recognize ?? systemOcr.default?.recognize
  const OcrAccuracy = systemOcr.OcrAccuracy ?? systemOcr.default?.OcrAccuracy
  if (typeof recognize !== 'function' || !OcrAccuracy) {
    return { status: 'unavailable', text: '', lines: [], languagesTried: [] }
  }

  const locale = Intl.DateTimeFormat().resolvedOptions().locale || 'zh-CN'
  const requested = Array.isArray(options.languages)
    ? options.languages.map(value => String(value ?? '').trim()).filter(Boolean)
    : []
  // Windows system-ocr effectively honors one preferred language per pass on
  // some hosts. Mirror the stable Desktop OCR strategy: run a small bounded set
  // of passes and merge line geometry instead of trusting one locale guess.
  const languages = [...new Set([...requested, locale, 'zh-CN', 'en-US'])].slice(0, 4)
  const observations = []
  const failures = []
  for (const language of languages) {
    try {
      const result = await recognize(image, OcrAccuracy.Accurate, [language], options.signal)
      observations.push({ language, result })
    } catch (error) {
      failures.push({ language, error: String(error?.message ?? error) })
    }
  }

  const lines = normalizeScreenshotOcrLines(observations)
  const geometryText = lines.map(line => line.text).join('\n')
  const fallbackText = observations.map(item => item?.result?.text ?? '').join('\n')
  const text = normalizeScreenshotOcrText(geometryText || fallbackText)
  return {
    status: text ? 'recognized' : observations.length > 0 ? 'empty' : 'unavailable',
    text,
    lines,
    languagesTried: languages,
    languagesSucceeded: observations.map(item => item.language),
    ...(failures.length === 0 ? {} : { languageErrors: failures }),
  }
}

export function normalizeScreenshotOcrLines(observations, maxLines = MAX_SCREENSHOT_OCR_LINES) {
  const out = []
  for (const observation of observations ?? []) {
    const language = String(observation?.language ?? '')
    const rawLines = Array.isArray(observation?.result?.lines) ? observation.result.lines : []
    for (const raw of rawLines) {
      const text = normalizeOcrLine(raw?.text)
      const box = raw?.boundingBox
      if (!text || !validNormalizedBox(box)) continue
      const centerX = box.x + box.width / 2
      const centerY = box.y + box.height / 2
      const key = ocrMatchKey(text)
      if (out.some(existing =>
        ocrMatchKey(existing.text) === key
        && Math.abs(existing.centerX - centerX) <= 0.008
        && Math.abs(existing.centerY - centerY) <= 0.008)) {
        continue
      }
      out.push({
        text,
        confidence: finiteNumber(raw?.confidence, 0),
        language,
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        centerX,
        centerY,
      })
      if (out.length >= maxLines) return out
    }
  }
  return out
}

export function findScreenshotOcrTextMatches(lines, query, match = 'exact', caseSensitive = false) {
  const text = String(query ?? '').trim()
  if (!text) return []
  const requested = ocrMatchVariants(text, caseSensitive)
  return (Array.isArray(lines) ? lines : []).filter(line => {
    const observed = ocrMatchVariants(line?.text, caseSensitive)
    if (match === 'contains') {
      return observed.spaced.includes(requested.spaced)
        || observed.compact.includes(requested.compact)
        || observed.alnum.includes(requested.alnum)
    }
    return observed.spaced === requested.spaced
      || observed.compact === requested.compact
      || observed.alnum === requested.alnum
  })
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

function normalizeOcrLine(value) {
  return String(value ?? '')
    .replace(/\u0000/g, ' ')
    .replace(/[\t ]+/g, ' ')
    .trim()
}

function ocrMatchVariants(value, caseSensitive = false) {
  const nfkc = String(value ?? '').normalize('NFKC').replace(/\u00a0/g, ' ')
  const spaced = nfkc.replace(/\s+/g, ' ').trim()
  const cased = caseSensitive ? spaced : spaced.toLocaleLowerCase()
  return {
    spaced: cased,
    compact: cased.replace(/\s+/g, ''),
    alnum: cased.replace(/[^\p{L}\p{N}]+/gu, ''),
  }
}

function ocrMatchKey(value) {
  return ocrMatchVariants(value, false).alnum
}

function validNormalizedBox(value) {
  if (!value || typeof value !== 'object') return false
  const x = Number(value.x)
  const y = Number(value.y)
  const width = Number(value.width)
  const height = Number(value.height)
  return [x, y, width, height].every(Number.isFinite)
    && x >= -0.02 && y >= -0.02
    && width > 0 && height > 0
    && x <= 1.02 && y <= 1.02
    && width <= 1.05 && height <= 1.05
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
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
