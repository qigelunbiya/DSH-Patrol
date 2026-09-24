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

  it('uses Patrol local OCR before model vision and keeps test-mode click fallbacks operational', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/image-code.*不再视觉优先/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toContain('patrol_insert_wait_step')
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/结构编辑期间禁止用 patrol_wait.*patrol_screenshot/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/保存图未满足用户要求时禁止 patrol_validate/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/authenticated.*fast-forward.*登录前缀/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/用户只要求执行\/重跑时.*不得擅自编辑/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/第一次识别必须先调用 patrol_solve_current_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/browser_detect_auth_challenge 本地 OCR solver/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/禁止一上来直接调用 browser_capture_image_code_visual/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/autoFilled=true/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/testModeFallback=true \/ strategy=model-visual-test/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/视觉工具是后备，不是第一路径/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/默认不要传历史 tabId/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/置信度 >= 0\.90/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_current_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_refresh_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/最多尝试 3 次验证码级刷新/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/1 次整页 reload/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/普通 image-code 不转人工 checkpoint\/handoff/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/NORMAL MODE \/ 无人值守 replay.*动态 browser_detect_auth_challenge/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_list_totp_profiles/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_type_totp_profile/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_show.*stepId/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不得把纠正继续追加到流程尾部/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/完整 patrol_validate/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/显式要求拥有最高优先级/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/没有指定方法.*AUTO\/HYBRID/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/只用视觉模型.*patrol_browser_click_ocr_text.*patrol_browser_visual_action_map.*patrol_browser_click_visual_candidate/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/禁止视觉.*不得调用 patrol_observe\(includeImage=true\).*patrol_browser_visual_action_map.*patrol_browser_click_visual_candidate.*patrol_browser_click_ocr_text/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/Desktop BuildActionMap/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/V1\/V2\/\.\.\./)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/最终坐标只能由程序的 V# bbox center 产生/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/可以直接使用 patrol_click/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/browser_semantic_click \/ browser_click/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/用户可见语言规则不会因 TEST MODE 放宽/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/learned semantic.*learned selector.*guarded visual geometry/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/browser_navigate/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/固定列\/分裂表格/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/operational-click-fallbacks/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_runtime_mode/)

    const localOcrFirst = PATROL_TEST_MODE_OVERRIDE_PROMPT.indexOf('patrol_solve_current_image_code')
    const modelVisionFallback = PATROL_TEST_MODE_OVERRIDE_PROMPT.indexOf('browser_capture_image_code_visual')
    expect(localOcrFirst).toBeGreaterThanOrEqual(0)
    expect(modelVisionFallback).toBeGreaterThan(localOcrFirst)
  })
})