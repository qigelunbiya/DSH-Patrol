import { describe, expect, it } from 'vitest'
import {
  assertSafePlainTextInput,
  BROWSER_ACTIONS,
  browserToolForAction,
  findUniqueHealingSelector,
  isReplayableBrowserTool,
  isSafeBrowserTool,
} from '../src/browser.ts'


describe('browser policy', () => {
  it('maps canonical actions to exact provider tools', () => {
    expect(browserToolForAction('navigate')).toBe('browser_navigate')
    expect(browserToolForAction('count')).toBe('browser_count')
    expect(browserToolForAction('detect-auth-challenge')).toBe('browser_detect_auth_challenge')
    expect(browserToolForAction('screenshot')).toBe('browser_screenshot')
    expect(isSafeBrowserTool('browser_type_credential')).toBe(true)
    expect(isSafeBrowserTool('browser_count')).toBe(true)
    expect(isSafeBrowserTool('browser_detect_auth_challenge')).toBe(true)
    expect(isSafeBrowserTool('browser_eval')).toBe(false)
    expect(isReplayableBrowserTool('browser_status')).toBe(false)
    expect(isReplayableBrowserTool('browser_activate_tab')).toBe(false)
    expect(isReplayableBrowserTool('browser_count')).toBe(true)
    expect(isReplayableBrowserTool('browser_detect_auth_challenge')).toBe(true)
    expect(BROWSER_ACTIONS).not.toContain('activate-tab')
    expect(BROWSER_ACTIONS).not.toContain('list-tabs')
  })

  it('forces credential flow for credential-looking inputs', () => {
    expect(() => assertSafePlainTextInput('用户名', '#username')).not.toThrow()
    expect(() => assertSafePlainTextInput('输入密码', '#password')).toThrow(/credential-like/i)
    expect(() => assertSafePlainTextInput('验证码', '#captcha')).toThrow(/credential-like/i)
  })

  it('heals only on one exact semantic match', () => {
    const snapshot = {
      elements: [
        { selector: '#a', text: '全部工单', role: 'button', tag: 'button' },
        { selector: '#b', text: '我的工作台', role: 'button', tag: 'button' },
      ],
    }
    expect(findUniqueHealingSelector(snapshot, { text: '全部工单', role: 'button' })).toBe('#a')
    expect(findUniqueHealingSelector({ elements: [snapshot.elements[0], { ...snapshot.elements[0], selector: '#c' }] }, { text: '全部工单' })).toBeUndefined()
  })
})
