import { describe, expect, it } from 'vitest'
import { CAPTCHA_MODES } from '../browser-bridge-runtime/captcha-mode.js'
import {
  authorizedCapture,
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

  it('lets one explicit visible markup family refine a weak text classification in every mode', () => {
    const clickInfo = {
      available: true,
      kinds: ['click-sequence'],
      documentKey: 'doc-1',
      origin: 'https://demo.test',
      sources: { 'click-sequence': 'explicit' },
    }
    const sliderInfo = {
      available: true,
      kinds: ['slider-puzzle'],
      documentKey: 'doc-2',
      origin: 'https://demo.test',
      sources: { 'slider-puzzle': 'explicit' },
    }

    for (const mode of [CAPTCHA_MODES.normal, CAPTCHA_MODES.test]) {
      expect(selectDemoChallenge(
        { kind: 'none', subtype: 'none' },
        clickInfo,
        mode,
      )).toEqual({
        kind: 'captcha',
        subtype: 'click-sequence',
        strategy: 'ddddocr-click-sequence-demo',
      })

      expect(selectDemoChallenge(
        { kind: 'slider', subtype: 'slider' },
        sliderInfo,
        mode,
      )).toEqual({
        kind: 'slider',
        subtype: 'slider-puzzle',
        strategy: 'ddddocr-slider-demo',
      })
    }
  })

  it('blocks weak unmarked automation in normal mode and allows it in test mode on any origin', () => {
    const classified = { kind: 'captcha', subtype: 'click-sequence' }
    const remote = {
      available: true,
      kinds: ['click-sequence'],
      documentKey: 'doc-remote',
      origin: 'https://example.test',
      sources: { 'click-sequence': 'weak' },
    }
    const intranet = {
      ...remote,
      documentKey: 'doc-intranet',
      origin: 'http://10.192.1.121:8069',
    }
    const local = {
      ...remote,
      documentKey: 'doc-local',
      origin: 'http://127.0.0.1:3000',
    }

    expect(selectDemoChallenge(classified, remote, CAPTCHA_MODES.normal)).toBeNull()
    expect(selectDemoChallenge(classified, intranet, CAPTCHA_MODES.normal)).toBeNull()
    expect(selectDemoChallenge(classified, local, CAPTCHA_MODES.normal)).toBeNull()

    for (const info of [remote, intranet, local]) {
      expect(selectDemoChallenge(classified, info, CAPTCHA_MODES.test)).toEqual({
        kind: 'captcha',
        subtype: 'click-sequence',
        strategy: 'ddddocr-click-sequence-demo',
      })
    }
  })

  it('lets test mode refine one weak unmarked DOM candidate even when visible-text classification is none', () => {
    const info = {
      available: true,
      kinds: ['slider-puzzle'],
      documentKey: 'doc-test',
      origin: 'http://10.0.25.77:8080',
      sources: { 'slider-puzzle': 'weak' },
    }

    expect(selectDemoChallenge(
      { kind: 'none', subtype: 'none' },
      info,
      CAPTCHA_MODES.normal,
    )).toBeNull()

    expect(selectDemoChallenge(
      { kind: 'none', subtype: 'none' },
      info,
      CAPTCHA_MODES.test,
    )).toEqual({
      kind: 'slider',
      subtype: 'slider-puzzle',
      strategy: 'ddddocr-slider-demo',
    })
  })

  it('does not guess when weak classification sees multiple allowed challenge families', () => {
    expect(selectDemoChallenge(
      { kind: 'none', subtype: 'none' },
      {
        available: true,
        kinds: ['click-sequence', 'slider-puzzle'],
        documentKey: 'doc-1',
        origin: 'http://10.0.0.12',
        sources: { 'click-sequence': 'weak', 'slider-puzzle': 'weak' },
      },
      CAPTCHA_MODES.test,
    )).toBeNull()
  })

  it('keeps protected verification families out of the local solver even in test mode', () => {
    const info = {
      available: true,
      kinds: ['click-sequence'],
      documentKey: 'doc-1',
      origin: 'http://10.0.0.12',
      sources: { 'click-sequence': 'weak' },
    }
    for (const mode of [CAPTCHA_MODES.normal, CAPTCHA_MODES.test]) {
      expect(selectDemoChallenge({ kind: 'captcha', subtype: 'third-party' }, info, mode)).toBeNull()
      expect(selectDemoChallenge({ kind: 'captcha', subtype: 'rotate' }, info, mode)).toBeNull()
      expect(selectDemoChallenge({ kind: 'captcha', subtype: 'image-code' }, info, mode)).toBeNull()
      expect(selectDemoChallenge({ kind: 'otp', subtype: 'otp' }, info, mode)).toBeNull()
      expect(selectDemoChallenge({ kind: 'approval', subtype: 'approval' }, info, mode)).toBeNull()
    }
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
