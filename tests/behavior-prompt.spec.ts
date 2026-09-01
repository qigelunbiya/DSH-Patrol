import { describe, expect, it } from 'vitest'
import { PATROL_BEHAVIOR_PROMPT } from '../src/behavior-prompt.js'

describe('current Patrol behavior prompt', () => {
  it('forbids converting ordinary image-code failure into human handoff', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/image-code 完全禁止人工接管/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/失败就直接报错并停止/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/patrol_prepare_verification_handoff 只允许真正需要人的验证/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/observedSubtype=image-code.*运行时也会拒绝/s)
  })

  it('uses encrypted durable Patrol storage for passwords supplied in chat', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/当前对话提供密码.*直接使用 patrol_type_transient/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/AES-256-GCM/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/PATROL_SECRET_/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不要调用 patrol_credential_help/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/Harness 重启后仍可自动解密重放/s)
  })

  it('requires semantic grouping before writing weekly-report templates', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/禁止把源记录按顺序逐条塞进空行/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/多条源记录映射到同一个键时先合并\/编号\/换行后一次写入同一个目标单元格/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/模板不是固定格式/s)
  })
})
