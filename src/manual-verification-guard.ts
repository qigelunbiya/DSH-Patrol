const ATTEMPT_TTL_MS = 2 * 60_000

const ORDINARY_CAPTCHA = /(captcha|图形验证码|图片验证码|字符验证码|验证码图片|\b验证码\b)/i
const TRUE_HUMAN_ONLY = /(otp|one[- ]?time|动态码|动态验证码|一次性|短信|手机验证码|邮箱验证码|邮件验证码|二次验证码|二次验证|passkey|security key|安全密钥|扫码|二维码|确认登录|手机.{0,12}确认|设备.{0,12}确认|approval|approve|recaptcha|hcaptcha|turnstile|arkose|funcaptcha)/i

export const PATROL_MANUAL_VERIFICATION_PROMPT = `人工验证最小化规则：
- 人工 checkpoint 是最后手段，不是看到“验证码/验证”字样后的默认动作。
- 常规图片字符验证码必须自动化优先：调用 patrol_detect_auth_challenge，让专用 image-code 链路先对验证码小图使用本地 ddddocr，必要时再回退 Windows 系统 OCR，并尝试自动填写输入框。
- patrol_screenshot 返回 verification-suppressed 只表示“整页截图 OCR 没有读取验证内容”，不是人工接管信号。不要因为 screenshot 的这句话直接添加 checkpoint；专用 detector 才是验证码求解入口。
- 只有 detector 已经实际尝试普通 image-code 且仍返回 handoffRequired=true，才允许为该验证码添加人工 checkpoint；不要无限循环 OCR。
- OTP/一次性动态码、设备确认、Passkey、二维码确认、第三方 reCAPTCHA/hCaptcha/Turnstile/Arkose 和真正不支持的验证仍可直接人工接管。`

export function createManualVerificationGuard() {
  const attempts = new Map<string, number>()

  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const inspectionId = typeof args.inspectionId === 'string' ? args.inspectionId.trim() : ''
    const now = Date.now()
    cleanup(attempts, now)

    if (name === 'patrol_detect_auth_challenge' && inspectionId !== '') {
      attempts.set(inspectionId, now)
      return undefined
    }
    if (name !== 'patrol_add_checkpoint') return undefined

    const prompt = typeof args.prompt === 'string' ? args.prompt : ''
    const reason = typeof args.reason === 'string' ? args.reason : ''
    const text = `${reason} ${prompt}`
    if (TRUE_HUMAN_ONLY.test(text) || reason === 'otp' || reason === 'approval') return undefined
    if (!ORDINARY_CAPTCHA.test(text)) return undefined

    const attemptedAt = inspectionId === '' ? undefined : attempts.get(inspectionId)
    if (attemptedAt !== undefined && now - attemptedAt <= ATTEMPT_TTL_MS) return undefined

    return [
      'DSH Patrol verification guard：普通图片字符验证码不能直接进入人工 checkpoint。',
      '请先调用 patrol_detect_auth_challenge；它会优先运行专用 ddddocr/image-code OCR，再按需回退 Windows OCR。',
      '只有自动识别尝试后验证码仍未解决时，才允许人工接管。',
      'OTP、设备确认和已识别的第三方 CAPTCHA 不受此规则影响。',
    ].join(' ')
  }
}

function cleanup(attempts: Map<string, number>, now: number): void {
  for (const [key, value] of attempts) {
    if (now - value > ATTEMPT_TTL_MS) attempts.delete(key)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
