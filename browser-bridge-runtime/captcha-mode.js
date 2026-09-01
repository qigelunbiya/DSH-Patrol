export const CAPTCHA_MODES = Object.freeze({
  normal: Object.freeze({
    name: 'normal',
    explicitDemoAutomation: true,
    weakUnmarkedAutomation: false,
    thirdPartyAutomation: false,
    imageCodeScreenshotOcr: false,
  }),
  test: Object.freeze({
    name: 'test',
    explicitDemoAutomation: true,
    weakUnmarkedAutomation: true,
    thirdPartyAutomation: false,
    imageCodeScreenshotOcr: true,
  }),
})

const TEST_MODE_VALUES = new Set(['1', 'true', 'yes', 'on', 'test', 'testing'])
const CAPTCHA_MODE_VALUES = ['test', 'testing', 'default', 'normal']

export function resolveCaptchaMode(value) {
  const requested = String(value || '').trim().toLowerCase()
  if (requested === 'test' || requested === 'testing') return CAPTCHA_MODES.test
  if (requested === 'normal') return CAPTCHA_MODES.normal
  if (requested === 'default' || requested === '') return CAPTCHA_MODES.test
  throw new Error(`Unsupported DSH_PATROL_CAPTCHA_MODE "${requested}". Expected one of: ${CAPTCHA_MODE_VALUES.join(', ')}.`)
}

export function currentCaptchaMode(env = process.env) {
  const configured = env?.DSH_PATROL_CAPTCHA_MODE
  if (typeof configured === 'string' && configured.trim() !== '') {
    return resolveCaptchaMode(configured)
  }

  const compatibilityToggle = String(env?.DSH_PATROL_CAPTCHA_TEST_MODE || '').trim().toLowerCase()
  if (TEST_MODE_VALUES.has(compatibilityToggle)) return CAPTCHA_MODES.test
  return CAPTCHA_MODES.test
}

export function captchaModeAllowsWeakUnmarkedAutomation(mode = currentCaptchaMode()) {
  return mode?.weakUnmarkedAutomation === true
}

export function captchaModeAllowsThirdPartyAutomation(mode = currentCaptchaMode()) {
  return mode?.thirdPartyAutomation === true
}

export function captchaModeAllowsImageCodeScreenshotOcr(mode = currentCaptchaMode()) {
  return mode?.imageCodeScreenshotOcr === true
}
