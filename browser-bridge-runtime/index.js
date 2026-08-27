// Patrol-scoped browser bridge. Derived in part from dsh-browser-bridge (MIT).
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { BrowserBridge } from './bridge.js'
import { registerTools } from './tools.js'
import { handleUpgrade } from './ws.js'

export const name = 'dsh-patrol-browser-bridge'
export const inject = ['webServer', 'tools']

export function apply(ctx, config = {}) {
  const bridge = new BrowserBridge({
    timeoutMs: config.commandTimeoutMs ?? 60000,
    screenshotDir: config.screenshotDir,
    logger: ctx.logger,
  })
  const path = config.path ?? '/patrol-browser-bridge'
  const originTrustFile = config.originTrustFile ?? defaultOriginTrustFile()
  let trustedOrigin = readTrustedOrigin(originTrustFile)
  let urlHint = ''

  ctx.effect(() => registerTools(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
    bridgeUrlHint: () => urlHint,
  }), 'dsh-patrol/browser-bridge: tools')

  const upgradeDispose = ctx.webServer.registerUpgrade({
    path,
    handler(req, socket, head) {
      try {
        const origin = String(req.headers.origin ?? '')
        if (!/^chrome-extension:\/\/[a-z0-9-]+$/i.test(origin)) {
          throw new Error(`websocket origin is not an installed Chromium extension: ${origin || '(missing)'}`)
        }
        const connection = handleUpgrade(req, socket, head, { maxMessageBytes: config.maxMessageBytes ?? 8 * 1024 * 1024 })
        try {
          trustedOrigin = authorizeOrigin(originTrustFile, trustedOrigin, origin)
        } catch (error) {
          try { connection.close(4003, 'extension origin is not paired with DSH Patrol') } catch {}
          throw error
        }
        bridge.attach(connection)
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
      const body = JSON.stringify({
        name: 'dsh-patrol-browser-bridge',
        protocol: 1,
        ws: `ws://${safeHost}${path}`,
        connected: bridge.connected,
        paired: trustedOrigin !== undefined,
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
  ctx.logger.info(`[dsh-patrol/browser-bridge] ready at ${urlHint}; extension origin pairing=${trustedOrigin === undefined ? 'awaiting first TOFU connection' : 'configured'}`)
  ctx.effect(() => () => bridge.dispose(), 'dsh-patrol/browser-bridge: dispose')
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

function authorizeOrigin(path, current, candidate) {
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

export default apply
