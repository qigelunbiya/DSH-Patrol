import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  createManagedBrowserController as createBaseManagedBrowserController,
  defaultLaunchBrowser,
  defaultProfilePath,
} from './managed-browser.js'
import { installPrivateCertificateErrorHandler } from './private-cert.js'

export { defaultProfilePath }

export function createManagedBrowserController(options = {}) {
  const logger = options.logger ?? console
  const launchBrowser = options.launchBrowser ?? defaultLaunchBrowser

  return createBaseManagedBrowserController({
    ...options,
    launchBrowser: async launchOptions => {
      const browser = await launchBrowser(launchOptions)
      try {
        // Chromium can keep an already-installed unpacked extension service
        // worker alive across source updates. The host code may therefore know
        // a new command (for example captureImageCode) while the connected
        // worker still answers "unsupported browser command". Compare the live
        // worker manifest revision with the bundled manifest and reload only
        // that managed extension when they differ. This preserves the Patrol
        // browser profile/cookies instead of deleting the whole profile.
        await refreshBundledExtensionRevision(
          browser,
          launchOptions.extensionPath,
          logger,
          launchOptions.startTimeoutMs,
        )
      } catch (error) {
        logger.warn?.(`[dsh-patrol/managed-browser] managed extension revision check failed; base provisioning will continue: ${errorMessage(error)}`)
      }

      try {
        const installed = await installPrivateCertificateErrorHandler(browser, logger)
        if (!installed) {
          logger.warn?.('[dsh-patrol/managed-browser] browser-level certificate handler is unavailable; retaining DOM interstitial fallback')
        }
      } catch (error) {
        logger.warn?.(`[dsh-patrol/managed-browser] browser-level certificate handler setup failed; retaining DOM interstitial fallback: ${errorMessage(error)}`)
      }
      return browser
    },
  })
}

async function refreshBundledExtensionRevision(browser, extensionPath, logger, timeoutMs = 5000) {
  if (!extensionPath || typeof browser?.extensions !== 'function') return false
  const expectedVersion = bundledManifestVersion(extensionPath)
  if (!expectedVersion) return false

  let extensions
  try {
    extensions = await browser.extensions()
  } catch {
    // Chromium builds without the runtime extension API are handled by the
    // base controller's legacy --load-extension fallback.
    return false
  }

  for (const [id, extension] of extensions) {
    let samePath = false
    try {
      samePath = typeof extension?.path === 'string'
        && resolve(extension.path) === resolve(extensionPath)
    } catch {}
    if (!samePath || typeof extension?.workers !== 'function') continue

    const workers = await extension.workers()
    const worker = workers?.[0]
    if (!worker) return false

    const liveVersion = await workerManifestVersion(worker)
    if (liveVersion === expectedVersion) return false

    logger.info?.(`[dsh-patrol/managed-browser] refreshing bundled extension ${id}: live=${liveVersion || 'unknown'}, bundled=${expectedVersion}`)
    try {
      await worker.evaluate(() => {
        chrome.runtime.reload()
      })
    } catch {
      // MV3 normally destroys the worker execution context as part of reload;
      // that rejection is expected. Verify the replacement worker below.
    }

    const deadline = Date.now() + Math.max(1000, Number(timeoutMs) || 5000)
    while (Date.now() < deadline) {
      await delay(100)
      try {
        const latestExtensions = await browser.extensions()
        const latest = latestExtensions.get(id) ?? extension
        const latestWorkers = typeof latest?.workers === 'function' ? await latest.workers() : []
        for (const candidate of latestWorkers ?? []) {
          const version = await workerManifestVersion(candidate)
          if (version === expectedVersion) {
            logger.info?.(`[dsh-patrol/managed-browser] bundled extension ${id} refreshed to ${expectedVersion}`)
            return true
          }
        }
      } catch {
        // Service worker is between old/new instances; keep the bounded poll.
      }
    }

    logger.warn?.(`[dsh-patrol/managed-browser] extension reload was requested but ${expectedVersion} was not observable before timeout; normal provisioning will perform its own worker readiness check`)
    return false
  }
  return false
}

function bundledManifestVersion(extensionPath) {
  try {
    const parsed = JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8'))
    return typeof parsed?.version === 'string' && parsed.version ? parsed.version : undefined
  } catch {
    return undefined
  }
}

async function workerManifestVersion(worker) {
  try {
    const value = await worker.evaluate(() => chrome.runtime.getManifest().version)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

function delay(ms) {
  return new Promise(resolveDelay => setTimeout(resolveDelay, ms))
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
