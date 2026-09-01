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
    // base controller's legacy --load-extension fallback.
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
