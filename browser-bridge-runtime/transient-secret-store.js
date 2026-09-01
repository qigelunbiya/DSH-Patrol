import { randomUUID } from 'node:crypto'

const TTL_MS = 8 * 60 * 60 * 1000
const secrets = new Map()

export function rememberTransientSecret(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('transient secret must not be empty')
  cleanup()
  const ref = `PATROL_TRANSIENT_${randomUUID().replace(/-/g, '').toUpperCase()}`
  secrets.set(ref, { value, expiresAt: Date.now() + TTL_MS })
  return ref
}

export function resolveTransientSecret(ref) {
  cleanup()
  const entry = secrets.get(String(ref || ''))
  if (!entry) return undefined
  return entry.value
}

export function forgetTransientSecret(ref) {
  secrets.delete(String(ref || ''))
}

export function clearTransientSecrets() {
  secrets.clear()
}

function cleanup() {
  const now = Date.now()
  for (const [ref, entry] of secrets) {
    if (!entry || entry.expiresAt <= now) secrets.delete(ref)
  }
}
