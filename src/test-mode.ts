const TEST_MODE_VALUES = new Set(['test', 'testing', 'default', ''])
const CAPTCHA_MODE_VALUES = ['test', 'testing', 'default', 'normal']

export interface PatrolRuntimePolicy {
  testMode: boolean
  installGuards: boolean
  injectStrictWorkflowPrompt: boolean
  injectStrictRecoveryPrompt: boolean
  injectStrictVerificationPrompt: boolean
  injectObservationPrompt: boolean
  /**
   * TEST mode keeps the same tools/runtime capabilities but avoids injecting
   * every domain-specific instruction block into the model's first turn.
   * This is intentionally prompt-only: Desktop/Browser/Excel tools remain
   * registered and callable.
   */
  injectExtendedDomainPrompts: boolean
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
    injectExtendedDomainPrompts: !testMode,
  }
}

export const PATROL_TEST_MODE_OVERRIDE_PROMPT = `DSH Patrol TEST MODE 精简规则（优先完成真实巡检，避免首轮提示/工具选择过载）：
- 用户可见语言规则不会因 TEST MODE 放宽：用户最近一条自然语言消息是中文时，解释、进度、错误、恢复和总结继续使用简体中文。
- TEST MODE 不启用 NORMAL 的 observe-before-mutate、策略次数/HARD STOP 或 direct-browser 全禁用；仍保留非法 selector、畸形 URL、敏感输入和验证码边界。拿到足够 CURRENT 证据后直接调用最合适的工具，不要长时间只分析不调用工具。
- 新建流程时创建真实 inspectionId + taskChecklist 后立即执行；运行已有流程优先 patrol_run / patrol_run_flow。replay/validate 为只读；authenticated 会话可 fast-forward 登录前缀。用户只要求执行/重跑时不得擅自编辑；只有明确要求修改时才进入 patrol_begin_edit / patrol_insert_* / patrol_update_* / patrol_reteach_*。
- 用户对浏览器操作方式的显式要求拥有最高优先级。未指定时保持 AUTO/HYBRID，可用 CURRENT DOM/semantic/selector/视觉中证据最可靠的方法。
- 用户明确“只用视觉”时只使用三个公开视觉入口：可见文字 → patrol_browser_click_ocr_text；无文字控件 → patrol_observe(includeImage=true) 获取 CURRENT 完整图 → patrol_browser_visual_action_map → read_image(mapPath) → patrol_browser_click_visual_candidate。模型只选择文字或 V#，最终点击坐标由程序计算；不得偷偷切回 DOM/selector。
- 视觉点击聚焦搜索框/编辑框后，PUBLIC 文本使用 patrol_type_focused_text(clear=true)。TEST 新教学不暴露 patrol_visual_click_target；A#/B#/preview/imageX/imageY/xRatio/yRatio 只做内部/历史兼容。Browser V# runtime/state 与 Desktop D# runtime/state 完全隔离。
- 用户明确禁止视觉时不得 includeImage=true，也不得调用上述三个视觉入口，只走 CURRENT DOM/semantic/selector。用户未指定方法时 browser_semantic_click / browser_click 可作为 CURRENT 恢复通道。
- patrol_observe 只在页面跳转、目标不确定、弹窗/iframe 重建或需要新视觉证据时调用；不要无状态变化重复 snapshot/analyze/read。
- TEST MODE 已启用 Windows Desktop Automation：desktop_* 原语可以直接操作当前桌面应用，发消息、删除文件、关闭窗口等当前都允许直接执行；NORMAL MODE 现阶段同样不分级。需要记录时用 patrol_desktop_action；定位优先 UI Automation > 快捷键 > OCR > CURRENT 坐标。已知应用先 desktop_read_app_guide，再以 desktop_snapshot / desktop_ocr 的 CURRENT 证据为准。
- 普通 image-code 第一次识别必须先 patrol_solve_current_image_code，复用 browser_detect_auth_challenge 本地 OCR solver；禁止一上来直接 browser_capture_image_code_visual。autoFilled=true 时直接继续。只有 testModeFallback=true / strategy=model-visual-test 才允许模型视觉后备；置信度 >= 0.90 才可 patrol_type_current_image_code，否则 patrol_refresh_image_code，最多 3 次验证码刷新，刷新机制异常才允许 1 次整页 reload。
- 密码、token、TOTP、验证码只能走专用敏感工具；TOTP 用 patrol_list_totp_profiles + patrol_type_totp_profile。不得把敏感值写入 Runbook、notes、报告或总结。
- 修改已有流程先 patrol_show 映射 stepId；等待/截图/读页/已知 URL 导航用 patrol_insert_* / patrol_update_*，不要曲线追加第二套路径。保存图正确后再完整 patrol_validate；教学完成后 patrol_finalize_flow，只保留完成 taskChecklist 的已验证业务路径。
- 如需确认模式调用 patrol_runtime_mode；TEST MODE 应报告 operational-click-fallbacks。需要严格边界时设置 DSH_PATROL_CAPTCHA_MODE=normal 并彻底重启 Harness。`
