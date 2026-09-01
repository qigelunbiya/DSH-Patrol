const ORDINARY_CAPTCHA = /(captcha|图形验证码|图片验证码|字符验证码|验证码图片|\b验证码\b)/i
const TRUE_HUMAN_ONLY = /(otp|one[- ]?time|动态码|动态验证码|一次性|短信|手机验证码|邮箱验证码|邮件验证码|二次验证码|二次验证|passkey|security key|安全密钥|扫码|二维码|确认登录|手机.{0,12}确认|设备.{0,12}确认|approval|approve|recaptcha|hcaptcha|turnstile|arkose|funcaptcha)/i

export const PATROL_MANUAL_VERIFICATION_PROMPT = `人工验证最小化规则：
- 普通图片字符验证码（image-code）禁止人工 checkpoint。它不是“自动优先、失败再人工”，而是“只能自动”：patrol_detect_auth_challenge 必须调用专用 image-code 链路，本地 ddddocr 优先、Windows 系统 OCR 后备；识别成功就自动填写并继续已观察到的登录/提交步骤，识别失败就让当前巡检步骤直接失败并报告错误。
- 不要为 image-code 调用 patrol_prepare_verification_handoff，不要为它调用 patrol_add_checkpoint，不要让用户手动核对、抄写或输入该图片验证码。
- patrol_screenshot 返回 verification-suppressed 只表示整页截图 OCR 没有读取验证内容，不是人工接管信号；验证码只能由专用 detector/solver 处理。
- OTP/一次性动态码、设备确认、Passkey、二维码确认、第三方 reCAPTCHA/hCaptcha/Turnstile/Arkose 和真正不支持的其他验证仍可人工接管。`

export function createManualVerificationGuard() {
  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    if (name !== 'patrol_add_checkpoint') return undefined

    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    const reason = typeof args.reason === 'string' ? args.reason : ''
    const text = `${reason} ${prompt}`
    if (TRUE_HUMAN_ONLY.test(text) || reason === 'otp' || reason === 'approval') return undefined
    if (!ORDINARY_CAPTCHA.test(text)) return undefined

    return [
      'DSH Patrol verification guard：普通图片字符验证码（image-code）禁止人工 checkpoint。',
      '请调用 patrol_detect_auth_challenge，让专用 ddddocr/Windows OCR 自动识别并填写。',
      '如果自动识别失败，当前巡检应直接失败并报告 image-code automation failed；不得改成让用户手工输入验证码。',
      'OTP、设备确认和已识别的第三方 CAPTCHA 不受此规则影响。',
    ].join(' ')
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
