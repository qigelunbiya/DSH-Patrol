import { createHmac, randomUUID } from 'node:crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import {
  forgetTransientSecret,
  rememberTransientSecret,
  resolveTransientSecret,
} from './transient-secret-store.js'

const STORE_VERSION = 1
const PROFILE_FILE = 'totp-profiles-v1.json'
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const BASE32_PATTERN = /^[A-Z2-7]+$/
const SUPPORTED_ALGORITHMS = new Set(['SHA1', 'SHA256', 'SHA512'])

export function parseTotpUri(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error('TOTP import must be a valid otpauth:// URI')
  }
  if (url.protocol !== 'otpauth:' || url.hostname.toLowerCase() !== 'totp') {
    throw new Error('Only otpauth://totp profiles are supported in this Patrol version')
  }

  const secret = normalizeBase32Secret(url.searchParams.get('secret'))
  if (!secret) throw new Error('otpauth TOTP profile is missing a valid Base32 secret')

  const rawLabel = safeDecodeURIComponent(url.pathname.replace(/^\/+/, '')).trim()
  const queryIssuer = (url.searchParams.get('issuer') || '').trim()
  const labelParts = splitLabel(rawLabel)
  const issuer = queryIssuer || labelParts.issuer
  const account = labelParts.account || rawLabel || 'TOTP account'
  const algorithm = normalizeAlgorithm(url.searchParams.get('algorithm'))
  const digits = normalizeInteger(url.searchParams.get('digits'), 6, 6, 8, 'digits')
  const period = normalizeInteger(url.searchParams.get('period'), 30, 15, 120, 'period')

  return {
    secret,
    issuer,
    account,
    label: rawLabel || [issuer, account].filter(Boolean).join(':') || account,
    algorithm,
    digits,
    period,
  }
}

export function saveTotpProfileFromUri(profileId, uri) {
  assertProfileId(profileId)
  const parsed = parseTotpUri(uri)
  const store = loadProfileStore()
  const previous = store.profiles[profileId]
  const secretRef = rememberTransientSecret(parsed.secret)
  const now = new Date().toISOString()

  const profile = {
    id: profileId,
    issuer: parsed.issuer,
    account: parsed.account,
    label: parsed.label,
    algorithm: parsed.algorithm,
    digits: parsed.digits,
    period: parsed.period,
    secretRef,
    createdAt: typeof previous?.createdAt === 'string' ? previous.createdAt : now,
    updatedAt: now,
  }

  try {
    store.profiles[profileId] = profile
    saveProfileStore(store)
  } catch (error) {
    forgetTransientSecret(secretRef)
    throw error
  }

  if (typeof previous?.secretRef === 'string' && previous.secretRef !== secretRef) {
    forgetTransientSecret(previous.secretRef)
  }
  return publicProfile(profile)
}

export function listTotpProfiles() {
  return Object.values(loadProfileStore().profiles)
    .filter(validStoredProfile)
    .sort((left, right) => left.id.localeCompare(right.id))
    .map(publicProfile)
}

export function describeTotpProfile(profileId) {
  assertProfileId(profileId)
  const profile = loadProfileStore().profiles[profileId]
  return validStoredProfile(profile) ? publicProfile(profile) : undefined
}

export function deleteTotpProfile(profileId) {
  assertProfileId(profileId)
  const store = loadProfileStore()
  const profile = store.profiles[profileId]
  if (!validStoredProfile(profile)) return false
  delete store.profiles[profileId]
  saveProfileStore(store)
  forgetTransientSecret(profile.secretRef)
  return true
}

export function generateTotpForProfile(profileId, timestampMs = Date.now()) {
  assertProfileId(profileId)
  const profile = loadProfileStore().profiles[profileId]
  if (!validStoredProfile(profile)) throw new Error(`TOTP profile ${profileId} is not configured`)
  const secret = resolveTransientSecret(profile.secretRef)
  if (!secret) throw new Error(`TOTP profile ${profileId} has no resolvable encrypted seed`)
  const generated = generateTotp({
    secret,
    algorithm: profile.algorithm,
    digits: profile.digits,
    period: profile.period,
  }, timestampMs)
  return {
    ...generated,
    profile: publicProfile(profile),
  }
}

export function generateTotp(config, timestampMs = Date.now()) {
  const secret = normalizeBase32Secret(config?.secret)
  if (!secret) throw new Error('TOTP secret must be valid Base32')
  const algorithm = normalizeAlgorithm(config?.algorithm)
  const digits = normalizeInteger(config?.digits, 6, 6, 8, 'digits')
  const period = normalizeInteger(config?.period, 30, 15, 120, 'period')
  const timeMs = Number(timestampMs)
  if (!Number.isFinite(timeMs) || timeMs < 0) throw new Error('TOTP timestamp must be a non-negative number')

  const seconds = Math.floor(timeMs / 1000)
  const counter = Math.floor(seconds / period)
  const counterBuffer = Buffer.alloc(8)
  counterBuffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac(algorithm.toLowerCase().replace('sha', 'sha'), decodeBase32(secret))
    .update(counterBuffer)
    .digest()
  const offset = digest[digest.length - 1] & 0x0f
  const binary = ((digest[offset] & 0x7f) << 24)
    | ((digest[offset + 1] & 0xff) << 16)
    | ((digest[offset + 2] & 0xff) << 8)
    | (digest[offset + 3] & 0xff)
  const modulo = 10 ** digits
  const code = String(binary % modulo).padStart(digits, '0')
  const elapsed = seconds % period
  const validForSeconds = elapsed === 0 ? period : period - elapsed

  return {
    code,
    algorithm,
    digits,
    period,
    counter,
    validForSeconds,
  }
}

export function totpProfileStorePath() {
  const override = String(process.env.DSH_PATROL_TOTP_DIR || '').trim()
  const root = override || join(String(process.env.DSH_HOME || '').trim() || join(homedir(), '.dsh'), 'patrol', 'totp-v1')
  return join(root, PROFILE_FILE)
}

function loadProfileStore() {
  const path = totpProfileStorePath()
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!parsed || parsed.version !== STORE_VERSION || !parsed.profiles || typeof parsed.profiles !== 'object' || Array.isArray(parsed.profiles)) {
      throw new Error('Patrol TOTP profile store has an unsupported format')
    }
    return { version: STORE_VERSION, profiles: { ...parsed.profiles } }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    return { version: STORE_VERSION, profiles: {} }
  }
}

function saveProfileStore(store) {
  const path = totpProfileStorePath()
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const normalized = { version: STORE_VERSION, profiles: { ...store.profiles } }
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 })
  try { chmodSync(temp, 0o600) } catch {}
  renameSync(temp, path)
  try { chmodSync(path, 0o600) } catch {}
}

function publicProfile(profile) {
  return {
    id: profile.id,
    issuer: profile.issuer,
    account: profile.account,
    label: profile.label,
    algorithm: profile.algorithm,
    digits: profile.digits,
    period: profile.period,
    createdAt: profile.createdAt,
    updatedAt: profile.updatedAt,
  }
}

function validStoredProfile(profile) {
  return !!profile
    && typeof profile === 'object'
    && typeof profile.id === 'string'
    && PROFILE_ID_PATTERN.test(profile.id)
    && typeof profile.secretRef === 'string'
    && profile.secretRef.startsWith('PATROL_SECRET_')
    && SUPPORTED_ALGORITHMS.has(profile.algorithm)
    && Number.isInteger(profile.digits)
    && profile.digits >= 6
    && profile.digits <= 8
    && Number.isInteger(profile.period)
    && profile.period >= 15
    && profile.period <= 120
}

function normalizeAlgorithm(value) {
  const algorithm = String(value || 'SHA1').replace(/[-_]/g, '').toUpperCase()
  if (!SUPPORTED_ALGORITHMS.has(algorithm)) throw new Error(`Unsupported TOTP algorithm ${algorithm || '(empty)'}`)
  return algorithm
}

function normalizeInteger(value, fallback, min, max, name) {
  if (value === undefined || value === null || value === '') return fallback
  const number = Number(value)
  if (!Number.isInteger(number) || number < min || number > max) {
    throw new Error(`TOTP ${name} must be an integer between ${min} and ${max}`)
  }
  return number
}

function normalizeBase32Secret(value) {
  const secret = String(value || '')
    .toUpperCase()
    .replace(/[\s=-]/g, '')
  if (!secret || !BASE32_PATTERN.test(secret)) return ''
  return secret
}

function decodeBase32(secret) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  const output = []
  for (const char of secret) {
    const index = alphabet.indexOf(char)
    if (index < 0) throw new Error('TOTP secret contains an invalid Base32 character')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) {
      output.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  if (output.length === 0) throw new Error('TOTP secret decoded to an empty key')
  return Buffer.from(output)
}

function splitLabel(label) {
  const separator = label.indexOf(':')
  if (separator < 0) return { issuer: '', account: label.trim() }
  return {
    issuer: label.slice(0, separator).trim(),
    account: label.slice(separator + 1).trim(),
  }
}

function safeDecodeURIComponent(value) {
  try { return decodeURIComponent(value) } catch { return value }
}

function assertProfileId(value) {
  if (typeof value !== 'string' || !PROFILE_ID_PATTERN.test(value)) {
    throw new Error('TOTP profile id must be 1-64 characters using letters, numbers, dot, underscore, or hyphen')
  }
}
