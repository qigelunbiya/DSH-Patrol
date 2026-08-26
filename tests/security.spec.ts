import { describe, expect, it } from 'vitest'
import { assertSafeForStorage, isSecretReference, redactLikelySecrets } from '../src/security.ts'

describe('security helpers', () => {
  it('accepts secret references but rejects plaintext secret keys', () => {
    expect(isSecretReference('${secret:prod.password}')).toBe(true)
    expect(() => assertSafeForStorage({ password: '${secret:prod.password}' })).not.toThrow()
    expect(() => assertSafeForStorage({ password: 'plain-text-password' })).toThrow(/refuses to persist plaintext secrets/)
  })

  it('redacts common textual secret patterns', () => {
    expect(redactLikelySecrets('token=abc123')).toContain('[REDACTED]')
    expect(redactLikelySecrets('Authorization: Bearer abc.def')).not.toContain('abc.def')
  })
})
