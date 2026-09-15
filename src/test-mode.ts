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
- 复用已有流程优先于重新教学。用户只要明确提到某个已有流程并使用“参考/复用/沿用/使用/按…流程/基于…流程/照着…流程/用之前那个流程”等表达，就先 patrol_resolve_flow；唯一匹配且有步骤时默认直接 patrol_run_flow，不得因为同一句里出现“新建一个流程/重新巡检”等泛化措辞就另起空白流程。只有用户明确说“不要复用旧流程/必须创建全新的独立 Runbook”，或者 resolve 后确认不存在/无可用步骤，才 patrol_create_inspection。若用户明确要求修改已有流程，则选择并原位编辑那个流程，而不是从零复制一份。
- 当前流程必须是真实 inspectionId。运行已有流程用 patrol_run / patrol_run_flow；只有用户明确要修改流程时才进入教学/编辑。已有成功路径不得为了补一个后续动作而从头重新教学。
- patrol_observe 是推荐的 CURRENT 页面观察工具。长流程不要每个动作后都 observe/snapshot；只有页面跳转、目标不确定、弹窗/iframe 重建或下一步确实需要新证据时再观察。
- CURRENT 页面点击优先 patrol_click_target，因为它可以语义定位、验证并记录。若唯一文本点击失败、同名控件有多个、表格/弹窗/iframe 结构复杂，可调用 patrol_analyze_step 获取 CURRENT 证据，但 analyze 在 TEST MODE 是辅助工具，不是 patrol_click / patrol_click_target 的强制许可证。
- 当已经从 CURRENT snapshot/read-page 获得一个具体 CSS selector 时，可以直接使用 patrol_click 做受记录的 fallback；不要因为缺少 patrol_analyze_step 而拒绝执行。patrol_click 自己负责浏览器动作和结果验证。
- 若 Patrol 复合点击在复杂老系统上仍无法执行，TEST MODE 允许把 browser_semantic_click / browser_click 作为“当前页面现场操作”的最后后备，也允许 browser_press / browser_scroll / browser_select。它们不会自动写入 Runbook，所以一旦低层后备成功，应尽快用 CURRENT 成功证据补教为 patrol_* 步骤或在最终 flow cleanup 时保留可重放路径。不要把低层后备当第一选择，也不要无限循环 selector。
- 对“目标身份 + 行内动作”场景，例如某一主机/工单/设备行里的 RDP、SSH、详情按钮，patrol_click_target 的 stepName 必须同时保留目标身份和动作名称，例如“点击 10.192.3.174 的 RDP”；locatorText 只写动作文本（如 RDP），不要臆造 locatorRole=link 或 locatorTag=a。扩展会先按最近业务行上下文定位；对于固定列/分裂表格，还会按 row key、aria-rowindex、同组行序号和水平对齐关系把身份列与动作列关联。若 CURRENT DOM 是类似 <span title="[RDP] [EMPTY]">[RDP] [EMPTY]</span> 的 title-backed 自定义动作，必须点击该真实 span/其委托父级，禁止继续猜 a[href] 或不存在的锚点。
- 不要使用 :has-text()、text=、XPath 等当前 CSS 层不支持的伪选择器碰运气。定位失败时最多做少量有新证据的尝试；TEST MODE 不靠 Error guard 阻断，而靠工具自身的唯一性验证和模型停止重复试错。
- 普通图片字符验证码 image-code 在 Windows TEST MODE 必须 Windows 系统 OCR 优先：先调用 patrol_windows_ocr_image_code。该工具第一路径通过 captureImageCode 截取 CURRENT 验证码紧凑区域并用 @napi-rs/system-ocr 识别；如果紧凑裁图返回 empty/weak 或本地 OCR 无可用候选，工具内部必须继续使用稳定旧实现的第二路径：对 CURRENT 整页 PNG 做 Windows OCR，同时用 CURRENT snapshot/readPage 的已知页面文字过滤普通登录文本，只接受过滤后仍未在页面文字中出现的 strong 短候选。两条 Windows OCR 路径都跑完之前禁止先用 model-visual 猜字符。
- 只有当紧凑裁图 Windows OCR + 过滤后的 CURRENT 整页 Windows OCR 都是 unsupported/empty/weak，或候选违反 taskChecklist 声明的长度/字符集硬约束时，才允许 browser_capture_image_code_visual 作为后备；视觉后备也必须读取 CURRENT 新图，不能复用历史验证码。ddddocr 仅作为 NORMAL/无人值守动态 solver 的兼容补充，不得在 TEST MODE 抢在 Windows OCR 前面。
- Windows OCR 优先级现在同时由运行时强制：即使模型误先调用 browser_capture_image_code_visual，该工具也会先内部执行 Windows OCR；若得到 >=0.90 的 strong CURRENT 候选，则不会把图片交给模型视觉，而是直接返回 Windows OCR 候选。
- CAPTCHA OCR/视觉读取默认不要传历史 tabId；让 Patrol 使用当前活动目标页。若旧 tabId 已失效或 content-script bridge 暂时不可用，不要手工进入 recover/list-tabs/screenshot/read_image 循环。
- 每次读取只给一个最终识别值和 0~1 置信度。置信度 >= 0.90 才允许 patrol_type_current_image_code；多个候选、字符边界不确定或置信度 < 0.90 时禁止提交，使用 patrol_refresh_image_code 换一张后重新识别。
- 同一页面最多尝试 3 次验证码级刷新；只有刷新机制异常时才允许 1 次整页 reload。不要通过反复提交低置信度验证码“试对”。普通 image-code 不转人工 checkpoint/handoff。
- NORMAL MODE / 无人值守 replay 仍可使用 Runbook 中的动态 browser_detect_auth_challenge 本地 solver；这与 TEST MODE 交互教学优先 Windows OCR 不冲突。
- 动态口令/TOTP 使用 patrol_list_totp_profiles + patrol_type_totp_profile；有匹配 profile 时不要先留空提交，也不要让用户重复提供动态码。
- 密码、token、TOTP 等敏感值仍只能走专用敏感输入工具，绝不写入 Runbook 明文、notes、报告或用户可见总结。即使 TEST MODE 允许部分低层页面操作，browser_type / browser_type_credential 等敏感输入仍不得作为绕过安全工具的后备。
- 用户纠正已有流程时先 patrol_show 映射 stepId，能原位 reteach 就原位 reteach；确认旧步骤不应存在时才 remove。只有确实缺新动作时才新增，并立即移动到正确位置。不得把纠正继续追加到流程尾部形成第二套路径。
- 修改后必须完整 patrol_validate；需要人工 OTP/checkpoint 时再 resume_validation。只有完整通过后才确认编辑。
- 教学完成后先 patrol_finalize_flow，只保留 taskChecklist 的最终成功路线，再确认流程。诊断探针、失败点击、重复输入、恢复试错不能固化进 Runbook。
- 如需确认模式调用 patrol_runtime_mode；TEST MODE 应报告 operational-click-fallbacks。需要恢复严格边界时设置 DSH_PATROL_CAPTCHA_MODE=normal 后彻底重启 Harness。`