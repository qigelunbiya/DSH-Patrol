import { describe, expect, it } from 'vitest'
import {
  CAPTCHA_MODES,
  captchaModeAllowsImageCodeScreenshotOcr,
  captchaModeAllowsThirdPartyAutomation,
  captchaModeAllowsWeakUnmarkedAutomation,
  currentCaptchaMode,
  resolveCaptchaMode,
} from '../browser-bridge-runtime/captcha-mode.js'

describe('captcha runtime mode', () => {
  it('defaults to test mode for empty/default values', () => {
    expect(resolveCaptchaMode('')).toBe(CAPTCHA_MODES.test)
    expect(resolveCaptchaMode('default')).toBe(CAPTCHA_MODES.test)
    expect(currentCaptchaMode({})).toBe(CAPTCHA_MODES.test)
  })

  it('still allows an explicit switch back to normal mode', () => {
    expect(resolveCaptchaMode('normal')).toBe(CAPTCHA_MODES.normal)
    expect(currentCaptchaMode({ DSH_PATROL_CAPTCHA_MODE: 'normal' })).toBe(CAPTCHA_MODES.normal)
  })

  it('enables weak unmarked automation in the default test mode and disables it in normal mode', () => {
    expect(resolveCaptchaMode('test')).toBe(CAPTCHA_MODES.test)
    expect(resolveCaptchaMode('testing')).toBe(CAPTCHA_MODES.test)
    expect(currentCaptchaMode({ DSH_PATROL_CAPTCHA_MODE: 'test' })).toBe(CAPTCHA_MODES.test)
    expect(captchaModeAllowsWeakUnmarkedAutomation(CAPTCHA_MODES.normal)).toBe(false)
    expect(captchaModeAllowsWeakUnmarkedAutomation(CAPTCHA_MODES.test)).toBe(true)
  })

  it('allows screenshot OCR for conventional image-code only in test mode', () => {
    expect(captchaModeAllowsImageCodeScreenshotOcr(CAPTCHA_MODES.test)).toBe(true)
    expect(captchaModeAllowsImageCodeScreenshotOcr(CAPTCHA_MODES.normal)).toBe(false)
    expect(captchaModeAllowsImageCodeScreenshotOcr(currentCaptchaMode({}))).toBe(true)
  })

  it('rejects unsupported non-empty mode values instead of silently falling back to test', () => {
    expect(() => resolveCaptchaMode('nromal')).toThrow(/Unsupported DSH_PATROL_CAPTCHA_MODE/)
    expect(() => resolveCaptchaMode('unexpected-mode')).toThrow(/Expected one of: test, testing, default, normal/)
    expect(() => currentCaptchaMode({ DSH_PATROL_CAPTCHA_MODE: 'whatever' })).toThrow(/Unsupported DSH_PATROL_CAPTCHA_MODE/)
  })

  it('keeps the compatibility test-mode toggle harmless and does not override an explicit normal mode', () => {
    expect(currentCaptchaMode({ DSH_PATROL_CAPTCHA_TEST_MODE: '1' })).toBe(CAPTCHA_MODES.test)
    expect(currentCaptchaMode({ DSH_PATROL_CAPTCHA_TEST_MODE: 'true' })).toBe(CAPTCHA_MODES.test)
    expect(currentCaptchaMode({
      DSH_PATROL_CAPTCHA_MODE: 'normal',
      DSH_PATROL_CAPTCHA_TEST_MODE: '1',
    })).toBe(CAPTCHA_MODES.normal)
  })

  it('keeps third-party CAPTCHA automation disabled in every supported mode', () => {
    expect(captchaModeAllowsThirdPartyAutomation(CAPTCHA_MODES.normal)).toBe(false)
    expect(captchaModeAllowsThirdPartyAutomation(CAPTCHA_MODES.test)).toBe(false)
  })
})
