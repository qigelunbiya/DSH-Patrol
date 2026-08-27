import { describe, expect, it } from 'vitest'
import { conditionMatches, deterministicPageSummary, evaluateExpectation } from '../src/runner.ts'
import type { StepRunResult } from '../src/types.ts'

function result(output: string, overrides: Partial<StepRunResult> = {}): StepRunResult {
  return {
    stepId: 'step-001',
    name: 'read login state',
    kind: 'tool',
    tool: 'browser_read_page',
    status: 'passed',
    startedAt: '2026-01-01T00:00:00.000Z',
    finishedAt: '2026-01-01T00:00:01.000Z',
    output,
    ...overrides,
  }
}

describe('runner predicates', () => {
  it('evaluates contains and not-contains expectations', () => {
    expect(evaluateExpectation('Hello World', { mode: 'contains', value: 'world', caseSensitive: false })).toBeUndefined()
    expect(evaluateExpectation('Hello World', { mode: 'not-contains', value: 'world', caseSensitive: false })).toMatch(/not to contain/)
  })

  it('uses prior successful step output for login branches', () => {
    expect(conditionMatches([result('用户登录 验证码')], { sourceStepId: 'step-001', mode: 'contains', value: '登录', caseSensitive: false })).toBe(true)
    expect(conditionMatches([result('我的工作台 全部工单')], { sourceStepId: 'step-001', mode: 'contains', value: '登录', caseSensitive: false })).toBe(false)
    expect(conditionMatches([result('用户登录', { status: 'failed' })], { sourceStepId: 'step-001', mode: 'contains', value: '登录', caseSensitive: false })).toBe(false)
  })

  it('builds a deterministic page summary from untrusted read output', () => {
    const summary = deterministicPageSummary([result(`--- BEGIN UNTRUSTED PAGE DATA ---
Page: Portal - http://intranet/
全部工单  待处理 3
--- END UNTRUSTED PAGE DATA ---`)])
    expect(summary).toContain('Portal')
    expect(summary).toContain('全部工单')
  })

  it('returns no deterministic summary without a successful page read', () => {
    expect(deterministicPageSummary([result('page', { status: 'failed' })])).toBeUndefined()
    expect(deterministicPageSummary([result('', { tool: 'browser_snapshot' })])).toBeUndefined()
  })
})
