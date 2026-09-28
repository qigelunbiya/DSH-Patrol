import { describe, expect, it } from 'vitest'
import {
  captureSuccessfulTeachingTrace,
  resolveSuccessfulTraceStepIds,
  restoreMissingSuccessfulTeachingSteps,
} from '../src/successful-teaching-trace.ts'
import type { InspectionDefinition, InspectionStep, ToolStep } from '../src/types.ts'

function definition(steps: InspectionStep[] = []): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'trace-repair',
    name: 'Trace repair',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps,
    metadata: {
      createdAt: '2026-09-28T00:00:00.000Z',
      updatedAt: '2026-09-28T00:00:00.000Z',
      taskChecklist: ['访问入口', '点击搜索结果', '向下滑动', '点击目标'],
    },
  }
}

function step(id: string, name: string, tool: string, args: Record<string, any>, second: number): ToolStep {
  return {
    id,
    kind: 'tool',
    name,
    tool,
    arguments: args,
    teaching: tool.includes('click')
      ? { status: 'verified', method: 'state-change', evidence: `state-${second}` }
      : undefined,
    recordedAt: `2026-09-28T00:00:${String(second).padStart(2, '0')}.000Z`,
  }
}

describe('successful teaching trace', () => {
  it('journals only newly executed teaching actions, not pre-existing structural graph rows', () => {
    const structural = step('step-001', '结构插入等待', 'browser_wait', { timeoutMs: 1000 }, 1)
    const previous = definition([structural])
    const live = step('step-002', '真实访问工作台', 'browser_navigate', { url: 'https://example.test/workbench' }, 2)
    const next = definition([structural, live])

    captureSuccessfulTeachingTrace(previous, next)

    expect(next.metadata.successfulTeachingTrace?.map(item => item.name)).toEqual(['真实访问工作台'])
  })

  it('does not journal transient probes or explicitly unverified actions', () => {
    const previous = definition([])
    const snapshot = step('step-001', '探针', 'browser_snapshot', {}, 1)
    const bad = step('step-002', '未验证点击', 'browser_click', { selector: '#bad' }, 2)
    bad.teaching = { status: 'unverified', method: 'execution-only' }
    const good = step('step-003', '有效点击', 'browser_click', { selector: '#good' }, 3)
    const next = definition([snapshot, bad, good])

    captureSuccessfulTeachingTrace(previous, next)

    expect(next.metadata.successfulTeachingTrace?.map(item => item.id)).toEqual(['step-003'])
  })

  it('reconciles only the latest checklist-committed retry instead of restoring every successful attempt', () => {
    const first = step('step-001', '执行搜索', 'browser_press', { key: 'Enter' }, 1)
    const retry = step('step-002', '执行搜索', 'browser_press', { key: 'Enter' }, 2)
    const value = definition([])
    value.metadata.taskChecklist = ['执行搜索']
    value.metadata.successfulTeachingTrace = [first, retry]

    const restored = restoreMissingSuccessfulTeachingSteps(value)

    expect(restored.restored).toBe(1)
    expect(value.steps).toHaveLength(1)
    expect(value.steps[0]?.name).toBe('执行搜索')
    expect(value.steps[0]?.recordedAt).toBe(retry.recordedAt)
  })

  it('restores a missing successful route in original trace order without deleting existing manual steps', () => {
    const nav = step('step-001', '访问 Google', 'browser_navigate', { url: 'https://google.com' }, 1)
    const result = step('step-002', '点击维基百科结果', 'browser_click', { selector: '#wiki' }, 2)
    const scroll = step('step-003', '向下滑动找伶仃洋', 'browser_scroll', { direction: 'down', amount: 600 }, 3)
    const target = step('step-004', '点击伶仃洋', 'browser_click', { selector: '#lingdingyang' }, 4)
    const manual = step('step-010', '人工补充说明步骤', 'browser_wait', { timeoutMs: 250 }, 10)

    const value = definition([nav, manual, target])
    value.metadata.successfulTeachingTrace = [nav, result, scroll, target]

    const restored = restoreMissingSuccessfulTeachingSteps(value)

    expect(restored.restored).toBe(2)
    expect(value.steps.map(item => item.name)).toEqual([
      '访问 Google',
      '点击维基百科结果',
      '向下滑动找伶仃洋',
      '人工补充说明步骤',
      '点击伶仃洋',
    ])
    expect(value.steps.map(item => item.name)).toContain('人工补充说明步骤')
  })

  it('rebinds restored conditional steps to the current/restored source id', () => {
    const source = step('step-005', '读取登录状态', 'browser_read_page', {}, 1)
    const click = step('step-006', '条件点击登录', 'browser_click', { selector: '#login' }, 2)
    click.when = {
      sourceStepId: 'step-005',
      mode: 'contains',
      value: 'login-required',
      caseSensitive: false,
    }

    const value = definition([])
    value.metadata.successfulTeachingTrace = [source, click]

    const restored = restoreMissingSuccessfulTeachingSteps(value)

    expect(restored.restored).toBe(2)
    expect(value.steps).toHaveLength(2)
    expect(value.steps[1]?.when?.sourceStepId).toBe(value.steps[0]?.id)
  })

  it('resolves a historical successfulTeachingTrace id to the equivalent current Runbook id', () => {
    const traceClick = step('step-003', '点击目标', 'browser_click', { selector: '#go' }, 3)
    const currentClick = { ...traceClick, id: 'step-012' }
    const value = definition([currentClick])
    value.metadata.successfulTeachingTrace = [traceClick]

    expect(resolveSuccessfulTraceStepIds(value, ['step-003'])).toEqual(['step-012'])
  })

  it('fails clearly when a historical trace id has not been reconciled into the current Runbook', () => {
    const traceClick = step('step-003', '点击目标', 'browser_click', { selector: '#go' }, 3)
    const value = definition([])
    value.metadata.successfulTeachingTrace = [traceClick]

    expect(() => resolveSuccessfulTraceStepIds(value, ['step-003']))
      .toThrow(/patrol_reconcile_successful_steps/)
  })

  it('is idempotent after the missing successful steps have been restored once', () => {
    const nav = step('step-001', '访问入口', 'browser_navigate', { url: 'https://example.test' }, 1)
    const click = step('step-002', '点击目标', 'browser_click', { selector: '#go' }, 2)
    const value = definition([nav])
    value.metadata.successfulTeachingTrace = [nav, click]

    const first = restoreMissingSuccessfulTeachingSteps(value)
    const second = restoreMissingSuccessfulTeachingSteps(value)

    expect(first.restored).toBe(1)
    expect(second.restored).toBe(0)
    expect(value.steps).toHaveLength(2)
  })
})
