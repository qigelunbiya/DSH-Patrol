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
  it('keeps real business input/click work across later repeated navigation', () => {
    const definition = {
      status: 'ready',
      target: { url: 'https://example.test' },
      artifacts: ['screenshot', 'page-text'],
      steps: [
        step('step-001', 'browser_navigate', { arguments: { url: 'https://example.test' } }),
        step('step-002', 'browser_login_state'),
        step('step-003', 'browser_type', { arguments: { selector: '#user', text: 'demo' } }),
        step('step-004', 'browser_click', { expectation: { mode: 'contains', value: '首页', caseSensitive: false } }),
        step('step-005', 'browser_wait', { arguments: { selector: '#home' } }),
        step('step-006', 'browser_screenshot', { artifact: 'screenshot' }),
        step('step-007', 'browser_read_page', { artifact: 'page-text' }),

        // A later ad-hoc round must not delete the valid login work above.
        step('step-008', 'browser_navigate', { arguments: { url: 'https://example.test' } }),
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
    expect(definition.steps.length).toBeGreaterThan(3)
  })

  it('collapses repeated failed login submit rounds before the successful TOTP boundary', () => {
    const definition = {
      status: 'draft',
      target: { url: 'https://example.test/login' },
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
    expect(detectors.length).toBeLessThanOrEqual(1)
    expect(definition.steps.some(item => item.tool === 'browser_type_totp_profile')).toBe(true)
    expect(definition.steps.some(item => item.locator?.text === '确定')).toBe(true)
  })

  it('does not let generated execution notes protect probes from cleanup', () => {
    const definition = {
      status: 'draft',
      target: { url: 'https://example.test' },
      artifacts: [],
      steps: [
        step('step-001', 'browser_navigate', { arguments: { url: 'https://example.test' }, notes: '执行方法：导航到 https://example.test。' }),
        step('step-002', 'browser_snapshot', { notes: '执行方法：读取当前交互元素。' }),
        step('step-003', 'browser_wait', { arguments: { timeoutMs: 3000 }, notes: '执行方法：等待页面稳定，超时 3000ms。' }),
        step('step-004', 'browser_count', { arguments: { selector: 'a' }, notes: '执行方法：统计 selector a 的可见元素数量。' }),
      ],
    }

    const result = compactFlowConservatively(definition)
    expect(result.removedSteps).toBe(3)
    expect(definition.steps).toHaveLength(1)
    expect(definition.steps[0].tool).toBe('browser_navigate')
  })

  it('removes the exact guess-url / return / guess-url tail shape from an interrupted draft', () => {
    const home = 'http://172.21.9.122/com-portal'
    const definition = {
      status: 'draft',
      target: { url: home },
      artifacts: ['page-text', 'screenshot'],
      steps: [
        step('step-001', 'browser_navigate', { name: '访问系统', arguments: { url: home }, notes: `执行方法：导航到 ${home}。` }),
        step('step-002', 'browser_type', { name: '输入用户名', arguments: { selector: '#username', text: 'fangzeming' }, notes: '执行方法：向 selector #username 填写值。' }),
        step('step-003', 'browser_type_transient_ref', { name: '输入密码', arguments: { selector: '#password', secretRef: 'PATROL_SECRET_password' }, notes: '执行方法：向 selector #password 填写值。' }),
        step('step-004', 'browser_type_transient_ref', { name: '输入短信验证码', arguments: { selector: '#register-code', secretRef: 'PATROL_SECRET_sms' }, notes: '执行方法：向 selector #register-code 填写值。' }),
        step('step-005', 'browser_read_page', { artifact: 'page-text', notes: '执行方法：读取当前页面可见文本，作为本步骤产物供后续摘要/断言使用。' }),
        step('step-006', 'browser_navigate', { name: '猜测工作台地址', arguments: { url: 'http://172.21.9.122/com-portal/workbench' }, notes: '执行方法：导航到猜测地址。' }),
        step('step-007', 'browser_navigate', { name: '返回首页', arguments: { url: home }, notes: `执行方法：导航到 ${home}。` }),
        step('step-008', 'browser_wait', { arguments: { timeoutMs: 3000 }, notes: '执行方法：等待页面稳定，超时 3000ms。' }),
        step('step-009', 'browser_navigate', { name: '再次猜工作台地址', arguments: { url: 'http://172.21.9.122/cmp-cloud-manage/workbench/home/index.do' }, notes: '执行方法：导航到猜测地址。' }),
        step('step-010', 'browser_navigate', { name: '返回首页', arguments: { url: home }, notes: `执行方法：导航到 ${home}。` }),
        step('step-011', 'browser_navigate', { name: '第三次猜工作台地址', arguments: { url: 'http://172.21.9.122/cmp-cloud-manage/workbench/home/index.do' }, notes: '执行方法：导航到猜测地址。' }),
        step('step-012', 'browser_wait', { arguments: { timeoutMs: 3000 }, notes: '执行方法：等待页面变化，超时 3000ms。' }),
      ],
    }

    compactFlowConservatively(definition)
    const urls = definition.steps
      .filter(item => item.tool === 'browser_navigate')
      .map(item => item.arguments.url)

    expect(urls).toEqual([home, home, home])
    expect(definition.steps.some(item => String(item.arguments?.url || '').includes('workbench'))).toBe(false)
    expect(definition.steps.some(item => item.tool === 'browser_wait')).toBe(false)
    expect(definition.steps.some(item => item.tool === 'browser_type')).toBe(true)
    expect(definition.steps.some(item => item.tool === 'browser_type_transient_ref')).toBe(true)
  })

  it('does not deduplicate arbitrary repeated business clicks', () => {
    const definition = {
      status: 'ready',
      target: { url: 'https://example.test' },
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
