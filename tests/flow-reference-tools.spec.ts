import { describe, expect, it } from 'vitest'
import { normalizeFlowReference, resolveFlowReference } from '../src/flow-reference-tools.js'
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

  it('finds a flow by its exact display name', () => {
    const result = resolveFlowReference([flow('adbba-login-check', 'ADBBA 登录巡检')], 'ADBBA 登录巡检  ', 'E:\\temp\\test')
    expect(result).toMatchObject({ kind: 'exact-name', definition: { id: 'adbba-login-check' } })
  })

  it('finds a flow by @display-name', () => {
    const result = resolveFlowReference([flow('adbba-login-check', 'ADBBA 登录巡检')], '@ADBBA 登录巡检')
    expect(result).toMatchObject({ kind: 'exact-name', definition: { id: 'adbba-login-check' } })
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
