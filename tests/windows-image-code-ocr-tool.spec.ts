import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('Windows OCR image-code priority', () => {
  it('rasterizes the tight CURRENT image-code before invoking Windows System OCR', () => {
    const source = readFileSync(join(root, 'browser-bridge-runtime', 'windows-image-code-ocr-tool.js'), 'utf8')

    expect(source).toContain("name: 'patrol_windows_ocr_image_code'")
    expect(source).toContain("bridge.request('captureImageCode'")
    expect(source).toContain('visualScale: 2')
    expect(source).toContain('recognizeScreenshotText(captured.dataUrl')
    expect(source.indexOf("bridge.request('captureImageCode'")).toBeLessThan(source.indexOf('recognizeScreenshotText(captured.dataUrl'))
    expect(source).toContain("process.platform !== 'win32'")
    expect(source).not.toMatch(/ddddocr/i)
  })

  it('rediscovers the CURRENT page target instead of forwarding persisted selectors', () => {
    const source = readFileSync(join(root, 'browser-bridge-runtime', 'windows-image-code-ocr-tool.js'), 'utf8')
    const captureStart = source.indexOf("bridge.request('captureImageCode'")
    const captureEnd = source.indexOf('}, requestOptions)', captureStart)
    const captureArgs = source.slice(captureStart, captureEnd)

    expect(captureArgs).toContain('tabId')
    expect(captureArgs).toContain('visualScale: 2')
    expect(captureArgs).not.toContain('inputSelector: args.inputSelector')
    expect(captureArgs).not.toContain('imageSelector: args.imageSelector')
  })

  it('retries once on the CURRENT active tab when a recorded tab id becomes stale', () => {
    const source = readFileSync(join(root, 'browser-bridge-runtime', 'windows-image-code-ocr-tool.js'), 'utf8')

    expect(source).toContain('STALE_TAB_ERROR')
    expect(source).toContain('captured = await capture(currentTabId)')
    expect(source).toContain('currentTabId = undefined')
    expect(source).toContain('captured = await capture(undefined)')
    expect(source).toMatch(/no tab with id|receiving end does not exist/i)
  })

  it('uses the stable CURRENT-page Windows OCR recovery before model vision', () => {
    const source = readFileSync(join(root, 'browser-bridge-runtime', 'windows-image-code-ocr-tool.js'), 'utf8')

    const tightOcr = source.indexOf('recognizeScreenshotText(captured.dataUrl')
    const pageRecovery = source.indexOf('recognizeFromCurrentPage(')
    expect(tightOcr).toBeGreaterThan(-1)
    expect(pageRecovery).toBeGreaterThan(tightOcr)
    expect(source).toContain("bridge.request('snapshot'")
    expect(source).toContain("bridge.request('readPage'")
    expect(source).toContain("bridge.request('screenshot', { tabId, format: 'png' }")
    expect(source).toContain('selectImageCodeCandidate(rawOcrText, knownText)')
    expect(source).toContain("captureMode: 'legacy-page-screenshot-windows-ocr'")
    expect(source).toContain("status: 'recognized-strong-page-fallback'")
  })

  it('registers Windows OCR before the model-visual fallback', () => {
    const source = readFileSync(join(root, 'browser-bridge-runtime', 'tools-plugin.js'), 'utf8')
    const windowsRegistration = 'registerWindowsImageCodeOcrTool(ctx, bridge'
    const visualRegistration = 'registerImageCodeVisualTool(ctx, bridge'

    expect(source).toContain(windowsRegistration)
    expect(source).toContain(visualRegistration)
    expect(source.lastIndexOf(windowsRegistration)).toBeLessThan(source.lastIndexOf(visualRegistration))
  })

  it('enforces Windows OCR at runtime even when the model calls visual capture first', () => {
    const source = readFileSync(join(root, 'browser-bridge-runtime', 'image-code-visual-tool.js'), 'utf8')
    const ocrCall = source.indexOf('readCurrentImageCodeWithWindowsOcr(bridge, args, exec')
    const visualCall = source.indexOf('captureCurrentImageCodeVisual(bridge, args, exec')

    expect(source).toContain("from './windows-image-code-ocr-tool.js'")
    expect(ocrCall).toBeGreaterThan(-1)
    expect(visualCall).toBeGreaterThan(ocrCall)
    expect(source).toContain("imageStatus: 'skipped-windows-ocr'")
    expect(source).toContain('Visual capture was intentionally skipped')
  })

  it('teaches TEST MODE to exhaust both Windows OCR paths before visual fallback', () => {
    const source = readFileSync(join(root, 'src', 'test-mode.ts'), 'utf8')

    expect(source).toMatch(/先调用 patrol_windows_ocr_image_code/)
    expect(source).toMatch(/CURRENT 验证码紧凑区域.*CURRENT 整页 PNG/s)
    expect(source).toMatch(/snapshot\/readPage.*已知页面文字/s)
    expect(source).toMatch(/两条 Windows OCR 路径都跑完之前禁止先用 model-visual/s)
    expect(source).toMatch(/紧凑裁图 Windows OCR \+ 过滤后的 CURRENT 整页 Windows OCR.*browser_capture_image_code_visual/s)
    expect(source).toMatch(/误先调用 browser_capture_image_code_visual.*先内部执行 Windows OCR/s)
  })
})
