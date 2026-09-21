import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  defaultProfilePath,
  defaultStatePath,
  resolveBrowserExecutable,
  tryProceedPrivateCertificateInterstitial,
} from './managed-browser.js'
import { defaultPatrolLaunchBrowser } from './background-browser-launch.js'
import { createClosingAwareBrowser } from './managed-browser-controller.js'
import { installPrivateCertificateErrorHandler } from './private-cert.js'

const PATROL_EXTENSION_NAME = 'DSH Patrol Browser Bridge'
const EXTENSION_DIR = fileURLToPath(new URL('../browser-extension/', import.meta.url))
const DEFAULT_START_TIMEOUT_MS = 30_000
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000

export { defaultProfilePath }

/**
 * Stable single-process managed browser controller.
 *
 * Invariants:
 * - once a visible Chromium process is launched, provisioning/recovery never
 *   closes or replaces it;
 * - runtime extension install/worker/bridge failures keep the same browser and
 *   profile alive so diagnostics and a bounded retry can reuse CURRENT tabs;
 * - browser.close() is reserved for explicit host disposal. If Chromium itself
 *   exits, a later ensureStarted() may launch a replacement.
 */
export function createManagedBrowserController(options = {}) {
  const logger = options.logger ?? console
  const bridge = options.bridge
  if (!bridge) throw new Error('managed Patrol browser requires a BrowserBridge instance')

  const profilePath = resolve(options.profilePath ?? defaultProfilePath())
  const statePath = resolve(options.statePath ?? defaultStatePath())
  const extensionPath = resolve(options.extensionPath ?? EXTENSION_DIR)
  const startTimeoutMs = positiveInt(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS)
  const connectTimeoutMs = positiveInt(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS)
  const launchBrowser = options.launchBrowser ?? defaultPatrolLaunchBrowser

  let browser
  let starting
  let disposed = false
  let lastError
  let lastExecutable
  let browserVersion
  let extensionId
  let extensionLoadMode = 'runtime'
  let attachedBrowser
  const watchedPages = new WeakSet()
  const pendingCertificatePages = new WeakSet()

  const controller = {
    get status() {
      return {
        running: browser !== undefined && browser.connected !== false,
        starting: starting !== undefined,
        connected: ready(),
        profilePath,
        extensionPath,
        executable: lastExecutable,
        browserVersion,
        extensionId,
        extensionLoadMode,
        lifecycle: 'single-process',
        error: lastError,
      }
    },

    async ensureStarted() {
      if (disposed) throw new Error('managed Patrol browser is disposed')
      if (ready()) return this.status
      if (starting !== undefined) return await starting
      starting = provisionOrRepair().finally(() => { starting = undefined })
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
      removeStateFile(statePath)
      if (active !== undefined && active.connected !== false) {
        try { await active.close() } catch (error) {
          logger.warn?.(`[dsh-patrol/managed-browser] browser close failed during explicit shutdown: ${errorMessage(error)}`)
        }
      }
    },
  }

  return controller

  async function provisionOrRepair() {
    let launchedNow = false
    try {
      if (browser === undefined || browser.connected === false) {
        mkdirSync(profilePath, { recursive: true, mode: 0o700 })
        if (!existsSync(extensionPath)) {
          throw new Error(`Patrol browser extension directory is missing: ${extensionPath}`)
        }

        lastExecutable = resolveBrowserExecutable(options.browserExecutable)
        logger.info?.(`[dsh-patrol/managed-browser] launching one persistent browser process: ${lastExecutable}`)
        browser = createClosingAwareBrowser(await launchBrowser({
          executablePath: lastExecutable,
          profilePath,
          extensionPath,
          startTimeoutMs,
          legacyExtensionLoad: false,
        }), logger)
        launchedNow = true
        attachBrowser(browser)
        try { browserVersion = await browser.version?.() } catch { browserVersion = undefined }
        writeCurrentState()

        try {
          const installed = await installPrivateCertificateErrorHandler(browser, logger)
          if (!installed) {
            logger.warn?.('[dsh-patrol/managed-browser] browser-level certificate handler unavailable; retaining DOM fallback')
          }
        } catch (error) {
          logger.warn?.(`[dsh-patrol/managed-browser] certificate handler setup failed; retaining DOM fallback: ${errorMessage(error)}`)
        }
      }

      extensionId = await ensureRuntimeExtension(browser)
      options.onExtensionReady?.(extensionId)
      const worker = await waitForExtensionWorker(browser, extensionId, startTimeoutMs)
      await configureWorker(worker)
      await waitForBridge(bridge, connectTimeoutMs, extensionId)

      if (missingRequiredCapability() || missingRecommendedCapability()) {
        const requiredBeforeRefresh = missingRequiredCapability()
        logger.warn?.(
          requiredBeforeRefresh
            ? '[dsh-patrol/managed-browser] connected extension is stale; attempting one in-place extension refresh without closing Chromium'
            : '[dsh-patrol/managed-browser] visual-click extension layer is stale; attempting a best-effort in-place refresh without closing Chromium',
        )
        try {
          extensionId = await refreshRuntimeExtensionInPlace(browser, extensionId)
          options.onExtensionReady?.(extensionId)
          const refreshedWorker = await waitForExtensionWorker(browser, extensionId, startTimeoutMs)
          await configureWorker(refreshedWorker)
          await waitForBridge(bridge, connectTimeoutMs, extensionId)
        } catch (error) {
          if (requiredBeforeRefresh) throw error
          logger.warn?.(`[dsh-patrol/managed-browser] optional trusted visual-click refresh failed; basic DOM patrol remains available: ${errorMessage(error)}`)
        }
        if (missingRequiredCapability()) {
          throw new Error('Patrol extension connected but is still missing required visual calibration capabilities after in-place refresh')
        }
      }

      lastError = undefined
      writeCurrentState()
      logger.info?.(`[dsh-patrol/managed-browser] ready; pid=${browser?.process?.()?.pid ?? 'unknown'}; extension=${extensionId}; mode=runtime; browser kept persistent`)
      return controller.status
    } catch (error) {
      lastError = explainProvisioningFailure(error)
      writeCurrentState()
      if (browser !== undefined && browser.connected !== false) {
        logger.warn?.(`[dsh-patrol/managed-browser] provisioning failed but the browser stays open for in-place recovery: ${lastError}`)
      } else if (launchedNow) {
        logger.warn?.(`[dsh-patrol/managed-browser] browser process exited during provisioning: ${lastError}`)
      }
      throw new Error(lastError)
    }
  }

  function ready() {
    return browser !== undefined
      && browser.connected !== false
      && bridge.connected === true
      && originMatches(bridge, extensionId)
      && extensionHelloReceived(bridge)
      && !missingRequiredCapability()
  }

  async function ensureRuntimeExtension(activeBrowser) {
    let extensions
    try {
      extensions = await activeBrowser.extensions()
    } catch (error) {
      throw extensionApiError(error)
    }

    for (const [id, extension] of extensions) {
      let samePath = false
      try {
        samePath = typeof extension?.path === 'string'
          && resolve(extension.path) === extensionPath
      } catch {}
      const sameName = extension?.name === PATROL_EXTENSION_NAME
      if (samePath || sameName) return id
    }

    try {
      return await activeBrowser.installExtension(extensionPath)
    } catch (error) {
      throw extensionApiError(error)
    }
  }

  async function refreshRuntimeExtensionInPlace(activeBrowser, currentId) {
    if (typeof activeBrowser.uninstallExtension !== 'function' || typeof activeBrowser.installExtension !== 'function') {
      throw new Error('Patrol extension is stale and this Chromium build does not expose runtime extension refresh APIs')
    }
    try {
      if (currentId) await activeBrowser.uninstallExtension(currentId)
      return await activeBrowser.installExtension(extensionPath)
    } catch (error) {
      throw extensionApiError(error)
    }
  }

  async function configureWorker(worker) {
    const bridgeUrl = String(options.bridgeUrlHint?.() ?? '')
    if (bridgeUrl.length === 0) throw new Error('Patrol browser bridge URL is not ready')
    await worker.evaluate(async url => {
      await chrome.storage.local.set({ bridgeUrl: url, autoConnect: true })
      try { await chrome.runtime.sendMessage({ type: 'bridge:connect' }) } catch {}
    }, bridgeUrl)
  }

  function attachBrowser(active) {
    if (attachedBrowser === active) return
    attachedBrowser = active
    active.on?.('disconnected', () => {
      if (browser !== active) return
      browser = undefined
      attachedBrowser = undefined
      removeStateFile(statePath)
      logger.warn?.('[dsh-patrol/managed-browser] managed browser process disconnected; the next Patrol action may launch a replacement')
    })

    const checkPage = page => {
      if (!page || pendingCertificatePages.has(page)) return
      pendingCertificatePages.add(page)
      void tryProceedPrivateCertificateInterstitial(page, logger)
        .catch(error => logger.warn?.(`[dsh-patrol/managed-browser] private certificate interstitial handling failed: ${errorMessage(error)}`))
        .finally(() => pendingCertificatePages.delete(page))
    }

    const watchPage = page => {
      if (!page) return
      if (!watchedPages.has(page)) {
        watchedPages.add(page)
        page.on?.('domcontentloaded', () => checkPage(page))
        page.on?.('load', () => checkPage(page))
        page.on?.('framenavigated', frame => {
          const mainFrame = page.mainFrame?.()
          if (mainFrame === undefined || frame === mainFrame) checkPage(page)
        })
      }
      checkPage(page)
    }

    const observeTarget = target => {
      try {
        if (target?.type?.() !== 'page') return
        void Promise.resolve(target.page?.()).then(watchPage).catch(() => {})
      } catch {}
    }
    active.on?.('targetcreated', observeTarget)
    active.on?.('targetchanged', observeTarget)
    void Promise.resolve(active.pages?.()).then(pages => {
      if (Array.isArray(pages)) for (const page of pages) watchPage(page)
    }).catch(() => {})
  }

  function missingRequiredCapability() {
    const extension = bridge.status?.()?.extension
    const capabilities = extension?.capabilities
    return Array.isArray(capabilities)
      && (
        !capabilities.includes('semanticClick')
        || !capabilities.includes('boundedVisualCaptureV2')
        || !capabilities.includes('reusableVisualFramesV1')
        || !capabilities.includes('visualCoordinateGuideV1')
        || !capabilities.includes('visualPointerProbeV1')
      )
  }

  function missingRecommendedCapability() {
    const extension = bridge.status?.()?.extension
    const capabilities = extension?.capabilities
    return Array.isArray(capabilities)
      && (
        (capabilities.includes('visualClick') && !capabilities.includes('trustedVisualClick'))
        || !capabilities.includes('trustedFocusedType')
        || !capabilities.includes('trustedSemanticClick')
        || !capabilities.includes('clickOpenedTabAdoption')
        || !capabilities.includes('compactVisualCapture')
      )
  }

  function writeCurrentState() {
    if (browser === undefined || browser.connected === false) return
    writeStateFile(statePath, {
      pid: browser.process?.()?.pid,
      executable: lastExecutable,
      browserVersion,
      profilePath,
      extensionPath,
      extensionId,
      extensionLoadMode,
      lifecycle: 'single-process',
      ...(lastError === undefined ? {} : { error: lastError }),
    })
  }
}

async function waitForExtensionWorker(browser, extensionId, timeoutMs) {
  const extensions = await browser.extensions()
  const extension = extensions.get(extensionId)
  if (extension?.workers) {
    const workers = await extension.workers()
    if (workers.length > 0) return workers[0]
  }
  const target = await browser.waitForTarget(
    candidate => candidate.type() === 'service_worker'
      && candidate.url().startsWith(`chrome-extension://${extensionId}/`),
    { timeout: timeoutMs },
  )
  const worker = await target.worker()
  if (!worker) throw new Error(`Patrol extension ${extensionId} has no service worker`)
  return worker
}

async function waitForBridge(bridge, timeoutMs, extensionId) {
  const expectedOrigin = extensionId ? `chrome-extension://${extensionId}` : undefined
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (bridge.connected === true && originMatches(bridge, extensionId) && extensionHelloReceived(bridge)) return
    await delay(100)
  }
  const status = typeof bridge.status === 'function' ? bridge.status() : undefined
  const actualOrigin = status?.origin ?? bridge.origin
  throw new Error(`Patrol extension did not connect to the local bridge within ${timeoutMs}ms${expectedOrigin ? ` (expected ${expectedOrigin}, got ${actualOrigin || 'no extension connection'})` : ''}`)
}

function extensionHelloReceived(bridge) {
  if (typeof bridge?.status !== 'function') return true
  const status = bridge.status()
  if (!status || !Object.prototype.hasOwnProperty.call(status, 'extension')) return true
  return status.extension !== null && typeof status.extension === 'object'
}

function originMatches(bridge, extensionId) {
  if (!extensionId) return bridge.connected === true
  const expected = `chrome-extension://${extensionId}`
  const status = typeof bridge.status === 'function' ? bridge.status() : undefined
  if (status !== undefined && Object.prototype.hasOwnProperty.call(status, 'origin')) return status.origin === expected
  if (Object.prototype.hasOwnProperty.call(bridge, 'origin') || 'origin' in bridge) return bridge.origin === expected
  return bridge.connected === true
}

function extensionApiError(error) {
  const message = errorMessage(error)
  if (/Extensions\.loadUnpacked|Method not available|method.*not found|wasn't found|method.*unsupported/i.test(message)) {
    return new Error([
      'Patrol could not install its MV3 extension through Chromium runtime APIs.',
      'The existing browser was deliberately kept open; Patrol did not close or replace it.',
      'This Chrome build may not expose Extensions.loadUnpacked to Puppeteer despite CDP pipe mode.',
      'Use Chrome for Testing or Chromium via DSH_PATROL_BROWSER if this persists.',
      `Original error: ${message}`,
    ].join(' '))
  }
  return error instanceof Error ? error : new Error(message)
}

function explainProvisioningFailure(error) {
  const message = errorMessage(error)
  if (/Patrol could not install its MV3 extension/i.test(message)) return message
  if (/Timed out|waiting for target|service worker/i.test(message)) {
    return `${message} The browser process was kept open; extension/service-worker startup can be retried in place.`
  }
  return message
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}
