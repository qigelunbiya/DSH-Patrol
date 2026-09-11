import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  createManagedBrowserController as createBaseManagedBrowserController,
  defaultProfilePath,
} from './managed-browser.js'
import { defaultPatrolLaunchBrowser } from './background-browser-launch.js'
import { installPrivateCertificateErrorHandler } from './private-cert.js'

export { defaultProfilePath }

export function createManagedBrowserController(options = {}) {
  const logger = options.logger ?? console
  const launchBrowser = options.launchBrowser ?? defaultPatrolLaunchBrowser

  return createBaseManagedBrowserController({
    ...options,
    launchBrowser: async launchOptions => {
      // Puppeteer may keep Browser.connected=true for a short interval while
      // Chromium is already shutting down. If an extension/CDP call then throws
      // "Browser is closing", the base controller would otherwise keep reusing
      // that same dying handle on every recovery attempt. Wrap the handle so
      // browser-level closing errors immediately make connected=false; the next
      // bounded recovery can launch a fresh Chromium instead of looping forever.
      const browser = createClosingAwareBrowser(await launchBrowser(launchOptions), logger)
      try {
        // A persistent Chromium profile can retain an older runtime-installed
        // unpacked extension even when the checkout at extensionPath has newer
        // JavaScript. Manifest-version comparisons are insufficient because a
        // source-only update can keep the same version and runtime installs may
        // report a profile-internal path. On every fresh runtime-extension launch,
        // replace only the Patrol extension with the current checkout. Site
        // cookies/profile state are preserved; configureRuntimeExtension() in the
        // base controller immediately re-applies the bridge URL afterwards.
        if (launchOptions.legacyExtensionLoad !== true) {
          await refreshBundledExtensionInstall(browser, launchOptions.extensionPath, logger)
        }
      } catch (error) {
        logger.warn?.(`[dsh-patrol/managed-browser] managed extension source refresh failed; base provisioning will continue: ${errorMessage(error)}`)
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

export function createClosingAwareBrowser(browser, logger = console) {
  if (!browser || typeof browser !== 'object') return browser
  let staleClosing = false
  let warned = false

  const markIfClosing = error => {
    if (!isBrowserClosingError(error)) return
    staleClosing = true
    if (!warned) {
      warned = true
      logger.warn?.('[dsh-patrol/managed-browser] Chromium reported that the browser is closing; marking this Puppeteer handle stale so the next recovery relaunches instead of reusing it')
    }
  }

  return new Proxy(browser, {
    get(target, property) {
      if (property === 'connected') {
        return staleClosing ? false : target.connected
      }
      const value = Reflect.get(target, property, target)
      if (typeof value !== 'function') return value
      return (...args) => {
        try {
          const result = value.apply(target, args)
          if (result && typeof result.then === 'function') {
            return Promise.resolve(result).catch(error => {
              markIfClosing(error)
              throw error
            })
          }
          return result
        } catch (error) {
          markIfClosing(error)
          throw error
        }
      }
    },
  })
}

export function isBrowserClosingError(error) {
  const message = errorMessage(error)
  return /browser\s+(?:is|was)\s+closing|browser\s+has\s+disconnected|browser\s+(?:is|was)\s+closed|connection\s+closed.*browser|protocol error[^\n]*browser[^\n]*closing/i.test(message)
}

export async function refreshBundledExtensionInstall(browser, extensionPath, logger = console) {
  if (!extensionPath
    || typeof browser?.extensions !== 'function'
    || typeof browser?.uninstallExtension !== 'function'
    || typeof browser?.installExtension !== 'function') return false

  const expected = bundledManifestInfo(extensionPath)
  if (expected === undefined) return false

  let extensions
  try {
    extensions = await browser.extensions()
  } catch {
    // Chromium builds without the runtime extension API are handled by the
    // base controller's legacy --load-extension fallback. Closing-aware browser
    // wrappers also mark the handle stale before this soft compatibility return.
    return false
  }

  for (const [id, extension] of extensions) {
    let samePath = false
    try {
      samePath = typeof extension?.path === 'string'
        && resolve(extension.path) === resolve(extensionPath)
    } catch {}
    const sameName = typeof extension?.name === 'string'
      && extension.name === expected.name
    if (!samePath && !sameName) continue

    const liveVersion = typeof extension?.version === 'string' && extension.version
      ? extension.version
      : 'unknown'
    logger.info?.(`[dsh-patrol/managed-browser] reinstalling bundled extension ${id} from current source: live=${liveVersion}; bundled=${expected.version || 'unknown'}`)
    await browser.uninstallExtension(id)
    const installedId = await browser.installExtension(extensionPath)
    logger.info?.(`[dsh-patrol/managed-browser] bundled extension reinstalled from current source as ${installedId}`)
    return true
  }
  return false
}

function bundledManifestInfo(extensionPath) {
  try {
    const parsed = JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8'))
    const name = typeof parsed?.name === 'string' && parsed.name ? parsed.name : undefined
    if (name === undefined) return undefined
    const version = typeof parsed?.version === 'string' && parsed.version ? parsed.version : undefined
    return { name, version }
  } catch {
    return undefined
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
