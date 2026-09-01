const ORDINARY_CAPTCHA = /(captcha|图形验证码|图片验证码|字符验证码|验证码图片|图形码|校验码|\b验证码\b)/i
const TRUE_HUMAN_ONLY = /(otp|one[- ]?time|动态码|动态验证码|一次性|短信|手机验证码|邮箱验证码|邮件验证码|二次验证码|二次验证|passkey|security key|安全密钥|扫码|二维码|确认登录|手机.{0,12}确认|设备.{0,12}确认|approval|approve|recaptcha|hcaptcha|turnstile|arkose|funcaptcha)/i

const MANUAL_IMAGE_CODE_INPUT_TOOLS = new Set([
  'patrol_type',
  'patrol_type_text',
  'patrol_type_transient',
  'patrol_type_credential',
  'patrol_reteach_text',
  'patrol_reteach_transient',
  'patrol_reteach_credential',
])

const CAPTCHA_REFRESH_TOOLS = new Set([
  'patrol_click',
  'patrol_press',
])

export const PATROL_MANUAL_VERIFICATION_PROMPT = `人工验证最小化规则：
- 普通图片字符验证码（image-code）禁止人工 checkpoint。它不是“自动优先、失败再人工”，而是“只能自动”：patrol_detect_auth_challenge 必须调用专用 image-code 链路，本地 ddddocr 优先、Windows 系统 OCR 后备；识别成功就自动填写并继续已观察到的登录/提交步骤，识别失败就让当前巡检步骤直接失败并报告错误。
- 不要为 image-code 调用 patrol_prepare_verification_handoff，不要为它调用 patrol_add_checkpoint，不要让用户手动核对、抄写或输入该图片验证码。
- 同样禁止模型把聊天附件、Patrol 截图 OCR 或历史消息里“看起来像验证码”的字符串再通过 patrol_type_transient / patrol_type_text 等输入工具写回 #captcha。图片验证码与当前页面实例绑定，刷新、导航或失败提交后旧字符很可能已经失效；只能让专用 detector 在同一次当前页面捕获中识别并立即填写。
- detector 的 image-code 自动识别已经失败后，不要点击验证码图片刷新并继续猜，也不要 screenshot/snapshot/read_page/navigate 后形成诊断循环。保留第一次具体错误并结束当前尝试。
- patrol_screenshot 返回 verification-suppressed 只表示整页截图 OCR 没有读取验证内容，不是人工接管信号；验证码只能由专用 detector/solver 处理。
- OTP/一次性动态码、设备确认、Passkey、二维码确认、第三方 reCAPTCHA/hCaptcha/Turnstile/Arkose 和真正不支持的其他验证仍可人工接管。`

export function createManualVerificationGuard() {
  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const descriptor = verificationDescriptor(args)
    const humanOnly = isHumanOnly(args, descriptor)
    const ordinaryImageCode = ORDINARY_CAPTCHA.test(descriptor) && !humanOnly

    if (name === 'patrol_add_checkpoint') {
      if (!ordinaryImageCode) return undefined
      return [
        'DSH Patrol verification guard：普通图片字符验证码（image-code）禁止人工 checkpoint。',
        '请调用 patrol_detect_auth_challenge，让专用 ddddocr/Windows OCR 自动识别并填写。',
        '如果自动识别失败，当前巡检应直接失败并报告 image-code automation failed；不得改成让用户手工输入验证码。',
        'OTP、设备确认和已识别的第三方 CAPTCHA 不受此规则影响。',
      ].join(' ')
    }

    if (MANUAL_IMAGE_CODE_INPUT_TOOLS.has(name) && ordinaryImageCode) {
      return [
        'DSH Patrol verification guard：禁止通过通用输入工具手工填写普通图片验证码。',
        '不要把聊天截图、OCR 文本或历史消息中猜到的验证码写回验证码输入框；验证码刷新/提交后旧值可能已经失效。',
        '只能调用 patrol_detect_auth_challenge，让专用 image-code solver 捕获“当前页面当前验证码”并在同一自动步骤中立即填写。',
        '如果 detector 已经失败，请保留第一次错误并结束当前尝试，不要换输入工具继续猜。',
      ].join(' ')
    }

    if (CAPTCHA_REFRESH_TOOLS.has(name) && ordinaryImageCode) {
      return [
        'DSH Patrol verification guard：禁止模型在 image-code 自动识别失败后通过点击/按键刷新验证码并继续猜测。',
        '专用 patrol_detect_auth_challenge 自己负责当前验证码的捕获与填写；失败后应停止本轮，而不是制造新的验证码再进入截图/OCR循环。',
      ].join(' ')
    }

    return undefined
  }
}

function verificationDescriptor(args: Record<string, unknown>): string {
  // Deliberately exclude args.text/secret values. The guard only needs field
  // identity/intent and must never echo or inspect a supplied sensitive value.
  return [
    args.stepName,
    args.selector,
    args.notes,
    args.prompt,
    args.reason,
    args.locatorText,
    args.key,
  ]
    .filter(value => typeof value === 'string')
    .join(' ')
}

function isHumanOnly(args: Record<string, unknown>, descriptor: string): boolean {
  return args.reason === 'otp'
    || args.reason === 'approval'
    || TRUE_HUMAN_ONLY.test(descriptor)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
