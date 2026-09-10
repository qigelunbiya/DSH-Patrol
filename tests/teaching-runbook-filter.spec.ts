import { describe, expect, it } from 'vitest'
import { filterDraftRunbookInPlace } from '../src/teaching-runbook-filter.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

function baseDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'com-portal-login-workbench',
    name: 'COM Portal 登录与工作台巡检',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'http://172.21.9.122/com-portal' },
    expectedResult: 'done',
    artifacts: ['markdown-report', 'screenshot', 'page-text'],
    auth: { mode: 'manual-checkpoint' },
    schedule: null,
    steps: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
      taskChecklist: [
        '访问目标 URL',
        '点击 Logo',
        '输入用户名 fangzeming',
        '输入密码',
        '输入短信验证码 123',
        '点击登录',
        '点击我的工作台',
        '验证侧栏出现',
        '点击待办待阅工单',
        '读取工单信息',
        '截图工单列表',
        '打开一张工单',
        '截图工单详情',
      ],
    },
  }
}

function tool(id: string, name: string, toolName: string, args: Record<string, any> = {}): ToolStep {
  return {
    id,
    kind: 'tool',
    name,
    tool: toolName,
    arguments: args,
    notes: '',
    recordedAt: new Date().toISOString(),
  }
}

describe('draft teaching Runbook filter', () => {
  it('reduces the supplied stuck COM Portal trace to the only completed business step', () => {
    const definition = baseDefinition()
    definition.steps = [
      tool('step-001', '访问目标 URL', 'browser_navigate', { url: 'http://172.21.9.122/com-portal', action: 'navigate' }),
      tool('step-002', '登录页面快照', 'browser_snapshot', { maxElements: 30 }),
      { ...tool('step-003', '读取登录页面内容', 'browser_read_page'), artifact: 'page-text' },
      { ...tool('step-004', '登录页面截图', 'browser_screenshot'), artifact: 'screenshot' },
      tool('step-005', '等待页面加载', 'browser_wait', { timeoutMs: 5000 }),
      tool('step-006', '滚动页面查看内容', 'browser_scroll', { direction: 'down', amount: 500 }),
      tool('step-007', '检查登录状态', 'browser_login_state'),
      tool('step-008', '导航到 COM Portal', 'browser_navigate', { url: 'http://172.21.9.122/com-portal', action: 'navigate' }),
      { ...tool('step-009', '读取完整页面内容', 'browser_read_page'), artifact: 'page-text' },
      tool('step-010', '等待页面加载完成', 'browser_wait', { timeoutMs: 10000 }),
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps).toHaveLength(1)
    expect(definition.steps[0]).toMatchObject({
      id: 'step-001',
      name: '访问目标 URL',
      tool: 'browser_navigate',
    })
  })

  it('keeps user-requested work-order read and screenshots while dropping diagnostic ones', () => {
    const definition = baseDefinition()
    definition.steps = [
      { ...tool('step-001', '读取登录页面内容', 'browser_read_page'), artifact: 'page-text' },
      { ...tool('step-002', '登录页面截图', 'browser_screenshot'), artifact: 'screenshot' },
      { ...tool('step-003', '读取待办工单信息', 'browser_read_page'), artifact: 'page-text' },
      { ...tool('step-004', '截图工单列表', 'browser_screenshot'), artifact: 'screenshot' },
      { ...tool('step-005', '截图工单详情', 'browser_screenshot'), artifact: 'screenshot' },
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.name)).toEqual([
      '读取待办工单信息',
      '截图工单列表',
      '截图工单详情',
    ])
    expect(definition.steps.map(step => step.id)).toEqual(['step-001', 'step-002', 'step-003'])
  })

  it('keeps an internal context step only when another Runbook step depends on it', () => {
    const definition = baseDefinition()
    const loginState = tool('step-001', '检查登录状态', 'browser_login_state')
    const username = tool('step-002', '输入用户名 fangzeming', 'browser_type', { selector: '#username', text: 'fangzeming' })
    username.when = {
      sourceStepId: 'step-001',
      mode: 'contains',
      value: 'login-required',
      caseSensitive: false,
    }
    definition.steps = [loginState, username]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps).toHaveLength(2)
    expect(definition.steps[0]?.tool).toBe('browser_login_state')
    expect(definition.steps[1]?.when?.sourceStepId).toBe('step-001')
  })

  it('drops explicitly unverified clicks and renumbers surviving dependencies', () => {
    const definition = baseDefinition()
    const bad = tool('step-001', '点击 Logo', 'browser_click', { selector: '#logo' })
    bad.teaching = { status: 'unverified', method: 'execution-only' }
    const loginState = tool('step-002', '检查登录状态', 'browser_login_state')
    const password = tool('step-003', '输入密码', 'browser_type_credential', { selector: '#password', ref: 'x' })
    password.when = {
      sourceStepId: 'step-002',
      mode: 'contains',
      value: 'login-required',
      caseSensitive: false,
    }
    definition.steps = [bad, loginState, password]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-001', 'step-002'])
    expect(definition.steps[0]?.tool).toBe('browser_login_state')
    expect(definition.steps[1]?.when?.sourceStepId).toBe('step-001')
  })
})
