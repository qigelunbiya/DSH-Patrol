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

  it('uses visual-first image-code teaching, preserves confidence gates, and bounds ordinary click recovery', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/image-code.*视觉优先/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/browser_capture_image_code_visual/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不再先运行 ddddocr\/Windows OCR 预检/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/视觉工具本身也不得再偷偷执行本地 OCR/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/默认不要传历史 tabId/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/置信度 >= 0\.90/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_current_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_refresh_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/最多尝试 3 次验证码级刷新/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/1 次整页 reload/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不要通过反复提交低置信度验证码/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/普通 image-code 不转人工 checkpoint\/handoff/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/NORMAL MODE \/ 无人值守 replay.*动态 browser_detect_auth_challenge/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_list_totp_profiles/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_totp_profile/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_show.*stepId/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不得把纠正继续追加到流程尾部/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/完整 patrol_validate/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/页面规划器.*两策略上限/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/HARD STOP/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_runtime_mode/)
  })
})
