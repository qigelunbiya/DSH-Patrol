import { describe, expect, it } from 'vitest'
import { CAPTCHA_MODES } from '../browser-bridge-runtime/captcha-mode.js'
import { findScreenshotOcrTextMatches, normalizeScreenshotOcrLines, normalizeScreenshotOcrText } from '../browser-bridge-runtime/screenshot-ocr.js'
import { shouldSuppressScreenshotOcr } from '../browser-bridge-runtime/tools.js'

describe('screenshot OCR normalization', () => {
  it('normalizes whitespace while preserving readable line boundaries', () => {
    expect(normalizeScreenshotOcrText('  首页   推荐  \n\n 人工智能\t 视频  ')).toBe('首页 推荐\n人工智能 视频')
  })

  it('drops NUL characters and clips oversized output', () => {
    expect(normalizeScreenshotOcrText('A\u0000B')).toBe('A B')
    expect(normalizeScreenshotOcrText('x'.repeat(7000)).length).toBeLessThanOrEqual(6001)
  })

  it('merges Windows OCR line geometry across language passes without duplicating the same visible line', () => {
    const lines = normalizeScreenshotOcrLines([
      {
        language: 'zh-CN',
        result: {
          lines: [
            { text: '龙之信条 2 - 百度百科', confidence: 0.96, boundingBox: { x: 0.12, y: 0.20, width: 0.24, height: 0.05 } },
            { text: '7 发售版本', confidence: 0.92, boundingBox: { x: 0.08, y: 0.62, width: 0.11, height: 0.04 } },
          ],
        },
      },
      {
        language: 'en-US',
        result: {
          lines: [
            { text: '龙之信条 2 - 百度百科', confidence: 0.90, boundingBox: { x: 0.121, y: 0.201, width: 0.24, height: 0.05 } },
          ],
        },
      },
    ])

    expect(lines).toHaveLength(2)
    expect(lines[0]).toMatchObject({
      text: '龙之信条 2 - 百度百科',
      x: 0.12,
      y: 0.20,
      width: 0.24,
      height: 0.05,
    })
    expect(lines[0].centerX).toBeCloseTo(0.24)
    expect(lines[0].centerY).toBeCloseTo(0.225)
  })

  it('matches OCR text across harmless punctuation/spacing differences while preserving exact geometry', () => {
    const lines = [
      { text: '7 发售版本', x: 0.08, y: 0.62, width: 0.11, height: 0.04, centerX: 0.135, centerY: 0.64 },
      { text: '龙之信条 2 - 百度百科', x: 0.12, y: 0.20, width: 0.24, height: 0.05, centerX: 0.24, centerY: 0.225 },
    ]

    expect(findScreenshotOcrTextMatches(lines, '7.发售版本', 'exact')).toEqual([lines[0]])
    expect(findScreenshotOcrTextMatches(lines, '龙之信条2百度百科', 'contains')).toEqual([lines[1]])
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
