import { describe, expect, it } from 'vitest'
import { PATROL_LANGUAGE_PROMPT } from '../src/language-prompt.ts'
import { PATROL_TEST_MODE_OVERRIDE_PROMPT } from '../src/test-mode.ts'

describe('Patrol user-visible language contract', () => {
  it('keeps Chinese replies, errors, recovery text and summaries in Chinese when the user speaks Chinese', () => {
    expect(PATROL_LANGUAGE_PROMPT).toMatch(/用户使用中文.*简体中文/s)
    expect(PATROL_LANGUAGE_PROMPT).toMatch(/解释、进度、错误说明、恢复说明、总结/)
    expect(PATROL_LANGUAGE_PROMPT).toMatch(/工具输出.*使用英文.*不代表用户切换了语言/s)
    expect(PATROL_LANGUAGE_PROMPT).toMatch(/上游暂不可用.*等待多久.*第几次重试/s)
  })

  it('states explicitly that TEST MODE does not disable the locale contract', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/用户可见语言规则不会因 TEST MODE 放宽/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/简体中文/)
  })
})
