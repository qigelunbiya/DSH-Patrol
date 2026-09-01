import { describe, expect, it } from 'vitest'
import { PATROL_BEHAVIOR_PROMPT } from '../src/behavior-prompt.js'

describe('current Patrol behavior prompt', () => {
  it('forbids converting ordinary image-code failure into human handoff', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/image-code.*完全禁止人工接管/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/识别失败时 detector 必须直接报错/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/不要.*patrol_prepare_verification_handoff/s)
  })

  it('requires semantic grouping before writing weekly-report templates', () => {
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/禁止采用“源记录第 1 条写第 1 个空行/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/多条源记录映射到同一个语义键时，必须先合并\/编号\/换行后一次写入同一个目标单元格/s)
    expect(PATROL_BEHAVIOR_PROMPT).toMatch(/模板不是固定格式/s)
  })
})
