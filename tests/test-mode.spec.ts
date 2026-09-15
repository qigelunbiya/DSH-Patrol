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

  it('uses dedicated Windows OCR before model-visual fallback and keeps test-mode click fallbacks operational', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/Windows OCR 优先于视觉模型/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/第一识别动作调用 patrol_windows_ocr_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/CURRENT 验证码紧凑区域/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/CURRENT 整页 PNG Windows OCR/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/snapshot\/readPage/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/两条 Windows OCR 路径都跑完之前禁止先用 model-visual/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/禁止一上来直接调用 browser_capture_image_code_visual/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/才调用 browser_capture_image_code_visual/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT.indexOf('第一识别动作调用 patrol_windows_ocr_image_code')).toBeLessThan(PATROL_TEST_MODE_OVERRIDE_PROMPT.indexOf('才调用 browser_capture_image_code_visual'))
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).not.toMatch(/image-code.*视觉优先/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/默认不要传历史 tabId/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/confidence >= 0\.90/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_current_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_refresh_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/最多尝试 3 次验证码级刷新/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/1 次整页 reload/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/普通 image-code 不转人工 checkpoint\/handoff/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/NORMAL MODE \/ 无人值守 replay.*browser_detect_auth_challenge/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_list_totp_profiles/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_totp_profile/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_show.*stepId/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不得把纠正继续追加到流程尾部/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/完整 patrol_validate/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/analyze 在 TEST MODE 是辅助工具/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/可以直接使用 patrol_click/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/browser_semantic_click \/ browser_click/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/固定列\/分裂表格/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/operational-click-fallbacks/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_runtime_mode/)
  })
})
