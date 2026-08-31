import { describe, expect, it } from 'vitest'
import {
  CAPTCHA_MODES,
  captchaModeAllowsThirdPartyAutomation,
  captchaModeAllowsWeakUnmarkedAutomation,
  currentCaptchaMode,
  resolveCaptchaMode,
} from '../browser-bridge-runtime/captcha-mode.js'

describe('captcha runtime mode', () => {
  it('defaults to normal mode and fails closed for unknown values', () => {
    expect(resolveCaptchaMode('')).toBe(CAPTCHA_MODES.normal)
    expect(resolveCaptchaMode('normal')).toBe(CAPTCHA_MODES.normal)
    expect(resolveCaptchaMode('unexpected-mode')).toBe(CAPTCHA_MODES.normal)
    expect(currentCaptchaMode({})).toBe(CAPTCHA_MODES.normal)
  })

  it('enables weak unmarked automation only in test mode', () => {
    expect(resolveCaptchaMode('test')).toBe(CAPTCHA_MODES.test)
    expect(resolveCaptchaMode('testing')).toBe(CAPTCHA_MODES.test)
    expect(currentCaptchaMode({ DSH_PATROL_CAPTCHA_MODE: 'test' })).toBe(CAPTCHA_MODES.test)
    expect(captchaModeAllowsWeakUnmarkedAutomation(CAPTCHA_MODES.normal)).toBe(false)
    expect(captchaModeAllowsWeakUnmarkedAutomation(CAPTCHA_MODES.test)).toBe(true)
  })

  it('supports the compatibility test-mode toggle without overriding the primary mode setting', () => {
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
