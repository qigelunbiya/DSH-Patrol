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

export function parseTotpImportPayload(value) {
  const text = String(value || '').trim()
  if (!text) throw new Error('TOTP import payload is empty')
  if (/^otpauth:\/\/totp\//i.test(text)) return [parseTotpUri(text)]
  if (/^otpauth-migration:\/\//i.test(text)) return parseGoogleAuthenticatorMigration(text)
  if (text.startsWith('[') || text.startsWith('{')) return parseAuthingExport(text)
  throw new Error('Unsupported TOTP import payload; use otpauth://, Google Authenticator migration, or Authing export JSON')
}

export function saveTotpProfilesFromPayload(profileIdHint, payload) {
  const hint = String(profileIdHint || '').trim()
  if (hint) assertProfileId(hint)
  const parsedProfiles = parseTotpImportPayload(payload)
  if (parsedProfiles.length === 0) throw new Error('TOTP import payload did not contain any TOTP accounts')

  const store = loadProfileStore()
  const now = new Date().toISOString()
  const createdSecretRefs = []
  const replacedSecretRefs = []
  const imported = []
  const usedIds = new Set()

  try {
    for (let index = 0; index < parsedProfiles.length; index += 1) {
      const parsed = parsedProfiles[index]
      const profileId = chooseProfileId(hint, parsed, index, parsedProfiles.length, usedIds)
      usedIds.add(profileId)
      const previous = store.profiles[profileId]
      const secretRef = rememberTransientSecret(parsed.secret)
      createdSecretRefs.push(secretRef)

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
      store.profiles[profileId] = profile
      imported.push(publicProfile(profile))
      if (typeof previous?.secretRef === 'string' && previous.secretRef !== secretRef) {
        replacedSecretRefs.push(previous.secretRef)
      }
    }
    saveProfileStore(store)
  } catch (error) {
    for (const secretRef of createdSecretRefs) forgetTransientSecret(secretRef)
    throw error
  }

  for (const secretRef of replacedSecretRefs) forgetTransientSecret(secretRef)
  return imported
}

export function saveTotpProfileFromUri(profileId, uri) {
  return saveTotpProfilesFromPayload(profileId, uri)[0]
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
  const digest = createHmac(algorithm.toLowerCase(), decodeBase32(secret))
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

function parseAuthingExport(text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('Authing TOTP export must contain valid JSON')
  }
  let entries
  if (Array.isArray(parsed)) entries = parsed
  else if (Array.isArray(parsed?.accounts)) entries = parsed.accounts
  else if (Array.isArray(parsed?.tokens)) entries = parsed.tokens
  else if (Array.isArray(parsed?.data)) entries = parsed.data
  else if (parsed && typeof parsed === 'object') entries = [parsed]
  else entries = []

  const profiles = []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const secret = normalizeBase32Secret(entry.secret ?? entry.seed)
    if (!secret) continue
    const issuer = String(entry.issuer ?? entry.provider ?? entry.service ?? 'Authing').trim()
    const account = String(entry.account ?? entry.accountId ?? entry.name ?? entry.label ?? 'TOTP account').trim() || 'TOTP account'
    const algorithm = normalizeAlgorithm(entry.algorithm)
    const digits = normalizeInteger(entry.digits, 6, 6, 8, 'digits')
    const period = normalizeInteger(entry.interval ?? entry.period, 30, 15, 120, 'period')
    profiles.push({
      secret,
      issuer,
      account,
      label: [issuer, account].filter(Boolean).join(':') || account,
      algorithm,
      digits,
      period,
    })
  }
  if (profiles.length === 0) throw new Error('Authing export JSON did not contain any supported TOTP account')
  return profiles
}

function parseGoogleAuthenticatorMigration(value) {
  let url
  try {
    url = new URL(String(value || ''))
  } catch {
    throw new Error('Google Authenticator migration payload is invalid')
  }
  if (url.protocol !== 'otpauth-migration:') throw new Error('Google Authenticator migration payload is invalid')
  const encoded = url.searchParams.get('data')
  if (!encoded) throw new Error('Google Authenticator migration payload is missing data')
  let bytes
  try {
    bytes = Buffer.from(encoded.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
  } catch {
    throw new Error('Google Authenticator migration payload is not valid Base64')
  }
  if (!bytes.length) throw new Error('Google Authenticator migration payload is empty')

  const profiles = []
  let offset = 0
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset)
    offset = key.offset
    const field = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    if (field === 1 && wire === 2) {
      const chunk = readLengthDelimited(bytes, offset)
      offset = chunk.offset
      const profile = decodeGoogleOtpParameters(chunk.value)
      if (profile) profiles.push(profile)
      continue
    }
    offset = skipProtobufField(bytes, offset, wire)
  }
  if (profiles.length === 0) throw new Error('Google Authenticator migration QR did not contain supported TOTP accounts')
  return profiles
}

function decodeGoogleOtpParameters(bytes) {
  let offset = 0
  let secretBytes
  let name = ''
  let issuer = ''
  let algorithm = 1
  let digits = 1
  let type = 2
  while (offset < bytes.length) {
    const key = readVarint(bytes, offset)
    offset = key.offset
    const field = Number(key.value >> 3n)
    const wire = Number(key.value & 7n)
    if (wire === 2 && (field === 1 || field === 2 || field === 3)) {
      const chunk = readLengthDelimited(bytes, offset)
      offset = chunk.offset
      if (field === 1) secretBytes = chunk.value
      else if (field === 2) name = chunk.value.toString('utf8').trim()
      else issuer = chunk.value.toString('utf8').trim()
      continue
    }
    if (wire === 0 && (field === 4 || field === 5 || field === 6 || field === 7)) {
      const item = readVarint(bytes, offset)
      offset = item.offset
      const number = Number(item.value)
      if (field === 4) algorithm = number
      else if (field === 5) digits = number
      else if (field === 6) type = number
      continue
    }
    offset = skipProtobufField(bytes, offset, wire)
  }

  if (type === 1) return undefined
  if (!secretBytes?.length) return undefined
  const algorithmName = ({ 0: 'SHA1', 1: 'SHA1', 2: 'SHA256', 3: 'SHA512' })[algorithm]
  if (!algorithmName) throw new Error('Google Authenticator migration contains an unsupported TOTP algorithm')
  const digitCount = digits === 2 ? 8 : 6
  const account = name || 'TOTP account'
  return {
    secret: encodeBase32(secretBytes),
    issuer,
    account,
    label: [issuer, account].filter(Boolean).join(':') || account,
    algorithm: algorithmName,
    digits: digitCount,
    period: 30,
  }
}

function readVarint(buffer, start) {
  let value = 0n
  let shift = 0n
  let offset = start
  while (offset < buffer.length && shift <= 63n) {
    const byte = buffer[offset]
    offset += 1
    value |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return { value, offset }
    shift += 7n
  }
  throw new Error('Google Authenticator migration protobuf is malformed')
}

function readLengthDelimited(buffer, start) {
  const lengthInfo = readVarint(buffer, start)
  const length = Number(lengthInfo.value)
  if (!Number.isSafeInteger(length) || length < 0 || lengthInfo.offset + length > buffer.length) {
    throw new Error('Google Authenticator migration protobuf has an invalid field length')
  }
  return {
    value: buffer.subarray(lengthInfo.offset, lengthInfo.offset + length),
    offset: lengthInfo.offset + length,
  }
}

function skipProtobufField(buffer, start, wire) {
  if (wire === 0) return readVarint(buffer, start).offset
  if (wire === 1) {
    if (start + 8 > buffer.length) throw new Error('Google Authenticator migration protobuf is truncated')
    return start + 8
  }
  if (wire === 2) return readLengthDelimited(buffer, start).offset
  if (wire === 5) {
    if (start + 4 > buffer.length) throw new Error('Google Authenticator migration protobuf is truncated')
    return start + 4
  }
  throw new Error('Google Authenticator migration protobuf uses an unsupported wire type')
}

function encodeBase32(bytes) {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  let bits = 0
  let value = 0
  let output = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      output += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) output += alphabet[(value << (5 - bits)) & 31]
  return output
}

function chooseProfileId(hint, profile, index, total, usedIds) {
  let base
  if (hint && total === 1) base = hint
  else {
    const identity = slugifyProfileId([profile.issuer, profile.account].filter(Boolean).join('-'))
    base = hint ? slugifyProfileId(`${hint}-${identity || index + 1}`) : (identity || `token-${index + 1}`)
  }
  if (!base) base = `token-${index + 1}`
  let candidate = base.slice(0, 64)
  let suffix = 2
  while (usedIds.has(candidate)) {
    const tail = `-${suffix}`
    candidate = `${base.slice(0, Math.max(1, 64 - tail.length))}${tail}`
    suffix += 1
  }
  assertProfileId(candidate)
  return candidate
}

function slugifyProfileId(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '')
    .slice(0, 64)
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
