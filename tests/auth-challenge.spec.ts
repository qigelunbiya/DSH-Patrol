import { describe, expect, it } from 'vitest'
import { classifyAuthChallenge } from '../browser-bridge-runtime/challenge-tool.js'
import { normalizeImageCodeText } from '../browser-bridge-runtime/image-code.js'

describe('auth challenge classification', () => {
  it('returns none for an ordinary login page without secondary verification', () => {
    const result = classifyAuthChallenge({
      elements: [
        { selector: '#login', name: 'login', type: 'text', text: '' },
        { selector: '#password', name: 'password', type: 'password', text: '' },
        { selector: 'button[type="submit"]', text: 'Log in', tag: 'button' },
      ],
    }, 'Welcome\nPlease log in to continue.')
    expect(result.kind).toBe('none')
    expect(result.hasChallenge).toBe(false)
  })

  it('detects one-time-code verification from observed inputs', () => {
    const result = classifyAuthChallenge({
      elements: [
        { selector: 'input[name="otp"]', name: 'otp', type: 'text', text: '' },
        { selector: '#verify', text: 'Verify code', tag: 'button' },
      ],
    }, 'Enter the verification code sent to your device.')
    expect(result.kind).toBe('otp')
    expect(result.hasChallenge).toBe(true)
    expect(result.selectors).toContain('input[name="otp"]')
  })

  it('detects graphical CAPTCHA text without solving it in the classifier', () => {
    const result = classifyAuthChallenge({ elements: [] }, 'Security check\nComplete the reCAPTCHA to continue.')
    expect(result.kind).toBe('captcha')
    expect(result.hasChallenge).toBe(true)
  })

  it('detects an image or iframe CAPTCHA signal even when visible page text is empty', () => {
    const result = classifyAuthChallenge(
      { elements: [] },
      'iframe captcha-frame https://www.google.com/recaptcha/api2/anchor',
    )
    expect(result.kind).toBe('captcha')
    expect(result.hasChallenge).toBe(true)
  })

  it('gives slider verification higher priority than generic captcha wording', () => {
    const result = classifyAuthChallenge({
      elements: [{ selector: '.geetest_slider_button', text: '拖动滑块完成验证', role: 'button' }],
    }, '人机验证：请拖动滑块完成拼图验证')
    expect(result.kind).toBe('slider')
    expect(result.selectors).toContain('.geetest_slider_button')
  })

  it('detects passkey or device approval flows', () => {
    const result = classifyAuthChallenge({ elements: [] }, 'Use your passkey or security key to approve sign-in.')
    expect(result.kind).toBe('approval')
    expect(result.hasChallenge).toBe(true)
  })

  it('normalizes a simple locally recognized image code', () => {
    expect(normalizeImageCodeText('  A B 1 2  \n')).toBe('AB12')
    expect(normalizeImageCodeText('"x7K9"')).toBe('x7K9')
    expect(normalizeImageCodeText('')).toBe('')
  })
})
