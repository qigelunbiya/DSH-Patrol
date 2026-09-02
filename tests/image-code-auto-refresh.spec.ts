// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { refreshCurrentImageCode } from '../browser-bridge-runtime/image-code-refresh-tool.js'
import { IMAGE_CODE_MAX_REFRESH_ATTEMPTS } from '../browser-bridge-runtime/image-code.js'

describe('automatic image-code refresh policy', () => {
  it('caps confidence-driven CAPTCHA refreshes at three fresh images', () => {
    expect(IMAGE_CODE_MAX_REFRESH_ATTEMPTS).toBe(3)
  })

  it('never reloads the whole page when the automatic solver requests captcha-only recovery', async () => {
    const calls = []
    const bridge = {
      status: () => ({ extension: { version: '0.2.1', capabilities: ['captureImageCode'] } }),
      async request(cmd, args) {
        calls.push({ cmd, args })
        if (cmd === 'captureImageCode') {
          return {
            ok: true,
            dataUrl: 'data:image/png;base64,QUFB',
            inputSelector: '#captcha',
            imageSelector: '#captcha-image',
            captureMode: 'element-crop',
          }
        }
        if (cmd === 'snapshot') return { ok: true, elements: [] }
        if (cmd === 'click') return { ok: true }
        if (cmd === 'wait') return { ok: true }
        if (cmd === 'navigate') throw new Error('automatic captcha-only recovery must not reload the page')
        throw new Error(`unexpected ${cmd}`)
      },
    }

    const result = await refreshCurrentImageCode(bridge, {
      inputSelector: '#captcha',
      imageSelector: '#captcha-image',
      allowPageReload: false,
    }, {})

    expect(result).toBeUndefined()
    expect(calls.some(call => call.cmd === 'navigate')).toBe(false)
  })
})
