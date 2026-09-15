import { describe, expect, it } from 'vitest'
import { assertImageCodeAutoSolved } from '../browser-bridge-runtime/challenge-tool.js'

describe('image-code debug fallback', () => {
  it('keeps normal/replay mode terminal but allows only an explicit debug fallback', () => {
    const classified = { kind: 'captcha', subtype: 'image-code' }

    expect(() => assertImageCodeAutoSolved(classified, false, 'win32', 'OCR failed', false))
      .toThrow(/image-code automation failed at the image-code step/)

    expect(() => assertImageCodeAutoSolved(classified, false, 'win32', 'OCR failed', false))
      .toThrow(/must stop here instead of continuing to login\/TOTP/)

    expect(assertImageCodeAutoSolved(classified, false, 'win32', 'OCR failed', true))
      .toBe(false)

    expect(assertImageCodeAutoSolved(classified, true, 'win32', '', true))
      .toBe(true)
  })
})
