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
  parseTotpUri,
  saveTotpProfileFromUri,
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

  it('rejects HOTP, missing secrets, and unsafe profile identifiers', async () => {
    await isolatedStores()
    expect(() => parseTotpUri('otpauth://hotp/Test?secret=JBSWY3DPEHPK3PXP&counter=1')).toThrow(/Only otpauth:\/\/totp/i)
    expect(() => parseTotpUri('otpauth://totp/Test')).toThrow(/Base32 secret/i)
    expect(() => saveTotpProfileFromUri('../escape', 'otpauth://totp/Test?secret=JBSWY3DPEHPK3PXP')).toThrow(/profile id/i)
  })
})
