import { randomUUID } from 'node:crypto'

const AUTH_KEY = Symbol.for('dsh-patrol.image-code-visual-fallback-auth')
const TTL_MS = 60_000

function store() {
  if (!(globalThis[AUTH_KEY] instanceof Map)) globalThis[AUTH_KEY] = new Map()
  return globalThis[AUTH_KEY]
}

function pruneExpired(now = Date.now()) {
  for (const [token, expiresAt] of store()) {
    if (!Number.isFinite(expiresAt) || expiresAt <= now) store().delete(token)
  }
}

export function issueImageCodeVisualAuthorization() {
  pruneExpired()
  const token = randomUUID()
  store().set(token, Date.now() + TTL_MS)
  return token
}

export function consumeImageCodeVisualAuthorization(token) {
  pruneExpired()
  const key = String(token || '').trim()
  if (!key || !store().has(key)) return false
  store().delete(key)
  return true
}
