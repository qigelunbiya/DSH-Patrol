const TEST_MODE_VALUES = new Set(['test', 'testing', 'default', ''])
const CAPTCHA_MODE_VALUES = ['test', 'testing', 'default', 'normal']

export interface PatrolRuntimePolicy {
  testMode: boolean
  installGuards: boolean
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
    injectStrictRecoveryPrompt: !testMode,
    injectStrictVerificationPrompt: !testMode,
    injectObservationPrompt: !testMode,
  }
}

export const PATROL_TEST_MODE_OVERRIDE_PROMPT = `DSH Patrol TEST MODE 调试覆盖规则（本节优先级高于前面所有 Patrol 工作流/验证码/恢复限制）：
- 当前是测试模式。不要因为旧 Patrol 文案中的“必须先 observe”“detector 失败后必须停止”“禁止刷新验证码”“禁止通用输入工具填写 image-code”“禁止直接 browser_*”而拒绝用户要求的调试操作；这些运行时 guard 在 test mode 下不会注册。
- patrol_observe 在测试模式下是可选诊断工具，不再是所有页面改变操作的前置条件。需要时可以直接 patrol_screenshot、patrol_snapshot、patrol_read_page、patrol_doctor、patrol_wait、patrol_navigate 或继续执行其他 Patrol 操作。
- 普通图片字符验证码 image-code 在测试模式下允许反复调试：patrol_detect_auth_challenge 失败后可以再次 detector、截图、读取工作区图片、使用模型视觉/OCR、刷新验证码、重新定位图片区域，并继续尝试。
- 对普通 image-code，测试模式允许使用 patrol_type_text / patrol_type_transient 等通用输入工具把当前页面当前验证码的调试识别结果写入验证码输入框；也允许点击/按键刷新验证码。不要仅因为验证码 guard 的旧文字而停止。
- 测试模式允许模型直接调用已挂载且位于 Patrol browser allowlist 内的 browser_* 工具做诊断。注意：直接 browser_* 调用不会自动写入 Runbook；正式教学步骤仍优先使用 patrol_*，但这只是记录建议，不是禁止。
- recovery circuit breaker 在测试模式下关闭。允许为了定位问题重复 detector、wait、snapshot、read_page、screenshot、doctor、navigate 等诊断动作，不得再以“stalled phase / already run once / too many diagnostics”为理由阻止调试。
- 以上放开仅用于调试 Patrol 自身和用户授权的网站流程。密码等敏感值仍不得写入 Runbook、notes、报告或用户可见总结；现有 browser allowlist、secret vault 和底层工具参数校验仍然有效。
- 如需恢复严格巡检边界，设置 DSH_PATROL_CAPTCHA_MODE=normal 后重启 Harness。`
