export const CAPTCHA_MODES = Object.freeze({
  normal: Object.freeze({
    name: 'normal',
    explicitDemoAutomation: true,
    weakUnmarkedAutomation: false,
    thirdPartyAutomation: false,
  }),
  test: Object.freeze({
    name: 'test',
    explicitDemoAutomation: true,
    weakUnmarkedAutomation: true,
    thirdPartyAutomation: false,
  }),
})

const TEST_MODE_VALUES = new Set(['1', 'true', 'yes', 'on', 'test', 'testing'])

export function resolveCaptchaMode(value) {
  const requested = String(value || '').trim().toLowerCase()
  if (requested === 'test' || requested === 'testing') return CAPTCHA_MODES.test
  if (requested === 'normal' || requested === 'default' || requested === '') return CAPTCHA_MODES.normal
  return CAPTCHA_MODES.normal
}

export function currentCaptchaMode(env = process.env) {
  const configured = env?.DSH_PATROL_CAPTCHA_MODE
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolveCaptchaMode(configured)
  }

  const compatibilityToggle = String(env?.DSH_PATROL_CAPTCHA_TEST_MODE || '').trim().toLowerCase()
  if (TEST_MODE_VALUES.has(compatibilityToggle)) return CAPTCHA_MODES.test
  return CAPTCHA_MODES.normal
}

export function captchaModeAllowsWeakUnmarkedAutomation(mode = currentCaptchaMode()) {
  return mode?.weakUnmarkedAutomation === true
}

export function captchaModeAllowsThirdPartyAutomation(mode = currentCaptchaMode()) {
  return mode?.thirdPartyAutomation === true
}
