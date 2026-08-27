import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import puppeteer from 'puppeteer-core'

const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000
const EXTENSION_DIR = fileURLToPath(new URL('../browser-extension/', import.meta.url))

export function createManagedBrowserController(options = {}) {
  const logger = options.logger ?? console
  const bridge = options.bridge
  if (!bridge) throw new Error('managed Patrol browser requires a BrowserBridge instance')

  const profilePath = resolve(options.profilePath ?? defaultProfilePath())
  const extensionPath = resolve(options.extensionPath ?? EXTENSION_DIR)
  const statePath = resolve(options.statePath ?? defaultStatePath())
  const startTimeoutMs = positiveInt(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS)
  const connectTimeoutMs = positiveInt(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)
  const launchBrowser = options.launchBrowser ?? defaultLaunchBrowser
  const executable = options.browserExecutable

  let browser
  let starting
  let disposed = false
  let lastError
  let lastExecutable
  let extensionId

  const controller = {
    get status() {
      return {
        running: browser !== undefined && browser.connected !== false,
        starting: starting !== undefined,
        connected: bridge.connected === true,
        profilePath,
        extensionPath,
        executable: lastExecutable,
        extensionId,
        error: lastError,
      }
    },

    async ensureStarted() {
      if (disposed) throw new Error('managed Patrol browser is disposed')
      if (bridge.connected === true && browser !== undefined && browser.connected !== false) {
        return this.status
      }
      if (starting !== undefined) return await starting
      starting = startOrRepair().finally(() => { starting = undefined })
      return await starting
    },

    async dispose() {
      disposed = true
      const active = browser
      browser = undefined
      try {
        if (active !== undefined && active.connected !== false) await active.close()
      } catch (error) {
        logger.warn?.(`[dsh-patrol/managed-browser] browser close failed: ${errorMessage(error)}`)
      }
      removeStateFile(statePath)
    },
  }

  return controller

  async function startOrRepair() {
    try {
      if (browser !== undefined && browser.connected !== false) {
        await configureExtension(browser)
        await waitForBridge(bridge, connectTimeoutMs)
        lastError = undefined
        return controller.status
      }

      mkdirSync(profilePath, { recursive: true, mode: 0o700 })
      if (!existsSync(extensionPath)) throw new Error(`Patrol browser extension directory is missing: ${extensionPath}`)
      lastExecutable = resolveBrowserExecutable(executable)
      logger.info?.(`[dsh-patrol/managed-browser] launching ${lastExecutable} with isolated profile ${profilePath}`)

      browser = await launchBrowser({
        executablePath: lastExecutable,
        profilePath,
        extensionPath,
        startTimeoutMs,
      })
      browser.on?.('disconnected', () => {
        browser = undefined
        removeStateFile(statePath)
      })

      extensionId = await configureExtension(browser)
      writeStateFile(statePath, {
        pid: browser.process?.()?.pid,
        executable: lastExecutable,
        profilePath,
        extensionPath,
        extensionId,
      })
      await waitForBridge(bridge, connectTimeoutMs)
      lastError = undefined
      logger.info?.(`[dsh-patrol/managed-browser] ready; extension=${extensionId}`)
      return controller.status
    } catch (error) {
      lastError = errorMessage(error)
      logger.warn?.(`[dsh-patrol/managed-browser] automatic browser setup failed: ${lastError}`)
      throw error
    }
  }

  async function configureExtension(activeBrowser) {
    const id = await activeBrowser.installExtension(extensionPath)
    extensionId = id
    options.onExtensionReady?.(id)
    const bridgeUrl = String(options.bridgeUrlHint?.() ?? '')
    if (bridgeUrl.length === 0) throw new Error('Patrol browser bridge URL is not ready')

    const extension = (await activeBrowser.extensions()).get(id)
    if (!extension) throw new Error(`Patrol extension ${id} was installed but is not visible to the browser`)
    const worker = await waitForExtensionWorker(activeBrowser, extension, id, startTimeoutMs)
    await worker.evaluate(async (url) => {
      await chrome.storage.local.set({ bridgeUrl: url, autoConnect: true })
      try { await chrome.runtime.sendMessage({ type: 'bridge:connect' }) } catch {}
    }, bridgeUrl)
    return id
  }
}

export async function defaultLaunchBrowser({ executablePath, profilePath, startTimeoutMs }) {
  return await puppeteer.launch({
    browser: 'chrome',
    executablePath,
    pipe: true,
    headless: false,
    userDataDir: profilePath,
    enableExtensions: true,
    defaultViewport: null,
    handleSIGINT: false,
    handleSIGTERM: false,
    handleSIGHUP: false,
    timeout: startTimeoutMs,
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized',
    ],
  })
}

export function resolveBrowserExecutable(explicit) {
  const requested = explicit || process.env.DSH_PATROL_BROWSER
  if (requested) {
    const absolute = resolve(requested)
    if (!existsSync(absolute)) throw new Error(`configured Patrol browser executable does not exist: ${absolute}`)
    return absolute
  }

  for (const candidate of browserCandidates()) {
    if (candidate && existsSync(candidate)) return candidate
  }

  for (const command of process.platform === 'win32'
    ? ['chrome.exe', 'msedge.exe', 'chromium.exe']
    : ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']) {
    const found = findOnPath(command)
    if (found !== undefined) return found
  }

  // puppeteer-core intentionally does not provision a browser. Keep discovery
  // synchronous and explicit instead of falling back to Puppeteer's v25 async
  // executablePath() API, which may point at a non-existent download cache.
  throw new Error('No supported Chromium browser was found. Install Google Chrome, Microsoft Edge, Chromium, or configure DSH_PATROL_BROWSER.')
}

export function defaultProfilePath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'patrol', 'browser-profile')
}

export function defaultStatePath() {
  return join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'patrol', 'managed-browser.json')
}

function browserCandidates() {
  if (process.platform === 'win32') {
    const roots = [process.env.LOCALAPPDATA, process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)']].filter(Boolean)
    // Prefer Chrome across all install roots before Edge. Puppeteer guarantees
    // Chrome compatibility; Edge remains a useful Chromium fallback on Windows.
    return [
      ...roots.map(root => join(root, 'Google', 'Chrome', 'Application', 'chrome.exe')),
      ...roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
    ]
  }
  if (process.platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ]
  }
  return [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ]
}

function findOnPath(command) {
  for (const directory of String(process.env.PATH || '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, command)
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

async function waitForExtensionWorker(browser, extension, extensionId, timeoutMs) {
  const existing = await extension.workers()
  if (existing.length > 0) return existing[0]
  const target = await browser.waitForTarget(
    candidate => candidate.type() === 'service_worker' && candidate.url().startsWith(`chrome-extension://${extensionId}/`),
    { timeout: timeoutMs },
  )
  const worker = await target.worker()
  if (!worker) throw new Error(`Patrol extension ${extensionId} has no service worker`)
  return worker
}

async function waitForBridge(bridge, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (bridge.connected === true) return
    await delay(100)
  }
  throw new Error(`Patrol extension did not connect to the local bridge within ${timeoutMs}ms`)
}

function writeStateFile(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
}

function removeStateFile(path) {
  try { rmSync(path, { force: true }) } catch {}
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
