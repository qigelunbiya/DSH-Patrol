// @ts-nocheck
import { Readable } from 'node:stream'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearTransientSecrets } from '../browser-bridge-runtime/transient-secret-store.js'
import { registerTotpManagementRoutes } from '../browser-bridge-runtime/totp-management.js'

const roots = []
const previousTotp = process.env.DSH_PATROL_TOTP_DIR
const previousSecret = process.env.DSH_PATROL_SECRET_DIR

afterEach(async () => {
  clearTransientSecrets()
  if (previousTotp === undefined) delete process.env.DSH_PATROL_TOTP_DIR
  else process.env.DSH_PATROL_TOTP_DIR = previousTotp
  if (previousSecret === undefined) delete process.env.DSH_PATROL_SECRET_DIR
  else process.env.DSH_PATROL_SECRET_DIR = previousSecret
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-totp-api-'))
  roots.push(root)
  process.env.DSH_PATROL_TOTP_DIR = join(root, 'profiles')
  process.env.DSH_PATROL_SECRET_DIR = join(root, 'secrets')
  clearTransientSecrets()
  const routes = []
  const ctx = {
    webServer: {
      register(route) {
        routes.push(route)
        return () => {}
      },
    },
  }
  registerTotpManagementRoutes(ctx, '/patrol-browser-bridge')
  return { routes }
}

function request(method, body = '', headers = {}) {
  const req = Readable.from(body ? [Buffer.from(body)] : [])
  req.method = method
  req.headers = headers
  return req
}

function response() {
  return {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.status = status
      this.headers = headers || {}
    },
    end(body = '') { this.body = String(body) },
  }
}

describe('local TOTP management API', () => {
  it('uses a same-origin-readable CSRF session, previews current codes locally, and never echoes seed material', async () => {
    const { routes } = await setup()
    expect(routes.map(route => route.path)).toEqual([
      '/patrol-browser-bridge/totp/session',
      '/patrol-browser-bridge/totp/preview',
      '/patrol-browser-bridge/totp/import',
      '/patrol-browser-bridge/totp/import-image',
      '/patrol-browser-bridge/totp/delete',
    ])

    const sessionRes = response()
    await routes[0].handler(request('GET'), sessionRes)
    expect(sessionRes.status).toBe(200)
    expect(sessionRes.headers).not.toHaveProperty('access-control-allow-origin')
    const session = JSON.parse(sessionRes.body)
    expect(session.csrf).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(session.profiles).toEqual([])

    const forbidden = response()
    await routes[1].handler(request('POST', '{}', { 'content-type': 'application/json' }), forbidden)
    expect(forbidden.status).toBe(403)

    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const uri = `otpauth://totp/Operations:alice?secret=${secret}&issuer=Operations&digits=6&period=30`
    const imported = response()
    await routes[2].handler(request('POST', JSON.stringify({ profileId: 'ops-login', uri }), {
      'content-type': 'application/json',
      'x-dsh-patrol-csrf': session.csrf,
    }), imported)
    expect(imported.status).toBe(200)
    expect(imported.body).not.toContain(secret)
    expect(imported.body).not.toContain('otpauth://')
    expect(JSON.parse(imported.body)).toMatchObject({
      imported: [expect.objectContaining({ id: 'ops-login', issuer: 'Operations', account: 'alice' })],
      profiles: [expect.objectContaining({ id: 'ops-login', issuer: 'Operations', account: 'alice' })],
    })

    const preview = response()
    await routes[1].handler(request('POST', JSON.stringify({ profileIds: ['ops-login'] }), {
      'content-type': 'application/json',
      'x-dsh-patrol-csrf': session.csrf,
    }), preview)
    expect(preview.status).toBe(200)
    expect(preview.body).not.toContain(secret)
    expect(JSON.parse(preview.body)).toMatchObject({
      ok: true,
      codes: [expect.objectContaining({ profileId: 'ops-login', digits: 6, period: 30 })],
    })
    expect(JSON.parse(preview.body).codes[0].code).toMatch(/^\d{6}$/)

    const deleted = response()
    await routes[4].handler(request('POST', JSON.stringify({ profileId: 'ops-login' }), {
      'content-type': 'application/json',
      'x-dsh-patrol-csrf': session.csrf,
    }), deleted)
    expect(deleted.status).toBe(200)
    expect(JSON.parse(deleted.body)).toMatchObject({ ok: true, deleted: true, profiles: [] })
  })

  it('accepts Authing export JSON through the same local import endpoint without echoing seeds', async () => {
    const { routes } = await setup()
    const sessionRes = response()
    await routes[0].handler(request('GET'), sessionRes)
    const session = JSON.parse(sessionRes.body)
    const secret = 'JBSWY3DPEHPK3PXP'
    const payload = JSON.stringify([
      { account: 'alice', issuer: 'USM', algorithm: 'SHA1', digits: 6, interval: 30, secret },
    ])

    const imported = response()
    await routes[2].handler(request('POST', JSON.stringify({ payload }), {
      'content-type': 'application/json',
      'x-dsh-patrol-csrf': session.csrf,
    }), imported)
    expect(imported.status).toBe(200)
    expect(imported.body).not.toContain(secret)
    expect(JSON.parse(imported.body)).toMatchObject({
      ok: true,
      imported: [expect.objectContaining({ id: 'usm-alice', issuer: 'USM', account: 'alice' })],
    })
  })
})