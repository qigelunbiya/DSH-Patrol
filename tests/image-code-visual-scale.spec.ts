import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('CAPTCHA visual fallback readability', () => {
  it('requests a 3x tight crop and does not run a second local OCR pass', () => {
    const tool = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'image-code-visual-tool.js'), 'utf8')
    expect(tool).toContain('visualScale: 3')
    expect(tool).toContain('No ddddocr/Windows OCR preflight was run')
    expect(tool).not.toContain('recognizeImageCodeWithDdddocr')
    expect(tool).not.toContain('tryLocalOcr')
  })

  it('falls back once to the active current-page screenshot instead of browser recovery loops', () => {
    const tool = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'image-code-visual-tool.js'), 'utf8')
    expect(tool).toContain('CAPTURE_FALLBACK_ERROR')
    expect(tool).toContain("captureMode: 'full-page-current-tab-fallback'")
    expect(tool).toMatch(/bridge\.request\('screenshot',[\s\S]*format: 'png'/)
  })

  it('keeps visual scaling opt-in so unattended local OCR captures are not inflated', () => {
    const background = readFileSync(join(process.cwd(), 'browser-extension', 'background.js'), 'utf8')
    expect(background).toContain('const visualScale = Number.isFinite(Number(args.visualScale))')
    expect(background).toContain('scaleImageDataUrl(dataUrl, visualScale)')
    expect(background).toContain("captureMode = `${captureMode}-visual-${visualScale}x`")
  })
})
