import { describe, expect, it } from 'vitest'
import { PATROL_BEHAVIOR_PROMPT } from '../src/behavior-prompt.js'

describe('current Patrol behavior prompt', () => {
  it('requires user-visible replies to follow the user language', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/跟随用户最近一条自然语言消息/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/用户用中文就必须用简体中文/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/流程名称、description、expectedResult、stepName/s)
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

  it('prevents repeated conversational loops after the same patrol failure', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/同一目标.*同类失败/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/最多重试一次/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不得复述同一段计划/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/连续两次自然语言回复/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/立即停止继续生成同类文字/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/仍无法完成用户任务清单中的该项.*结束本轮教学/s)
  })

  it('requires task-list driven teaching and excludes unverified steps from the flow graph', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/先把用户原始巡检要求拆成一份有序任务清单/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/expectedText 不是点击前置门槛/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/只有实际变化得到验证才记录步骤/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/未完成、未验证、页面未变化/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/自动填好了用户名.*不能.*省略该步骤/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/预填状态.*不能替代下一次重放所需的动作/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不得因为点击困难就偷偷用 patrol_navigate 直达目标 URL/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/CURRENT 页面已经出现下一项的明确目标.*立即执行/s)
  })

  it('requires semantic grouping before writing weekly-report templates', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/禁止把源记录按顺序逐条塞进空行/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/多条源记录映射到同一个键时先合并\/编号\/换行后一次写入同一个目标单元格/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/模板不是固定格式/s)
  })
})