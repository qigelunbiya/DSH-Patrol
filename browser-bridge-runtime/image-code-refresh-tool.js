import { createHash } from 'node:crypto'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertImageCodeCaptureCapability } from './image-code-visual-tool.js'

const reqBool = { type: 'boolean', required: true }
const str = { type: 'string' }
const optStr = { type: 'string' }
const optInt = { type: 'integer' }
const optBool = { type: 'boolean' }

const REFRESH_ACTION_HINT = /(refresh|reload|change|switch|another|new[-_ ]?code|retry|换一张|换一个|看不清|刷新|重载|重新获取|重新生成|点击.*换|点击.*刷新)/i
const IMAGE_CODE_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|verify|verification|验证码|校验码|图形码)/i
const NOISE_HINT = /(logo|brand|avatar|favicon|qrcode|qr[-_ ]?code|二维码)/i

export function registerImageCodeRefreshTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'browser_refresh_image_code',
    description: 'Refresh the CURRENT conventional image-code CAPTCHA without submitting the login form. It first tries the captured CAPTCHA image itself, then explicit nearby refresh/change controls, verifies that the CAPTCHA image bytes actually changed, and can use one whole-page reload as a last resort. A page reload sets requiresCredentialRefill=true because username/password fields may have been cleared.',
    parameters: {
      tabId: optInt,
      inputSelector: optStr,
      imageSelector: optStr,
      allowPageReload: optBool,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: reqBool,
          changed: reqBool,
          method: { type: 'string', required: true, enum: ['image-click', 'refresh-control', 'page-reload'] },
          selector: str,
          inputSelector: str,
          imageSelector: str,
          captureMode: str,
          attempts: { type: 'integer', required: true },
          requiresCredentialRefill: reqBool,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `CURRENT CAPTCHA refresh method=${value.method}${value.selector ? ` selector=${value.selector}` : ''}; changed=${value.changed}; attempts=${value.attempts}.`,
          value.requiresCredentialRefill
            ? 'The whole page was reloaded. Re-observe the page and refill username/password plus a freshly recognized CAPTCHA before login submission.'
            : 'The CAPTCHA image changed without submitting the login form. The previous CAPTCHA text is invalid; re-capture/re-observe and recognize the fresh image.',
        ].join('\n'),
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Refresh current CAPTCHA',
      kind: 'other',
      rawInput: {
        tabId: args.tabId,
        inputSelector: args.inputSelector,
        imageSelector: args.imageSelector,
        allowPageReload: args.allowPageReload,
      },
    }),
    async execute(args, exec) {
      assertImageCodeCaptureCapability(bridge)
      const options = { timeoutMs, signal: exec?.signal }
      const before = await capture(bridge, {
        tabId: args.tabId,
        inputSelector: args.inputSelector,
        imageSelector: args.imageSelector,
      }, options)
      const beforeFingerprint = imageFingerprint(before.dataUrl)
      const inputSelector = before.inputSelector || args.inputSelector || ''
      const imageSelector = before.imageSelector || args.imageSelector || ''

      let snapshot
      try {
        snapshot = await bridge.request('snapshot', {
          maxElements: 300,
          includeHidden: false,
          tabId: args.tabId,
        }, options)
      } catch {
        snapshot = { elements: [] }
      }

      const candidates = findImageCodeRefreshCandidates(snapshot, imageSelector, inputSelector).slice(0, 6)
      let attempts = 0
      for (const candidate of candidates) {
        attempts += 1
        try {
          await bridge.request('click', { selector: candidate.selector, tabId: args.tabId }, options)
        } catch {
          continue
        }
        const after = await waitForChangedCapture(bridge, {
          tabId: args.tabId,
          inputSelector,
        }, beforeFingerprint, options)
        if (after !== undefined) {
          return {
            ok: true,
            changed: true,
            method: candidate.method,
            selector: candidate.selector,
            inputSelector: after.inputSelector || inputSelector,
            imageSelector: after.imageSelector || imageSelector,
            captureMode: after.captureMode || '',
            attempts,
            requiresCredentialRefill: false,
          }
        }
      }

      if (args.allowPageReload !== false) {
        attempts += 1
        await bridge.request('navigate', { action: 'reload', tabId: args.tabId }, options)
        const after = await waitForChangedCapture(bridge, {
          tabId: args.tabId,
          inputSelector: '',
        }, beforeFingerprint, options, [280, 650, 1200])
        return {
          ok: true,
          changed: after !== undefined,
          method: 'page-reload',
          inputSelector: after?.inputSelector || '',
          imageSelector: after?.imageSelector || '',
          captureMode: after?.captureMode || '',
          attempts,
          requiresCredentialRefill: true,
        }
      }

      throw new Error(`Could not verify a fresh CAPTCHA after ${attempts} bounded refresh attempts. No login submission was performed.`)
    },
  })

  return ctx.tools.register(definition)
}

export function findImageCodeRefreshCandidates(snapshot, imageSelector = '', inputSelector = '') {
  const candidates = []
  const seen = new Set()
  if (typeof imageSelector === 'string' && imageSelector.trim() !== '' && imageSelector !== inputSelector) {
    candidates.push({ selector: imageSelector, method: 'image-click', score: 100, index: -1 })
    seen.add(imageSelector)
  }

  const elements = Array.isArray(snapshot?.elements) ? snapshot.elements : []
  for (let index = 0; index < elements.length; index += 1) {
    const element = elements[index]
    if (!element || typeof element !== 'object' || typeof element.selector !== 'string') continue
    const selector = element.selector
    if (!selector || selector === inputSelector || seen.has(selector)) continue
    const tag = String(element.tag || '').toLowerCase()
    const hint = [selector, element.name, element.text, element.role, element.title, element.ariaLabel]
      .filter(value => typeof value === 'string')
      .join(' ')
    if (!REFRESH_ACTION_HINT.test(hint)) continue
    if (NOISE_HINT.test(hint) && !IMAGE_CODE_HINT.test(hint)) continue

    let score = 40
    if (IMAGE_CODE_HINT.test(hint)) score += 25
    if (/(button|link)/i.test(String(element.role || ''))) score += 12
    if (['button', 'a'].includes(tag)) score += 10
    if (['img', 'canvas', 'svg'].includes(tag)) score += 6
    if (/换一张|看不清|刷新|refresh|change/i.test(hint)) score += 12
    candidates.push({ selector, method: 'refresh-control', score, index })
    seen.add(selector)
  }

  candidates.sort((left, right) => right.score - left.score || left.index - right.index)
  return candidates.map(({ selector, method }) => ({ selector, method }))
}

async function waitForChangedCapture(bridge, args, beforeFingerprint, options, delays = [120, 320, 700]) {
  for (const delay of delays) {
    try {
      await bridge.request('wait', { timeoutMs: delay, tabId: args.tabId }, options)
    } catch {
      await new Promise(resolve => setTimeout(resolve, delay))
    }
    try {
      const current = await capture(bridge, args, options)
      if (imageFingerprint(current.dataUrl) !== beforeFingerprint) return current
    } catch {
      // A refresh can briefly detach/recreate the visual node. Keep the retry
      // bounded and let the next capture rediscover the CURRENT image target.
    }
  }
  return undefined
}

async function capture(bridge, args, options) {
  const value = await bridge.request('captureImageCode', args, options)
  if (!value || typeof value !== 'object' || value.ok === false || typeof value.dataUrl !== 'string') {
    throw new Error(String(value?.error || 'captureImageCode did not return a CAPTCHA image'))
  }
  return value
}

function imageFingerprint(dataUrl) {
  return createHash('sha256').update(String(dataUrl || ''), 'utf8').digest('hex')
}
