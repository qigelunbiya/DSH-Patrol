import { describe, expect, it } from 'vitest'
import { createResilientBrowserBridge } from '../browser-bridge-runtime/resilient-bridge.js'

describe('Patrol tab transition bridge', () => {
  it('uses a newly opened tab for the immediate verification read', async () => {
    let tabs: any[] = [{ id: 1, active: true, url: 'http://site/list' }]
    let actionCalls = 0
    let readTabId: number | undefined
    const raw: any = {
      connected: true,
      status: () => ({ connected: true, extension: {} }),
      saveScreenshot: () => '',
      async request(cmd: string, args: any = {}) {
        if (cmd === 'listTabs') return { tabs }
        if (cmd === 'click') {
          actionCalls += 1
          tabs = [
            { id: 1, active: false, url: 'http://site/list' },
            { id: 2, active: true, url: 'http://site/detail' },
          ]
          return { ok: true }
        }
        if (cmd === 'readPage') {
          readTabId = args.tabId
          return { url: args.tabId === 2 ? 'http://site/detail' : 'http://site/list', text: '' }
        }
        throw new Error(`unexpected command ${cmd}`)
      },
    }
    const service: any = {
      bridge: raw,
      managedBrowserStatus: () => ({ running: true, starting: false, connected: true }),
    }
    const bridge = createResilientBrowserBridge(service, { logger: { info() {}, warn() {} } })

    await bridge.request('click', { selector: '.item' })
    await expect(bridge.request('readPage', {})).resolves.toMatchObject({ url: 'http://site/detail' })
    expect(readTabId).toBe(2)
    expect(actionCalls).toBe(1)
  })

  it('uses a newly opened tab for verification after a visualClick too', async () => {
    let tabs: any[] = [{ id: 11, active: true, url: 'https://www.bilibili.com/' }]
    let readTabId: number | undefined
    const raw: any = {
      connected: true,
      status: () => ({ connected: true, extension: {} }),
      saveScreenshot: () => '',
      async request(cmd: string, args: any = {}) {
        if (cmd === 'listTabs') return { tabs }
        if (cmd === 'visualClick') {
          tabs = [
            { id: 11, active: false, url: 'https://www.bilibili.com/' },
            { id: 12, active: true, openerTabId: 11, url: 'https://www.bilibili.com/video/BV-test' },
          ]
          return { ok: true, xRatio: 0.5, yRatio: 0.5 }
        }
        if (cmd === 'readPage') {
          readTabId = args.tabId
          return {
            url: args.tabId === 12 ? 'https://www.bilibili.com/video/BV-test' : 'https://www.bilibili.com/',
            title: args.tabId === 12 ? '目标视频' : '首页',
            text: '',
          }
        }
        throw new Error(`unexpected command ${cmd}`)
      },
    }
    const service: any = {
      bridge: raw,
      managedBrowserStatus: () => ({ running: true, starting: false, connected: true }),
    }
    const bridge = createResilientBrowserBridge(service, { logger: { info() {}, warn() {} } })

    await bridge.request('visualClick', { frameId: 'browser-visual-current', xRatio: 0.5, yRatio: 0.5 })
    await expect(bridge.request('readPage', { tabId: 11 })).resolves.toMatchObject({
      url: 'https://www.bilibili.com/video/BV-test',
      title: '目标视频',
    })
    expect(readTabId).toBe(12)
  })
})
