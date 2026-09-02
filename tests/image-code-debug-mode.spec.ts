import { describe, expect, it } from 'vitest'
import { assertImageCodeAutoSolved } from '../browser-bridge-runtime/challenge-tool.js'

describe('image-code debug fallback', () => {
  it('keeps normal mode terminal but lets test mode continue to model vision', () => {
    const classified = { kind: 'captcha', subtype: 'image-code' }

    expect(() => assertImageCodeAutoSolved(classified, false, 'win32', 'OCR failed', false))
      .toThrow(/Manual handoff is disabled for image-code/)

    expect(assertImageCodeAutoSolved(classified, false, 'win32', 'OCR failed', true))
      .toBe(false)

    expect(assertImageCodeAutoSolved(classified, true, 'win32', '', true))
      .toBe(true)
  })
})
