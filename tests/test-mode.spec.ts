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

  it('uses local OCR first, keeps a high-confidence visual fallback, and edits existing flows in place', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/image-code 的测试优先级：先调用 patrol_solve_current_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/ddddocr \+ Windows OCR/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/TEST MODE 下不要直接调用 patrol_detect_auth_challenge/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/只有 patrol_solve_current_image_code 明确返回 OCR fallback\/不确定时.*browser_capture_image_code_visual/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不要把全页截图里的小验证码当作高置信度依据/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/置信度 >= 0\.90/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_current_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_refresh_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/视觉不确定就是换图/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/多个候选/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/置信度 < 0\.90 时禁止把弱猜测写入输入框/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/最多尝试 3 次验证码级刷新/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/1 次整页 reload/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不要通过反复提交低置信度验证码/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/普通 image-code 在 TEST MODE 也不应转成人工 checkpoint\/handoff/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_list_totp_profiles/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_totp_profile/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不要先留空点击确定/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_show.*stepId/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_reteach_browser_step/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_remove_steps/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_move_step/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不得继续追加新的教学步骤并把纠正留在尾部/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/完整 patrol_validate/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/recovery circuit breaker 在测试模式关闭/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_runtime_mode/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/selector hint.*同一次受控调用内重新计数.*不要另起 patrol_click/s)
  })
})
