import { existsSync, readFileSync } from 'node:fs'
import { delimiter, join, resolve } from 'node:path'
import {
  createManagedBrowserController as createBaseManagedBrowserController,
  defaultProfilePath,
} from './managed-browser.js'
import { defaultPatrolLaunchBrowser } from './background-browser-launch.js'
import { installPrivateCertificateErrorHandler } from './private-cert.js'

const PATROL_EXTENSION_NAME = 'DSH Patrol Browser Bridge'
const PATROL_WORKER_RE = /^chrome-extension:\/\/([a-p]{32})\/background-entry\.js(?:[?#].*)?$/i
const SOURCE_EXTENSION_WAIT_MS = 6_000

export { defaultProfilePath }

export function createManagedBrowserController(options = {}) {
  const logger = options.logger ?? console
  const launchBrowser = options.launchBrowser ?? defaultPatrolLaunchBrowser
  const browserExecutable = resolvePreferredPatrolBrowserExecutable(options.browserExecutable)
  const selectExtensionLoadStrategy = options.selectExtensionLoadStrategy ?? patrolExtensionLoadStrategy

  return createBaseManagedBrowserController({
    ...options,
    ...(browserExecutable === undefined ? {} : { browserExecutable }),
    launchBrowser: async launchOptions => {
      const strategy = selectExtensionLoadStrategy(launchOptions.executablePath)
      const legacyRequestedByBase = launchOptions.legacyExtensionLoad === true

      // Google Chrome branded builds removed --load-extension. The old base
      // fallback used to close the first browser and immediately launch a second
      // Chrome with a flag that modern Chrome ignores. That is exactly the
      // open-close-open/blank-window failure users observed. Never launch that
      // known-bad second browser. Auto discovery prefers Edge/Chromium first,
      // where command-line unpacked extensions remain supported.
      if (legacyRequestedByBase && strategy === 'runtime-only') {
        throw new Error([
          `Patrol cannot source-load its extension into this Google Chrome build: ${launchOptions.executablePath}.`,
          'Modern Chrome branded builds no longer support --load-extension.',
          'Use Microsoft Edge, Chromium, or Chrome for Testing, or set DSH_PATROL_BROWSER to one of those executables.',
        ].join(' '))
      }

      const sourceLoad = legacyRequestedByBase || strategy === 'source-load'
      const actualLaunchOptions = sourceLoad
        ? { ...launchOptions, legacyExtensionLoad: true }
        : launchOptions

      // Puppeteer may keep Browser.connected=true for a short interval while
      // Chromium is already shutting down. Closing-aware wrapping prevents a
      // later recovery from reusing that dying handle.
      let browser = createClosingAwareBrowser(await launchBrowser(actualLaunchOptions), logger)

      try {
        if (sourceLoad) {
          // The base controller still speaks in terms of runtime-installed
          // extensions. Present the source-loaded worker as a small Extension
          // facade so configureRuntimeExtension() can configure the real worker
          // without calling Extensions.loadUnpacked and without a second launch.
          browser = await createSourceLoadedExtensionFacade(
            browser,
            actualLaunchOptions.extensionPath,
            Math.min(actualLaunchOptions.startTimeoutMs ?? SOURCE_EXTENSION_WAIT_MS, SOURCE_EXTENSION_WAIT_MS),
            logger,
          )
        } else {
          // Runtime-install mode is kept for browser builds that expose the
          // Extensions CDP domain. Refresh the persisted Patrol extension only
          // in this mode; source-load mode already executes the current checkout.
          await refreshBundledExtensionInstall(browser, actualLaunchOptions.extensionPath, logger)
        }
      } catch (error) {
        try { await browser?.close?.() } catch {}
        throw error
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

/**
 * Pick an extension-capable browser before the first visible launch.
 *
 * Chrome 137+ branded builds removed --load-extension, while Edge/Chromium
 * still support command-line unpacked extensions unless an administrator policy
 * explicitly blocks the command_line installation type. Windows ships Edge, so
 * preferring it avoids the old probe-Chrome-then-close-then-relaunch sequence.
 */
export function resolvePreferredPatrolBrowserExecutable(explicit, env = process.env, platform = process.platform) {
  const requested = explicit || env.DSH_PATROL_BROWSER
  if (requested) return requested

  for (const candidate of sourceLoadBrowserCandidates(env, platform)) {
    if (candidate && existsSync(candidate)) return candidate
  }

  for (const command of sourceLoadBrowserCommands(platform)) {
    const found = findOnPath(command, env.PATH)
    if (found !== undefined) return found
  }

  // Let the base controller perform its normal broad browser discovery. If it
  // ends up on branded Chrome, runtime Extensions.loadUnpacked is tried once;
  // a failed runtime API will no longer create a second blank Chrome window.
  return undefined
}

export function patrolExtensionLoadStrategy(executablePath) {
  const normalized = String(executablePath || '').replace(/\\/g, '/').toLowerCase()
  if (!normalized) return 'runtime'

  if (/(^|\/)msedge(?:\.exe)?$/.test(normalized)
    || normalized.includes('/microsoft edge.app/')) return 'source-load'

  if (/(^|\/)chromium(?:\.exe)?$/.test(normalized)
    || normalized.includes('/chromium.app/')) return 'source-load'

  if (normalized.includes('chrome for testing')
    || normalized.includes('chrome-for-testing')
    || /\/chrome-win(?:32|64)?\/chrome\.exe$/.test(normalized)
    || normalized.includes('/.cache/puppeteer/chrome/')) return 'source-load'

  if (/\/google\/chrome\/application\/chrome\.exe$/.test(normalized)
    || normalized.includes('/google chrome.app/')
    || /(^|\/)google-chrome(?:-stable)?$/.test(normalized)) return 'runtime-only'

  return 'runtime'
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

export async function createSourceLoadedExtensionFacade(browser, extensionPath, timeoutMs = SOURCE_EXTENSION_WAIT_MS, logger = console) {
  if (!browser || typeof browser.waitForTarget !== 'function') {
    throw new Error('Patrol source-loaded extension requires Puppeteer waitForTarget support')
  }
  const manifest = bundledManifestInfo(extensionPath)
  if (manifest === undefined) throw new Error(`Patrol extension manifest is unavailable at ${extensionPath}`)

  const located = await locatePatrolWorker(browser, timeoutMs)
  logger.info?.(`[dsh-patrol/managed-browser] source-loaded Patrol extension ready as ${located.id}; using one browser process without runtime reinstall/relaunch`)

  const extension = {
    id: located.id,
    name: manifest.name,
    version: manifest.version ?? 'unknown',
    path: resolve(extensionPath),
    enabled: true,
    async workers() {
      const current = await locatePatrolWorker(browser, Math.min(timeoutMs, 3_000))
      return [current.worker]
    },
    async pages() { return [] },
  }

  return new Proxy(browser, {
    get(target, property) {
      if (property === 'extensions') return async () => new Map([[located.id, extension]])
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
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
    // source-loaded path above. Closing-aware wrappers also mark a dying handle
    // stale before this soft compatibility return.
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

async function locatePatrolWorker(browser, timeoutMs) {
  const target = await browser.waitForTarget(candidate => {
    try {
      return candidate?.type?.() === 'service_worker' && PATROL_WORKER_RE.test(String(candidate?.url?.() ?? ''))
    } catch {
      return false
    }
  }, { timeout: Math.max(1_000, timeoutMs || SOURCE_EXTENSION_WAIT_MS) })
  const match = PATROL_WORKER_RE.exec(String(target?.url?.() ?? ''))
  const worker = await target?.worker?.()
  if (!match?.[1] || !worker) throw new Error('Patrol source-loaded extension did not expose background-entry.js service worker')
  return { id: match[1], worker }
}

function sourceLoadBrowserCandidates(env, platform) {
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA].filter(Boolean)
    return [
      ...roots.map(root => join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe')),
      ...(env.LOCALAPPDATA ? [join(env.LOCALAPPDATA, 'Chromium', 'Application', 'chrome.exe')] : []),
    ]
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
    ]
  }
  return [
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/microsoft-edge',
    '/usr/bin/microsoft-edge-stable',
  ]
}

function sourceLoadBrowserCommands(platform) {
  if (platform === 'win32') return ['msedge.exe', 'chromium.exe']
  if (platform === 'darwin') return []
  return ['chromium', 'chromium-browser', 'microsoft-edge', 'microsoft-edge-stable']
}

function findOnPath(command, pathValue) {
  for (const directory of String(pathValue || '').split(delimiter)) {
    if (!directory) continue
    const candidate = join(directory, command)
    if (existsSync(candidate)) return candidate
  }
  return undefined
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
