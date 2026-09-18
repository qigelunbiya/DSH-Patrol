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

export const PATROL_TEST_MODE_OVERRIDE_PROMPT = `DSH Patrol TEST MODE 调试规则（测试模式以“完成真实巡检”为优先，安全边界保留，但不得让编排限制本身阻塞正常页面操作）：
- 当前是测试模式。严格 NORMAL MODE 的 observe-before-mutate、页面规划器强制前置、HARD STOP 和 direct-browser 全禁用规则不作为 TEST MODE 的运行时拦截器。不要因为“必须先 analyze”“不能直接 browser_click”之类旧文案拒绝合理操作。
- 当前流程必须是真实 inspectionId。运行已有流程用 patrol_run / patrol_run_flow；只有用户明确要修改流程时才进入教学/编辑。已有成功路径不得为了补一个后续动作而从头重新教学。
- patrol_run / patrol_run_flow / patrol_run_batch 以及 patrol_validate 的重放阶段都按只读运行处理。若 CURRENT 浏览器已经处于同站点 authenticated 会话，Runner 会自动 fast-forward 已保存的登录前缀并从第一个登录后业务步骤继续；这不是流程漂移。不要因为登录 selector 缺失、登录步骤被 skipped、当前已经登录，或 validation/replay 命中 authenticated session，就调用 patrol_begin_edit、patrol_login_state、patrol_insert_*、patrol_reteach_*、patrol_finalize_flow 去补或改流程。用户只要求执行/重跑时，正式 replay 若仍失败就报告真实失败；除非用户在当前消息明确要求修改/优化流程，否则不得擅自编辑。
- patrol_observe 是推荐的 CURRENT 页面观察工具。长流程不要每个动作后都 observe/snapshot；只有页面跳转、目标不确定、弹窗/iframe 重建或下一步确实需要新证据时再观察。
- CURRENT 页面点击优先 patrol_click_target，因为它可以语义定位、验证并记录。若唯一文本点击失败、同名控件有多个、表格/弹窗/iframe 结构复杂，可调用 patrol_analyze_step 获取 CURRENT 证据，但 analyze 在 TEST MODE 是辅助工具，不是 patrol_click / patrol_click_target 的强制许可证。
- 当已经从 CURRENT snapshot/read-page 获得一个具体 CSS selector 时，可以直接使用 patrol_click 做受记录的 fallback；不要因为缺少 patrol_analyze_step 而拒绝执行。patrol_click 自己负责浏览器动作和结果验证。
- 若 Patrol 复合点击在复杂老系统上仍无法执行，TEST MODE 允许把 browser_semantic_click / browser_click 作为“当前页面现场操作”的最后后备，也允许 browser_press / browser_scroll / browser_select。它们不会自动写入 Runbook，所以一旦低层后备成功，应尽快用 CURRENT 成功证据补教为 patrol_* 步骤或在最终 flow cleanup 时保留可重放路径。不要把低层后备当第一选择，也不要无限循环 selector。
- TEST MODE 已启用 Windows Desktop Automation。desktop_* 原语可以直接操作当前桌面应用，不做动作权限分级；发消息、删除文件、关闭窗口等当前都允许直接执行。NORMAL MODE 现阶段同样不分级，后续权限分级由项目维护者单独设计。需要把桌面动作写入 Runbook 时使用 patrol_desktop_action；桌面定位优先 UI Automation > 快捷键 > OCR > CURRENT 坐标。
- 操作微信/WPS/百度网盘等已知应用前，优先 desktop_read_app_guide 读取对应 Markdown 指南；工作区指南优先于插件内置指南。不要把应用知识库当成 CURRENT UI 事实，真正点击前仍以 desktop_snapshot / desktop_ocr 的当前证据为准。
- 对“目标身份 + 行内动作”场景，例如某一主机/工单/设备行里的 RDP、SSH、详情按钮，patrol_click_target 的 stepName 必须同时保留目标身份和动作名称。扩展会先按最近业务行上下文定位；对于固定列/分裂表格，还会按 row key、aria-rowindex、同组行序号和水平对齐关系把身份列与动作列关联，避免只按第一个同名按钮点击。
- 不要使用 :has-text()、text=、XPath 等当前 CSS 层不支持的伪选择器碰运气。定位失败时最多做少量有新证据的尝试；TEST MODE 不靠 Error guard 阻断，而靠工具自身的唯一性验证和模型停止重复试错。
- 普通图片字符验证码 image-code 在 TEST MODE 不再视觉优先。第一次识别必须先调用 patrol_solve_current_image_code；该 Patrol 复合工具会在授权上下文中调用现有 browser_detect_auth_challenge 本地 OCR solver 处理 CURRENT 验证码。禁止一上来直接调用 browser_capture_image_code_visual。这样 TEST MODE 与 NORMAL MODE 都先走本地 OCR（包括 Windows OCR）路径，只有本地 OCR 没有安全地自动填写验证码时才允许视觉后备。
- 当 patrol_solve_current_image_code 报告本地 solver 已成功自动填写验证码（autoFilled=true）时，直接继续执行已记录的登录/提交步骤；不要再捕获同一张验证码、不要再用模型视觉重复识别、也不要重新填写一次。
- 只有 patrol_solve_current_image_code 明确报告 TEST MODE fallback（testModeFallback=true / strategy=model-visual-test），说明本地 OCR 没有安全产出可自动填写结果时，才调用 browser_capture_image_code_visual 获取 CURRENT 验证码紧凑裁图给模型读取。视觉工具是后备，不是第一路径。
- CAPTCHA 视觉裁图时默认不要传历史 tabId；让 Patrol 使用当前活动目标页。若旧 tabId 已失效或 content-script bridge 暂时不可用，视觉工具会做一次当前活动页截图后备，不要手工进入 recover/list-tabs/screenshot/read_image 循环。
- 每次视觉读取只给一个最终识别值和 0~1 置信度。置信度 >= 0.90 才允许 patrol_type_current_image_code；多个候选、字符边界不确定或置信度 < 0.90 时禁止提交，使用 patrol_refresh_image_code 换一张后重新抓 CURRENT 裁图。
- 同一页面最多尝试 3 次验证码级刷新；只有刷新机制异常时才允许 1 次整页 reload。不要通过反复提交低置信度验证码“试对”。普通 image-code 不转人工 checkpoint/handoff。
- NORMAL MODE / 无人值守 replay 继续使用 Runbook 中的动态 browser_detect_auth_challenge 本地 solver；TEST MODE 通过 patrol_solve_current_image_code 复用同一条稳定本地 OCR 路径，只是在本地 OCR 明确失败后额外允许模型视觉后备。
- 动态口令/TOTP 使用 patrol_list_totp_profiles + patrol_type_totp_profile；有匹配 profile 时不要先留空提交，也不要让用户重复提供动态码。
- 密码、token、TOTP 等敏感值仍只能走专用敏感输入工具，绝不写入 Runbook 明文、notes、报告或用户可见总结。即使 TEST MODE 允许部分低层页面操作，browser_type / browser_type_credential 等敏感输入仍不得作为绕过安全工具的后备。
- 用户纠正已有流程时先 patrol_show 映射 stepId。等待、截图、读取页面、已知 URL 导航这类不依赖 CURRENT 页面证据的新增动作属于纯 Runbook 结构编辑：必须优先 patrol_insert_wait_step / patrol_insert_screenshot_step / patrol_insert_read_page_step / patrol_insert_navigate_step；已有 wait/screenshot/read/navigate 仅改参数时必须用 patrol_update_*。只有 selector/点击目标本身需要重新学习时才进入 reteach/现场教学。不得把纠正继续追加到流程尾部形成第二套路径。
- 结构编辑期间禁止用 patrol_wait、patrol_screenshot、patrol_read_page、patrol_click、patrol_click_target 去“曲线追加”步骤，也禁止用 patrol_rewrite_flow_path 代替普通新增/参数修改。若 patrol_insert_* / patrol_update_* 报持久化问题，以 patrol_show 的保存图为事实，继续修结构；不要操作 CURRENT 页面碰运气。
- 一轮结构修改完成后只调用一次 patrol_show 核对 step 顺序/tool/关键参数；保存图未满足用户要求时禁止 patrol_validate。只有保存图正确后才完整 patrol_validate；需要人工 OTP/checkpoint 时再 resume_validation。只有完整通过后才确认编辑。
- 教学完成后先 patrol_finalize_flow，只保留 taskChecklist 的最终成功路线，再确认流程。诊断探针、失败点击、重复输入、恢复试错不能固化进 Runbook。
- 如需确认模式调用 patrol_runtime_mode；TEST MODE 应报告 operational-click-fallbacks。需要恢复严格边界时设置 DSH_PATROL_CAPTCHA_MODE=normal 后彻底重启 Harness。`