import { defineTool } from '@deepseek-ai/dsh-tools'

const reqStr = { type: 'string', required: true }
const reqBool = { type: 'boolean', required: true }
const str = { type: 'string' }
const optInt = { type: 'integer' }

const CHALLENGE_KINDS = ['none', 'otp', 'captcha', 'slider', 'approval', 'unknown']
const KIND_ORDER = ['slider', 'otp', 'captcha', 'approval', 'unknown']

const RULES = {
  slider: [
    /\bslider\b/i,
    /\bdrag\b.{0,30}\b(verify|verification|captcha|puzzle)\b/i,
    /\bgeetest\b/i,
    /滑块/,
    /拖动.{0,20}(验证|拼图|滑块)/,
    /拼图.{0,20}(验证|滑块)/,
  ],
  otp: [
    /\botp\b/i,
    /one[-\s]?time.{0,20}(code|password)/i,
    /verification.{0,10}code/i,
    /verify.{0,10}code/i,
    /短信验证码/,
    /手机验证码/,
    /邮箱验证码/,
    /邮件验证码/,
    /动态验证码/,
    /动态码/,
    /一次性(密码|验证码)/,
    /安全码/,
  ],
  captcha: [
    /\bcaptcha\b/i,
    /\brecaptcha\b/i,
    /\bhcaptcha\b/i,
    /\bturnstile\b/i,
    /图形验证码/,
    /图片验证码/,
    /字符验证码/,
    /验证码图片/,
    /人机验证/,
    /机器人验证/,
    /verify you are human/i,
  ],
  approval: [
    /\bpasskey\b/i,
    /security key/i,
    /push.{0,20}(approve|approval|notification)/i,
    /approve.{0,20}(sign[-\s]?in|login)/i,
    /扫码(登录|验证)/,
    /二维码.{0,20}(登录|验证|确认)/,
    /确认登录/,
    /在.{0,20}(手机|设备|应用).{0,20}确认/,
    /安全密钥/,
  ],
  unknown: [
    /security check/i,
    /additional verification/i,
    /identity verification/i,
    /身份验证/,
    /安全验证/,
    /额外验证/,
    /二次验证/,
  ],
}

export function classifyAuthChallenge(snapshotValue, pageText = '') {
  const elements = Array.isArray(snapshotValue?.elements) ? snapshotValue.elements : []
  const evidenceByKind = new Map(CHALLENGE_KINDS.map(kind => [kind, []]))

  for (const element of elements) {
    if (!element || typeof element !== 'object') continue
    const selector = typeof element.selector === 'string' ? element.selector : ''
    const text = compact([
      element.text,
      element.name,
      element.type,
      element.role,
      selector,
    ].filter(value => typeof value === 'string').join(' '), 320)
    if (!text) continue
    for (const kind of KIND_ORDER) {
      if (matchesAny(text, RULES[kind])) {
        evidenceByKind.get(kind).push({ selector, text })
      }
    }
  }

  const page = String(pageText || '').replace(/\u0000/g, ' ')
  const pageLines = page.split(/\r?\n/).map(line => compact(line, 320)).filter(Boolean)
  for (const kind of KIND_ORDER) {
    for (const line of pageLines) {
      if (matchesAny(line, RULES[kind])) evidenceByKind.get(kind).push({ selector: '', text: line })
      if (evidenceByKind.get(kind).length >= 8) break
    }
  }

  const kind = KIND_ORDER.find(item => evidenceByKind.get(item).length > 0) || 'none'
  const evidence = kind === 'none' ? [] : evidenceByKind.get(kind).slice(0, 5)
  const selectors = [...new Set(evidence.map(item => item.selector).filter(Boolean))].slice(0, 5)
  return {
    kind,
    hasChallenge: kind !== 'none',
    selectors,
    evidence: evidence.map(item => compact(item.text, 180)),
  }
}

export function registerChallengeTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'browser_detect_auth_challenge',
    description: 'Detect common post-login human-verification challenges from a safe page snapshot and visible text. This tool classifies only; it never solves, bypasses, OCRs, drags, or submits a challenge.',
    parameters: {
      tabId: optInt,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: reqBool,
          hasChallenge: reqBool,
          kind: { type: 'string', required: true, enum: CHALLENGE_KINDS },
          selectors: { type: 'array', required: true, items: str },
          evidence: { type: 'array', required: true, items: str },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Auth challenge: kind=${value.kind}; hasChallenge=${value.hasChallenge}${value.selectors?.length ? `; selectors=${value.selectors.join(', ')}` : ''}${value.evidence?.length ? `; evidence=${value.evidence.join(' | ')}` : ''}`,
      }],
    },
    presentCall: args => ({ card: 'generic', title: 'Detect login verification', kind: 'other', rawInput: args }),
    execute: async (args, exec) => {
      const options = { timeoutMs, signal: exec?.signal }
      const snapshot = await bridge.request('snapshot', {
        maxElements: 300,
        includeHidden: false,
        tabId: args.tabId,
      }, options)
      if (!snapshot || typeof snapshot !== 'object' || snapshot.ok === false) {
        throw new Error(String(snapshot?.error || 'auth challenge snapshot failed'))
      }
      const page = await bridge.request('readPage', {
        maxChars: 12000,
        tabId: args.tabId,
      }, options)
      if (!page || typeof page !== 'object' || page.ok === false) {
        throw new Error(String(page?.error || 'auth challenge page read failed'))
      }
      const classified = classifyAuthChallenge(snapshot, page.text || '')
      return { ok: true, ...classified }
    },
  })
  return ctx.tools.register(definition)
}

function matchesAny(text, rules) {
  return rules.some(rule => rule.test(text))
}

function compact(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}
