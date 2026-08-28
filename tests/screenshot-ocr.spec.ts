import { describe, expect, it } from 'vitest'
import { normalizeScreenshotOcrText } from '../browser-bridge-runtime/screenshot-ocr.js'

describe('screenshot OCR normalization', () => {
  it('normalizes whitespace while preserving readable line boundaries', () => {
    expect(normalizeScreenshotOcrText('  首页   推荐  \n\n 人工智能\t 视频  ')).toBe('首页 推荐\n人工智能 视频')
  })

  it('drops NUL characters and clips oversized output', () => {
    expect(normalizeScreenshotOcrText('A\u0000B')).toBe('A B')
    expect(normalizeScreenshotOcrText('x'.repeat(7000)).length).toBeLessThanOrEqual(6001)
  })
})
