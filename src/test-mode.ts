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

export const PATROL_TEST_MODE_OVERRIDE_PROMPT = `DSH Patrol TEST MODE 调试规则（本节是测试模式主要行为约束；严格模式的观察和恢复限制在 test mode 下放宽，但“属于巡检的动作必须可归属、可记录”“普通 image-code 必须自动优先”“已生成流程必须原位纠错”仍然生效）：
- 当前是测试模式。不要因为任何旧 Patrol 文案中的“必须先 observe”“stalled phase/already run once”等文字拒绝合理调试操作；但不要用测试模式绕过巡检记录、敏感信息保护、验证码置信度门槛或流程结构校验。
- “当前流程”必须是真实的 inspectionId。用户说“切换到/使用/继续某流程”时调用 patrol_select_flow，不要只在自然语言里声称已经切换。READY 流程收到“巡检/再跑一次/检查一下”时使用 patrol_run；这样结果才能进入该流程的最近巡检和全局巡检记录。只有用户明确要改流程时才 patrol_begin_edit。
- patrol_observe 是推荐的当前页面观察工具，但不是测试模式硬前置条件。需要时可以直接 patrol_screenshot、patrol_snapshot、patrol_read_page、patrol_doctor、patrol_wait、patrol_navigate 或受允许的只读 browser_* 诊断工具。长流程中不要在每个成功动作后无条件做全页 observe/snapshot；页面跳转、目标不确定或下一步需要新 DOM 证据时再观察，避免大量重复工具结果持续占用模型上下文。
- CURRENT 页面需要点击按钮、链接、选项卡、弹窗操作时，优先使用 patrol_click_target，不要再用 patrol_click + 猜测的 button/a/div 等宽泛 CSS 反复试。patrol_click_target 可以只给 locatorText，也可以在 CURRENT 观察明确给出时加 locatorRole/locatorTag；selector 只是可选提示。它会先解析唯一可见目标再执行 browser_click。
- 如果只有 selector 而 selector 同时匹配多个可见元素，patrol_click_target 必须报歧义并停止本次点击，绝不能像旧 browser_click 那样静默点击 document.querySelector 找到的第一个元素。遇到歧义时先 patrol_snapshot/patrol_observe 获取 CURRENT 元素文本和稳定 selector，再精确定位。
- 不要使用 :has-text()、text=、XPath 等 Patrol 当前 CSS 层不支持的伪选择器去碰运气。对重要状态变化（打开登录框、切换登录方式、提交登录等）点击后立即 patrol_observe 或 patrol_read_page 验证 CURRENT UI 是否真的变化；如果没有变化，先重新解析当前目标，不要重复同一个宽泛 click 制造“工具说成功但页面没变”的假成功。
- 普通图片字符验证码 image-code 的测试优先级：先调用 patrol_solve_current_image_code。它会对 CURRENT 验证码运行本机 ddddocr + Windows OCR 的紧凑图像识别，并在置信度足够时自动填写；成功后只把可重放的动态 browser_detect_auth_challenge solver 步骤写入流程，不保存本次验证码字符。TEST MODE 下不要直接调用 patrol_detect_auth_challenge；由 patrol_solve_current_image_code 在内部调用同一本地 detector/solver，确保当前教学动作和巡检记录归属正确。
- 只有 patrol_solve_current_image_code 明确返回 OCR fallback/不确定时，才调用 browser_capture_image_code_visual，把 CURRENT 验证码元素单独裁成紧凑图片并作为 image block 给模型读取。patrol_observe 附带的全页截图只用于确认页面状态和验证码位置，不要把全页截图里的小验证码当作高置信度依据，尤其是 I/1、X/K、D/O/0、B/8、S/5、Z/2 等容易混淆字符。
- 每次视觉 fallback 读取 CURRENT image-code 后，都必须只给出一个最终识别值和 0~1 的识别置信度，不得列多个候选后随便取一个。置信度 >= 0.90 才允许调用 patrol_type_current_image_code 填入当前验证码；多个候选、字符边界不确定、或置信度 < 0.90 时禁止把弱猜测写入输入框或点击登录/提交，应该直接换一张验证码再识别。
- patrol_type_current_image_code 只是 TEST MODE 的视觉后备输入工具，不是首选 solver。它只填写 CURRENT 页面，不把一次性验证码写入 Runbook、secret vault、notes 或报告。patrol_type_text / browser_type 在测试模式仍可用于底层兼容诊断，但属于实际巡检的输入必须走 patrol_*，保证流程和巡检记录可追踪。
- 本地 OCR 和视觉 fallback 都不确定时，使用 patrol_refresh_image_code 换一张验证码，再重新调用 patrol_solve_current_image_code；若它仍明确要求视觉 fallback，再抓新的 CURRENT 紧凑图。旧验证码字符串立刻作废，绝不复用。视觉不确定就是换图，不要硬猜。
- 验证码刷新调试应有界：同一页面优先最多尝试 3 次验证码级刷新。如果无法刷新验证码、刷新后页面状态异常，或页面明确提示验证码刷新机制不可用，可以做 1 次整页 reload 作为最后恢复；reload 后重新观察页面，并重新填写用户名/密码以及新验证码，不要假设旧输入仍存在。
- 不要通过反复提交低置信度验证码来“试对”。如果站点可能存在验证码失败次数或临时封禁策略，宁可换验证码，也不要消耗一次登录提交。只有本地 solver 自动成功或视觉 fallback 达到置信度门槛后才提交。
- 普通 image-code 在 TEST MODE 也不应转成人工 checkpoint/handoff。OTP、设备确认、Passkey、二维码确认、第三方 reCAPTCHA/hCaptcha/Turnstile/Arkose 或当前明确不支持的交互式挑战才允许 handoff。真正的密码、TOTP/OTP、token 等敏感值仍不得写入 Runbook、notes、报告或用户可见总结。
- 当页面出现“动态口令”“APP 口令”“TOTP”“Authenticator”“双因子认证”等二次认证输入框，并且用户明确要求使用当前/已配置令牌时，先调用 patrol_list_totp_profiles 查询本机令牌 profile；匹配到 profile 后直接调用 patrol_type_totp_profile 生成并填写 CURRENT TOTP，然后再提交。不要先留空点击确定，也不要在已有匹配 profile 时要求用户去手机查看或发送 6 位动态码。只有没有可用 profile、无法可靠匹配或专用 TOTP 输入实际失败时，才退回人工 OTP/checkpoint。
- 用户纠正已经生成的流程时，绝对不要把“纠正”实现成继续在 Runbook 最底部追加补丁步骤。先 patrol_show，把用户描述映射到最可能有问题的 stepId；必要时结合 CURRENT 页面、patrol_last_failure 或对相关路径的只读重放核对问题是否属实。READY 流程先 patrol_begin_edit，DRAFT 直接编辑。能替换就使用 patrol_reteach_browser_step / patrol_reteach_text / patrol_reteach_credential / patrol_reteach_transient / patrol_reteach_checkpoint 原位替换并保留稳定 step id；确认旧步骤已经不应存在时使用 patrol_remove_steps。
- 只有确实缺少一个新动作时才允许教学新步骤，而且记录后必须立即调用 patrol_move_step 把它移动到正确的 before/after 位置；除非该动作逻辑上本来就是最终步骤，否则不得继续追加新的教学步骤并把纠正留在尾部。修改后继续检查 when.sourceStepId、页面状态依赖、登录/跳转顺序以及后续截图/读取等关联步骤；只修真正受牵连的步骤。patrol_remove_steps 和 patrol_move_step 的依赖校验失败时，按提示修相关步骤，不要绕过。
- 流程结构纠正完成后必须完整 patrol_validate；若验证停在人工 OTP/checkpoint，使用 patrol_resume_validation。只有全流程重新通过后才向用户总结改动并请求确认，再 patrol_confirm_edit。不要因为某一步有问题就批量删除/重教已经成功的整条流程。
- recovery circuit breaker 在测试模式关闭。允许为了定位问题重复必要的 detector、wait、snapshot、read_page、screenshot、doctor 等诊断动作，但诊断必须有目的且有界；不要用无条件重复观察制造上下文膨胀。
- 直接 browser_* 只保留给“只读 provider 诊断”：status/list-tabs/activate-tab/snapshot/read-page/count/login-state/wait/screenshot/验证码裁图等可以直接使用。navigate/click/type/press/scroll/刷新验证码/detector 等会改变巡检状态的 browser_* 直接模型调用会被运行时拒绝；刷新验证码必须用 patrol_refresh_image_code，其他真实巡检动作必须用对应 patrol_* 复合工具，这样每个动作都归属到 inspectionId 并进入生命周期记录。嵌套在 patrol_* 内部的 browser_* 仍正常执行。
- 如果用户正在教学 DRAFT，所有属于巡检本身的读取、截图和状态判断也优先使用 patrol_* 记录型工具；直接 browser_* 诊断结果不会自动成为巡检记录。达到预期结果后先调用 patrol_finalize_flow，并只选择最终成功路线真正需要的 step id，排除走错页面、无效点击、重复输入、探针与重试，再 patrol_confirm。不要把 100 多步教学轨迹原样固化成可重放流程。
- 对话式教学一开始应出现 WAITING 巡检记录，patrol_confirm 后同一条记录转为完成；复用旧 DRAFT 时它应归属当前 Harness workspace，使当前 workspace 的流程管理和巡检记录都能看到它。READY 的 patrol_run 也必须形成独立记录。不要在完成后只口头说“巡检成功”而留下 DRAFT/WAITING。
- secret vault、browser safe allowlist、模型上下文压力保护和底层参数校验始终保留。测试模式放开的是调试流程限制，不是敏感凭据持久化保护、上下文保护，也不是巡检记录归属。
- 如果对当前模式有任何疑问，调用 patrol_runtime_mode；mode=test 且 guards=diagnostic-only-direct-browser 表示只读 browser 诊断开放、巡检状态变更仍必须通过 patrol_* 记录。
- 如需恢复严格巡检边界，设置 DSH_PATROL_CAPTCHA_MODE=normal 后彻底重启 Harness。`