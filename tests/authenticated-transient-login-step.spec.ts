import { describe, expect, it } from 'vitest'
import { looksLikeLoginStep } from '../src/runner.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

function flow(): InspectionDefinition {
  const steps: ToolStep[] = [
    { id: 'step-002', kind: 'tool', name: '输入用户名', tool: 'browser_type', arguments: { selector: '#username', text: 'u' }, recordedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'step-003', kind: 'tool', name: '输入密码', tool: 'browser_type_transient_ref', arguments: { selector: '#password', transientRef: 'PATROL_SECRET_X' }, sensitive: true, recordedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'step-004', kind: 'tool', name: '输入短信验证码 123', tool: 'browser_type_transient_ref', arguments: { selector: '#register-code', transientRef: 'PATROL_SECRET_Y' }, sensitive: true, recordedAt: '2026-01-01T00:00:00.000Z' },
    { id: 'step-005', kind: 'tool', name: '点击登录', tool: 'browser_click', arguments: { selector: '#sign_in' }, recordedAt: '2026-01-01T00:00:00.000Z' },
  ]
  return { schemaVersion: '0.2', id: 'login', name: 'login', description: '', status: 'draft', target: { type: 'browser', url: 'http://example.test/app' }, expectedResult: '', artifacts: [], auth: { mode: 'manual-checkpoint' }, schedule: null, steps, metadata: { createdAt: '', updatedAt: '' } }
}

describe('authenticated-session login prefix recognition', () => {
  it('treats transient password and nearby SMS verification as login steps', () => {
    const definition = flow()
    expect(looksLikeLoginStep(definition, definition.steps[1] as ToolStep)).toBe(true)
    expect(looksLikeLoginStep(definition, definition.steps[2] as ToolStep)).toBe(true)
  })
})
