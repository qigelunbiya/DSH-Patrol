// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { trustedClickManagedTarget } from '../browser-bridge-runtime/trusted-click.js'

describe('managed Puppeteer trusted click transport', () => {
  it('uses ElementHandle.click on the CURRENT top-frame selector', async () => {
    let clickOptions
    let broughtToFront = 0
    let disposed = 0
    const element = {
      async click(options) { clickOptions = options },
      async dispose() { disposed += 1 },
    }
    const frame = {
      url: () => 'https://example.test/app',
      async $(selector) { return selector === 'span[title="详情"]' ? element : null },
    }
    const page = {
      url: () => 'https://example.test/app#hosts',
      isClosed: () => false,
      mainFrame: () => frame,
      frames: () => [frame],
      async bringToFront() { broughtToFront += 1 },
      async evaluate() { return true },
    }
    const browser = {
      connected: true,
      async pages() { return [page] },
    }

    const result = await trustedClickManagedTarget(browser, {
      selector: 'span[title="详情"]',
      pageUrl: 'https://example.test/app#hosts',
      frameId: 0,
    })

    expect(clickOptions).toEqual({ button: 'left', clickCount: 1 })
    expect(broughtToFront).toBe(1)
    expect(disposed).toBeGreaterThanOrEqual(1)
    expect(result).toMatchObject({
      ok: true,
      selector: 'span[title="详情"]',
      transport: 'puppeteer-trusted-click',
    })
  })

  it('selects the only page whose CURRENT frame still contains the resolved selector', async () => {
    const clicked = []
    const makePage = (url, containsTarget) => {
      const frame = {
        url: () => url,
        async $(selector) {
          if (!containsTarget || selector !== '[data-action="open"]') return null
          return {
            async click() { clicked.push(url) },
            async dispose() {},
          }
        },
      }
      return {
        url: () => url,
        isClosed: () => false,
        mainFrame: () => frame,
        frames: () => [frame],
        async bringToFront() {},
        async evaluate() { return false },
      }
    }
    const browser = {
      connected: true,
      async pages() {
        return [
          makePage('https://example.test/other', false),
          makePage('https://example.test/hosts', true),
        ]
      },
    }

    await trustedClickManagedTarget(browser, { selector: '[data-action="open"]' })
    expect(clicked).toEqual(['https://example.test/hosts'])
  })
})
