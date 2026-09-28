import { describe, expect, it } from 'vitest'
import {
  isPatrolTestMode,
  PATROL_TEST_MODE_OVERRIDE_PROMPT,
  resolvePatrolRuntimePolicy,
} from '../src/test-mode.js'

describe('Patrol test-mode guard policy', () => {
  it('defaults to test mode with a compact first-turn prompt profile', () => {
    expect(isPatrolTestMode({})).toBe(true)
    expect(resolvePatrolRuntimePolicy({})).toEqual({
      testMode: true,
      installGuards: false,
      injectStrictWorkflowPrompt: false,
      injectStrictRecoveryPrompt: false,
      injectStrictVerificationPrompt: false,
      injectObservationPrompt: false,
      injectExtendedDomainPrompts: false,
    })
  })

  it('keeps explicit normal mode strict and fully documented', () => {
    expect(isPatrolTestMode({ DSH_PATROL_CAPTCHA_MODE: 'normal' })).toBe(false)
    expect(resolvePatrolRuntimePolicy({ DSH_PATROL_CAPTCHA_MODE: 'normal' })).toEqual({
      testMode: false,
      installGuards: true,
      injectStrictWorkflowPrompt: true,
      injectStrictRecoveryPrompt: true,
      injectStrictVerificationPrompt: true,
      injectObservationPrompt: true,
      injectExtendedDomainPrompts: true,
    })
  })

  it('accepts all documented test aliases and rejects typos', () => {
    for (const value of ['test', 'testing', 'default', '']) {
      expect(isPatrolTestMode({ DSH_PATROL_CAPTCHA_MODE: value })).toBe(true)
    }
    expect(() => isPatrolTestMode({ DSH_PATROL_CAPTCHA_MODE: 'nromal' })).toThrow(/Unsupported DSH_PATROL_CAPTCHA_MODE/)
  })

  it('keeps the TEST prompt compact while preserving operational browser, desktop, auth and edit rules', () => {
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT.length).toBeLessThan(3_800)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不要长时间只分析不调用工具/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/显式要求拥有最高优先级/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/只用视觉.*patrol_browser_click_ocr_text.*patrol_browser_visual_action_map.*patrol_browser_click_visual_candidate/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/模型只选择文字或 V#.*最终点击坐标由程序计算/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/不暴露 patrol_visual_click_target/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/Browser V# runtime\/state 与 Desktop D# runtime\/state 完全隔离/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/明确禁止视觉.*不得 includeImage=true/s)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/browser_semantic_click \/ browser_click/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/desktop_\* 原语可以直接操作当前桌面应用/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/发消息、删除文件、关闭窗口等当前都允许直接执行/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/NORMAL MODE 现阶段同样不分级/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/第一次识别必须先 patrol_solve_current_image_code/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/browser_detect_auth_challenge 本地 OCR solver/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/禁止一上来直接 browser_capture_image_code_visual/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/autoFilled=true/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/testModeFallback=true \/ strategy=model-visual-test/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/置信度 >= 0\.90/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/最多 3 次验证码刷新/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/1 次整页 reload/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_list_totp_profiles \+ patrol_type_totp_profile/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_show 映射 stepId/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/完整 patrol_validate/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/patrol_finalize_flow/)
    expect(PATROL_TEST_MODE_OVERRIDE_PROMPT).toMatch(/operational-click-fallbacks/)

    const localOcrFirst = PATROL_TEST_MODE_OVERRIDE_PROMPT.indexOf('patrol_solve_current_image_code')
    const modelVisionFallback = PATROL_TEST_MODE_OVERRIDE_PROMPT.indexOf('browser_capture_image_code_visual')
    expect(localOcrFirst).toBeGreaterThanOrEqual(0)
    expect(modelVisionFallback).toBeGreaterThan(localOcrFirst)
  })
})
