import { describe, expect, it } from 'vitest'
import {
  authorizedCapture,
  isLocalTestOrigin,
  selectDemoChallenge,
  supportsDemoSolve,
} from '../browser-bridge-runtime/captcha-demo.js'

describe('captcha demo challenge support', () => {
  it('attempts ordered-click and slider-puzzle solves without startup origin configuration', () => {
    expect(supportsDemoSolve('captcha', 'click-sequence')).toBe(true)
    expect(supportsDemoSolve('slider', 'slider-puzzle')).toBe(true)
  })

  it('does not treat third-party or unrelated verification families as demo-solvable', () => {
    expect(supportsDemoSolve('captcha', 'third-party')).toBe(false)
    expect(supportsDemoSolve('captcha', 'rotate')).toBe(false)
    expect(supportsDemoSolve('slider', 'slider')).toBe(false)
    expect(supportsDemoSolve('otp', 'otp')).toBe(false)
  })

  it('lets one explicit visible markup family refine a weak text classification', () => {
    expect(selectDemoChallenge(
      { kind: 'none', subtype: 'none' },
      {
        available: true,
        kinds: ['click-sequence'],
        documentKey: 'doc-1',
        origin: 'https://demo.test',
        sources: { 'click-sequence': 'explicit' },
      },
    )).toEqual({
      kind: 'captcha',
      subtype: 'click-sequence',
      strategy: 'ddddocr-click-sequence-demo',
    })

    expect(selectDemoChallenge(
      { kind: 'slider', subtype: 'slider' },
      {
        available: true,
        kinds: ['slider-puzzle'],
        documentKey: 'doc-2',
        origin: 'https://demo.test',
        sources: { 'slider-puzzle': 'explicit' },
      },
    )).toEqual({
      kind: 'slider',
      subtype: 'slider-puzzle',
      strategy: 'ddddocr-slider-demo',
    })
  })

  it('runs weak unmarked solving only on zero-config loopback test origins', () => {
    const classified = { kind: 'captcha', subtype: 'click-sequence' }
    const remote = {
      available: true,
      kinds: ['click-sequence'],
      documentKey: 'doc-remote',
      origin: 'https://example.test',
      sources: { 'click-sequence': 'weak' },
    }
    const local = {
      ...remote,
      documentKey: 'doc-local',
      origin: 'http://127.0.0.1:3000',
    }

    expect(selectDemoChallenge(classified, remote)).toBeNull()
    expect(selectDemoChallenge(classified, local)).toEqual({
      kind: 'captcha',
      subtype: 'click-sequence',
      strategy: 'ddddocr-click-sequence-demo',
    })
    expect(isLocalTestOrigin('http://localhost:5173')).toBe(true)
    expect(isLocalTestOrigin('http://127.0.0.1:3000')).toBe(true)
    expect(isLocalTestOrigin('https://example.test')).toBe(false)
  })

  it('does not let weak unmarked probing invent a challenge from kind=none', () => {
    expect(selectDemoChallenge(
      { kind: 'none', subtype: 'none' },
      {
        available: true,
        kinds: ['click-sequence'],
        documentKey: 'doc-local',
        origin: 'http://localhost:3000',
        sources: { 'click-sequence': 'weak' },
      },
    )).toBeNull()
  })

  it('does not guess when weak classification sees multiple explicit challenge families', () => {
    expect(selectDemoChallenge(
      { kind: 'none', subtype: 'none' },
      {
        available: true,
        kinds: ['click-sequence', 'slider-puzzle'],
        documentKey: 'doc-1',
        origin: 'https://demo.test',
        sources: { 'click-sequence': 'explicit', 'slider-puzzle': 'explicit' },
      },
    )).toBeNull()
  })

  it('keeps protected verification families out of the local demo solver even when markup exists', () => {
    const info = {
      available: true,
      kinds: ['click-sequence'],
      documentKey: 'doc-1',
      origin: 'http://localhost:3000',
      sources: { 'click-sequence': 'explicit' },
    }
    expect(selectDemoChallenge({ kind: 'captcha', subtype: 'third-party' }, info)).toBeNull()
    expect(selectDemoChallenge({ kind: 'captcha', subtype: 'rotate' }, info)).toBeNull()
    expect(selectDemoChallenge({ kind: 'captcha', subtype: 'image-code' }, info)).toBeNull()
    expect(selectDemoChallenge({ kind: 'otp', subtype: 'otp' }, info)).toBeNull()
    expect(selectDemoChallenge({ kind: 'approval', subtype: 'approval' }, info)).toBeNull()
  })

  it('rejects a capture that comes from another page, challenge instance, or family', () => {
    const capture = {
      ok: true,
      available: true,
      kind: 'click-sequence',
      documentKey: 'doc-a',
      challengeKey: 'challenge-a',
    }
    expect(authorizedCapture(capture, 'doc-a', 'challenge-a', 'click-sequence')).toBe(true)
    expect(authorizedCapture(capture, 'doc-b', 'challenge-a', 'click-sequence')).toBe(false)
    expect(authorizedCapture(capture, 'doc-a', 'challenge-b', 'click-sequence')).toBe(false)
    expect(authorizedCapture(capture, 'doc-a', 'challenge-a', 'slider-puzzle')).toBe(false)
  })
})
