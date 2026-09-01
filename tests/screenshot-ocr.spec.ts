import { describe, expect, it } from 'vitest'
import { CAPTCHA_MODES } from '../browser-bridge-runtime/captcha-mode.js'
import { normalizeScreenshotOcrText } from '../browser-bridge-runtime/screenshot-ocr.js'
import { shouldSuppressScreenshotOcr } from '../browser-bridge-runtime/tools.js'

describe('screenshot OCR normalization', () => {
  it('normalizes whitespace while preserving readable line boundaries', () => {
    expect(normalizeScreenshotOcrText('  首页   推荐  \n\n 人工智能\t 视频  ')).toBe('首页 推荐\n人工智能 视频')
  })

  it('drops NUL characters and clips oversized output', () => {
    expect(normalizeScreenshotOcrText('A\u0000B')).toBe('A B')
    expect(normalizeScreenshotOcrText('x'.repeat(7000)).length).toBeLessThanOrEqual(6001)
  })
})

describe('screenshot OCR verification policy', () => {
  it('does not suppress conventional image-code OCR in test mode', () => {
    expect(shouldSuppressScreenshotOcr({ kind: 'captcha', subtype: 'image-code' }, CAPTCHA_MODES.test)).toBe(false)
  })

  it('keeps image-code suppression available in explicit normal mode', () => {
    expect(shouldSuppressScreenshotOcr({ kind: 'captcha', subtype: 'image-code' }, CAPTCHA_MODES.normal)).toBe(true)
  })

  it('still suppresses non-image-code verification flows in test mode', () => {
    expect(shouldSuppressScreenshotOcr({ kind: 'otp', subtype: 'otp' }, CAPTCHA_MODES.test)).toBe(true)
    expect(shouldSuppressScreenshotOcr({ kind: 'captcha', subtype: 'third-party' }, CAPTCHA_MODES.test)).toBe(true)
    expect(shouldSuppressScreenshotOcr({ kind: 'none', subtype: 'none' }, CAPTCHA_MODES.test)).toBe(false)
  })
})
