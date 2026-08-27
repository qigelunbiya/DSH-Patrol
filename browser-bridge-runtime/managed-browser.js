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
  let extensionLoadMode

  const controller = {
    get status() {
      return {
        running: browser !== undefined && browser.connected !== false,
        starting: starting !== undefined,
        connected: bridge.connected === true && originMatches(bridge, extensionId),
        profilePath,
        extensionPath,
        executable: lastExecutable,
        extensionId,
        extensionLoadMode,
        error: lastError,
      }
    },

    async ensureStarted() {
      if (disposed) throw new Error('managed Patrol browser is disposed')
      if (bridge.connected === true
        && browser !== undefined
        && browser.connected !== false
        && originMatches(bridge, extensionId)) {
        return this.status
      }
      if (starting !== undefined) return await starting
      starting = startOrRepair().finally(() => { starting = undefined })
      return await starting
    },

    async dispose() {
      disposed = true
      const pending = starting
      if (pending !== undefined) {
        try { await pending } catch {}
      }
      const active = browser
      browser = undefined
      await safeClose(active, logger)
      removeStateFile(statePath)
    },
  }

  return controller

  async function startOrRepair() {
    let active
    let launchedHere = false
    try {
      if (browser !== undefined && browser.connected !== false) {
        extensionId = await configureRuntimeExtension(browser)
        extensionLoadMode = 'runtime'
        await waitForBridge(bridge, connectTimeoutMs, extensionId)
        lastError = undefined
        return controller.status
      }

      mkdirSync(profilePath, { recursive: true, mode: 0o700 })
      if (!existsSync(extensionPath)) throw new Error(`Patrol browser extension directory is missing: ${extensionPath}`)
      lastExecutable = resolveBrowserExecutable(executable)
      logger.info?.(`[dsh-patrol/managed-browser] launching ${lastExecutable} with isolated profile ${profilePath}`)

      active = await launchBrowser({
        executablePath: lastExecutable,
        profilePath,
        extensionPath,
        startTimeoutMs,
        legacyExtensionLoad: false,
      })
      launchedHere = true

      try {
        extensionId = await configureRuntimeExtension(active)
        extensionLoadMode = 'runtime'
      } catch (error) {
        if (!isExtensionApiUnavailable(error)) throw error
        logger.warn?.(`[dsh-patrol/managed-browser] runtime extension API unavailable; retrying with automatic legacy launch loading: ${errorMessage(error)}`)
        await safeClose(active, logger)
        active = undefined
        active = await launchBrowser({
          executablePath: lastExecutable,
          profilePath,
          extensionPath,
          startTimeoutMs,
          legacyExtensionLoad: true,
        })
        extensionId = await configureLegacyExtension(active)
        extensionLoadMode = 'legacy-launch'
      }

      attachBrowser(active)
      browser = active
      writeStateFile(statePath, {
        pid: active.process?.()?.pid,
        executable: lastExecutable,
        profilePath,
        extensionPath,
        extensionId,
        extensionLoadMode,
      })
      await waitForBridge(bridge, connectTimeoutMs, extensionId)
      if (disposed) throw new Error('managed Patrol browser was disposed while provisioning')
      lastError = undefined
      logger.info?.(`[dsh-patrol/managed-browser] ready; extension=${extensionId}; mode=${extensionLoadMode}`)
      return controller.status
    } catch (error) {
      lastError = errorMessage(error)
      logger.warn?.(`[dsh-patrol/managed-browser] automatic browser setup failed: ${lastError}`)
      if (launchedHere && active !== undefined) {
        if (browser === active) browser = undefined
        await safeClose(active, logger)
      }
      removeStateFile(statePath)
      throw error
    }
  }

  function attachBrowser(active) {
    active.on?.('disconnected', () => {
      if (browser !== active) return
      browser = undefined
      removeStateFile(statePath)
    })
  }

  async function configureRuntimeExtension(activeBrowser) {
    const existing = await findInstalledExtension(activeBrowser, extensionPath)
    const id = existing?.id ?? await activeBrowser.installExtension(extensionPath)
    extensionId = id
    options.onExtensionReady?.(id)
    const extension = existing?.extension ?? (await activeBrowser.extensions()).get(id)
    const worker = await waitForExtensionWorker(activeBrowser, extension, id, startTimeoutMs)
    await configureWorker(worker)
    return id
  }

  async function configureLegacyExtension(activeBrowser) {
    const located = await waitForAnyPatrolExtensionWorker(activeBrowser, startTimeoutMs)
    extensionId = located.id
    options.onExtensionReady?.(located.id)
    await configureWorker(located.worker)
    return located.id
  }

  async function configureWorker(worker) {
    const bridgeUrl = String(options.bridgeUrlHint?.() ?? '')
    if (bridgeUrl.length === 0) throw new Error('Patrol browser bridge URL is not ready')
    await worker.evaluate(async (url) => {
      await chrome.storage.local.set({ bridgeUrl: url, autoConnect: true })
      try { await chrome.runtime.sendMessage({ type: 'bridge:connect' }) } catch {}
    }, bridgeUrl)
  }
}

export async function defaultLaunchBrowser({ executablePath, profilePath, extensionPath, startTimeoutMs, legacyExtensionLoad = false }) {
  const args = [
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
  ]
  if (legacyExtensionLoad) {
    args.push(`--disable-extensions-except=${extensionPath}`)
    args.push(`--load-extension=${extensionPath}`)
  }

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
    args,
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
  // synchronous and explicit instead of falling back to Puppeteer's async
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

async function findInstalledExtension(browser, extensionPath) {
  const extensions = await browser.extensions()
  for (const [id, extension] of extensions) {
    try {
      if (extension?.path && resolve(extension.path) === extensionPath) return { id, extension }
    } catch {}
  }
  return undefined
}

async function waitForExtensionWorker(browser, extension, extensionId, timeoutMs) {
  if (extension?.workers) {
    const existing = await extension.workers()
    if (existing.length > 0) return existing[0]
  }
  const target = await browser.waitForTarget(
    candidate => candidate.type() === 'service_worker' && candidate.url().startsWith(`chrome-extension://${extensionId}/`),
    { timeout: timeoutMs },
  )
  const worker = await target.worker()
  if (!worker) throw new Error(`Patrol extension ${extensionId} has no service worker`)
  return worker
}

async function waitForAnyPatrolExtensionWorker(browser, timeoutMs) {
  const target = await browser.waitForTarget(
    candidate => candidate.type() === 'service_worker' && /^chrome-extension:\/\/[a-p]{32}\//.test(candidate.url()),
    { timeout: timeoutMs },
  )
  const match = /^chrome-extension:\/\/([a-p]{32})\//.exec(target.url())
  const worker = await target.worker()
  if (!match?.[1] || !worker) throw new Error('Patrol legacy-loaded extension did not expose a valid service worker')
  return { id: match[1], worker }
}

async function waitForBridge(bridge, timeoutMs, extensionId) {
  const expectedOrigin = extensionId ? `chrome-extension://${extensionId}` : undefined
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (bridge.connected === true && originMatches(bridge, extensionId)) return
    await delay(100)
  }
  const status = typeof bridge.status === 'function' ? bridge.status() : undefined
  const actualOrigin = status?.origin ?? bridge.origin
  throw new Error(`Patrol extension did not connect to the local bridge within ${timeoutMs}ms${expectedOrigin ? ` (expected ${expectedOrigin}, got ${actualOrigin || 'no extension connection'})` : ''}`)
}

function originMatches(bridge, extensionId) {
  if (!extensionId) return bridge.connected === true
  const expected = `chrome-extension://${extensionId}`
  const status = typeof bridge.status === 'function' ? bridge.status() : undefined
  if (status !== undefined && Object.prototype.hasOwnProperty.call(status, 'origin')) {
    return status.origin === expected
  }
  if (Object.prototype.hasOwnProperty.call(bridge, 'origin') || 'origin' in bridge) {
    return bridge.origin === expected
  }
  // Lightweight test doubles and older bridge implementations have no origin
  // field at all. The real BrowserBridge always exposes it and is therefore
  // checked strictly above.
  return bridge.connected === true
}

async function safeClose(browser, logger) {
  try {
    if (browser !== undefined && browser.connected !== false) await browser.close()
  } catch (error) {
    logger.warn?.(`[dsh-patrol/managed-browser] browser close failed during repair: ${errorMessage(error)}`)
  }
}

function isExtensionApiUnavailable(error) {
  const message = errorMessage(error)
  return /Extensions\.loadUnpacked|Method not available|method.*not found|wasn't found|method.*unsupported/i.test(message)
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
