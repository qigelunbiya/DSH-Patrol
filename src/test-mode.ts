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
- patrol_observe 是推荐的 CURRENT 页面观察工具。长流程不要每个动作后都 observe/snapshot；只有页面跳转、目标不确定、弹窗/iframe 重建或下一步确实需要新证据时再观察。
- CURRENT 页面点击优先 patrol_click_target，因为它可以语义定位、验证并记录。若唯一文本点击失败、同名控件有多个、表格/弹窗/iframe 结构复杂，可调用 patrol_analyze_step 获取 CURRENT 证据，但 analyze 在 TEST MODE 是辅助工具，不是 patrol_click / patrol_click_target 的强制许可证。
- 当已经从 CURRENT snapshot/read-page 获得一个具体 CSS selector 时，可以直接使用 patrol_click 做受记录的 fallback；不要因为缺少 patrol_analyze_step 而拒绝执行。patrol_click 自己负责浏览器动作和结果验证。
- 若 Patrol 复合点击在复杂老系统上仍无法执行，TEST MODE 允许把 browser_semantic_click / browser_click 作为“当前页面现场操作”的最后后备，也允许 browser_press / browser_scroll / browser_select。它们不会自动写入 Runbook，所以一旦低层后备成功，应尽快用 CURRENT 成功证据补教为 patrol_* 步骤或在最终 flow cleanup 时保留可重放路径。不要把低层后备当第一选择，也不要无限循环 selector。
- 对“目标身份 + 行内动作”场景，例如某一主机/工单/设备行里的 RDP、SSH、详情按钮，patrol_click_target 的 stepName 必须同时保留目标身份和动作名称。扩展会先按最近业务行上下文定位；对于固定列/分裂表格，还会按 row key、aria-rowindex、同组行序号和水平对齐关系把身份列与动作列关联，避免只按第一个同名按钮点击。
- 不要使用 :has-text()、text=、XPath 等当前 CSS 层不支持的伪选择器碰运气。定位失败时最多做少量有新证据的尝试；TEST MODE 不靠 Error guard 阻断，而靠工具自身的唯一性验证和模型停止重复试错。
- 普通图片字符验证码 image-code 在 Windows TEST MODE 必须 Windows OCR 优先于视觉模型。已知当前页面是普通字符验证码时，第一识别动作调用 patrol_windows_ocr_image_code；禁止一上来直接调用 browser_capture_image_code_visual，也不要先把 model-visual 当主要识别路径。
- patrol_windows_ocr_image_code 会先 OCR CURRENT 验证码紧凑区域；若紧凑裁图为空/弱，再自动执行 CURRENT 整页 PNG Windows OCR，并用 CURRENT snapshot/readPage 的已知页面文字过滤普通页面文本。两条 Windows OCR 路径都跑完之前禁止先用 model-visual。
- 当 patrol_windows_ocr_image_code 返回强候选且 confidence >= 0.90 时，直接把这个 CURRENT 候选交给 patrol_type_current_image_code；taskChecklist 中的验证码格式约束仍然优先，候选不满足约束时不得提交。
- 只有紧凑裁图 Windows OCR + 过滤后的 CURRENT 整页 Windows OCR 都明确失败/为空/弱，或候选不满足 taskChecklist 约束时，才调用 browser_capture_image_code_visual 获取 CURRENT 验证码裁图作为模型视觉后备。这里的优先级固定为 Windows OCR → model-visual。
- browser_detect_auth_challenge 仍用于 NORMAL MODE/无人值守动态 solver 和未知挑战分类；不要用它覆盖上述 Windows TEST MODE 已知普通 image-code 的明确优先级。
- CAPTCHA 视觉后备裁图时默认不要传历史 tabId；让 Patrol 使用当前活动目标页。若旧 tabId 已失效或 content-script bridge 暂时不可用，视觉工具会做一次当前活动页截图后备，不要手工进入 recover/list-tabs/screenshot/read_image 循环。
- 每次视觉后备读取只给一个最终识别值和 0~1 置信度。置信度 >= 0.90 才允许 patrol_type_current_image_code；多个候选、字符边界不确定或置信度 < 0.90 时禁止提交，使用 patrol_refresh_image_code 换一张后重新抓 CURRENT 裁图。
- 同一页面最多尝试 3 次验证码级刷新；只有刷新机制异常时才允许 1 次整页 reload。不要通过反复提交低置信度验证码“试对”。普通 image-code 不转人工 checkpoint/handoff。
- NORMAL MODE / 无人值守 replay 继续使用 Runbook 中的动态 browser_detect_auth_challenge 本地 solver；TEST MODE 的已知普通 image-code 则固定先走 patrol_windows_ocr_image_code，再允许 model-visual 后备。
- 动态口令/TOTP 使用 patrol_list_totp_profiles + patrol_type_totp_profile；有匹配 profile 时不要先留空提交，也不要让用户重复提供动态码。
- 密码、token、TOTP 等敏感值仍只能走专用敏感输入工具，绝不写入 Runbook 明文、notes、报告或用户可见总结。即使 TEST MODE 允许部分低层页面操作，browser_type / browser_type_credential 等敏感输入仍不得作为绕过安全工具的后备。
- 用户纠正已有流程时先 patrol_show 映射 stepId，能原位 reteach 就原位 reteach；确认旧步骤不应存在时才 remove。只有确实缺新动作时才新增，并立即移动到正确位置。不得把纠正继续追加到流程尾部形成第二套路径。
- 修改后必须完整 patrol_validate；需要人工 OTP/checkpoint 时再 resume_validation。只有完整通过后才确认编辑。
- 教学完成后先 patrol_finalize_flow，只保留 taskChecklist 的最终成功路线，再确认流程。诊断探针、失败点击、重复输入、恢复试错不能固化进 Runbook。
- 如需确认模式调用 patrol_runtime_mode；TEST MODE 应报告 operational-click-fallbacks。需要恢复严格边界时设置 DSH_PATROL_CAPTCHA_MODE=normal 后彻底重启 Harness。`