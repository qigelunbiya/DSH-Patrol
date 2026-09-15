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

  it('shares one robust Windows OCR reader between interactive use and runbook replay', () => {
    const tool = readFileSync(join(root, 'browser-bridge-runtime', 'windows-image-code-ocr-tool.js'), 'utf8')
    const reader = readFileSync(join(root, 'browser-bridge-runtime', 'windows-image-code-reader.js'), 'utf8')

    expect(tool).toContain("import { readCurrentImageCodeWithWindowsOcr } from './windows-image-code-reader.js'")
    expect(tool).toContain('readCurrentImageCodeWithWindowsOcr(bridge, args')
    expect(reader).toContain('export async function readCurrentImageCodeWithWindowsOcr')
    expect(reader).toContain("bridge.request('captureImageCode'")
    expect(reader).toContain('for (const visualScale of [2, 3])')
    expect(reader).toContain('recognizeScreenshotText(captured.dataUrl')
    expect(reader).toContain("bridge.request('snapshot'")
    expect(reader).toContain("bridge.request('readPage'")
    expect(reader).toContain("bridge.request('screenshot', { tabId, format: 'png' }")
    expect(reader).toContain('selectImageCodeCandidate(rawOcrText, knownText)')
    expect(reader).toContain("captureMode: 'legacy-page-screenshot-windows-ocr'")
    expect(reader).not.toMatch(/ddddocr/i)
  })

  it('uses Windows OCR before the legacy local solver inside TEST-mode runbook replay', () => {
    const challenge = readFileSync(join(root, 'browser-bridge-runtime', 'challenge-tool.js'), 'utf8')
    const windows = challenge.indexOf('readCurrentImageCodeWithWindowsOcr(bridge')
    const legacy = challenge.indexOf('tryFillImageCode(bridge')

    expect(challenge).toContain("import { readCurrentImageCodeWithWindowsOcr } from './windows-image-code-reader.js'")
    expect(windows).toBeGreaterThan(-1)
    expect(legacy).toBeGreaterThan(windows)
    expect(challenge).toContain("args.allowTestFallback === true")
    expect(challenge).toContain('allowTestDebugFallback')
    expect(challenge).toMatch(/assertImageCodeAutoSolved\([\s\S]*allowTestDebugFallback/)
  })

  it('makes Windows OCR the explicit TEST-mode first choice and avoids duplicate recognition of a known CURRENT candidate', () => {
    const source = readFileSync(join(root, 'src', 'test-mode.ts'), 'utf8')
    const windows = source.indexOf('第一识别动作调用 patrol_windows_ocr_image_code')
    const visual = source.indexOf('才调用 browser_capture_image_code_visual')

    expect(windows).toBeGreaterThan(-1)
    expect(visual).toBeGreaterThan(windows)
    expect(source).toContain('Windows OCR → model-visual')
    expect(source).toContain('不要为了形式上的 OCR 优先级又对同一张验证码调用 patrol_windows_ocr_image_code')
    expect(source).toContain('已有可靠 CURRENT 识别结果不得重复识别')
    expect(source).toContain('必须在“动态识别并填写图片验证码”这一当前步骤失败并停止')
  })
})
