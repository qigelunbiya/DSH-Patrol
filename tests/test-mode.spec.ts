import { describe, expect, it } from 'vitest'
import {
  isPatrolTestMode,
  PATROL_TEST_MODE_OVERRIDE_PROMPT,
  resolvePatrolRuntimePolicy,
} from '../src/test-mode.js'

describe('Patrol test-mode guard policy', () => {
  it('defaults to test mode and disables orchestration guards', () => {
    expect(isPatrolTestMode({})).toBe(true)
    expect(resolvePatrolRuntimePolicy({})).toEqual({
      testMode: true,
      installGuards: false,
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

  it('explicitly overrides the image-code, recovery, observation, and direct-browser restrictions', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/detector 失败后可以再次 detector/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/允许点击\/按键刷新验证码/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/允许模型直接调用.*browser_\*/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/recovery circuit breaker 在测试模式下关闭/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_observe 在测试模式下是可选诊断工具/)
  })
})
