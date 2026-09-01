import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  clearTransientSecrets,
  forgetTransientSecret,
  rememberTransientSecret,
  resolveTransientSecret,
  transientSecretStorePaths,
} from '../browser-bridge-runtime/transient-secret-store.js'

const roots: string[] = []
const previousOverride = process.env.DSH_PATROL_SECRET_DIR

afterEach(async () => {
  clearTransientSecrets()
  if (previousOverride === undefined) delete process.env.DSH_PATROL_SECRET_DIR
  else process.env.DSH_PATROL_SECRET_DIR = previousOverride
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('Patrol encrypted secret store', () => {
  it('persists only authenticated ciphertext and survives process-cache reset', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-secret-'))
    roots.push(root)
    process.env.DSH_PATROL_SECRET_DIR = root
    clearTransientSecrets()

    const plaintext = 'example-sensitive-password-123!'
    const ref = rememberTransientSecret(plaintext)
    expect(ref).toMatch(/^PATROL_SECRET_[A-F0-9]+$/)

    const paths = transientSecretStorePaths()
    const vaultText = await readFile(paths.vault, 'utf8')
    const key = await readFile(paths.key)
    expect(key).toHaveLength(32)
    expect(vaultText).not.toContain(plaintext)
    expect(vaultText).toContain('aes-256-gcm')
    expect(vaultText).toContain(ref)

    clearTransientSecrets()
    expect(resolveTransientSecret(ref)).toBe(plaintext)

    forgetTransientSecret(ref)
    clearTransientSecrets()
    expect(resolveTransientSecret(ref)).toBeUndefined()
  })

  it('fails closed when encrypted ciphertext is tampered with', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-secret-tamper-'))
    roots.push(root)
    process.env.DSH_PATROL_SECRET_DIR = root
    clearTransientSecrets()

    const ref = rememberTransientSecret('tamper-test-secret')
    const paths = transientSecretStorePaths()
    const vault = JSON.parse(await readFile(paths.vault, 'utf8'))
    const entry = vault.entries[ref]
    entry.ciphertext = Buffer.from('tampered').toString('base64')
    await writeFile(paths.vault, `${JSON.stringify(vault, null, 2)}\n`, 'utf8')

    clearTransientSecrets()
    expect(() => resolveTransientSecret(ref)).toThrow(/could not be decrypted|integrity verification/i)
  })
})
