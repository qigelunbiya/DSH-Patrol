import { describe, expect, it } from 'vitest'
import { assertInspectionDefinition } from '../src/validation.ts'


describe('inspection validation', () => {
  it('rejects credentials embedded in target URLs', () => {
    expect(() => assertInspectionDefinition({
      schemaVersion: '0.2',
      id: 'x',
      name: 'x',
      description: 'x',
      status: 'draft',
      target: { type: 'browser', url: 'https://user:pass@example.com/' },
      expectedResult: 'x',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [],
      metadata: { createdAt: '', updatedAt: '' },
    })).toThrow(/must not embed credentials/i)
  })

  it('rejects forward condition references', () => {
    expect(() => assertInspectionDefinition({
      schemaVersion: '0.2', id: 'x', name: 'x', description: 'x', status: 'draft',
      target: { type: 'browser', url: 'https://example.com/' }, expectedResult: 'x', artifacts: [],
      auth: { mode: 'none' }, schedule: null,
      steps: [
        { id: 'step-001', kind: 'tool', name: 'first', tool: 'browser_click', arguments: { selector: '#a' }, when: { sourceStepId: 'step-002', mode: 'contains', value: 'x', caseSensitive: false }, recordedAt: '2026-01-01T00:00:00.000Z' },
        { id: 'step-002', kind: 'tool', name: 'second', tool: 'browser_read_page', arguments: {}, recordedAt: '2026-01-01T00:00:00.000Z' },
      ],
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    })).toThrow(/earlier step/i)
  })

  it('requires credential typing to persist only a credential reference', () => {
    const base = {
      schemaVersion: '0.2' as const, id: 'x', name: 'x', description: 'x', status: 'draft' as const,
      target: { type: 'browser' as const, url: 'https://example.com/' }, expectedResult: 'x', artifacts: [],
      auth: { mode: 'secret-ref' as const }, schedule: null,
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'tool', name: 'password', tool: 'browser_type_credential', arguments: { selector: '#password', credentialRef: '${credential:PORTAL_PASSWORD}' }, sensitive: true, recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).not.toThrow()
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'tool', name: 'password', tool: 'browser_type_credential', arguments: { selector: '#password', credentialRef: 'PORTAL_PASSWORD', text: 'plain' }, sensitive: true, recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).toThrow()
  })

  it('rejects secret-bearing persistent prose', () => {
    expect(() => assertInspectionDefinition({
      schemaVersion: '0.2', id: 'x', name: 'x', description: '密码是 demo@1234', status: 'draft',
      target: { type: 'browser', url: 'https://example.com/' }, expectedResult: 'x', artifacts: [],
      auth: { mode: 'none' }, schedule: null, steps: [],
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    })).toThrow(/credential value/i)
  })

  it('rejects secrets in expectations, checkpoint notes, and URL fragments', () => {
    const base = {
      schemaVersion: '0.2' as const, id: 'x', name: 'x', description: 'x', status: 'draft' as const,
      target: { type: 'browser' as const, url: 'https://example.com/' }, expectedResult: 'x', artifacts: [],
      auth: { mode: 'none' as const }, schedule: null,
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'tool', name: 'read', tool: 'browser_read_page', arguments: {}, expectation: { mode: 'contains', value: '密码是 demo@1234', caseSensitive: false }, recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).toThrow(/credential value/i)
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'checkpoint', name: 'manual', prompt: '请完成登录', reason: 'login', notes: 'token=abc123', recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).toThrow(/credential value/i)
    expect(() => assertInspectionDefinition({ ...base, target: { type: 'browser' as const, url: 'https://example.com/#token=abc123' }, steps: [] })).toThrow(/fragment/i)
  })

  it('requires artifact kinds to match the browser tool', () => {
    const base = {
      schemaVersion: '0.2' as const, id: 'x', name: 'x', description: 'x', status: 'draft' as const,
      target: { type: 'browser' as const, url: 'https://example.com/' }, expectedResult: 'x', artifacts: [],
      auth: { mode: 'none' as const }, schedule: null,
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'tool', name: 'click', tool: 'browser_click', arguments: { selector: '#a' }, artifact: 'screenshot', recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).toThrow(/requires browser_screenshot/i)
  })

  it('rejects ephemeral tab ids and history navigation in runbooks', () => {
    const base = {
      schemaVersion: '0.2' as const, id: 'x', name: 'x', description: 'x', status: 'draft' as const,
      target: { type: 'browser' as const, url: 'https://example.com/' }, expectedResult: 'x', artifacts: [],
      auth: { mode: 'none' as const }, schedule: null,
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'tool', name: 'click', tool: 'browser_click', arguments: { selector: '#a', tabId: 42 }, recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).toThrow(/ephemeral browser tabId/i)
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'tool', name: 'back', tool: 'browser_navigate', arguments: { action: 'back' }, recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).toThrow(/explicit URL/i)
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'tool', name: 'new tab', tool: 'browser_navigate', arguments: { url: 'https://example.com/', newTab: true }, recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).toThrow(/newTab is not replay-stable/i)
  })

  it('rejects diagnostic browser tools as persisted runbook steps', () => {
    const base = {
      schemaVersion: '0.2' as const, id: 'x', name: 'x', description: 'x', status: 'draft' as const,
      target: { type: 'browser' as const, url: 'https://example.com/' }, expectedResult: 'x', artifacts: [],
      auth: { mode: 'none' as const }, schedule: null,
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    }
    expect(() => assertInspectionDefinition({ ...base, steps: [
      { id: 'step-001', kind: 'tool', name: 'status', tool: 'browser_status', arguments: {}, recordedAt: '2026-01-01T00:00:00.000Z' },
    ] })).toThrow(/non-replayable browser tool/i)
  })


  it('rejects unknown artifact names instead of silently ignoring typos', () => {
    expect(() => assertInspectionDefinition({
      schemaVersion: '0.2', id: 'x', name: 'x', description: 'x', status: 'draft',
      target: { type: 'browser', url: 'https://example.com/' }, expectedResult: 'x', artifacts: ['screenhot'],
      auth: { mode: 'none' }, schedule: null, steps: [],
      metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    })).toThrow(/artifacts must contain only/i)
  })

})
