// @ts-nocheck
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createManagedBrowserController,
  patrolExtensionLoadStrategy,
  resolvePreferredPatrolBrowserExecutable,
} from '../browser-bridge-runtime/managed-browser-controller.js'

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
    root,
    extensionPath,
    profilePath: join(root, 'profile'),
    statePath: join(root, 'state.json'),
  }
}

describe('single-process managed Patrol browser startup', () => {
  it('source-loads the Patrol extension in the first browser instead of runtime-probing and relaunching', async () => {
    const paths = fixture('dsh-patrol-single-launch-')
    const extensionId = 'abcdefghijklmnopabcdefghijklmnop'
    const bridge: any = { connected: false }
    let launches = 0
    let closes = 0
    let runtimeInstalls = 0
    const worker = {
      async evaluate() {
        bridge.connected = true
      },
    }
    const target = {
      type: () => 'service_worker',
      url: () => `chrome-extension://${extensionId}/background-entry.js`,
      worker: async () => worker,
    }
    const browser: any = {
      connected: true,
      on() {},
      process: () => ({ pid: 9010 }),
      async waitForTarget(predicate: any) {
        expect(predicate(target)).toBe(true)
        return target
      },
      async installExtension() {
        runtimeInstalls += 1
        throw new Error('runtime extension installation must not be used for source-load mode')
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
      selectExtensionLoadStrategy: () => 'source-load',
      bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge',
      launchBrowser: async options => {
        launches += 1
        expect(options.legacyExtensionLoad).toBe(true)
        return browser
      },
      logger: { info() {}, warn() {} },
      connectTimeoutMs: 200,
      startTimeoutMs: 200,
    })

    await expect(controller.ensureStarted()).resolves.toMatchObject({
      running: true,
      connected: true,
      extensionId,
    })
    expect(launches).toBe(1)
    expect(runtimeInstalls).toBe(0)
    expect(closes).toBe(0)

    await controller.dispose()
    expect(closes).toBe(1)
  })

  it('does not launch a second branded Chrome after runtime extension loading is unsupported', async () => {
    const paths = fixture('dsh-patrol-no-blank-second-chrome-')
    const bridge: any = { connected: false }
    let launches = 0
    let closes = 0
    const browser: any = {
      connected: true,
      on() {},
      process: () => ({ pid: 9020 }),
      async extensions() { return new Map() },
      async installExtension() {
        throw new Error("Protocol error (Extensions.loadUnpacked): 'Extensions.loadUnpacked' wasn't found")
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
      selectExtensionLoadStrategy: () => 'runtime-only',
      bridgeUrlHint: () => 'ws://127.0.0.1:3080/patrol-browser-bridge',
      launchBrowser: async () => {
        launches += 1
        return browser
      },
      logger: { info() {}, warn() {} },
      connectTimeoutMs: 100,
      startTimeoutMs: 100,
    })

    await expect(controller.ensureStarted()).rejects.toThrow(/Modern Chrome branded builds no longer support --load-extension/i)
    expect(launches).toBe(1)
    expect(closes).toBe(1)
  })

  it('classifies Edge and Chromium for direct source loading and branded Chrome for runtime-only loading', () => {
    expect(patrolExtensionLoadStrategy('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe')).toBe('source-load')
    expect(patrolExtensionLoadStrategy('C:\\Users\\u\\AppData\\Local\\Chromium\\Application\\chromium.exe')).toBe('source-load')
    expect(patrolExtensionLoadStrategy('C:\\Users\\u\\.cache\\puppeteer\\chrome\\win64-152\\chrome-win64\\chrome.exe')).toBe('source-load')
    expect(patrolExtensionLoadStrategy('C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe')).toBe('runtime-only')
    expect(patrolExtensionLoadStrategy('/usr/bin/google-chrome-stable')).toBe('runtime-only')
  })

  it('prefers an installed Edge executable on Windows before falling back to branded Chrome discovery', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-browser-pref-'))
    cleanup.push(root)
    const programFiles = join(root, 'Program Files')
    const edge = join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    mkdirSync(dirname(edge), { recursive: true })
    writeFileSync(edge, '')

    expect(resolvePreferredPatrolBrowserExecutable(undefined, {
      PROGRAMFILES: programFiles,
      'PROGRAMFILES(X86)': join(root, 'Program Files (x86)'),
      LOCALAPPDATA: join(root, 'LocalAppData'),
      PATH: '',
    }, 'win32')).toBe(edge)
  })
})
