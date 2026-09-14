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
})
