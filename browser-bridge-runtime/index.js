// Host-plane browser transport for DSH Patrol. Derived in part from dsh-browser-bridge (MIT).
//
// IMPORTANT: this plugin owns process-global WebServer routes, so it must run in
// the HOST composition. Agent presets consume the provided patrolBrowserBridge
// service through browser-bridge-runtime/tools-plugin.js; they do not register
// HTTP/WebSocket routes themselves.
//
// Keep this as a namespace Cordis plugin: do NOT add `export default apply`.
// Harness Loader prefers a module's default export and would otherwise discard
// the sibling `inject` metadata, causing `ctx.webServer` to fail at load time.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BrowserBridge } from './bridge.js'
import { createManagedBrowserController, defaultProfilePath } from './managed-browser.js'
import { handleUpgrade } from './ws.js'

export const name = 'dsh-patrol-browser-bridge-host'
export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const bridge = new BrowserBridge({
    timeoutMs: config.commandTimeoutMs ?? 60000,
    screenshotDir: config.screenshotDir,
    logger: ctx.logger,
  })
  const path = config.path ?? '/patrol-browser-bridge'
  const originTrustFile = config.originTrustFile ?? defaultOriginTrustFile()
  let trustedOrigin = readTrustedOrigin(originTrustFile)
  let managedOrigin
  let urlHint = ''

  const managedBrowser = config.managedBrowser === false ? undefined : createManagedBrowserController({
    bridge,
    logger: ctx.logger,
    bridgeUrlHint: () => urlHint,
    browserExecutable: config.browserExecutable,
    profilePath: config.browserProfilePath ?? defaultProfilePath(),
    startTimeoutMs: config.browserStartTimeoutMs,
    connectTimeoutMs: config.browserConnectTimeoutMs,
    onExtensionReady(extensionId) {
      managedOrigin = `chrome-extension://${extensionId}`
      trustedOrigin = trustManagedOrigin(originTrustFile, managedOrigin)
    },
  })

  // Host-plane service: one transport instance for the process. Agent-preset
  // browser tool rows resolve this service and register only tool schemas into
  // their own scoped ToolRuntime layer. Managed browser startup is intentionally
  // lazy: selecting Patrol mode triggers ensureBrowser(), while ordinary modes
  // do not open an automation browser window.
  ctx.provide('patrolBrowserBridge', {
    bridge,
    bridgeUrlHint: () => urlHint,
    ensureBrowser: async () => managedBrowser === undefined
      ? { managed: false, connected: bridge.connected }
      : await managedBrowser.ensureStarted(),
    managedBrowserStatus: () => managedBrowser?.status ?? { managed: false, connected: bridge.connected },
  })

  const upgradeDispose = ctx.webServer.registerUpgrade({
    path,
    handler(req, socket, head) {
      try {
        const origin = String(req.headers.origin ?? '')
        if (!/^chrome-extension:\/\/[a-z0-9-]+$/i.test(origin)) {
          throw new Error(`websocket origin is not an installed Chromium extension: ${origin || '(missing)'}`)
        }
        if (managedBrowser !== undefined) {
          // In zero-config mode no arbitrary Chromium extension gets a TOFU
          // window before Patrol knows the exact ID it just provisioned. The
          // managed extension may race one early connection and be rejected;
          // its reconnect loop / explicit bridge:connect retries after the ID
          // is known.
          if (managedOrigin === undefined) {
            throw new Error('DSH Patrol managed extension is not provisioned yet')
          }
          if (origin !== managedOrigin) {
            throw new Error('websocket origin is not the DSH Patrol managed extension')
          }
        }
        const connection = handleUpgrade(req, socket, head, { maxMessageBytes: config.maxMessageBytes ?? 8 * 1024 * 1024 })
        try {
          trustedOrigin = authorizeOrigin(originTrustFile, trustedOrigin, origin, managedOrigin)
        } catch (error) {
          try { connection.close(4003, 'extension origin is not paired with DSH Patrol') } catch {}
          throw error
        }
        bridge.attach(connection, { origin })
      } catch (error) {
        ctx.logger.warn?.(`[dsh-patrol/browser-bridge] rejected upgrade: ${error?.message ?? error}`)
        socket.destroy()
      }
    },
  })
  ctx.effect(() => upgradeDispose, 'dsh-patrol/browser-bridge: websocket route')

  const httpDispose = ctx.webServer.register({
    kind: 'exact',
    path: `${path}/info`,
    handler: async (req, res) => {
      const hostHeader = req.headers.host || `${ctx.webServer.host ?? '127.0.0.1'}:${ctx.webServer.port ?? 3080}`
      const safeHost = /^((127\.0\.0\.1|localhost)(:\d+)?)$/i.test(hostHeader) ? hostHeader : `127.0.0.1:${ctx.webServer.port ?? 3080}`
      const managed = managedBrowser?.status
      const body = JSON.stringify({
        name: 'dsh-patrol-browser-bridge',
        protocol: 1,
        ws: `ws://${safeHost}${path}`,
        connected: bridge.connected,
        paired: trustedOrigin !== undefined,
        managedBrowser: managedBrowser !== undefined,
        ...(managed === undefined ? {} : {
          managedRunning: managed.running,
          managedStarting: managed.starting,
          managedConnected: managed.connected,
        }),
      })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      })
      res.end(body)
    },
  })
  ctx.effect(() => httpDispose, 'dsh-patrol/browser-bridge: info route')

  const host = ctx.webServer.host ?? '127.0.0.1'
  const normalizedHost = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host
  urlHint = `ws://${normalizedHost}:${ctx.webServer.port ?? 3080}${path}`
  ctx.logger.info(`[dsh-patrol/browser-bridge] host ready at ${urlHint}; managed browser=${managedBrowser === undefined ? 'disabled' : 'on-demand'}; extension origin pairing=${trustedOrigin === undefined ? 'awaiting first connection' : 'configured'}`)
  ctx.effect(() => async () => {
    // Cordis awaits async disposers. Keep the bridge alive while a pending
    // managed-browser startup settles, then close the DSH-owned browser before
    // tearing down its transport so Harness shutdown does not orphan Chrome.
    if (managedBrowser !== undefined) await managedBrowser.dispose()
    bridge.dispose()
  }, 'dsh-patrol/browser-bridge: dispose')
}

function defaultOriginTrustFile() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'patrol', 'trusted-extension-origin.txt')
}

function readTrustedOrigin(path) {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return /^chrome-extension:\/\/[a-z0-9-]+$/i.test(value) ? value : undefined
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

function trustManagedOrigin(path, origin) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${origin}\n`, { encoding: 'utf8', mode: 0o600 })
  return origin
}

function authorizeOrigin(path, current, candidate, expected) {
  if (expected !== undefined) {
    if (candidate !== expected) throw new Error('browser extension origin does not match the DSH Patrol managed extension')
    return trustManagedOrigin(path, expected)
  }

  const onDisk = readTrustedOrigin(path)
  if (onDisk !== undefined) current = onDisk
  else if (current !== undefined) current = undefined
  if (current !== undefined) {
    if (candidate !== current) {
      throw new Error('browser extension origin does not match the paired DSH Patrol extension; remove the Patrol trusted-extension-origin.txt file only if you intentionally reinstalled/repaired the extension')
    }
    return current
  }

  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    writeFileSync(path, `${candidate}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' })
    return candidate
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const existing = readTrustedOrigin(path)
    if (existing === undefined || existing !== candidate) {
      throw new Error('browser extension origin pairing raced with another extension; inspect or remove the Patrol trusted-extension-origin.txt file before retrying')
    }
    return existing
  }
}
