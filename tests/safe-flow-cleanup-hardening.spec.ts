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
    expect(result.flowHealth).toEqual(definition.metadata.flowHealth)
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

  it('marks the supplied portal-style cleaned JSON incomplete instead of presenting it as reusable', () => {
    const definition = {
      status: 'draft',
      target: { url: 'http://172.21.9.122/com-portal' },
      artifacts: ['markdown-report', 'screenshot', 'page-text'],
      metadata: {
        taskChecklist: [
          '访问 com-portal',
          '点击 Logo',
          '输入账号',
          '输入密码',
          '填写短信验证码',
          '点击登录',
          '点击我的工作台',
          '点击待办待阅工单',
          '读取并整理待处理工单信息',
          '截图工单列表',
          '打开其中一张工单',
          '截图工单详情',
        ],
      },
      steps: [
        step('step-001', 'browser_navigate', { name: '导航到 com-portal', arguments: { url: 'http://172.21.9.122/com-portal' } }),
        step('step-002', 'browser_read_page', { name: '读取完整页面内容', artifact: 'page-text' }),
        step('step-003', 'browser_type_transient_ref', { name: '输入密码', arguments: { selector: '#password', transientRef: 'PATROL_SECRET_password' } }),
        step('step-004', 'browser_type_transient_ref', { name: '输入短信验证码', arguments: { selector: '#register-code', transientRef: 'PATROL_SECRET_sms' } }),
        step('step-005', 'browser_screenshot', { name: '截图当前主页状态', artifact: 'screenshot' }),
      ],
    }

    const result = compactDashboardFlow(definition)

    expect(result.flowHealth?.complete).toBe(false)
    expect(definition.metadata.flowHealth.complete).toBe(false)
    expect(definition.metadata.flowHealth.warnings.join('\n')).toMatch(/输入步骤之后没有任何已记录的提交\/点击\/选择\/导航动作/)
    expect(definition.metadata.flowHealth.warnings.join('\n')).toMatch(/任务清单要求 .*点击\/打开步骤/)
    expect(definition.metadata.flowHealth.warnings.join('\n')).toMatch(/任务清单要求 .*输入步骤/)
  })

  it('keeps both business screenshots when the persisted checklist explicitly asks for two screenshots', () => {
    const definition = {
      status: 'draft',
      target: { url: 'https://portal.test' },
      artifacts: ['screenshot'],
      metadata: {
        taskChecklist: [
          '访问系统',
          '点击待办待阅工单',
          '截图工单列表',
          '打开其中一张工单',
          '截图工单详情',
        ],
      },
      steps: [
        step('step-001', 'browser_navigate', { arguments: { url: 'https://portal.test' } }),
        step('step-002', 'browser_click', { name: '点击待办待阅工单', expectation: { mode: 'contains', value: '工单列表', caseSensitive: false } }),
        step('step-003', 'browser_screenshot', { name: '截图工单列表', artifact: 'screenshot' }),
        step('step-004', 'browser_click', { name: '打开其中一张工单', expectation: { mode: 'contains', value: '工单详情', caseSensitive: false } }),
        step('step-005', 'browser_screenshot', { name: '截图工单详情', artifact: 'screenshot' }),
      ],
    }

    const result = compactDashboardFlow(definition)

    expect(definition.steps.filter(item => item.tool === 'browser_screenshot')).toHaveLength(2)
    expect(result.flowHealth?.warnings.join('\n')).not.toMatch(/截图步骤/)
  })
})
