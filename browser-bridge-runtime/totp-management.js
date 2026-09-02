import { randomBytes } from 'node:crypto'
import { deleteTotpProfile, listTotpProfiles, saveTotpProfileFromUri } from './totp-store.js'

const MAX_JSON_BYTES = 24 * 1024

export function registerTotpManagementRoutes(ctx, basePath) {
  const csrf = randomBytes(32).toString('base64url')
  const prefix = `${String(basePath || '/patrol-browser-bridge').replace(/\/$/, '')}/totp`
  const disposers = []

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/session`,
    handler: async (req, res) => {
      if (req.method !== 'GET') return methodNotAllowed(res, ['GET'])
      return sendJson(res, 200, { ok: true, csrf, profiles: listTotpProfiles() })
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/import`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!timingSafeHeader(req.headers['x-dsh-patrol-csrf'], csrf)) return sendJson(res, 403, { ok: false, error: 'invalid local TOTP management session' })
      try {
        const body = await readJsonBody(req)
        const profileId = typeof body?.profileId === 'string' ? body.profileId : ''
        const uri = typeof body?.uri === 'string' ? body.uri : ''
        const profile = saveTotpProfileFromUri(profileId, uri)
        return sendJson(res, 200, { ok: true, profile, profiles: listTotpProfiles() })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeManagementError(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/delete`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!timingSafeHeader(req.headers['x-dsh-patrol-csrf'], csrf)) return sendJson(res, 403, { ok: false, error: 'invalid local TOTP management session' })
      try {
        const body = await readJsonBody(req)
        const profileId = typeof body?.profileId === 'string' ? body.profileId : ''
        const deleted = deleteTotpProfile(profileId)
        return sendJson(res, 200, { ok: true, deleted, profiles: listTotpProfiles() })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeManagementError(error) })
      }
    },
  }))

  return () => {
    for (const dispose of disposers.splice(0)) {
      try { dispose() } catch {}
    }
  }
}

async function readJsonBody(req) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_JSON_BYTES) throw new Error('TOTP management request is too large')
    chunks.push(buffer)
  }
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text.trim()) return {}
  try {
    return JSON.parse(text)
  } catch {
    throw new Error('TOTP management request must contain valid JSON')
  }
}

function timingSafeHeader(value, expected) {
  const candidate = Array.isArray(value) ? value[0] : value
  if (typeof candidate !== 'string' || candidate.length !== expected.length) return false
  let mismatch = 0
  for (let index = 0; index < expected.length; index += 1) {
    mismatch |= candidate.charCodeAt(index) ^ expected.charCodeAt(index)
  }
  return mismatch === 0
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

function methodNotAllowed(res, allow) {
  res.writeHead(405, {
    allow: allow.join(', '),
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ ok: false, error: 'method not allowed' }))
}

function safeManagementError(error) {
  const text = error instanceof Error ? error.message : String(error || 'TOTP management failed')
  return text
    .replace(/otpauth:\/\/\S+/gi, '[REDACTED OTPAUTH URI]')
    .replace(/(secret|seed|otp|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 240)
}
