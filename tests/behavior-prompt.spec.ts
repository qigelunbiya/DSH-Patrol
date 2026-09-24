import { describe, expect, it } from 'vitest'
import { PATROL_BEHAVIOR_PROMPT } from '../src/behavior-prompt.js'

describe('current Patrol behavior prompt', () => {
  it('requires user-visible replies to follow the user language', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/跟随用户最近一条自然语言消息/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/用户用中文就必须用简体中文/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/流程名称、description、expectedResult、stepName/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/draft.*“编辑中”.*ready.*“已保存”/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/禁止只抛出 DRAFT\/READY/s)
  })

  it('uses automatic local OCR first for ordinary image-code and keeps human handoff disabled', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/image-code 完全禁止人工接管/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_solve_current_image_code/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/本地 OCR/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/browser_capture_image_code_visual/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_refresh_image_code 换图/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_prepare_verification_handoff 只允许真正需要人的验证/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/observedSubtype=image-code.*运行时也会拒绝/s)
  })

  it('uses encrypted durable Patrol storage for passwords supplied in chat', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/当前对话提供密码.*直接使用 patrol_type_transient/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/AES-256-GCM/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/PATROL_SECRET_/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不要调用 patrol_credential_help/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/Harness 重启后仍可自动解密重放/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/用户可见.*不得复述.*明文密码/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/操作计划、编号步骤、进度说明/s)
  })

  it('requires completed-flow corrections to target, replace/remove, reposition, and validate affected steps', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/看某一步|某一步/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_run_flow/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_show/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_reteach_/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_remove_steps/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_move_step/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/尾部/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_validate/s)
  })

  it('separates structural Runbook edits from live browser teaching and requires saved-graph verification', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/“结构编辑”和“网页教学”必须分离/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_insert_wait_step/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_insert_screenshot_step/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_insert_read_page_step/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/禁止用 patrol_wait、patrol_screenshot、patrol_read_page、patrol_click_target/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/必须只调用一次 patrol_show/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/browser_wait\.timeoutMs=5000/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/绝不能用“可能是缓存”解释/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/保存图已核对.*patrol_validate 通过/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/正式巡检完成后.*持久化 Runbook 做结构编辑/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_insert_.*持久化失败.*禁止退化/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/禁止用 patrol_rewrite_flow_path 代替纯新增\/参数修改/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/保存图尚未匹配用户要求时调用 patrol_validate/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/任务清单是给人看的业务说明.*Runbook 流程图是给执行器看的/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_update_task_checklist/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不得只改流程图后留下过期任务清单/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_task_checklist.*核对/s)
  })

  it('uses structural update tools for parameter-only edits without live browser teaching', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_update_wait_step/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_update_screenshot_step/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_update_read_page_step/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_update_navigate_step/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/保持原 step id 和顺序/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不得为了把 5 秒改成 10 秒.*patrol_reteach_browser_step/s)
  })

  it('prevents repeated conversational loops after the same patrol failure', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/同一目标.*同类失败/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/最多重试一次/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不得复述同一段计划/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/连续两次自然语言回复/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/立即停止继续生成同类文字/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/仍无法完成用户任务清单中的该项.*结束本轮教学/s)
  })

  it('keeps semantic-click fallback inside one guarded composite action', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/selector hint.*selector-compatible click/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不要立刻另起 patrol_click/s)
  })

  it('requires task-list driven teaching and excludes unverified steps from the flow graph', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/先把用户原始巡检要求拆成一份有序任务清单/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/expectedText 不是点击前置门槛/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/只有实际变化得到验证才记录步骤/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/未完成、未验证、页面未变化/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/自动填好了用户名.*不能.*省略该步骤/s)
    expect(PATROL_BEHAVIOR_PROMPT).toContain('预填状态只能说明本次页面当前满足条件')
    expect(PATROL_BEHAVIOR_PROMPT).toContain('不能替代下一次重放所需动作')
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不得因为点击困难就偷偷用 patrol_navigate 直达目标 URL/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/CURRENT 页面已经出现下一项的明确目标.*立即执行/s)
  })

  it('requires semantic grouping before writing weekly-report templates', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/禁止把源记录按顺序逐条塞进空行/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/多条源记录映射到同一个键时先合并\/编号\/换行后一次写入同一个目标单元格/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/模板不是固定格式/s)
  })
  it('documents focused public typing for shadow-DOM/web-component editors', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toContain('patrol_type_focused_text')
    expect(PATROL_BEHAVIOR_PROMPT).toContain('web component')
    expect(PATROL_BEHAVIOR_PROMPT).toContain('shadow DOM')
    expect(PATROL_BEHAVIOR_PROMPT).toContain('browser_type_focused')
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/绝不能用于密码、token、OTP 或验证码/)
  })


  it('uses screenshot OCR geometry as the primary browser visual text path without touching Desktop runtime', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/视觉可直接执行、DOM\/语义负责学习和重放/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/CURRENT screenshot Windows OCR boundingBox/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_visual_click_target\(ocrText=/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/ocrRelation="close-right"/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/no-input safety probe/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/没有可靠可见文字.*imageX\/imageY/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/TEST 模式 live xRatio\/yRatio 禁止/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不要再把.*Browser Pixel Action Map B#.*DOM Action Map A#/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不要为普通视觉点击调用 read_image/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/Browser.*Desktop.*严格隔离/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/trusted Chrome debugger mouse dispatch/)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/learned semantic.*learned selector.*guarded visual geometry/)
    expect(PATROL_BEHAVIOR_PROMPT).not.toMatch(/两阶段 Pixel Grounding/)
  })

})
