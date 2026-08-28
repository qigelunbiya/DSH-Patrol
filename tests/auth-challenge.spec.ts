import { describe, expect, it } from 'vitest'
import { classifyAuthChallenge } from '../browser-bridge-runtime/challenge-tool.js'
import { normalizeImageCodeText } from '../browser-bridge-runtime/image-code.js'
import { classifyLoginState } from '../browser-bridge-runtime/login-state-tool.js'

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
    expect(result.subtype).toBe('none')
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
    expect(result.subtype).toBe('otp')
    expect(result.hasChallenge).toBe(true)
    expect(result.selectors).toContain('input[name="otp"]')
  })

  it('detects graphical CAPTCHA text without solving it in the classifier', () => {
    const result = classifyAuthChallenge({ elements: [] }, 'Security check\nComplete the reCAPTCHA to continue.')
    expect(result.kind).toBe('captcha')
    expect(result.subtype).toBe('third-party')
    expect(result.hasChallenge).toBe(true)
  })

  it('detects an image or iframe CAPTCHA signal even when visible page text is empty', () => {
    const result = classifyAuthChallenge(
      { elements: [] },
      'iframe captcha-frame https://www.google.com/recaptcha/api2/anchor',
    )
    expect(result.kind).toBe('captcha')
    expect(result.subtype).toBe('third-party')
    expect(result.hasChallenge).toBe(true)
  })

  it('recognizes click-sequence CAPTCHA wording as a dedicated human-handoff subtype', () => {
    const result = classifyAuthChallenge(
      { elements: [{ selector: '.geetest_panel', text: '请在下图依次点击文字', role: 'dialog' }] },
      '请在下图依次点击：目标文字，然后点击确认',
    )
    expect(result.kind).toBe('captcha')
    expect(result.subtype).toBe('click-sequence')
    expect(result.hasChallenge).toBe(true)
  })

  it('classifies conventional image-code wording separately', () => {
    const result = classifyAuthChallenge(
      { elements: [{ selector: 'input[name="captcha_code"]', name: 'captcha_code', type: 'text', text: '' }] },
      '请输入图形验证码',
    )
    expect(result.kind).toBe('captcha')
    expect(result.subtype).toBe('image-code')
  })

  it('gives slider verification higher priority than generic captcha wording', () => {
    const result = classifyAuthChallenge({
      elements: [{ selector: '.geetest_slider_button', text: '拖动滑块完成验证', role: 'button' }],
    }, '人机验证：请拖动滑块完成拼图验证')
    expect(result.kind).toBe('slider')
    expect(result.subtype).toBe('slider')
    expect(result.selectors).toContain('.geetest_slider_button')
  })

  it('detects passkey or device approval flows', () => {
    const result = classifyAuthChallenge({ elements: [] }, 'Use your passkey or security key to approve sign-in.')
    expect(result.kind).toBe('approval')
    expect(result.subtype).toBe('approval')
    expect(result.hasChallenge).toBe(true)
  })

  it('normalizes a simple locally recognized image code', () => {
    expect(normalizeImageCodeText('  A B 1 2  \n')).toBe('AB12')
    expect(normalizeImageCodeText('"x7K9"')).toBe('x7K9')
    expect(normalizeImageCodeText('')).toBe('')
  })
})

describe('login-state classification', () => {
  it('reports login-required when a visible password field is present', () => {
    const result = classifyLoginState({
      url: 'http://10.192.1.121:8069/web/login#action=400',
      elements: [
        { selector: '#login', name: 'login', type: 'text' },
        { selector: '#password', name: 'password', type: 'password' },
        { selector: 'button[type="submit"]', text: '登录', tag: 'button' },
      ],
    })
    expect(result.state).toBe('login-required')
    expect(result.reason).toBe('visible-password-field')
  })

  it('reports authenticated after the application redirects away from the login page', () => {
    const result = classifyLoginState({
      url: 'http://10.192.1.121:8069/web#action=400&model=project.task&view_type=list',
      elements: [
        { selector: '.o_list_view button', text: '创建', tag: 'button' },
        { selector: '.o_searchview_input', name: 'search', type: 'text' },
      ],
    })
    expect(result.state).toBe('authenticated')
    expect(result.reason).toBe('no-login-form-on-application-page')
  })

  it('does not claim authenticated when still on a login URL without a visible form', () => {
    const result = classifyLoginState({
      url: 'http://10.192.1.121:8069/web/login',
      elements: [],
    })
    expect(result.state).toBe('unknown')
  })
})
