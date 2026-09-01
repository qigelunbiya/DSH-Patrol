const ATTEMPT_TTL_MS = 2 * 60_000

const ORDINARY_CAPTCHA = /(captcha|图形验证码|图片验证码|字符验证码|验证码图片|\b验证码\b)/i
const TRUE_HUMAN_ONLY = /(otp|one[- ]?time|动态码|动态验证码|一次性|短信|手机验证码|邮箱验证码|邮件验证码|二次验证码|二次验证|passkey|security key|安全密钥|扫码|二维码|确认登录|手机.{0,12}确认|设备.{0,12}确认|approval|approve)/i

export const PATROL_MANUAL_VERIFICATION_PROMPT = `Human verification minimization:
- Human checkpoints are the LAST resort, not the default response to any verification-looking page.
- Conventional image-text CAPTCHA is automation-first: call patrol_detect_auth_challenge and let the Windows OCR path attempt it before adding a checkpoint.
- Do not add a human checkpoint merely because patrol_screenshot says verification OCR was suppressed; that screenshot message is evidence-only. The dedicated challenge detector is the solver entry point.
- OTP/one-time codes, device approvals, passkeys, QR confirmations and genuinely unsupported verification can still use checkpoints immediately.
- If an ordinary image-code was attempted and remains unsolved, a checkpoint is allowed; do not loop OCR indefinitely.`

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
      'DSH Patrol verification guard: ordinary image-text CAPTCHA must not jump directly to a human checkpoint.',
      'Call patrol_detect_auth_challenge first. It will attempt the dedicated Windows OCR/image-code solver.',
      'Only if that automation attempt still leaves the CAPTCHA unsolved should you add a manual checkpoint.',
      'OTP/one-time codes and device approvals are not affected by this rule.',
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
