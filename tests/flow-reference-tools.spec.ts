import { describe, expect, it } from 'vitest'
import { cloneForReadOnlyReplay, normalizeFlowReference, resolveBatchFlowReferences, resolveFlowReference } from '../src/flow-reference-tools.js'
import type { InspectionDefinition } from '../src/types.js'

function flow(id: string, name: string, updatedAt = '2026-09-04T00:00:00.000Z', workspaceRoot = 'E:\\temp\\test'): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id,
    name,
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [{
      id: 'step-001',
      kind: 'tool',
      name: 'Navigate',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.test' },
      recordedAt: updatedAt,
    }],
    metadata: { createdAt: updatedAt, updatedAt, workspaceRoot },
  }
}

describe('flow reference resolver', () => {
  it('normalizes @ prefix, NFKC and surrounding/repeated whitespace', () => {
    expect(normalizeFlowReference('  @ADBBA   登录巡检  ')).toBe('adbba 登录巡检')
  })

  it('normalizes native @flow:<inspectionId> tokens to the stable id', () => {
    expect(normalizeFlowReference(' @flow:ADBBA-login-check ')).toBe('adbba-login-check')
  })

  it('finds a flow by its exact display name', () => {
    const result = resolveFlowReference([flow('adbba-login-check', 'ADBBA 登录巡检')], 'ADBBA 登录巡检  ', 'E:\\temp\\test')
    expect(result).toMatchObject({ kind: 'exact-name', definition: { id: 'adbba-login-check' } })
  })

  it('finds a flow by @display-name', () => {
    const result = resolveFlowReference([flow('adbba-login-check', 'ADBBA 登录巡检')], '@ADBBA 登录巡检')
    expect(result).toMatchObject({ kind: 'exact-name', definition: { id: 'adbba-login-check' } })
  })

  it('finds a flow by native @flow:<inspectionId>', () => {
    const result = resolveFlowReference([flow('adbba-login-check', 'ADBBA 登录巡检')], '@flow:adbba-login-check')
    expect(result).toMatchObject({ kind: 'exact-id', definition: { id: 'adbba-login-check' } })
  })

  it('reports duplicate exact display names as ambiguous instead of claiming no exact match', () => {
    const result = resolveFlowReference([
      flow('adbba-login-check', 'ADBBA 登录巡检', '2026-09-04T01:00:00.000Z'),
      flow('adbba-login-test', 'ADBBA 登录巡检', '2026-09-03T01:00:00.000Z'),
    ], 'ADBBA 登录巡检')
    expect(result.kind).toBe('ambiguous')
    if (result.kind === 'ambiguous') {
      expect(result.matches.map(item => item.id)).toEqual(['adbba-login-check', 'adbba-login-test'])
    }
  })

  it('prefers the current workspace before considering same-name flows elsewhere', () => {
    const result = resolveFlowReference([
      flow('other', 'ADBBA 登录巡检', '2026-09-04T00:00:00.000Z', 'D:\\other'),
      flow('local', 'ADBBA 登录巡检', '2026-09-04T00:00:00.000Z', 'E:\\temp\\test'),
    ], 'ADBBA 登录巡检', 'E:\\temp\\test')
    expect(result).toMatchObject({ kind: 'exact-name', definition: { id: 'local' } })
  })
})

describe('read-only flow replay preparation', () => {
  it('pre-seeds the execution clone workspace without mutating steps or semantic updatedAt', () => {
    const original = flow('draft-flow', 'Draft flow', '2026-09-18T00:00:00.000Z', 'D:\\old')
    const before = JSON.stringify(original)
    const execution = cloneForReadOnlyReplay(original, 'E:\\current')

    expect(execution).not.toBe(original)
    expect(execution.metadata.workspaceRoot).toBe('E:\\current')
    expect(execution.metadata.updatedAt).toBe(original.metadata.updatedAt)
    expect(execution.steps).toEqual(original.steps)
    expect(JSON.stringify(original)).toBe(before)
  })
})

describe('batch flow resolver', () => {
  const flows = [
    flow('alpha', 'Alpha 巡检'),
    flow('beta', 'Beta 巡检'),
    flow('gamma', 'Gamma 巡检'),
  ]

  it('preserves user selection order and resolves native @flow references', () => {
    const result = resolveBatchFlowReferences(flows, ['@flow:gamma', 'alpha', 'Beta 巡检'])
    expect(result.map(item => item.definition.id)).toEqual(['gamma', 'alpha', 'beta'])
  })

  it('rejects duplicate resolved flows instead of running one flow twice accidentally', () => {
    expect(() => resolveBatchFlowReferences(flows, ['alpha', '@flow:alpha'])).toThrow(/duplicate flow alpha/)
  })

  it('preflights all references before execution and reports missing flows', () => {
    expect(() => resolveBatchFlowReferences(flows, ['alpha', 'does-not-exist', 'beta'])).toThrow(/no Patrol flow matched/)
  })

  it('rejects empty reusable flows during batch preflight', () => {
    const empty = { ...flow('empty', 'Empty'), steps: [] }
    expect(() => resolveBatchFlowReferences([...flows, empty], ['alpha', 'empty'])).toThrow(/has no reusable steps/)
  })
})