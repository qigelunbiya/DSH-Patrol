import { describe, expect, it } from 'vitest'
import { filterDraftRunbookInPlace } from '../src/teaching-runbook-filter.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

function baseDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'teaching-task-commit',
    name: 'Task committed teaching draft',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: ['screenshot'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
      taskChecklist: [
        '访问 Google 首页',
        '点击搜索栏',
        '输入中山市并执行搜索',
        '点击中山市的维基百科搜索结果',
        '在维基百科页面下滑找到伶仃洋并点击',
        '截图',
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
    recordedAt: `2026-09-28T00:00:${id.slice(-2)}.000Z`,
  }
}

describe('draft teaching Runbook filter', () => {
  it('keeps the latest checklist-constrained successful route instead of every retry', () => {
    const definition = baseDefinition()
    definition.steps = [
      tool('step-001', '访问 Google 首页', 'browser_navigate', { url: 'https://google.com' }),
      tool('step-002', '点击 Google 搜索栏', 'browser_visual_click', { targetHint: 'Google 搜索输入框' }),
      tool('step-003', '输入中山市', 'browser_type_focused', { text: '中山市', clear: true }),
      tool('step-004', '按 Enter 执行搜索', 'browser_press', { key: 'Enter' }),
      tool('step-005', '再次按 Enter 执行搜索', 'browser_press', { key: 'Enter' }),
      tool('step-006', '按 Esc 关闭搜索建议', 'browser_press', { key: 'Escape' }),
      tool('step-007', '点击错误的维基百科搜索建议', 'browser_visual_click', { targetHint: '中山市 维基百科 搜索建议' }),
      tool('step-008', '返回 Google 首页', 'browser_navigate', { url: 'https://google.com' }),
      tool('step-009', '点击 Google 搜索栏', 'browser_visual_click', { targetHint: 'Google 搜索输入框' }),
      tool('step-010', '输入中山市', 'browser_type_focused', { text: '中山市', clear: true }),
      tool('step-011', '按 Enter 执行搜索', 'browser_press', { key: 'Enter' }),
      tool('step-012', '点击中山市的维基百科搜索结果', 'browser_visual_click', { targetHint: '中山市 维基百科搜索结果' }),
      tool('step-013', '向下滑动页面查找伶仃洋', 'browser_scroll', { direction: 'down', amount: 500 }),
      tool('step-014', '点击伶仃洋链接', 'browser_visual_click', { targetHint: '伶仃洋链接' }),
      { ...tool('step-015', '截图伶仃洋页面', 'browser_screenshot'), artifact: 'screenshot' },
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual([
      'step-008',
      'step-009',
      'step-010',
      'step-011',
      'step-012',
      'step-013',
      'step-014',
      'step-015',
    ])
    expect(definition.steps.map(step => step.name)).not.toContain('按 Esc 关闭搜索建议')
    expect(definition.steps.map(step => step.name)).not.toContain('点击错误的维基百科搜索建议')
  })

  it('keeps both atomic actions for compound checklist items', () => {
    const definition = baseDefinition()
    definition.metadata.taskChecklist = [
      '输入中山市并执行搜索',
      '在维基百科页面下滑找到伶仃洋并点击',
    ]
    definition.artifacts = []
    definition.steps = [
      tool('step-001', '输入中山市', 'browser_type_focused', { text: '中山市', clear: true }),
      tool('step-002', '按 Enter 执行搜索', 'browser_press', { key: 'Enter' }),
      tool('step-003', '向下滑动页面查找伶仃洋', 'browser_scroll', { direction: 'down', amount: 500 }),
      tool('step-004', '点击伶仃洋链接', 'browser_visual_click', { targetHint: '伶仃洋链接' }),
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-001', 'step-002', 'step-003', 'step-004'])
  })

  it('drops pure probes and explicitly unverified clicks', () => {
    const definition = baseDefinition()
    definition.metadata.taskChecklist = ['点击目标']
    definition.artifacts = []
    const bad = tool('step-003', '错误点击', 'browser_click', { selector: '#bad' })
    bad.teaching = { status: 'unverified', method: 'execution-only' }
    const good = tool('step-004', '点击目标', 'browser_click', { selector: '#go' })
    good.teaching = { status: 'verified', method: 'state-change', evidence: 'state-b' }
    definition.steps = [
      tool('step-001', '页面探针', 'browser_snapshot'),
      tool('step-002', '数量探针', 'browser_count', { selector: '.item' }),
      bad,
      good,
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-004'])
  })

  it('preserves a structural/manual step that is outside the live teaching journal', () => {
    const definition = baseDefinition()
    definition.metadata.taskChecklist = ['访问入口', '点击目标']
    definition.artifacts = []
    const nav = tool('step-001', '访问入口', 'browser_navigate', { url: 'https://example.test' })
    const manual = tool('step-010', '人工结构插入等待', 'browser_wait', { timeoutMs: 250 })
    const click = tool('step-011', '点击目标', 'browser_click', { selector: '#go' })
    definition.steps = [nav, manual, click]
    definition.metadata.successfulTeachingTrace = [nav, click]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-001', 'step-010', 'step-011'])
  })

  it('keeps a condition source for a selected reusable action', () => {
    const definition = baseDefinition()
    definition.metadata.taskChecklist = ['点击目标']
    definition.artifacts = []
    const source = tool('step-004', '状态探针', 'browser_snapshot')
    const click = tool('step-009', '点击目标', 'browser_click', { selector: '#go' })
    click.when = {
      sourceStepId: 'step-004',
      mode: 'contains',
      value: 'ready',
      caseSensitive: false,
    }
    definition.steps = [source, click]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-004', 'step-009'])
  })

  it('does not renumber stable live DRAFT ids while replacing retries', () => {
    const definition = baseDefinition()
    definition.metadata.taskChecklist = ['执行搜索']
    definition.artifacts = []
    definition.steps = [
      tool('step-004', '执行搜索', 'browser_press', { key: 'Enter' }),
      tool('step-009', '执行搜索', 'browser_press', { key: 'Enter' }),
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-009'])
  })
})
