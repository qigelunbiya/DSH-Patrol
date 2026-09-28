import { describe, expect, it } from 'vitest'
import { filterDraftRunbookInPlace } from '../src/teaching-runbook-filter.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

function baseDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'teaching-lossless-draft',
    name: 'Lossless teaching draft',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: ['screenshot', 'page-text'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: {
      createdAt: now,
      updatedAt: now,
      taskChecklist: [
        '访问入口',
        '点击搜索框',
        '输入关键字',
        '执行搜索',
        '点击目标结果',
        '向下滑动找到目标',
        '点击目标链接',
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
  it('keeps every successful replayable live action even when checklist wording does not match exactly', () => {
    const definition = baseDefinition()
    definition.steps = [
      tool('step-001', '访问 Google', 'browser_navigate', { url: 'https://google.com' }),
      tool('step-002', '等待结果页加载', 'browser_wait', { timeoutMs: 1000 }),
      tool('step-003', '向下滚动寻找伶仃洋', 'browser_scroll', { direction: 'down', amount: 600 }),
      { ...tool('step-004', '读取当前正文', 'browser_read_page'), artifact: 'page-text' },
      { ...tool('step-005', '保存伶仃洋页面', 'browser_screenshot'), artifact: 'screenshot' },
      tool('step-006', '访问工作台', 'browser_navigate', { url: 'http://10.0.0.1/workbench' }),
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual([
      'step-001', 'step-002', 'step-003', 'step-004', 'step-005', 'step-006',
    ])
  })

  it('drops only pure snapshot/count probes when nothing depends on them', () => {
    const definition = baseDefinition()
    definition.steps = [
      tool('step-001', '页面探针', 'browser_snapshot'),
      tool('step-002', '数量探针', 'browser_count', { selector: '.item' }),
      tool('step-003', '真实点击', 'browser_click', { selector: '#go' }),
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-003'])
  })

  it('keeps a probe that is a condition source for a later reusable action', () => {
    const definition = baseDefinition()
    const snapshot = tool('step-001', '状态探针', 'browser_snapshot')
    const click = tool('step-002', '条件点击', 'browser_click', { selector: '#go' })
    click.when = {
      sourceStepId: 'step-001',
      mode: 'contains',
      value: 'ready',
      caseSensitive: false,
    }
    definition.steps = [snapshot, click]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-001', 'step-002'])
  })

  it('drops explicitly unverified clicks but never checklist-dedupes verified/successful actions', () => {
    const definition = baseDefinition()
    const bad = tool('step-001', '错误点击', 'browser_click', { selector: '#wrong' })
    bad.teaching = { status: 'unverified', method: 'execution-only' }
    const first = tool('step-002', '第一次点击登录', 'browser_click', { selector: '#login' })
    first.teaching = { status: 'verified', method: 'state-change', evidence: 'state-a' }
    const second = tool('step-003', '第二次有效业务点击', 'browser_click', { selector: '#login' })
    second.teaching = { status: 'verified', method: 'state-change', evidence: 'state-b' }
    definition.steps = [bad, first, second]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-002', 'step-003'])
  })

  it('does not renumber live DRAFT ids while filtering probes', () => {
    const definition = baseDefinition()
    definition.steps = [
      tool('step-004', '探针', 'browser_snapshot'),
      tool('step-009', '访问工作台', 'browser_navigate', { url: 'https://example.test/workbench' }),
    ]

    filterDraftRunbookInPlace(definition)

    expect(definition.steps.map(step => step.id)).toEqual(['step-009'])
  })
})
