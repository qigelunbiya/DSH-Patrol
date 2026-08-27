import { describe, expect, it } from 'vitest'
import {
  assertSafeCheckpointPrompt,
  assertSafeForStorage,
  assertSafePersistentText,
  assertSafePublicInputText,
  collectCredentialReferences,
  credentialPlaceholder,
  redactLikelySecrets,
} from '../src/security.ts'


describe('security', () => {
  it('allows credential references and rejects plaintext sensitive keys', () => {
    expect(() => assertSafeForStorage({ password: '${credential:PATROL_PASSWORD}' })).not.toThrow()
    expect(() => assertSafeForStorage({ password: 'plain-secret' })).toThrow(/refuses to persist plaintext/i)
  })

  it('collects credential references recursively', () => {
    const refs = collectCredentialReferences({ a: '${credential:ONE}', nested: [{ x: '${credential:TWO}' }] })
    expect([...refs].sort()).toEqual(['ONE', 'TWO'])
  })

  it('builds only valid credential placeholders', () => {
    expect(credentialPlaceholder('PATROL_PASSWORD')).toBe('${credential:PATROL_PASSWORD}')
    expect(() => credentialPlaceholder('bad-ref')).toThrow(/invalid credential/i)
  })

  it('redacts common secret forms and exact runtime secrets', () => {
    const value = redactLikelySecrets('password=hunter2 Bearer abc.def exactXYZ', ['exactXYZ'])
    expect(value).not.toContain('hunter2')
    expect(value).not.toContain('abc.def')
    expect(value).not.toContain('exactXYZ')
  })


  it('rejects credential values hidden in persistent prose or public typing', () => {
    expect(() => assertSafePersistentText('密码是 demo@1234', 'notes')).toThrow(/credential value/i)
    expect(() => assertSafePublicInputText('demo@1234')).toThrow(/secret-like/i)
    expect(() => assertSafePublicInputText('123456')).toThrow(/code-like/i)
    expect(() => assertSafePublicInputText('demo-user')).not.toThrow()
  })

  it('rejects unrelated contact requests in checkpoints', () => {
    expect(() => assertSafeCheckpointPrompt('请完成登录，然后回来继续')).not.toThrow()
    expect(() => assertSafeCheckpointPrompt('请告诉我你的微信号以继续')).toThrow(/contact identifiers/i)
  })
})
