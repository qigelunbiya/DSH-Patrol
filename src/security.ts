import type { JsonValue } from './types.js'

const SENSITIVE_KEY = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|otp|captcha|verification[-_]?code)/i
const REFERENCE = /^\$\{(?:credential|secret|env):([A-Za-z_][A-Za-z0-9_]*)\}$/
const CONTACT_REQUEST = /(微信|wechat|手机号|手机号码|电话号码|联系电话|email|e-mail|邮箱|qq号|qq号码)/i

export function isSecretReference(value: string): boolean {
  return REFERENCE.test(value)
}

export function credentialReferenceName(value: string): string | undefined {
  const match = /^\$\{credential:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  return match?.[1]
}

export function credentialPlaceholder(ref: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref)) throw new Error(`invalid credential reference name: ${ref}`)
  return `\${credential:${ref}}`
}

export function collectCredentialReferences(value: JsonValue, refs = new Set<string>()): Set<string> {
  if (typeof value === 'string') {
    const ref = credentialReferenceName(value)
    if (ref !== undefined) refs.add(ref)
    return refs
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return refs
  if (Array.isArray(value)) {
    for (const item of value) collectCredentialReferences(item, refs)
    return refs
  }
  for (const child of Object.values(value)) collectCredentialReferences(child, refs)
  return refs
}

export function assertSafeForStorage(value: JsonValue, path = 'arguments'): void {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return
  if (typeof value === 'string') {
    assertStringSafeForStorage(value, path)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeForStorage(item, `${path}[${index}]`))
    return
  }

  for (const [key, child] of Object.entries(value)) {
    const childPath = `${path}.${key}`
    if (SENSITIVE_KEY.test(key) && typeof child === 'string' && !isSecretReference(child)) {
      throw new Error(`${childPath} looks sensitive. DSH Patrol refuses to persist plaintext secrets; use a Harness credential reference or a manual checkpoint.`)
    }
    assertSafeForStorage(child, childPath)
  }
}

function assertStringSafeForStorage(value: string, path: string): void {
  if (/^Bearer\s+\S+/i.test(value)) {
    throw new Error(`${path} looks like a bearer credential. DSH Patrol refuses to persist it.`)
  }
  if (!/^https?:\/\//i.test(value)) return
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return
  }
  for (const [key, child] of url.searchParams) {
    if (SENSITIVE_KEY.test(key) && child.length > 0 && !isSecretReference(child)) {
      throw new Error(`${path} URL contains sensitive query parameter ${key}; store a credential reference outside the URL instead.`)
    }
  }
  if (/(?:password|passwd|pwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|otp|captcha)\s*(?:=|:)/i.test(url.hash)) {
    throw new Error(`${path} URL fragment appears to contain sensitive data; do not persist secrets in URLs.`)
  }
}


export function assertSafePersistentText(text: string, path = 'text'): void {
  if (/\bBearer\s+\S+/i.test(text)) throw new Error(`${path} contains a bearer credential and cannot be persisted`)
  if (/(?:password|passwd|pwd|密码|口令|token|secret|api[-_ ]?key|authorization|cookie|otp|验证码|captcha|verification[-_ ]?code)\s*(?:是|为|[:：=])\s*[^\s,;，；]+/i.test(text)) {
    throw new Error(`${path} appears to contain a credential value and cannot be persisted`)
  }
}

export function assertSafePublicInputText(text: string): void {
  assertSafePersistentText(text, 'public input text')
  const trimmed = text.trim()
  if (/^\d{3,8}$/.test(trimmed)) {
    throw new Error('numeric code-like text must use patrol_type_credential or a manual checkpoint')
  }
  if (/^[^\s]{6,128}$/.test(trimmed)
    && /[A-Za-z]/.test(trimmed)
    && /\d/.test(trimmed)
    && /[^A-Za-z0-9]/.test(trimmed)) {
    throw new Error('secret-like mixed-character text must use patrol_type_credential')
  }
  if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(trimmed)) {
    throw new Error('JWT-like text must use patrol_type_credential')
  }
}

export function assertSafeCheckpointPrompt(prompt: string): void {
  assertSafePersistentText(prompt, 'checkpoint prompt')
  if (CONTACT_REQUEST.test(prompt)) {
    throw new Error('checkpoint prompts must not request unrelated contact identifiers such as WeChat, phone numbers, QQ, or email')
  }
  if (/(password|passwd|密码|token|cookie|otp|验证码)\s*[:：=]\s*\S+/i.test(prompt)) {
    throw new Error('checkpoint prompts must not contain secret values')
  }
}

export function redactLikelySecrets(text: string, exactSecrets: readonly string[] = []): string {
  let redacted = text
  for (const secret of exactSecrets) {
    if (secret.length === 0) continue
    redacted = redacted.split(secret).join('[REDACTED]')
  }
  return redacted
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(/(password|passwd|pwd|token|secret|authorization|cookie|otp|captcha|密码|口令|验证码|令牌)\s*(是|为|[:=：])\s*([^\s,;，；]+)/gi, '$1$2[REDACTED]')
}

export function untrustedPageData(text: string): string {
  return `--- BEGIN UNTRUSTED PAGE DATA ---\n${text}\n--- END UNTRUSTED PAGE DATA ---`
}
