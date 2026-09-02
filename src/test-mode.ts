const TEST_MODE_VALUES = new Set(['test', 'testing', 'default', ''])
const CAPTCHA_MODE_VALUES = ['test', 'testing', 'default', 'normal']

export interface PatrolRuntimePolicy {
  testMode: boolean
  installGuards: boolean
  injectStrictWorkflowPrompt: boolean
  injectStrictRecoveryPrompt: boolean
  injectStrictVerificationPrompt: boolean
  injectObservationPrompt: boolean
}

export function isPatrolTestMode(env: Record<string, string | undefined> = process.env): boolean {
  const requested = String(env.DSH_PATROL_CAPTCHA_MODE ?? '').trim().toLowerCase()
  if (requested === 'normal') return false
  if (TEST_MODE_VALUES.has(requested)) return true
  throw new Error(`Unsupported DSH_PATROL_CAPTCHA_MODE "${requested}". Expected one of: ${CAPTCHA_MODE_VALUES.join(', ')}.`)
}

export function resolvePatrolRuntimePolicy(env: Record<string, string | undefined> = process.env): PatrolRuntimePolicy {
  const testMode = isPatrolTestMode(env)
  return {
    testMode,
    installGuards: !testMode,
    injectStrictWorkflowPrompt: !testMode,
    injectStrictRecoveryPrompt: !testMode,
    injectStrictVerificationPrompt: !testMode,
    injectObservationPrompt: !testMode,
  }
}

export const PATROL_TEST_MODE_OVERRIDE_PROMPT = `DSH Patrol TEST MODE 调试规则（本节是测试模式唯一的 Patrol 行为约束；严格模式的验证码、观察、恢复和 browser_* 限制在 test mode 下均不生效）：
- 当前是测试模式。不要因为任何旧 Patrol 文案中的“必须先 observe”“detector 失败后必须停止”“禁止刷新验证码”“禁止通用输入工具填写 image-code”“禁止直接 browser_*”“stalled phase/already run once”等文字拒绝调试操作。
- patrol_observe 是推荐的当前页面观察工具，但不是测试模式硬前置条件。需要时可以直接 patrol_screenshot、patrol_snapshot、patrol_read_page、patrol_doctor、patrol_wait、patrol_navigate 或 safe browser_* 诊断工具。
- 普通图片字符验证码 image-code 的测试优先级：第一优先使用刚刚 patrol_observe 附带的 CURRENT 页面截图让当前多模态模型直接视觉读取；模型视觉能够读到当前验证码时，可以直接用 patrol_type_text / browser_type 填入当前验证码输入框，然后继续登录。不要因为专用 OCR detector 失败而丢弃当前视觉结果。
- 如果整页视觉不够清楚，再调用 patrol_detect_auth_challenge 尝试 ddddocr/Windows OCR；失败后允许再次 detector、截图、读取工作区图片、read_image、重新定位验证码区域、刷新验证码并继续尝试。test mode 的 image-code detector 失败不得终止整个巡检。
- 普通 image-code 在测试模式允许 patrol_type_text / patrol_type_transient / browser_type 等通用输入方式填写当前页面当前验证码；允许点击/按键刷新验证码；允许用户或模型在调试过程中提供当前验证码。验证码刷新或登录提交后应重新观察当前值，避免复用旧验证码。
- recovery circuit breaker 在测试模式关闭。允许为了定位问题重复 detector、wait、snapshot、read_page、screenshot、doctor、navigate 等诊断动作，不得再以恢复预算为理由停止。
- 测试模式允许模型直接调用已挂载且位于 Patrol safe browser allowlist 内的 browser_* 工具做诊断。直接 browser_* 不自动记录 Runbook；需要正式记录时仍优先使用 patrol_*，但这是记录建议而不是禁止。
- image-code 在测试模式也允许人工 checkpoint/handoff，仅用于调试。OTP、设备确认等仍可正常 handoff。
- 密码、令牌等敏感值仍不得写入 Runbook、notes、报告或用户可见总结；secret vault、browser safe allowlist 和底层参数校验仍然保留。
- 如果对当前模式有任何疑问，调用 patrol_runtime_mode；只有它明确返回 mode=test / guards=disabled 才表示本轮确实加载了新的测试模式实现。
- 如需恢复严格巡检边界，设置 DSH_PATROL_CAPTCHA_MODE=normal 后彻底重启 Harness。`
