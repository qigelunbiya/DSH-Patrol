import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { patrolBrowserVisible } from './background-browser-launch.js'

const MAX_BODY_BYTES = 8 * 1024

export function defaultBrowserVisibilityPath() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'patrol', 'browser-visibility.json')
}

export function readBrowserVisibility(path = defaultBrowserVisibilityPath(), env = process.env) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed?.visible === 'boolean') return parsed.visible
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      // Invalid/corrupt preference must not prevent Patrol from starting. Fall
      // back to the existing environment/default behavior and overwrite it on
      // the next explicit UI change.
    }
  }
  return patrolBrowserVisible(env)
}

export function writeBrowserVisibility(visible, path = defaultBrowserVisibilityPath()) {
  if (typeof visible !== 'boolean') throw new Error('browser visibility must be boolean')
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify({ visible }, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  return visible
}

export function registerBrowserVisibilityRoutes(ctx, basePath, options) {
  const prefix = String(basePath || '/patrol-browser-bridge').replace(/\/$/, '')
  const routePath = `${prefix}/browser-visibility`
  const getVisible = options.getVisible
  const setVisible = options.setVisible

  const dispose = ctx.webServer.register({
    kind: 'exact',
    path: routePath,
    handler: async (req, res) => {
      if (req.method === 'GET') {
        return sendJson(res, 200, {
          ok: true,
          visible: Boolean(getVisible()),
          connected: options.bridge?.connected === true,
        })
      }
      if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST'])
      try {
        const body = await readJsonBody(req)
        if (typeof body?.visible !== 'boolean') throw new Error('visible must be boolean')
        const result = await setVisible(body.visible)
        return sendJson(res, 200, {
          ok: true,
          visible: Boolean(getVisible()),
          applied: result?.applied === true,
          connected: options.bridge?.connected === true,
          ...(result?.note ? { note: String(result.note) } : {}),
        })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeError(error) })
      }
    },
  })
  return dispose
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('browser visibility request is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try { return JSON.parse(text) } catch { throw new Error('browser visibility request must contain valid JSON') }
}

function sendJson(res, status, value) {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  })
  res.end(body)
}

function methodNotAllowed(res, methods) {
  res.writeHead(405, { allow: methods.join(', '), 'cache-control': 'no-store' })
  res.end()
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error || 'browser visibility update failed')).slice(0, 500)
}
