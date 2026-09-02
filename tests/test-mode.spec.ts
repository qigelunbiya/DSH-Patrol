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

  it('prioritizes current model vision, confidence gating, bounded captcha refresh, and configured TOTP profiles', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_observe 附带的 CURRENT 页面截图/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/browser_capture_image_code_visual/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/置信度 >= 0\.80/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_current_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/置信度 < 0\.80 时禁止把弱猜测写入输入框/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/最多尝试 3 次验证码级刷新/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/1 次整页 reload/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不要通过反复提交低置信度验证码/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_list_totp_profiles/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_totp_profile/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不要先留空点击确定/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/recovery circuit breaker 在测试模式关闭/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_runtime_mode/)
  })
})