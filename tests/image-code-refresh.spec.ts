// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { registerImageCodeRefreshTool, findImageCodeRefreshCandidates } from '../browser-bridge-runtime/image-code-refresh-tool.js'
import { isReplayableBrowserTool, isSafeBrowserTool } from '../src/browser.js'

function registerWithBridge(bridge) {
  let definition
  const ctx = {
    tools: {
      register(value) {
        definition = value
        return () => {}
      },
    },
  }
  registerImageCodeRefreshTool(ctx, bridge, { commandTimeoutMs: 1000 })
  return definition
}

describe('image-code refresh recovery', () => {
  it('prefers the already captured CAPTCHA image and only keeps explicit refresh controls', () => {
    const candidates = findImageCodeRefreshCandidates({
      elements: [
        { selector: '#captcha-input', tag: 'input', name: 'captcha' },
        { selector: '#logo', tag: 'img', text: 'visual:img logo 200x60' },
        { selector: '#submit', tag: 'button', text: '登录' },
        { selector: '#change-code', tag: 'a', text: '看不清？换一张验证码' },
      ],
    }, '#captcha-image', '#captcha-input')

    expect(candidates).toEqual([
      { selector: '#captcha-image', method: 'image-click' },
      { selector: '#change-code', method: 'refresh-control' },
    ])
  })

  it('clicks the CAPTCHA image and proves that the captured image actually changed', async () => {
    let captureCount = 0
    const calls = []
    const bridge = {
      status: () => ({ extension: { version: '0.2.1', capabilities: ['captureImageCode'] } }),
      async request(cmd, args) {
        calls.push({ cmd, args })
        if (cmd === 'captureImageCode') {
          captureCount += 1
          return {
            ok: true,
            dataUrl: captureCount === 1 ? 'data:image/png;base64,QUFB' : 'data:image/png;base64,QkJC',
            inputSelector: '#captcha',
            imageSelector: '#captcha-image',
            captureMode: 'element-crop',
          }
        }
        if (cmd === 'snapshot') return { ok: true, elements: [] }
        if (cmd === 'click') return { ok: true }
        if (cmd === 'wait') return { ok: true }
        throw new Error(`unexpected ${cmd}`)
      },
    }

    const tool = registerWithBridge(bridge)
    const result = await tool.execute({}, {})

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      method: 'image-click',
      selector: '#captcha-image',
      requiresCredentialRefill: false,
    })
    expect(calls.some(call => call.cmd === 'click' && call.args.selector === '#captcha-image')).toBe(true)
  })

  it('uses one page reload as the bounded last resort and marks credentials for refill', async () => {
    let captureCount = 0
    const calls = []
    const bridge = {
      status: () => ({ extension: { version: '0.2.1', capabilities: ['captureImageCode'] } }),
      async request(cmd, args) {
        calls.push({ cmd, args })
        if (cmd === 'captureImageCode') {
          captureCount += 1
          return {
            ok: true,
            dataUrl: captureCount === 1 ? 'data:image/png;base64,QUFB' : 'data:image/png;base64,Q0ND',
            inputSelector: '#captcha',
            imageSelector: '',
            captureMode: 'neighbor-region',
          }
        }
        if (cmd === 'snapshot') return { ok: true, elements: [] }
        if (cmd === 'navigate') return { ok: true }
        if (cmd === 'wait') return { ok: true }
        throw new Error(`unexpected ${cmd}`)
      },
    }

    const tool = registerWithBridge(bridge)
    const result = await tool.execute({ allowPageReload: true }, {})

    expect(result).toMatchObject({
      ok: true,
      changed: true,
      method: 'page-reload',
      requiresCredentialRefill: true,
    })
    expect(calls).toContainEqual(expect.objectContaining({ cmd: 'navigate', args: expect.objectContaining({ action: 'reload' }) }))
  })

  it('is safe for bounded test-mode recovery but is never recorded as a replayable Runbook step', () => {
    expect(isSafeBrowserTool('browser_refresh_image_code')).toBe(true)
    expect(isReplayableBrowserTool('browser_refresh_image_code')).toBe(false)
  })
})
