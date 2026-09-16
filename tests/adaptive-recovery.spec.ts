import { describe, expect, it } from 'vitest'
import { findAdaptiveSelectorRecovery, isSelectorUnavailable } from '../src/adaptive-recovery.ts'
import type { InspectionDefinition, ToolStep } from '../src/types.ts'

const at = '2026-01-01T00:00:00.000Z'

function definition(step: ToolStep, checklist: string[]): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'adaptive-test',
    name: 'adaptive test',
    description: 'test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.test/login' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [step],
    metadata: { createdAt: at, updatedAt: at, taskChecklist: checklist },
  }
}

function textStep(name: string, selector: string): ToolStep {
  return {
    id: 'step-001',
    kind: 'tool',
    name,
    tool: 'browser_type',
    arguments: { selector, text: 'public-value' },
    recordedAt: at,
  }
}

describe('adaptive selector recovery', () => {
  it('recognizes selector-not-found failures only', () => {
    expect(isSelectorUnavailable('element not found in any accessible frame: #username')).toBe(true)
    expect(isSelectorUnavailable('selector did not match any element')).toBe(true)
    expect(isSelectorUnavailable('permission denied')).toBe(false)
  })

  it('uses the persisted username task to choose one unique visible account field', () => {
    const step = textStep('输入用户名', '#username')
    const recovery = findAdaptiveSelectorRecovery(
      definition(step, ['访问登录页', '输入用户名', '输入密码', '点击登录']),
      step,
      {
        url: 'https://example.test/login',
        elements: [
          { tag: 'input', type: 'text', name: 'accountName', selector: 'input[name="accountName"]' },
          { tag: 'input', type: 'password', name: 'secret', selector: 'input[type="password"]' },
        ],
      },
    )
    expect(recovery).toEqual({
      selector: 'input[name="accountName"]',
      reason: 'unique visible username/account field',
      task: '输入用户名',
    })
  })

  it('uses a unique password field without guessing other inputs', () => {
    const step = textStep('输入密码', '#password')
    const recovery = findAdaptiveSelectorRecovery(
      definition(step, ['输入用户名', '输入密码']),
      step,
      {
        elements: [
          { tag: 'input', type: 'text', name: 'user', selector: '#user' },
          { tag: 'input', type: 'password', name: 'new-secret', selector: '#new-secret' },
        ],
      },
    )
    expect(recovery?.selector).toBe('#new-secret')
  })

  it('fails closed when multiple plausible username fields exist', () => {
    const step = textStep('输入用户名', '#username')
    const recovery = findAdaptiveSelectorRecovery(
      definition(step, ['输入用户名']),
      step,
      {
        elements: [
          { tag: 'input', type: 'text', name: 'username', selector: '#user-a' },
          { tag: 'input', type: 'email', name: 'email', selector: '#user-b' },
        ],
      },
    )
    expect(recovery).toBeUndefined()
  })

  it('never improvises captcha/otp/verification-code inputs', () => {
    const step = textStep('输入短信验证码', '#smsCode')
    const recovery = findAdaptiveSelectorRecovery(
      definition(step, ['输入短信验证码']),
      step,
      { elements: [{ tag: 'input', type: 'text', name: 'verificationCode', selector: '#code' }] },
    )
    expect(recovery).toBeUndefined()
  })
})
