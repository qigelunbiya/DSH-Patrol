// @ts-nocheck
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createManagedBrowserController } from '../browser-bridge-runtime/stable-managed-browser-controller.js'

const cleanup: string[] = []
afterEach(() => {
  while (cleanup.length > 0) rmSync(cleanup.pop()!, { recursive: true, force: true })
})

function fixture(prefix: string) {
  const root = mkdtempSync(join(tmpdir(), prefix))
  cleanup.push(root)
  const extensionPath = join(root, 'extension')
  mkdirSync(extensionPath)
  writeFileSync(join(extensionPath, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'DSH Patrol Browser Bridge',
    version: '0.3.1',
    background: { service_worker: 'background-entry.js' },
  }))
  return {
    extensionPath,
    profilePath: join(root, 'profile'),
    statePath: join(root, 'managed-browser.json'),
  }
}

function bridgeFixture() {
  const state: any = {
    connected: false,
    origin: null,
    extension: null,
  }
  return {
    state,
    bridge: {
      get connected() { return state.connected },
      get origin() { return state.origin },
      status() {
        return {
          connected: state.connected,
          origin: state.origin,
          extension: state.extension,
        }
      },
    },
  }
}

describe('stable managed Patrol browser controller', () => {
  it('keeps the first visible browser open when runtime extension provisioning fails', async () => {
    const paths = fixture('dsh-patrol-stable-fail-')
    const { bridge } = bridgeFixture()
    let launches = 0
    let closes = 0
    const browser: any = {
      connected: true,
      on() {},
      process: () => ({ pid: 9101 }),
      version: async () => 'Chrome/150.0.0.0',
      pages: async () => [],
      extensions: async () => new Map(),
      installExtension: async () => {
        throw new Error("Protocol error (Extensions.loadUnpacked): 'Extensions.loadUnpacked' wasn't found")
      },
      close: async () => {
        closes += 1
        browser.connected = false
      },
    }

    const controller = createManagedBrowserController({
      bridge,
      extensionPath: paths.extensionPath,
      profilePath: paths.profilePath,
      statePath: paths.statePath,
      browserExecutable: process.execPath,
      bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge',
      launchBrowser: async () => {
        launches += 1
        return browser
      },
      logger: { info() {}, warn() {} },
      startTimeoutMs: 100,
      connectTimeoutMs: 100,
    })

    await expect(controller.ensureStarted()).rejects.toThrow(/browser was deliberately kept open/i)
    expect(launches).toBe(1)
    expect(closes).toBe(0)
    expect(controller.status.running).toBe(true)
    expect(controller.status.lifecycle).toBe('single-process')

    await expect(controller.ensureStarted()).rejects.toThrow(/browser was deliberately kept open/i)
    expect(launches).toBe(1)
    expect(closes).toBe(0)

    await controller.dispose()
    expect(closes).toBe(1)
  })

  it('provisions the extension and reuses one browser for later Patrol actions', async () => {
    const paths = fixture('dsh-patrol-stable-ok-')
    const { bridge, state } = bridgeFixture()
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
    let launches = 0
    let closes = 0
    let installed = false

    const worker = {
      async evaluate() {
        state.connected = true
        state.origin = `chrome-extension://${extensionId}`
        state.extension = {
          name: 'dsh-patrol-browser-extension',
          version: '0.3.1',
          capabilities: ['captureImageCode', 'semanticClick', 'visualClick'],
        }
      },
    }
    const extension = {
      name: 'DSH Patrol Browser Bridge',
      path: paths.extensionPath,
      workers: async () => [worker],
    }
    const browser: any = {
      connected: true,
      on() {},
      process: () => ({ pid: 9102 }),
      version: async () => 'Chrome/150.0.0.0',
      pages: async () => [],
      extensions: async () => installed
        ? new Map([[extensionId, extension]])
        : new Map(),
      installExtension: async () => {
        installed = true
        return extensionId
      },
      close: async () => {
        closes += 1
        browser.connected = false
      },
    }

    const controller = createManagedBrowserController({
      bridge,
      extensionPath: paths.extensionPath,
      profilePath: paths.profilePath,
      statePath: paths.statePath,
      browserExecutable: process.execPath,
      bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge',
      launchBrowser: async options => {
        launches += 1
        expect(options.legacyExtensionLoad).toBe(false)
        return browser
      },
      logger: { info() {}, warn() {} },
      startTimeoutMs: 200,
      connectTimeoutMs: 200,
    })

    await expect(controller.ensureStarted()).resolves.toMatchObject({
      running: true,
      connected: true,
      extensionId,
      extensionLoadMode: 'runtime',
      lifecycle: 'single-process',
    })
    await expect(controller.ensureStarted()).resolves.toMatchObject({ connected: true })
    expect(launches).toBe(1)
    expect(closes).toBe(0)

    await controller.dispose()
    expect(closes).toBe(1)
  })
})
