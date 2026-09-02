import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { clearTransientSecrets, transientSecretStorePaths } from '../browser-bridge-runtime/transient-secret-store.js'
import {
  deleteTotpProfile,
  generateTotp,
  generateTotpForProfile,
  listTotpProfiles,
  parseTotpImportPayload,
  parseTotpUri,
  saveTotpProfileFromUri,
  saveTotpProfilesFromPayload,
  totpProfileStorePath,
} from '../browser-bridge-runtime/totp-store.js'

const roots: string[] = []
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

async function isolatedStores() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-totp-'))
  roots.push(root)
  process.env.DSH_PATROL_TOTP_DIR = join(root, 'profiles')
  process.env.DSH_PATROL_SECRET_DIR = join(root, 'secrets')
  clearTransientSecrets()
  return root
}

function varint(value: number | bigint) {
  const output: number[] = []
  let current = BigInt(value)
  do {
    let byte = Number(current & 0x7fn)
    current >>= 7n
    if (current) byte |= 0x80
    output.push(byte)
  } while (current)
  return Buffer.from(output)
}

function fieldVarint(field: number, value: number | bigint) {
  return Buffer.concat([varint((field << 3) | 0), varint(value)])
}

function fieldBytes(field: number, value: Buffer) {
  return Buffer.concat([varint((field << 3) | 2), varint(value.length), value])
}

function googleMigrationUri() {
  const otp = Buffer.concat([
    fieldBytes(1, Buffer.from('Hello!')),
    fieldBytes(2, Buffer.from('alice@example.com')),
    fieldBytes(3, Buffer.from('Example')),
    fieldVarint(4, 1),
    fieldVarint(5, 1),
    fieldVarint(6, 2),
  ])
  const payload = Buffer.concat([
    fieldBytes(1, otp),
    fieldVarint(2, 1),
    fieldVarint(3, 1),
    fieldVarint(4, 0),
    fieldVarint(5, 123),
  ])
  return `otpauth-migration://offline?data=${encodeURIComponent(payload.toString('base64'))}`
}

describe('Patrol TOTP profiles', () => {
  it('matches the RFC 6238 SHA-1 test vector', () => {
    const generated = generateTotp({
      // Base32 for ASCII "12345678901234567890" from RFC 6238 Appendix B.
      secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      algorithm: 'SHA1',
      digits: 8,
      period: 30,
    }, 59_000)

    expect(generated.code).toBe('94287082')
    expect(generated.validForSeconds).toBe(1)
  })

  it('parses ordinary otpauth TOTP URIs without retaining the URI itself', () => {
    expect(parseTotpUri('otpauth://totp/Example%20Co:alice%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Example%20Co&algorithm=SHA1&digits=6&period=30'))
      .toEqual({
        secret: 'JBSWY3DPEHPK3PXP',
        issuer: 'Example Co',
        account: 'alice@example.com',
        label: 'Example Co:alice@example.com',
        algorithm: 'SHA1',
        digits: 6,
        period: 30,
      })
  })

  it('parses Authing exported account JSON and supports bulk profiles', async () => {
    await isolatedStores()
    const payload = JSON.stringify([
      {
        account: 'alice',
        accountId: 'alice',
        algorithm: 'SHA1',
        digits: 6,
        interval: 30,
        issuer: 'USM',
        platform: 'Android',
        secret: 'JBSWY3DPEHPK3PXP',
        uuid: '1',
      },
      {
        account: 'bob',
        algorithm: 'SHA256',
        digits: 8,
        interval: 60,
        issuer: 'Example',
        secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
      },
    ])

    const parsed = parseTotpImportPayload(payload)
    expect(parsed).toHaveLength(2)
    expect(parsed[0]).toMatchObject({ issuer: 'USM', account: 'alice', algorithm: 'SHA1', digits: 6, period: 30 })
    const imported = saveTotpProfilesFromPayload('', payload)
    expect(imported).toEqual([
      expect.objectContaining({ id: 'usm-alice', issuer: 'USM', account: 'alice' }),
      expect.objectContaining({ id: 'example-bob', issuer: 'Example', account: 'bob', digits: 8, period: 60 }),
    ])
    expect(JSON.stringify(imported)).not.toContain('JBSWY3DPEHPK3PXP')
  })

  it('parses Google Authenticator migration protobuf payloads', () => {
    const parsed = parseTotpImportPayload(googleMigrationUri())
    expect(parsed).toHaveLength(1)
    expect(parsed[0]).toMatchObject({
      issuer: 'Example',
      account: 'alice@example.com',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    })
    expect(parsed[0].secret).toMatch(/^[A-Z2-7]+$/)
  })

  it('stores only profile metadata plus an opaque encrypted-secret reference', async () => {
    await isolatedStores()
    const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
    const uri = `otpauth://totp/Test:alice?secret=${secret}&issuer=Test&digits=8&period=30`

    const saved = saveTotpProfileFromUri('test-login', uri)
    expect(saved).toMatchObject({
      id: 'test-login',
      issuer: 'Test',
      account: 'alice',
      digits: 8,
      period: 30,
    })
    expect(saved).not.toHaveProperty('secret')
    expect(saved).not.toHaveProperty('secretRef')

    const profileText = await readFile(totpProfileStorePath(), 'utf8')
    const vaultText = await readFile(transientSecretStorePaths().vault, 'utf8')
    expect(profileText).not.toContain(secret)
    expect(profileText).not.toContain('otpauth://')
    expect(profileText).toContain('PATROL_SECRET_')
    expect(vaultText).not.toContain(secret)

    clearTransientSecrets()
    expect(generateTotpForProfile('test-login', 59_000).code).toBe('94287082')
    expect(listTotpProfiles()).toEqual([expect.objectContaining({ id: 'test-login', issuer: 'Test' })])

    expect(deleteTotpProfile('test-login')).toBe(true)
    expect(listTotpProfiles()).toEqual([])
  })

  it('rejects HOTP, missing secrets, unsafe profile identifiers, and unknown migration payloads', async () => {
    await isolatedStores()
    expect(() => parseTotpUri('otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP&counter=1')).toThrow(/Only otpauth:\/\/totp/i)
    expect(() => parseTotpUri('otpauth://totp/Test')).toThrow(/Base32 secret/i)
    expect(() => saveTotpProfileFromUri('../escape', 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP')).toThrow(/profile id/i)
    expect(() => parseTotpImportPayload('not-a-token')).toThrow(/Unsupported TOTP import payload/i)
  })
})