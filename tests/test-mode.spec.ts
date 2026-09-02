import { describe, expect, it } from 'vitest'
import {
  isPatrolTestMode,
  PATROL_TEST_MODE_OVERRIDE_PROMPT,
  resolvePatrolRuntimePolicy,
} from '../src/test-mode.js'

describe('Patrol test-mode guard policy', () => {
  it('defaults to test mode and disables orchestration guards and strict workflow prompts', () => {
    expect(isPatrolTestMode({})).toBe(true)
    expect(resolvePatrolRuntimePolicy({})).toEqual({
      testMode: true,
      installGuards: false,
      injectStrictWorkflowPrompt: false,
      injectStrictRecoveryPrompt: false,
      injectStrictVerificationPrompt: false,
      injectObservationPrompt: false,
    })
  })

  it('keeps explicit normal mode strict', () => {
    expect(isPatrolTestMode({ DSH_PATROL_CAPTCHA_MODE: 'normal' })).toBe(false)
    expect(resolvePatrolRuntimePolicy({ DSH_PATROL_CAPTCHA_MODE: 'normal' })).toEqual({
      testMode: false,
      installGuards: true,
      injectStrictWorkflowPrompt: true,
      injectStrictRecoveryPrompt: true,
      injectStrictVerificationPrompt: true,
      injectObservationPrompt: true,
    })
  })

  it('accepts all documented test aliases and rejects typos', () => {
    for (const value of ['test', 'testing', 'default', '']) {
      expect(isPatrolTestMode({ DSH_PATROL_CAPTCHA_MODE: value })).toBe(true)
    }
    expect(() => isPatrolTestMode({ DSH_PATROL_CAPTCHA_MODE: 'nromal' })).toThrow(/Unsupported DSH_PATROL_CAPTCHA_MODE/)
  })

  it('prioritizes current model vision and explicitly overrides debug restrictions', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/第一优先使用刚刚 patrol_observe 附带的 CURRENT 页面截图/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/直接用 patrol_type_text \/ browser_type 填入当前验证码输入框/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/失败后允许再次 detector/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/允许点击\/按键刷新验证码/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/recovery circuit breaker 在测试模式关闭/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_runtime_mode/)
  })
})
