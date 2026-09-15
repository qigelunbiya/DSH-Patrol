// @ts-nocheck
import { describe, expect, it, vi } from 'vitest'
import {
  IMAGE_CODE_OCR_ENGINE_ENV,
  imageCodeOcrEngineOrder,
  recognizeCapturedImageCodeWithDdddocr,
  recognizeCapturedImageCodeWithWindowsOcr,
  resolveImageCodeOcrEngine,
  runImageCodeOcrPolicy,
} from '../browser-bridge-runtime/image-code.js'

describe('image-code OCR engine policy', () => {
  it('uses Windows OCR before ddddocr in auto mode', () => {
    expect(imageCodeOcrEngineOrder()).toEqual(['windows', 'ddddocr'])
    expect(imageCodeOcrEngineOrder('auto')).toEqual(['windows', 'ddddocr'])
  })

  it('accepts a Windows OCR result without consulting ddddocr', async () => {
    const windowsOcr = vi.fn(async () => 'ABCD')
    const ddddocrOcr = vi.fn(async () => 'WXYZ')

    const result = await runImageCodeOcrPolicy({ mode: 'auto', windowsOcr, ddddocrOcr })

    expect(result).toEqual({ engine: 'windows', code: 'ABCD' })
    expect(windowsOcr).toHaveBeenCalledOnce()
    expect(ddddocrOcr).not.toHaveBeenCalled()
  })

  it('uses ddddocr only after Windows OCR independently fails in auto mode', async () => {
    const windowsOcr = vi.fn(async () => '')
    const ddddocrOcr = vi.fn(async () => 'WXYZ')

    const result = await runImageCodeOcrPolicy({ mode: 'auto', windowsOcr, ddddocrOcr })

    expect(result).toEqual({ engine: 'ddddocr', code: 'WXYZ' })
    expect(windowsOcr).toHaveBeenCalledOnce()
    expect(ddddocrOcr).toHaveBeenCalledOnce()
  })

  it('can force Windows-only testing without invoking ddddocr', async () => {
    const windowsOcr = vi.fn(async () => '')
    const ddddocrOcr = vi.fn(async () => 'WXYZ')

    const result = await runImageCodeOcrPolicy({ mode: 'windows', windowsOcr, ddddocrOcr })

    expect(result).toEqual({ engine: 'none', code: '' })
    expect(windowsOcr).toHaveBeenCalledOnce()
    expect(ddddocrOcr).not.toHaveBeenCalled()
  })

  it('can force ddddocr-only testing without invoking Windows OCR', async () => {
    const windowsOcr = vi.fn(async () => 'ABCD')
    const ddddocrOcr = vi.fn(async () => 'WXYZ')

    const result = await runImageCodeOcrPolicy({ mode: 'ddddocr', windowsOcr, ddddocrOcr })

    expect(result).toEqual({ engine: 'ddddocr', code: 'WXYZ' })
    expect(windowsOcr).not.toHaveBeenCalled()
    expect(ddddocrOcr).toHaveBeenCalledOnce()
  })

  it('resolves the optional engine override independently', () => {
    expect(resolveImageCodeOcrEngine({})).toBe('auto')
    expect(resolveImageCodeOcrEngine({ [IMAGE_CODE_OCR_ENGINE_ENV]: 'windows' })).toBe('windows')
    expect(resolveImageCodeOcrEngine({ [IMAGE_CODE_OCR_ENGINE_ENV]: 'windows-system-ocr' })).toBe('windows')
    expect(resolveImageCodeOcrEngine({ [IMAGE_CODE_OCR_ENGINE_ENV]: 'ddddocr' })).toBe('ddddocr')
    expect(() => resolveImageCodeOcrEngine({ [IMAGE_CODE_OCR_ENGINE_ENV]: 'mixed' })).toThrow(/Unsupported/)
  })

  it('keeps the engine implementations isolated from each other', () => {
    expect(recognizeCapturedImageCodeWithWindowsOcr.toString()).toContain('recognizeScreenshotText')
    expect(recognizeCapturedImageCodeWithWindowsOcr.toString()).not.toContain('recognizeImageCodeWithDdddocr')
    expect(recognizeCapturedImageCodeWithDdddocr.toString()).toContain('recognizeImageCodeWithDdddocr')
    expect(recognizeCapturedImageCodeWithDdddocr.toString()).not.toContain('recognizeScreenshotText')
  })
})
