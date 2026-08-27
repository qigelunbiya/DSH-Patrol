// @ts-nocheck
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BrowserBridge } from '../browser-bridge-runtime/bridge.js'
import { apply as applyHostBridge } from '../browser-bridge-runtime/index.js'

const cleanup = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true })
})

function tempRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-bridge-security-'))
  cleanup.push(root)
  return root
}

function fakeConnection() {
  let closeListener
  return {
    sent: [],
    onMessage() {},
    onClose(listener) { closeListener = listener },
    onError() {},
    send(text) { this.sent.push(text) },
    close() { closeListener?.() },
    fireClose() { closeListener?.() },
  }
}

describe('managed browser bridge origin security', () => {
  it('tracks the exact extension origin on the active bridge connection', () => {
    const root = tempRoot()
    const bridge = new BrowserBridge({ screenshotDir: join(root, 'shots') })
    const connection = fakeConnection()
    const origin = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop'

    bridge.attach(connection, { origin })
    expect(bridge.connected).toBe(true)
    expect(bridge.origin).toBe(origin)
    expect(bridge.status().origin).toBe(origin)

    connection.fireClose()
    expect(bridge.connected).toBe(false)
    expect(bridge.status().origin).toBeNull()
    bridge.dispose()
  })

  it('rejects extension websocket connections before the managed extension id is provisioned', () => {
    const root = tempRoot()
    const upgrades = []
    const routes = []
    const services = new Map()
    const ctx = {
      logger: { info() {}, warn() {} },
      webServer: {
        host: '127.0.0.1',
        port: 3080,
        register(route) { routes.push(route); return () => {} },
        registerUpgrade(route) { upgrades.push(route); return () => {} },
      },
      provide(name, value) { services.set(name, value) },
      get(name) { return services.get(name) },
      effect(factory) { return factory() },
    }

    applyHostBridge(ctx, {
      screenshotDir: join(root, 'shots'),
      browserProfilePath: join(root, 'profile'),
      originTrustFile: join(root, 'trusted-origin.txt'),
    })

    expect(upgrades).toHaveLength(1)
    let destroyed = 0
    const socket = { destroy() { destroyed += 1 } }
    upgrades[0].handler(
      { headers: { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' } },
      socket,
      Buffer.alloc(0),
    )
    expect(destroyed).toBe(1)
  })
})
