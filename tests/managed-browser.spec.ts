// @ts-nocheck
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedBrowserController,
  isPrivateNetworkUrl,
  tryProceedPrivateCertificateInterstitial,
} from '../browser-bridge-runtime/managed-browser.js'

const cleanup = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true })
})

function fixtureRoot(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(root)
  const extensionPath = join(root, 'extension')
  mkdirSync(extensionPath)
  return {
    root,
    extensionPath,
    profilePath: join(root, 'profile'),
    statePath: join(root, 'managed-browser.json'),
  }
}

function workerThatConnects(bridge, state = {}) {
  return {
    async evaluate(_fn, url) {
      state.configuredUrl = url
      bridge.connected = true
    },
  }
}

describe('managed Patrol browser', () => {
  it('launches once, installs the bundled extension, configures the bridge, and reuses the connection', async () => {
    const { extensionPath, profilePath, statePath } = fixtureRoot('dsh-patrol-managed-')
    const bridge = { connected: false }
    let launches = 0
    let installs = 0
    let closes = 0
    const state = {}
    const worker = workerThatConnects(bridge, state)
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
    expect(first.extensionLoadMode).toBe('runtime')
    expect(launches).toBe(1)
    expect(installs).toBe(1)
    expect(state.configuredUrl).toBe('ws://127.0.0.1:3080/patrol-browser-bridge')

    await controller.ensureStarted()
    expect(launches).toBe(1)
    expect(installs).toBe(1)

    await controller.dispose()
    expect(closes).toBe(1)
  })

  it('falls back automatically when Chromium lacks the runtime extension API', async () => {
    const { extensionPath, profilePath, statePath } = fixtureRoot('dsh-patrol-managed-fallback-')
    const bridge = { connected: false }
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
    const launchArgs = []
    let firstClosed = 0
    let secondClosed = 0
    const worker = workerThatConnects(bridge)

    const first = {
      connected: true,
      on() {},
      process: () => ({ pid: 1111 }),
      async extensions() { return new Map() },
      async installExtension() {
        throw new Error("Protocol error (Extensions.loadUnpacked): 'Extensions.loadUnpacked' wasn't found")
      },
      async close() {
        firstClosed += 1
        this.connected = false
      },
    }
    const target = {
      type: () => 'service_worker',
      url: () => `chrome-extension://${extensionId}/background.js`,
      worker: async () => worker,
    }
    const second = {
      connected: true,
      on() {},
      process: () => ({ pid: 2222 }),
      async waitForTarget(predicate) {
        expect(predicate(target)).toBe(true)
        return target
      },
      async close() {
        secondClosed += 1
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
      launchBrowser: async args => {
        launchArgs.push(args)
        return launchArgs.length === 1 ? first : second
      },
      logger: { info() {}, warn() {} },
      connectTimeoutMs: 1000,
    })

    const result = await controller.ensureStarted()
    expect(result.connected).toBe(true)
    expect(result.extensionLoadMode).toBe('legacy-launch')
    expect(result.extensionId).toBe(extensionId)
    expect(launchArgs).toHaveLength(2)
    expect(launchArgs[0].legacyExtensionLoad).toBe(false)
    expect(launchArgs[1].legacyExtensionLoad).toBe(true)
    expect(firstClosed).toBe(1)

    await controller.dispose()
    expect(secondClosed).toBe(1)
  })

  it('closes a browser that launched but failed during extension configuration', async () => {
    const { extensionPath, profilePath, statePath } = fixtureRoot('dsh-patrol-managed-config-fail-')
    const bridge = { connected: false }
    let closes = 0
    const browser = {
      connected: true,
      on() {},
      async extensions() { return new Map() },
      async installExtension() { throw new Error('synthetic extension configuration failure') },
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
      launchBrowser: async () => browser,
      logger: { info() {}, warn() {} },
    })

    await expect(controller.ensureStarted()).rejects.toThrow(/synthetic extension configuration failure/)
    expect(closes).toBe(1)
    expect(controller.status.running).toBe(false)
    expect(controller.status.error).toMatch(/synthetic extension configuration failure/)
  })

  it('records a provisioning failure without corrupting controller state', async () => {
    const { extensionPath, root } = fixtureRoot('dsh-patrol-managed-fail-')
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

  it('recognizes private and local navigation targets without treating public sites as internal', () => {
    expect(isPrivateNetworkUrl('https://10.192.253.133/134')).toBe(true)
    expect(isPrivateNetworkUrl('https://172.16.5.4/')).toBe(true)
    expect(isPrivateNetworkUrl('https://172.31.255.254/')).toBe(true)
    expect(isPrivateNetworkUrl('https://192.168.1.20/')).toBe(true)
    expect(isPrivateNetworkUrl('https://127.0.0.1/')).toBe(true)
    expect(isPrivateNetworkUrl('https://localhost:8443/')).toBe(true)
    expect(isPrivateNetworkUrl('https://8.8.8.8/')).toBe(false)
    expect(isPrivateNetworkUrl('https://example.com/')).toBe(false)
    expect(isPrivateNetworkUrl('file:///tmp/example')).toBe(false)
  })

  it('expands and proceeds through a private-network certificate interstitial', async () => {
    let expanded = false
    let detailClicks = 0
    let proceedClicks = 0
    const page = {
      url: () => 'https://10.192.253.133/134',
      isClosed: () => false,
      async $(selector) {
        if (selector === '#proceed-link') {
          return expanded ? { click: async () => { proceedClicks += 1 } } : null
        }
        if (selector === '#details-button') {
          return { click: async () => { expanded = true; detailClicks += 1 } }
        }
        return null
      },
    }

    await expect(tryProceedPrivateCertificateInterstitial(page, { info() {}, warn() {} }, { attempts: 3, retryMs: 0 })).resolves.toBe(true)
    expect(detailClicks).toBe(1)
    expect(proceedClicks).toBe(1)
  })

  it('does not bypass certificate warnings for public URLs', async () => {
    let selectorReads = 0
    const page = {
      url: () => 'https://example.com/',
      async $() { selectorReads += 1; return null },
    }

    await expect(tryProceedPrivateCertificateInterstitial(page, { info() {}, warn() {} }, { attempts: 1, retryMs: 0 })).resolves.toBe(false)
    expect(selectorReads).toBe(0)
  })
})
