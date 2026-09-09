import { describe, expect, it } from 'vitest'
import { compactDashboardFlow } from '../browser-bridge-runtime/safe-flow-cleanup-hardening.js'

function step(id, tool, extra = {}) {
  return {
    id,
    kind: 'tool',
    name: `${tool} ${id}`,
    tool,
    arguments: {},
    recordedAt: '2026-09-09T00:00:00Z',
    ...extra,
  }
}

describe('dashboard draft cleanup hardening', () => {
  it('removes guessed route recovery and blind scrolls without deleting login inputs or final artifacts', () => {
    const definition = {
      status: 'draft',
      target: { url: 'http://portal.test/com-portal' },
      artifacts: ['page-text', 'screenshot'],
      steps: [
        step('step-001', 'browser_navigate', { arguments: { url: 'http://portal.test/com-portal' }, expectation: { mode: 'contains', value: '登录' } }),
        step('step-002', 'browser_type', { name: '输入用户名', arguments: { selector: '#username', text: 'demo' } }),
        step('step-003', 'browser_type_transient_ref', { name: '输入密码', arguments: { selector: '#password', transientRef: 'PATROL_SECRET_demo' } }),
        step('step-004', 'browser_type_transient_ref', { name: '输入短信验证码', arguments: { selector: '#code', transientRef: 'PATROL_SECRET_code' } }),
        step('step-005', 'browser_click', { name: '某次错误业务点击', arguments: { selector: '#todo' }, expectation: { mode: 'contains', value: '待办' } }),
        step('step-006', 'browser_scroll', { arguments: { direction: 'down', amount: 500 }, notes: '执行方法：滚动当前页面。' }),
        step('step-007', 'browser_navigate', { arguments: { url: 'http://portal.test/com-portal/todo' }, expectation: { mode: 'contains', value: '待办' }, notes: '执行方法：导航到猜测地址。' }),
        step('step-008', 'browser_navigate', { arguments: { url: 'http://portal.test/com-portal/home' }, expectation: { mode: 'contains', value: '工作台' }, notes: '执行方法：导航回主页。' }),
        step('step-009', 'browser_navigate', { arguments: { url: 'http://portal.test/com-portal' }, expectation: { mode: 'contains', value: '登录' }, notes: '执行方法：导航回目标。' }),
        step('step-010', 'browser_scroll', { arguments: { direction: 'down', amount: 800 }, notes: '执行方法：继续向下滚动。' }),
        step('step-011', 'browser_read_page', { artifact: 'page-text' }),
        step('step-012', 'browser_screenshot', { artifact: 'screenshot' }),
      ],
    }

    const result = compactDashboardFlow(definition)
    expect(result.originalSteps).toBe(12)
    expect(definition.steps.filter(item => item.tool === 'browser_navigate')).toHaveLength(1)
    expect(definition.steps.some(item => item.tool === 'browser_scroll')).toBe(false)
    expect(definition.steps.some(item => item.name === '输入用户名')).toBe(true)
    expect(definition.steps.some(item => item.name === '输入密码')).toBe(true)
    expect(definition.steps.some(item => item.tool === 'browser_read_page')).toBe(true)
    expect(definition.steps.some(item => item.tool === 'browser_screenshot')).toBe(true)
  })

  it('preserves an explicitly user-noted revisit and selector-scoped scroll', () => {
    const definition = {
      status: 'draft',
      target: { url: 'https://example.test/a' },
      artifacts: [],
      steps: [
        step('step-001', 'browser_navigate', { arguments: { url: 'https://example.test/a' } }),
        step('step-002', 'browser_navigate', { arguments: { url: 'https://example.test/a' }, notes: '用户明确要求重新打开首页' }),
        step('step-003', 'browser_scroll', { arguments: { selector: '#grid', direction: 'down', amount: 400 } }),
      ],
    }
    compactDashboardFlow(definition)
    expect(definition.steps.map(item => item.tool)).toEqual(['browser_navigate', 'browser_navigate', 'browser_scroll'])
  })
})
