// @ts-nocheck
import { describe, expect, it } from 'vitest'
import { apply as applyHostBridge } from '../browser-bridge-runtime/index.js'
import { apply as applyBrowserTools } from '../browser-bridge-runtime/tools-plugin.js'

function fakeHostContext() {
  const services = new Map()
  const routes = []
  const upgrades = []
  const disposers = []
  const ctx = {
    logger: { info() {}, warn() {} },
    webServer: {
      host: '127.0.0.1',
      port: 3080,
      register(route) {
        routes.push(route)
        return () => {}
      },
      registerUpgrade(route) {
        upgrades.push(route)
        return () => {}
      },
    },
    provide(name, value) {
      services.set(name, value)
    },
    get(name) {
      return services.get(name)
    },
    effect(factory) {
      const disposer = factory()
      if (typeof disposer === 'function') disposers.push(disposer)
      return disposer
    },
  }
  return { ctx, services, routes, upgrades, disposers }
}

describe('browser host/agent plane split', () => {
  it('host bridge owns routes and publishes one shared transport service', () => {
    const fixture = fakeHostContext()

    applyHostBridge(fixture.ctx, {
      path: '/patrol-browser-bridge',
      commandTimeoutMs: 1000,
      maxMessageBytes: 1024 * 1024,
      managedBrowser: false,
      originTrustFile: '/tmp/dsh-patrol-test-origin-that-does-not-exist.txt',
    })

    expect(fixture.upgrades).toHaveLength(1)
    expect(fixture.routes).toHaveLength(1)
    expect(fixture.upgrades[0].path).toBe('/patrol-browser-bridge')
    expect(fixture.routes[0].path).toBe('/patrol-browser-bridge/info')
    const service = fixture.services.get('patrolBrowserBridge')
    expect(service).toBeDefined()
    expect(service.bridge).toBeDefined()
    expect(typeof service.bridgeUrlHint).toBe('function')
    expect(typeof service.ensureBrowser).toBe('function')
  })

  it('agent plugin registers browser tools without owning any WebServer route', async () => {
    const definitions = []
    const bridge = {
      connected: false,
      request: async () => ({ ok: true }),
      status: () => ({ connected: false, pending: 0 }),
      saveScreenshot: () => '/tmp/screenshot.png',
    }
    const ctx = {
      logger: { warn() {} },
      tools: {
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
      },
      get(name) {
        if (name === 'patrolBrowserBridge') {
          return { bridge, bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge' }
        }
        return undefined
      },
      effect(factory) {
        return factory()
      },
    }

    await applyBrowserTools(ctx, { commandTimeoutMs: 1000 })

    const names = definitions.map(definition => definition.name)
    expect(names).toContain('browser_status')
    expect(names).toContain('browser_navigate')
    expect(names).toContain('browser_click')
    expect(names).toContain('browser_type_credential')
    expect(names).toContain('browser_screenshot')
    expect(names).not.toContain('browser_eval')
  })

  it('browser_screenshot keeps host screenshot persistence available through the scoped bridge facade', async () => {
    const definitions = []
    const dataUrl = 'data:image/png;base64,AA=='
    let savedPayload
    const bridge = {
      connected: true,
      request: async (cmd) => cmd === 'screenshot'
        ? { ok: true, dataUrl, bytes: 1 }
        : { ok: true },
      status: () => ({ connected: true, pending: 0 }),
      saveScreenshot(payload) {
        savedPayload = payload
        return '/tmp/patrol-screenshot.png'
      },
    }
    const ctx = {
      logger: { warn() {} },
      tools: {
        register(definition) {
          definitions.push(definition)
          return () => {}
        },
      },
      get(name) {
        if (name === 'patrolBrowserBridge') {
          return { bridge, bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge' }
        }
        return undefined
      },
      effect(factory) {
        return factory()
      },
    }

    await applyBrowserTools(ctx, { commandTimeoutMs: 1000 })
    const screenshot = definitions.find(definition => definition.name === 'browser_screenshot')
    expect(screenshot).toBeDefined()

    const value = await screenshot.execute({}, {})
    expect(savedPayload).toBe(dataUrl)
    expect(value).toMatchObject({ ok: true, path: '/tmp/patrol-screenshot.png', bytes: 1 })
    expect(typeof value.ocrStatus).toBe('string')
  })

  it('agent plugin fails closed when the host bridge was not installed', async () => {
    const ctx = {
      tools: { register() { return () => {} } },
      get() { return undefined },
      effect(factory) { return factory() },
    }

    await expect(applyBrowserTools(ctx)).rejects.toThrow(/host patrolBrowserBridge service is unavailable/)
  })
})
