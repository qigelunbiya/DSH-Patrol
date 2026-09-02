import { randomBytes } from 'node:crypto'
import { decodeQrImageDataUrl } from './qr-code.js'
import {
  deleteTotpProfile,
  generateTotpForProfile,
  listTotpProfiles,
  saveTotpProfilesFromPayload,
} from './totp-store.js'

const MAX_JSON_BYTES = 24 * 1024
const MAX_IMAGE_JSON_BYTES = 12 * 1024 * 1024
const MAX_PREVIEW_PROFILES = 100

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

  // This route is intentionally local-management-UI only. Unlike Patrol's
  // browser_type_totp_profile tool, it returns the current digits so the human
  // owner can use the Token panel as an authenticator replacement. CSRF plus
  // same-origin browser policy keeps this separate from model/tool output.
  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/preview`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!timingSafeHeader(req.headers['x-dsh-patrol-csrf'], csrf)) return sendJson(res, 403, { ok: false, error: 'invalid local TOTP management session' })
      try {
        const body = await readJsonBody(req, MAX_JSON_BYTES)
        const profileIds = Array.isArray(body?.profileIds)
          ? body.profileIds.filter(value => typeof value === 'string').slice(0, MAX_PREVIEW_PROFILES)
          : []
        const requested = profileIds.length > 0
          ? [...new Set(profileIds)]
          : listTotpProfiles().slice(0, MAX_PREVIEW_PROFILES).map(profile => profile.id)
        const codes = requested.map(profileId => {
          const generated = generateTotpForProfile(profileId)
          return {
            profileId,
            code: generated.code,
            digits: generated.profile.digits,
            period: generated.profile.period,
            validForSeconds: generated.validForSeconds,
          }
        })
        return sendJson(res, 200, { ok: true, codes })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeManagementError(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/import`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!timingSafeHeader(req.headers['x-dsh-patrol-csrf'], csrf)) return sendJson(res, 403, { ok: false, error: 'invalid local TOTP management session' })
      try {
        const body = await readJsonBody(req, MAX_JSON_BYTES)
        const profileId = typeof body?.profileId === 'string' ? body.profileId : ''
        const payload = typeof body?.payload === 'string'
          ? body.payload
          : (typeof body?.uri === 'string' ? body.uri : '')
        const imported = saveTotpProfilesFromPayload(profileId, payload)
        return sendJson(res, 200, { ok: true, imported, profiles: listTotpProfiles() })
      } catch (error) {
        return sendJson(res, 400, { ok: false, error: safeManagementError(error) })
      }
    },
  }))

  disposers.push(ctx.webServer.register({
    kind: 'exact',
    path: `${prefix}/import-image`,
    handler: async (req, res) => {
      if (req.method !== 'POST') return methodNotAllowed(res, ['POST'])
      if (!timingSafeHeader(req.headers['x-dsh-patrol-csrf'], csrf)) return sendJson(res, 403, { ok: false, error: 'invalid local TOTP management session' })
      try {
        const body = await readJsonBody(req, MAX_IMAGE_JSON_BYTES)
        const profileId = typeof body?.profileId === 'string' ? body.profileId : ''
        const image = typeof body?.image === 'string' ? body.image : ''
        if (!image.startsWith('data:image/')) throw new Error('二维码图片数据无效')

        const decoded = await decodeQrImageDataUrl(image)
        if (!decoded?.ok || !Array.isArray(decoded.values) || decoded.values.length === 0) {
          throw new Error(decoded?.error || '二维码图片中没有识别到可导入内容')
        }

        const imported = []
        let firstError = ''
        for (let index = 0; index < decoded.values.length; index += 1) {
          try {
            const next = saveTotpProfilesFromPayload(index === 0 ? profileId : '', decoded.values[index])
            imported.push(...next)
          } catch (error) {
            if (!firstError) firstError = safeManagementError(error)
          }
        }
        if (imported.length === 0) {
          throw new Error(firstError || '二维码已识别，但其中没有受支持的 TOTP 账号')
        }
        return sendJson(res, 200, { ok: true, imported, profiles: listTotpProfiles() })
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
        const body = await readJsonBody(req, MAX_JSON_BYTES)
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

async function readJsonBody(req, maxBytes) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > maxBytes) throw new Error('TOTP management request is too large')
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
    .replace(/otpauth(?:-migration)?:\/\/\S+/gi, '[REDACTED OTP IMPORT]')
    .replace(/["']?(secret|seed)["']?\s*[:=]\s*["']?[^"',}\s]+/gi, '$1=[REDACTED]')
    .replace(/(otp|token)\s*[:=]\s*\S+/gi, '$1=[REDACTED]')
    .slice(0, 240)
}
