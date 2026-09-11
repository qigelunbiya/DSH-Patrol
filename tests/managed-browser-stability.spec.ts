// @ts-nocheck
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedBrowserController } from '../browser-bridge-runtime/managed-browser.js'

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
})

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(root)
  const extensionPath = join(root, 'extension')
  mkdirSync(extensionPath)
  return {
    root,
    extensionPath,
    profilePath: join(root, 'profile'),
    statePath: join(root, 'state.json'),
  }
}

describe('managed Patrol browser stability regressions', () => {
  it('keeps the same Chromium process open when the extension handshake is late, then repairs it in place', async () => {
    const paths = fixture('dsh-patrol-stable-handshake-')
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
    let shouldConnect = false
    let launches = 0
    let installs = 0
    let closes = 0
    let workerConfigures = 0
    const bridgeState: any = { connected: false, origin: null, extension: null }
    const bridge: any = {
      get connected() { return bridgeState.connected },
      status: () => ({ ...bridgeState }),
    }
    const worker = {
      async evaluate() {
        workerConfigures += 1
        if (!shouldConnect) return
        bridgeState.connected = true
        bridgeState.origin = `chrome-extension://${extensionId}`
        bridgeState.extension = { capabilities: ['semanticClick'] }
      },
    }
    const installed = {
      name: 'DSH Patrol Browser Bridge',
      // Runtime-installed extensions can report a profile-internal path. The
      // controller must still recognize the extension by its stable name.
      path: join(paths.profilePath, 'Extensions', extensionId),
      workers: async () => [worker],
    }
    const browser: any = {
      connected: true,
      on() {},
      process: () => ({ pid: 4242 }),
      pages: async () => [],
      extensions: async () => new Map([[extensionId, installed]]),
      async installExtension() {
        installs += 1
        return extensionId
      },
      async close() {
        closes += 1
        this.connected = false
      },
    }

    const controller = createManagedBrowserController({
      bridge,
      extensionPath: paths.extensionPath,
      profilePath: paths.profilePath,
      statePath: paths.statePath,
      browserExecutable: process.execPath,
      bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge',
      connectTimeoutMs: 30,
      startTimeoutMs: 100,
      launchBrowser: async () => {
        launches += 1
        return browser
      },
      logger: { info() {}, warn() {} },
    })

    await expect(controller.ensureStarted()).rejects.toThrow(/did not connect/i)
    expect(controller.status.running).toBe(true)
    expect(closes).toBe(0)
    expect(launches).toBe(1)
    expect(installs).toBe(0)

    shouldConnect = true
    await expect(controller.ensureStarted()).resolves.toMatchObject({ running: true, connected: true })
    expect(launches).toBe(1)
    expect(installs).toBe(0)
    expect(closes).toBe(0)
    expect(workerConfigures).toBeGreaterThanOrEqual(2)

    await controller.dispose()
    expect(closes).toBe(1)
  })

  it('repairs a legacy-loaded browser with its existing worker instead of runtime-reinstalling the extension', async () => {
    const paths = fixture('dsh-patrol-stable-legacy-')
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
    const bridgeState: any = { connected: false, origin: null, extension: null }
    const bridge: any = {
      get connected() { return bridgeState.connected },
      status: () => ({ ...bridgeState }),
    }
    const worker = {
      async evaluate() {
        bridgeState.connected = true
        bridgeState.origin = `chrome-extension://${extensionId}`
        bridgeState.extension = { capabilities: ['semanticClick'] }
      },
    }
    const target = {
      type: () => 'service_worker',
      url: () => `chrome-extension://${extensionId}/background-entry.js`,
      worker: async () => worker,
    }
    let launches = 0
    let firstCloses = 0
    let secondCloses = 0
    let legacyWorkerLookups = 0
    let runtimeInstallsOnLegacyBrowser = 0

    const first: any = {
      connected: true,
      on() {},
      process: () => ({ pid: 5001 }),
      pages: async () => [],
      extensions: async () => new Map(),
      async installExtension() {
        throw new Error("Protocol error (Extensions.loadUnpacked): 'Extensions.loadUnpacked' wasn't found")
      },
      async close() {
        firstCloses += 1
        this.connected = false
      },
    }
    const second: any = {
      connected: true,
      on() {},
      process: () => ({ pid: 5002 }),
      pages: async () => [],
      async waitForTarget(predicate: any) {
        legacyWorkerLookups += 1
        expect(predicate(target)).toBe(true)
        return target
      },
      async installExtension() {
        runtimeInstallsOnLegacyBrowser += 1
        throw new Error('runtime install must not be used to repair a legacy-loaded Patrol browser')
      },
      async close() {
        secondCloses += 1
        this.connected = false
      },
    }

    const controller = createManagedBrowserController({
      bridge,
      extensionPath: paths.extensionPath,
      profilePath: paths.profilePath,
      statePath: paths.statePath,
      browserExecutable: process.execPath,
      bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge',
      connectTimeoutMs: 100,
      startTimeoutMs: 100,
      launchBrowser: async () => {
        launches += 1
        return launches === 1 ? first : second
      },
      logger: { info() {}, warn() {} },
    })

    await expect(controller.ensureStarted()).resolves.toMatchObject({
      connected: true,
      extensionLoadMode: 'legacy-launch',
    })
    expect(firstCloses).toBe(1)
    expect(runtimeInstallsOnLegacyBrowser).toBe(0)

    bridgeState.connected = false
    bridgeState.origin = null
    bridgeState.extension = null
    await expect(controller.ensureStarted()).resolves.toMatchObject({
      connected: true,
      extensionLoadMode: 'legacy-launch',
    })
    expect(launches).toBe(2)
    expect(runtimeInstallsOnLegacyBrowser).toBe(0)
    expect(legacyWorkerLookups).toBeGreaterThanOrEqual(2)
    expect(secondCloses).toBe(0)

    await controller.dispose()
    expect(secondCloses).toBe(1)
  })
})
