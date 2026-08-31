import { describe, expect, it } from 'vitest'
import { assertInspectionDefinition } from '../src/validation.ts'

function withProfile(strategy: string) {
  return {
    schemaVersion: '0.2',
    id: 'captcha-demo-profile',
    name: 'Captcha demo profile',
    description: 'Validate non-secret learned challenge strategy.',
    status: 'ready',
    target: { type: 'browser', url: 'http://127.0.0.1:3000/login' },
    expectedResult: 'Application page is visible.',
    artifacts: ['markdown-report'],
    auth: {
      mode: 'secret-ref',
      challengeProfiles: [{
        kind: 'captcha',
        subtype: 'click-sequence',
        strategy,
        firstObservedAt: '2026-08-31T00:00:00.000Z',
        lastObservedAt: '2026-08-31T00:00:00.000Z',
        occurrences: 1,
        autoCompletedOccurrences: 1,
      }],
    },
    schedule: null,
    steps: [],
    metadata: {
      createdAt: '2026-08-31T00:00:00.000Z',
      updatedAt: '2026-08-31T00:00:00.000Z',
    },
  }
}

describe('captcha demo Runbook validation', () => {
  it('accepts the owned-site ddddocr strategy', () => {
    expect(() => assertInspectionDefinition(withProfile('ddddocr-click-sequence-demo'))).not.toThrow()
  })

  it('continues to reject unknown learned strategies', () => {
    expect(() => assertInspectionDefinition(withProfile('arbitrary-captcha-solver'))).toThrow(/strategy is invalid/i)
  })
})
