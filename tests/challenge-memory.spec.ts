import { describe, expect, it } from 'vitest'
import {
  challengeObservationFromText,
  challengeObservationFromValue,
  rememberChallengeObservation,
  rememberChallengeObservationFromText,
} from '../src/challenge-memory.js'
import type { InspectionDefinition } from '../src/types.js'

function definition(): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'captcha-memory',
    name: 'Captcha memory',
    description: 'Remember non-secret challenge taxonomy.',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.com/login' },
    expectedResult: 'Application page is visible.',
    artifacts: ['markdown-report'],
    auth: { mode: 'secret-ref' },
    schedule: null,
    steps: [],
    metadata: {
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:00.000Z',
    },
  }
}

describe('learned verification profile memory', () => {
  it('remembers the initially observed image-code family even after OCR clears the challenge', () => {
    const observed = challengeObservationFromValue({
      ok: true,
      kind: 'none',
      subtype: 'none',
      observedKind: 'captcha',
      observedSubtype: 'image-code',
      strategy: 'windows-system-ocr',
      hasChallenge: false,
      autoFilled: true,
    })
    expect(observed).toEqual({
      kind: 'captcha',
      subtype: 'image-code',
      strategy: 'windows-system-ocr',
      autoCompleted: true,
    })
  })

  it('learns from the deterministic rendered detector output stored in run reports', () => {
    const observed = challengeObservationFromText(
      'Auth challenge: kind=slider; subtype=slider-puzzle; observed=slider/slider-puzzle; strategy=manual-slider; hasChallenge=true; handoffRequired=true',
    )
    expect(observed).toEqual({
      kind: 'slider',
      subtype: 'slider-puzzle',
      strategy: 'manual-slider',
      autoCompleted: false,
    })
  })

  it('records the local demo solver as an auto-completed verification', () => {
    const observed = challengeObservationFromText(
      'Auth challenge: kind=none; subtype=none; observed=captcha/click-sequence; strategy=ddddocr-click-sequence-demo; hasChallenge=false; handoffRequired=false; verification auto-completed by the local Patrol solver',
    )
    expect(observed).toEqual({
      kind: 'captcha',
      subtype: 'click-sequence',
      strategy: 'ddddocr-click-sequence-demo',
      autoCompleted: true,
    })
  })

  it('increments occurrences without changing semantic Runbook updatedAt', () => {
    const runbook = definition()
    const updatedAt = runbook.metadata.updatedAt
    expect(rememberChallengeObservation(runbook, {
      kind: 'captcha',
      subtype: 'click-sequence',
      observedKind: 'captcha',
      observedSubtype: 'click-sequence',
      strategy: 'manual-click-sequence',
      hasChallenge: true,
      autoFilled: false,
    }, '2026-08-28T01:00:00.000Z')).toBe(true)
    expect(rememberChallengeObservationFromText(
      runbook,
      'Auth challenge: kind=captcha; subtype=click-sequence; observed=captcha/click-sequence; strategy=manual-click-sequence; hasChallenge=true; handoffRequired=true',
      '2026-08-28T02:00:00.000Z',
    )).toBe(true)

    expect(runbook.metadata.updatedAt).toBe(updatedAt)
    expect(runbook.auth.challengeProfiles).toEqual([{
      kind: 'captcha',
      subtype: 'click-sequence',
      strategy: 'manual-click-sequence',
      firstObservedAt: '2026-08-28T01:00:00.000Z',
      lastObservedAt: '2026-08-28T02:00:00.000Z',
      occurrences: 2,
      autoCompletedOccurrences: 0,
    }])
  })
})
