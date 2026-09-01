import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

const FORMAT_VERSION = 1
const ALGORITHM = 'aes-256-gcm'
const KEY_BYTES = 32
const IV_BYTES = 12
const KEY_FILE = 'master-key-v1.bin'
const VAULT_FILE = 'encrypted-secrets-v1.json'

let cachedKey
let cachedVault

/**
 * Store a sensitive value as authenticated ciphertext and return only an opaque
 * reference suitable for Runbook persistence. The legacy function name is kept
 * for compatibility with existing Patrol tool code; values are no longer
 * process-memory-only or TTL-bound.
 */
export function rememberTransientSecret(value) {
  if (typeof value !== 'string' || value.length === 0) throw new Error('sensitive value must not be empty')
  const ref = `PATROL_SECRET_${randomUUID().replace(/-/g, '').toUpperCase()}`
  const vault = loadVault()
  vault.entries[ref] = encryptSecret(ref, value)
  saveVault(vault)
  return ref
}

/** Resolve one encrypted Patrol secret reference for immediate browser typing. */
export function resolveTransientSecret(ref) {
  const normalized = String(ref || '')
  if (!normalized) return undefined
  const entry = loadVault().entries[normalized]
  if (!entry) return undefined
  return decryptSecret(normalized, entry)
}

/** Remove one no-longer-referenced ciphertext record. */
export function forgetTransientSecret(ref) {
  const normalized = String(ref || '')
  if (!normalized) return
  const vault = loadVault()
  if (!(normalized in vault.entries)) return
  delete vault.entries[normalized]
  saveVault(vault)
}

/**
 * Drop only process caches. Persisted encrypted values intentionally remain so
 * the next Harness process can replay the same Runbook password step.
 */
export function clearTransientSecrets() {
  cachedKey = undefined
  cachedVault = undefined
}

/** Test/diagnostic helper; paths never contain plaintext secret material. */
export function transientSecretStorePaths() {
  const root = secretRoot()
  return {
    root,
    key: join(root, KEY_FILE),
    vault: join(root, VAULT_FILE),
  }
}

function secretRoot() {
  const override = String(process.env.DSH_PATROL_SECRET_DIR || '').trim()
  if (override) return override
  const dshHome = String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh')
  return join(dshHome, 'patrol', 'secrets-v1')
}

function loadKey() {
  if (cachedKey) return cachedKey
  const { root, key: keyPath } = transientSecretStorePaths()
  mkdirSync(root, { recursive: true, mode: 0o700 })

  try {
    const existing = readFileSync(keyPath)
    if (existing.length !== KEY_BYTES) throw new Error(`invalid Patrol secret key length ${existing.length}`)
    cachedKey = existing
    return cachedKey
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }

  const generated = randomBytes(KEY_BYTES)
  try {
    writeFileSync(keyPath, generated, { flag: 'wx', mode: 0o600 })
    try { chmodSync(keyPath, 0o600) } catch {}
    cachedKey = generated
    return cachedKey
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error
    const raced = readFileSync(keyPath)
    if (raced.length !== KEY_BYTES) throw new Error(`invalid Patrol secret key length ${raced.length}`)
    cachedKey = raced
    return cachedKey
  }
}

function loadVault() {
  if (cachedVault) return cachedVault
  const { root, vault: vaultPath } = transientSecretStorePaths()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  try {
    const parsed = JSON.parse(readFileSync(vaultPath, 'utf8'))
    if (!parsed || parsed.version !== FORMAT_VERSION || !parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
      throw new Error('encrypted Patrol secret vault has an unsupported format')
    }
    cachedVault = { version: FORMAT_VERSION, entries: { ...parsed.entries } }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    cachedVault = { version: FORMAT_VERSION, entries: {} }
  }
  return cachedVault
}

function saveVault(vault) {
  const { root, vault: vaultPath } = transientSecretStorePaths()
  mkdirSync(root, { recursive: true, mode: 0o700 })
  const normalized = { version: FORMAT_VERSION, entries: { ...vault.entries } }
  writeFileSync(vaultPath, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(vaultPath, 0o600) } catch {}
  cachedVault = normalized
}

function encryptSecret(ref, value) {
  const key = loadKey()
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  cipher.setAAD(Buffer.from(`dsh-patrol:${FORMAT_VERSION}:${ref}`, 'utf8'))
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return {
    version: FORMAT_VERSION,
    algorithm: ALGORITHM,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    updatedAt: new Date().toISOString(),
  }
}

function decryptSecret(ref, entry) {
  if (!entry || entry.version !== FORMAT_VERSION || entry.algorithm !== ALGORITHM) {
    throw new Error('encrypted Patrol secret has an unsupported format')
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, loadKey(), Buffer.from(String(entry.iv || ''), 'base64'))
    decipher.setAAD(Buffer.from(`dsh-patrol:${FORMAT_VERSION}:${ref}`, 'utf8'))
    decipher.setAuthTag(Buffer.from(String(entry.tag || ''), 'base64'))
    return Buffer.concat([
      decipher.update(Buffer.from(String(entry.ciphertext || ''), 'base64')),
      decipher.final(),
    ]).toString('utf8')
  } catch {
    throw new Error('encrypted Patrol secret could not be decrypted or failed integrity verification')
  }
}
