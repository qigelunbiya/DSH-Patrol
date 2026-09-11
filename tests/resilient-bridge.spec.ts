import { describe, expect, it, vi } from 'vitest'
import {
  createResilientBrowserBridge,
  isTransportReplaySafe,
} from '../browser-bridge-runtime/resilient-bridge.js'

describe('resilient Patrol browser bridge', () => {
  it('starts managed-browser repair without waiting for the long controller deadline', async () => {
    const request = vi.fn(async (_cmd, _args, options) => {
      expect(options.timeoutMs).toBeLessThanOrEqual(10_000)
      return { tabs: [] }
    })
    const rawBridge: any = {
      connected: false,
      request,
      status: () => ({ connected: rawBridge.connected, pending: 0 }),
      saveScreenshot: () => '',
    }
    const service: any = {
      bridge: rawBridge,
      ensureBrowser: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        rawBridge.connected = true
        return { connected: true }
      }),
    }
    const bridge = createResilientBrowserBridge(service, {
      commandTimeoutMs: 60_000,
      repairWaitMs: 100,
      pollMs: 5,
      logger: { warn() {} },
    })

    await expect(bridge.request('listTabs', {}, { timeoutMs: 60_000 })).resolves.toEqual({ tabs: [] })
    expect(service.ensureBrowser).toHaveBeenCalledTimes(1)
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('never dispatches through a provisional extension socket while the managed browser is still starting', async () => {
    let starting = true
    let requestWhileStarting = false
    const rawBridge: any = {
      connected: true,
      async request() {
        if (starting) requestWhileStarting = true
        return { tabs: [{ id: 1 }] }
      },
      status: () => ({ connected: rawBridge.connected, extension: { capabilities: ['semanticClick'] } }),
      saveScreenshot: () => '',
      resetConnection: vi.fn(() => {
        rawBridge.connected = false
        return true
      }),
    }
    const service: any = {
      bridge: rawBridge,
      managedBrowserStatus: () => ({
        running: true,
        starting,
        connected: rawBridge.connected,
      }),
      ensureBrowser: vi.fn(async () => {
        await new Promise(resolve => setTimeout(resolve, 20))
        rawBridge.connected = true
        starting = false
        return { running: true, connected: true }
      }),
    }
    const bridge = createResilientBrowserBridge(service, {
      initialConnectWaitMs: 200,
      pollMs: 5,
      logger: { warn() {} },
    })

    await expect(bridge.request('listTabs')).resolves.toEqual({ tabs: [{ id: 1 }] })
    expect(service.ensureBrowser).toHaveBeenCalledTimes(1)
    expect(rawBridge.resetConnection).toHaveBeenCalledTimes(1)
    expect(requestWhileStarting).toBe(false)
  })

  it('resets a stale transport and retries a read-only command once', async () => {
    let calls = 0
    const rawBridge: any = {
      connected: true,
      async request() {
        calls += 1
        if (calls === 1) throw Object.assign(new Error('The browser did not answer listTabs within 10s.'), { code: 'TIMEOUT' })
        return { tabs: [{ id: 1 }] }
      },
      resetConnection: vi.fn(() => {
        rawBridge.connected = false
        return true
      }),
      status: () => ({ connected: rawBridge.connected, pending: 0 }),
      saveScreenshot: () => '',
    }
    const service: any = {
      bridge: rawBridge,
      ensureBrowser: vi.fn(async () => {
        rawBridge.connected = true
        return { connected: true }
      }),
    }
    const bridge = createResilientBrowserBridge(service, {
      repairWaitMs: 100,
      pollMs: 5,
      logger: { warn() {} },
    })

    await expect(bridge.request('listTabs')).resolves.toEqual({ tabs: [{ id: 1 }] })
    expect(calls).toBe(2)
    expect(rawBridge.resetConnection).toHaveBeenCalledTimes(1)
    expect(service.ensureBrowser).toHaveBeenCalledTimes(1)
  })

  it('repairs transport but never blindly repeats an uncertain mutating click', async () => {
    let calls = 0
    const rawBridge: any = {
      connected: true,
      async request() {
        calls += 1
        throw Object.assign(new Error('The browser did not answer click within 10s.'), { code: 'TIMEOUT' })
      },
      resetConnection() {
        rawBridge.connected = false
        return true
      },
      status: () => ({ connected: rawBridge.connected, pending: 0 }),
      saveScreenshot: () => '',
    }
    const service: any = {
      bridge: rawBridge,
      async ensureBrowser() {
        rawBridge.connected = true
        return { connected: true }
      },
    }
    const bridge = createResilientBrowserBridge(service, {
      repairWaitMs: 100,
      pollMs: 5,
      logger: { warn() {} },
    })

    await expect(bridge.request('click', { selector: '#login' }))
      .rejects.toThrow(/deliberately did not repeat this mutating command/i)
    expect(calls).toBe(1)
    expect(rawBridge.connected).toBe(true)
  })

  it('only treats same-tab explicit navigation as replay-safe', () => {
    expect(isTransportReplaySafe('navigate', { action: 'navigate', url: 'https://10.0.0.1/' })).toBe(true)
    expect(isTransportReplaySafe('navigate', { action: 'navigate', url: 'https://10.0.0.1/', newTab: true })).toBe(false)
    expect(isTransportReplaySafe('navigate', { action: 'reload' })).toBe(false)
    expect(isTransportReplaySafe('click', { selector: '#submit' })).toBe(false)
    expect(isTransportReplaySafe('snapshot', {})).toBe(true)
  })
})
