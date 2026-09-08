import { describe, expect, it } from 'vitest'
import { compactFlowConservatively } from '../browser-bridge-runtime/safe-flow-cleanup.js'

function step(id, tool, extra = {}) {
  return {
    id,
    kind: 'tool',
    name: `${tool} ${id}`,
    tool,
    arguments: {},
    recordedAt: `2026-09-04T00:00:${id.slice(-3)}Z`,
    ...extra,
  }
}

describe('dashboard conservative flow cleanup', () => {
  it('never treats a later repeated navigation as permission to delete the earlier flow', () => {
    const definition = {
      artifacts: ['screenshot', 'page-text'],
      steps: [
        step('step-001', 'browser_navigate'),
        step('step-002', 'browser_login_state'),
        step('step-003', 'browser_type'),
        step('step-004', 'browser_click'),
        step('step-005', 'browser_wait'),
        step('step-006', 'browser_screenshot', { artifact: 'screenshot' }),
        step('step-007', 'browser_read_page', { artifact: 'page-text' }),

        // A later ad-hoc "run" accidentally recorded another mini round.
        step('step-008', 'browser_navigate'),
        step('step-009', 'browser_login_state'),
        step('step-010', 'browser_screenshot', { artifact: 'screenshot' }),
        step('step-011', 'browser_read_page', { artifact: 'page-text' }),
      ],
    }

    const result = compactFlowConservatively(definition)

    expect(result.originalSteps).toBe(11)
    expect(definition.steps.some(item => item.tool === 'browser_type')).toBe(true)
    expect(definition.steps.some(item => item.tool === 'browser_click')).toBe(true)
    expect(definition.steps[0].tool).toBe('browser_navigate')
    expect(definition.steps.length).toBeGreaterThan(4)
  })

  it('collapses repeated failed login submit rounds before the successful TOTP boundary', () => {
    const definition = {
      artifacts: [],
      steps: [
        step('step-001', 'browser_navigate', { arguments: { url: 'https://example.test/login' } }),
        step('step-002', 'browser_type', { name: '填写用户名', arguments: { selector: '#username', text: 'demo' } }),
        step('step-003', 'browser_type_transient_ref', { name: '填写密码', arguments: { selector: '#password', secretRef: 'PATROL_SECRET_demo' } }),

        step('step-004', 'browser_detect_auth_challenge', { name: '识别验证码' }),
        step('step-005', 'browser_click', { name: '点击登录按钮', arguments: { selector: 'form > button' }, locator: { text: '登 录' } }),
        step('step-006', 'browser_snapshot'),
        step('step-007', 'browser_detect_auth_challenge', { name: '识别验证码' }),
        step('step-008', 'browser_click', { name: '点击登录按钮', arguments: { selector: 'form > button' }, locator: { text: '登 录' } }),
        step('step-009', 'browser_wait', { name: '等待登录结果', arguments: { timeoutMs: 500 } }),
        step('step-010', 'browser_detect_auth_challenge', { name: '识别验证码' }),
        step('step-011', 'browser_click', { name: '点击登录按钮', arguments: { selector: 'form > button' }, locator: { text: '登 录' } }),

        // Once TOTP appears, the final detector/click pair is the successful
        // login round. Cleanup must not cross this durable workflow boundary.
        step('step-012', 'browser_type_totp_profile', { name: '填写动态口令', arguments: { selector: '#otp', profile: 'demo' } }),
        step('step-013', 'browser_click', { name: '点击确定按钮', arguments: { selector: '.otp-ok' }, locator: { text: '确定' } }),
      ],
    }

    const result = compactFlowConservatively(definition)
    const loginClicks = definition.steps.filter(item => item.tool === 'browser_click' && item.locator?.text === '登 录')
    const detectors = definition.steps.filter(item => item.tool === 'browser_detect_auth_challenge')

    expect(result.originalSteps).toBe(13)
    expect(result.removedSteps).toBeGreaterThanOrEqual(5)
    expect(loginClicks).toHaveLength(1)
    expect(detectors).toHaveLength(1)
    expect(definition.steps.some(item => item.tool === 'browser_type_totp_profile')).toBe(true)
    expect(definition.steps.some(item => item.locator?.text === '确定')).toBe(true)
  })

  it('does not deduplicate arbitrary repeated business clicks', () => {
    const definition = {
      artifacts: [],
      steps: [
        step('step-001', 'browser_click', { name: '下一页', arguments: { selector: '.next' }, locator: { text: '下一页' } }),
        step('step-002', 'browser_click', { name: '下一页', arguments: { selector: '.next' }, locator: { text: '下一页' } }),
      ],
    }

    compactFlowConservatively(definition)
    expect(definition.steps).toHaveLength(2)
  })
})
