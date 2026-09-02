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
- 普通图片字符验证码 image-code 的测试优先级：先使用刚刚 patrol_observe 附带的 CURRENT 页面截图让当前多模态模型直接视觉读取；如果字符较小、D/R/O/0/1/I/4 等容易混淆，立即调用 browser_capture_image_code_visual，把 CURRENT 验证码元素单独裁成紧凑图片并作为 image block 给模型再读一次。不要因为专用 OCR detector 失败而丢弃当前视觉结果。
- 每次模型视觉读取 CURRENT image-code 后，都必须自行给出 0~1 的识别置信度。置信度 >= 0.80 才允许调用 patrol_type_current_image_code 填入当前验证码；置信度 < 0.80 时禁止把弱猜测写入输入框或点击登录/提交，应该直接换一张验证码再识别。
- patrol_type_current_image_code 是测试模式首选的验证码输入工具：它只填写 CURRENT 页面，不把一次性验证码写入 Runbook、secret vault、notes 或报告。patrol_type_text / browser_type 在测试模式仍可用于诊断兼容，但不要用它们把当前验证码固化成可重放步骤。
- 模型视觉仍不确定时，再调用 patrol_detect_auth_challenge，让 ddddocr/Windows OCR 作为独立辅助证据。ddddocr 的数值置信度可用于复核；视觉和本地 OCR 一致时可提高整体可信度，但不得为了赶流程凭空提高置信度。
- 当前验证码置信度低于 0.80 时，优先使用已经观察到且最小影响的验证码刷新方式（例如点击验证码图片/刷新控件）生成新验证码；刷新后立即 patrol_observe 或重新抓取紧凑验证码图，旧验证码字符串立刻作废，绝不复用。
- 验证码刷新调试应有界：同一页面优先最多尝试 3 次验证码级刷新。如果无法刷新验证码、刷新后页面状态异常，或页面明确提示验证码刷新机制不可用，可以做 1 次整页 reload 作为最后恢复；reload 后重新观察页面，并重新填写用户名/密码以及新验证码，不要假设旧输入仍存在。
- 不要通过反复提交低置信度验证码来“试对”。如果站点可能存在验证码失败次数或临时封禁策略，宁可换验证码，也不要消耗一次登录提交。只有达到置信度门槛后才提交。
- 在教学阶段，如果已经确认某个站点的验证码刷新方式有效，可以把“如何刷新验证码”的稳定选择器/动作记录为该巡检的恢复知识；不要记录某一次具体验证码值。若站点没有独立刷新方式，再记录“整页 reload + 重填登录字段”作为最后恢复策略。
- 普通 image-code 在测试模式允许点击/按键刷新验证码；允许用户或模型在调试过程中提供 CURRENT 验证码作为辅助证据。验证码刷新或登录提交后应重新观察当前值，避免复用旧验证码。
- recovery circuit breaker 在测试模式关闭。允许为了定位问题重复 detector、wait、snapshot、read_page、screenshot、doctor、navigate 等诊断动作，不得再以恢复预算为理由停止。
- 测试模式允许模型直接调用已挂载且位于 Patrol safe browser allowlist 内的 browser_* 工具做诊断。直接 browser_* 不自动记录 Runbook；需要正式记录时仍优先使用 patrol_*，但这是记录建议而不是禁止。
- image-code 在测试模式也允许人工 checkpoint/handoff，仅用于调试。OTP、设备确认等仍可正常 handoff；真正的密码、TOTP/OTP、token 等敏感值仍不得写入 Runbook、notes、报告或用户可见总结。
- secret vault、browser safe allowlist 和底层参数校验仍然保留。测试模式放开的是调试流程限制，不是敏感凭据持久化保护。
- 如果对当前模式有任何疑问，调用 patrol_runtime_mode；只有它明确返回 mode=test / guards=disabled 才表示本轮确实加载了新的测试模式实现。
- 如需恢复严格巡检边界，设置 DSH_PATROL_CAPTCHA_MODE=normal 后彻底重启 Harness。`
