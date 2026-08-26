import type { JsonValue } from './types.ts'

const SENSITIVE_KEY = /(pass(word|wd)?|secret|token|api[-_]?key|authorization|cookie|session[-_]?id)/i
const SECRET_REFERENCE = /^\$\{(?:secret|env):[^}]+\}$/

export function isSecretReference(value: string): boolean {
  return SECRET_REFERENCE.test(value)
}

export function assertSafeForStorage(value: JsonValue, path = 'arguments'): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value === 'string') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeForStorage(item, `${path}[${index}]`))
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (SENSITIVE_KEY.test(key) && typeof child === 'string' && !isSecretReference(child)) {
      throw new Error(`${childPath} looks sensitive. DSH Patrol refuses to persist plaintext secrets; use an existing authenticated session, a manual checkpoint, or a secret reference.`)
    }
    assertSafeForStorage(child, childPath)
  }
}

export function redactLikelySecrets(text: string): string {
  return text
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/\b(password|passwd|token|secret|authorization|cookie)\s*([:=])\s*([^\s,;]+)/gi, '$1$2[REDACTED]')
}
