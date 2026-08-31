import { describe, expect, it } from 'vitest'
import { supportsDemoSolve } from '../browser-bridge-runtime/captcha-demo.js'

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
})
