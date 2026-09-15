import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('Windows OCR image-code priority', () => {
  it('registers the dedicated Windows OCR tool before model-visual capture', () => {
    const source = readFileSync(join(root, 'browser-bridge-runtime', 'tools-plugin.js'), 'utf8')
    const windowsRegistration = 'registerWindowsImageCodeOcrTool(ctx, bridge'
    const visualRegistration = 'registerImageCodeVisualTool(ctx, bridge'

    expect(source).toContain("import { registerWindowsImageCodeOcrTool } from './windows-image-code-ocr-tool.js'")
    expect(source).toContain(windowsRegistration)
    expect(source).toContain(visualRegistration)
    expect(source.lastIndexOf(windowsRegistration)).toBeLessThan(source.lastIndexOf(visualRegistration))
  })

  it('keeps the tight CURRENT crop plus filtered CURRENT-page Windows OCR recovery', () => {
    const source = readFileSync(join(root, 'browser-bridge-runtime', 'windows-image-code-ocr-tool.js'), 'utf8')

    expect(source).toContain("name: 'patrol_windows_ocr_image_code'")
    expect(source).toContain("bridge.request('captureImageCode'")
    expect(source).toContain('visualScale: 2')
    expect(source).toContain('recognizeScreenshotText(captured.dataUrl')
    expect(source).toContain("bridge.request('snapshot'")
    expect(source).toContain("bridge.request('readPage'")
    expect(source).toContain("bridge.request('screenshot', { tabId, format: 'png' }")
    expect(source).toContain('selectImageCodeCandidate(rawOcrText, knownText)')
    expect(source).toContain("captureMode: 'legacy-page-screenshot-windows-ocr'")
    expect(source).not.toMatch(/ddddocr/i)
  })

  it('makes Windows OCR the explicit TEST-mode first choice and vision only the fallback', () => {
    const source = readFileSync(join(root, 'src', 'test-mode.ts'), 'utf8')
    const windows = source.indexOf('第一识别动作调用 patrol_windows_ocr_image_code')
    const visual = source.indexOf('才调用 browser_capture_image_code_visual')

    expect(windows).toBeGreaterThan(-1)
    expect(visual).toBeGreaterThan(windows)
    expect(source).toContain('两条 Windows OCR 路径都跑完之前禁止先用 model-visual')
    expect(source).toContain('Windows OCR → model-visual')
  })
})
