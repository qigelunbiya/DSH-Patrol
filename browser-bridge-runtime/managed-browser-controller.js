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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
