// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { classifyLoginState } from '../browser-bridge-runtime/login-state-tool.js'

describe('login-state regression', () => {
  it('does not treat a non-login URL with only a portal logo as authenticated', () => {
    const result = classifyLoginState({
      url: 'http://172.21.9.122/com-portal',
      elements: [
        { tag: 'a', role: 'link', text: '长城网际', selector: '#logo' },
      ],
    })

    expect(result).toEqual({
      state: 'unknown',
      reason: 'no-positive-authenticated-evidence',
      url: 'http://172.21.9.122/com-portal',
    })
  })

  it('detects a visible password field as login-required even on an application URL', () => {
    expect(classifyLoginState({
      url: 'http://172.21.9.122/com-portal',
      elements: [
        { tag: 'input', type: 'password', name: 'password', selector: '#password' },
      ],
    })).toMatchObject({ state: 'login-required', reason: 'visible-password-field' })
  })

  it('requires positive authenticated application evidence', () => {
    expect(classifyLoginState({
      url: 'http://172.21.9.122/com-portal/home',
      elements: [
        { tag: 'a', role: 'link', text: '我的工作台', selector: '#workbench' },
        { tag: 'button', role: 'button', text: '退出', selector: '#logout' },
      ],
    })).toMatchObject({ state: 'authenticated', reason: 'positive-authenticated-control' })
  })
})
