import { describe, expect, it } from 'vitest'
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

  it('lets one explicit visible markup family refine a weak text classification', () => {
    expect(selectDemoChallenge(
      { kind: 'none', subtype: 'none' },
      { available: true, kinds: ['click-sequence'], documentKey: 'doc-1' },
    )).toEqual({
      kind: 'captcha',
      subtype: 'click-sequence',
      strategy: 'ddddocr-click-sequence-demo',
    })

    expect(selectDemoChallenge(
      { kind: 'slider', subtype: 'slider' },
      { available: true, kinds: ['slider-puzzle'], documentKey: 'doc-2' },
    )).toEqual({
      kind: 'slider',
      subtype: 'slider-puzzle',
      strategy: 'ddddocr-slider-demo',
    })
  })

  it('does not guess when weak classification sees multiple explicit challenge families', () => {
    expect(selectDemoChallenge(
      { kind: 'none', subtype: 'none' },
      { available: true, kinds: ['click-sequence', 'slider-puzzle'], documentKey: 'doc-1' },
    )).toBeNull()
  })

  it('keeps protected verification families out of the local demo solver even when markup exists', () => {
    const info = { available: true, kinds: ['click-sequence'], documentKey: 'doc-1' }
    expect(selectDemoChallenge({ kind: 'captcha', subtype: 'third-party' }, info)).toBeNull()
    expect(selectDemoChallenge({ kind: 'captcha', subtype: 'rotate' }, info)).toBeNull()
    expect(selectDemoChallenge({ kind: 'captcha', subtype: 'image-code' }, info)).toBeNull()
    expect(selectDemoChallenge({ kind: 'otp', subtype: 'otp' }, info)).toBeNull()
    expect(selectDemoChallenge({ kind: 'approval', subtype: 'approval' }, info)).toBeNull()
  })

  it('rejects a capture that comes from another page instance or challenge family', () => {
    const capture = {
      ok: true,
      available: true,
      kind: 'click-sequence',
      documentKey: 'doc-a',
    }
    expect(authorizedCapture(capture, 'doc-a', 'click-sequence')).toBe(true)
    expect(authorizedCapture(capture, 'doc-b', 'click-sequence')).toBe(false)
    expect(authorizedCapture(capture, 'doc-a', 'slider-puzzle')).toBe(false)
  })
})
