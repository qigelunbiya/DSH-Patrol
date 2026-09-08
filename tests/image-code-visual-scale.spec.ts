import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('CAPTCHA visual fallback readability', () => {
  it('requests a 3x tight crop only for model-vision fallback', () => {
    const tool = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'image-code-visual-tool.js'), 'utf8')
    expect(tool).toContain('visualScale: 3')
    expect(tool).toContain('Local OCR ensemble for THIS crop')
  })

  it('keeps visual scaling opt-in so primary local OCR captures are not inflated', () => {
    const background = readFileSync(join(process.cwd(), 'browser-extension', 'background.js'), 'utf8')
    expect(background).toContain('const visualScale = Number.isFinite(Number(args.visualScale))')
    expect(background).toContain('scaleImageDataUrl(dataUrl, visualScale)')
    expect(background).toContain("captureMode = `${captureMode}-visual-${visualScale}x`")
  })
})
