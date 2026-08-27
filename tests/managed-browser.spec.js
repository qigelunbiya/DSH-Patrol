import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedBrowserController } from '../browser-bridge-runtime/managed-browser.js'

const cleanup = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true })
})

describe('managed Patrol browser', () => {
  it('launches once, installs the bundled extension, configures the bridge, and reuses the connection', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-managed-'))
    cleanup.push(root)
    const extensionPath = join(root, 'extension')
    const profilePath = join(root, 'profile')
    const statePath = join(root, 'managed-browser.json')
    mkdirSync(extensionPath)

    const bridge = { connected: false }
    let launches = 0
    let installs = 0
    let closes = 0
    let configuredUrl
    const worker = {
      async evaluate(_fn, url) {
        configuredUrl = url
        bridge.connected = true
      },
    }
    const extension = { workers: async () => [worker] }
    const browser = {
      connected: true,
      on() {},
      process: () => ({ pid: 1234 }),
      async installExtension(path) {
        installs += 1
        expect(path).toBe(extensionPath)
        return 'abcdefghijklmnopabcdefghijklmnop'
      },
      async extensions() {
        return new Map([['abcdefghijklmnopabcdefghijklmnop', extension]])
      },
      async close() {
        closes += 1
        this.connected = false
      },
    }

    const controller = createManagedBrowserController({
      bridge,
      extensionPath,
      profilePath,
      statePath,
      browserExecutable: process.execPath,
      bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge',
      launchBrowser: async () => {
        launches += 1
        return browser
      },
      connectTimeoutMs: 1000,
    })

    const [first, second] = await Promise.all([controller.ensureStarted(), controller.ensureStarted()])
    expect(first.connected).toBe(true)
    expect(second.connected).toBe(true)
    expect(launches).toBe(1)
    expect(installs).toBe(1)
    expect(configuredUrl).toBe('ws://127.0.0.1:3080/patrol-browser-bridge')

    await controller.ensureStarted()
    expect(launches).toBe(1)
    expect(installs).toBe(1)

    await controller.dispose()
    expect(closes).toBe(1)
  })

  it('records a provisioning failure without corrupting controller state', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-managed-fail-'))
    cleanup.push(root)
    const extensionPath = join(root, 'extension')
    mkdirSync(extensionPath)
    const bridge = { connected: false }
    const controller = createManagedBrowserController({
      bridge,
      extensionPath,
      profilePath: join(root, 'profile'),
      statePath: join(root, 'managed-browser.json'),
      browserExecutable: process.execPath,
      bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge',
      launchBrowser: async () => { throw new Error('synthetic launch failure') },
      logger: { info() {}, warn() {} },
    })

    await expect(controller.ensureStarted()).rejects.toThrow(/synthetic launch failure/)
    expect(controller.status.connected).toBe(false)
    expect(controller.status.error).toMatch(/synthetic launch failure/)
  })
})
