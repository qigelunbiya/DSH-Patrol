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

export const PATROL_TEST_MODE_OVERRIDE_PROMPT = `DSH Patrol TEST MODE 调试规则（测试模式允许诊断，但真实巡检动作仍必须可归属、可记录、可重放）：
- 当前是测试模式。不要因为旧 Patrol 文案中的“必须先 observe”等限制拒绝合理调试，但不得绕过巡检记录、敏感信息保护、验证码置信度门槛、流程结构校验或页面规划器的 HARD STOP。
- 当前流程必须是真实 inspectionId。运行已有流程用 patrol_run / patrol_run_flow；只有用户明确要修改流程时才进入教学/编辑。已有成功路径不得为了补一个后续动作而从头重新教学。
- patrol_observe 是推荐的 CURRENT 页面观察工具。长流程不要每个动作后都 observe/snapshot；只有页面跳转、目标不确定、弹窗/iframe 重建或下一步确实需要新证据时再观察。
- CURRENT 页面点击优先 patrol_click_target。遇到同名控件、表格多行、弹窗或 iframe 时，第一次失败后只允许一次 patrol_analyze_step 和一次恢复策略；若运行时返回 HARD STOP，立即停止 selector 探索，不得继续 patrol_click、browser_count、snapshot/read_page 或换一种说法重复同一点击。
- 对“目标身份 + 行内动作”场景，例如某一主机/工单/设备行里的 RDP、SSH、详情按钮，stepName 必须同时保留目标身份和动作名称，让原子语义点击器按最近业务行上下文定位；禁止退化成只点第一个同名按钮。
- 不要使用 :has-text()、text=、XPath 等当前 CSS 层不支持的伪选择器碰运气。不要把 nth-of-type 当成无限重试策略。
- 普通图片字符验证码 image-code 在 TEST MODE 的交互教学改为视觉优先：直接调用 browser_capture_image_code_visual 获取 CURRENT 验证码紧凑裁图并附加给模型读取，不再先运行 ddddocr/Windows OCR 预检。视觉工具本身也不得再偷偷执行本地 OCR。
- CAPTCHA 视觉裁图时默认不要传历史 tabId；让 Patrol 使用当前活动目标页。若旧 tabId 已失效或 content-script bridge 暂时不可用，视觉工具会做一次当前活动页截图后备，不要手工进入 recover/list-tabs/screenshot/read_image 循环。
- 每次视觉读取只给一个最终识别值和 0~1 置信度。置信度 >= 0.90 才允许 patrol_type_current_image_code；多个候选、字符边界不确定或置信度 < 0.90 时禁止提交，使用 patrol_refresh_image_code 换一张后重新抓 CURRENT 裁图。
- 同一页面最多尝试 3 次验证码级刷新；只有刷新机制异常时才允许 1 次整页 reload。不要通过反复提交低置信度验证码“试对”。普通 image-code 不转人工 checkpoint/handoff。
- NORMAL MODE / 无人值守 replay 仍可使用 Runbook 中的动态 browser_detect_auth_challenge 本地 solver，因为重放阶段没有模型视觉；这与 TEST MODE 交互教学跳过本地 OCR 预检不冲突。
- 动态口令/TOTP 使用 patrol_list_totp_profiles + patrol_type_totp_profile；有匹配 profile 时不要先留空提交，也不要让用户重复提供动态码。
- 密码、token、TOTP 等敏感值仍只能走专用敏感输入工具，绝不写入 Runbook 明文、notes、报告或用户可见总结。
- 用户纠正已有流程时先 patrol_show 映射 stepId，能原位 reteach 就原位 reteach；确认旧步骤不应存在时才 remove。只有确实缺新动作时才新增，并立即移动到正确位置。不得把纠正继续追加到流程尾部形成第二套路径。
- 修改后必须完整 patrol_validate；需要人工 OTP/checkpoint 时再 resume_validation。只有完整通过后才确认编辑。
- TEST MODE 的旧 recovery circuit breaker 仍关闭以允许必要诊断，但 always-on 页面规划器仍负责普通业务点击的两策略上限；“诊断开放”绝不等于允许 selector/reply 无限循环。
- 直接 browser_* 只用于只读诊断：status/list-tabs/activate-tab/snapshot/read-page/count/login-state/wait/screenshot/验证码裁图。真实 navigate/click/type/press/scroll/刷新/detector 必须走 patrol_*，保证动作进入生命周期记录。
- 教学完成后先 patrol_finalize_flow，只保留 taskChecklist 的最终成功路线，再确认流程。诊断探针、失败点击、重复输入、恢复试错不能固化进 Runbook。
- 如需确认模式调用 patrol_runtime_mode；如需恢复严格边界，设置 DSH_PATROL_CAPTCHA_MODE=normal 后彻底重启 Harness。`