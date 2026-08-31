import { defineTool } from '@deepseek-ai/dsh-tools'
import { tryFillImageCode } from './image-code.js'
import { probeOwnedSiteChallenge, trySolveOwnedSiteChallenge } from './captcha-demo.js'

const reqStr = { type: 'string', required: true }
const reqBool = { type: 'boolean', required: true }
const bool = { type: 'boolean' }
const str = { type: 'string' }
const optInt = { type: 'integer' }

const CHALLENGE_KINDS = ['none', 'otp', 'captcha', 'slider', 'approval', 'unknown']
const CHALLENGE_SUBTYPES = ['none', 'otp', 'image-code', 'click-sequence', 'third-party', 'generic-captcha', 'slider', 'slider-puzzle', 'rotate', 'approval', 'unknown']
const CHALLENGE_STRATEGIES = ['none', 'windows-system-ocr', 'ddddocr-click-sequence-demo', 'ddddocr-slider-demo', 'manual-click-sequence', 'manual-slider', 'manual-third-party', 'manual-otp', 'manual-approval', 'manual-review']
const KIND_ORDER = ['slider', 'otp', 'captcha', 'approval', 'unknown']

const CLICK_SEQUENCE_RULES = [
  /依次点击/,
  /按(?:照|顺序).{0,20}点击/,
  /请.{0,20}(?:下图|图片).{0,20}点击/,
  /点击.{0,20}(?:文字|汉字|字符|目标|图标).{0,20}(?:顺序|依次)?/,
  /请选择.{0,20}(?:文字|汉字|字符|图标|目标)/,
  /选出.{0,20}(?:文字|汉字|字符|图标|目标)/,
  /click.{0,30}(?:characters?|words?|symbols?|icons?).{0,30}(?:order|sequence)/i,
  /select.{0,30}(?:characters?|words?|symbols?|icons?)/i,
]

const IMAGE_CODE_RULES = [
  /图形验证码/,
  /图片验证码/,
  /字符验证码/,
  /验证码图片/,
  /验证码.{0,20}(?:输入|填写|字符)/,
  /\bimage[-_ ]?code\b/i,
  /\b(?:captcha|verify|verification)[-_ ]?(?:code|input)\b/i,
  /name[=\s"'_-]*captcha/i,
  /#captcha\b/i,
]

const THIRD_PARTY_RULES = [
  /\brecaptcha\b/i,
  /\bhcaptcha\b/i,
  /\bturnstile\b/i,
  /\barkose\b/i,
  /\bfuncaptcha\b/i,
  /\btc(?:aptcha)?\b/i,
  /captcha\.qq\.com/i,
]

const SLIDER_PUZZLE_RULES = [
  /\bgeetest\b/i,
  /\bjigsaw\b/i,
  /\bpuzzle\b/i,
  /拼图/,
  /缺口/,
  /滑块.{0,20}(?:拼图|缺口)/,
  /拖动.{0,20}(?:拼图|缺口)/,
]

const ROTATE_RULES = [
  /旋转.{0,20}(?:图片|图像|物体|验证码)/,
  /转动.{0,20}(?:图片|图像|物体)/,
  /调整.{0,20}(?:角度|方向)/,
  /rotate.{0,30}(?:image|object|captcha)/i,
  /rotation.{0,20}(?:captcha|challenge)/i,
]

const RULES = {
  slider: [
    /\bslider\b/i,
    /\bdrag\b.{0,30}\b(verify|verification|captcha|puzzle)\b/i,
    /\bgeetest\b/i,
    /\bjigsaw\b/i,
    /滑块/,
    /拖动.{0,20}(验证|拼图|滑块|缺口)/,
    /拼图.{0,20}(验证|滑块|缺口)/,
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
    ...CLICK_SEQUENCE_RULES,
    ...ROTATE_RULES,
    /\bcaptcha\b/i,
    /\brecaptcha\b/i,
    /\bhcaptcha\b/i,
    /\bturnstile\b/i,
    /\barkose\b/i,
    /\bfuncaptcha\b/i,
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
  const observedText = []

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
    observedText.push(text)
    for (const kind of KIND_ORDER) {
      if (matchesAny(text, RULES[kind])) evidenceByKind.get(kind).push({ selector, text })
    }
  }

  const page = String(pageText || '').replace(/\u0000/g, ' ')
  const pageLines = page.split(/\r?\n/).map(line => compact(line, 320)).filter(Boolean)
  observedText.push(...pageLines)
  for (const kind of KIND_ORDER) {
    for (const line of pageLines) {
      if (matchesAny(line, RULES[kind])) evidenceByKind.get(kind).push({ selector: '', text: line })
      if (evidenceByKind.get(kind).length >= 8) break
    }
  }

  const combinedText = observedText.join('\n')
  const kind = matchesAny(combinedText, THIRD_PARTY_RULES)
    ? 'captcha'
    : KIND_ORDER.find(item => evidenceByKind.get(item).length > 0) || 'none'
  const evidence = kind === 'none' ? [] : evidenceByKind.get(kind).slice(0, 5)
  const selectors = [...new Set(evidence.map(item => item.selector).filter(Boolean))].slice(0, 5)
  const subtype = inferChallengeSubtype(kind, combinedText)
  return {
    kind,
    subtype,
    hasChallenge: kind !== 'none',
    selectors,
    evidence: evidence.map(item => compact(item.text, 180)),
  }
}

export function ambiguousDemoFallback(classified, demo) {
  if (!isWeakClassification(classified)) return null
  const kinds = Array.isArray(demo?.visibleKinds) ? [...new Set(demo.visibleKinds)] : []
  if (kinds.length <= 1) return null
  return {
    kind: 'unknown',
    subtype: 'unknown',
    hasChallenge: true,
    selectors: Array.isArray(classified?.selectors) ? classified.selectors : [],
    evidence: [`multiple captcha families visible: ${kinds.join(', ')}`],
  }
}

export function registerChallengeTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'browser_detect_auth_challenge',
    description: 'Detect and classify common post-login verification challenges from safe DOM signals and visible text. Conventional image-text codes may be locally recognized on Windows. Ordered-click and slider/jigsaw demo challenges may be completed locally with ddddocr when explicit DSH Patrol challenge markup is present. On localhost/127.0.0.1 test pages, exact click-sequence or slider-puzzle classifications may also use weak DOM discovery without markup. Remote weak detections stay in the normal handoff path. OTP, approval, rotate, unsupported challenges, and third-party reCAPTCHA/hCaptcha/Turnstile/Arkose-style widgets remain deterministic human handoffs.',
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
          subtype: { type: 'string', required: true, enum: CHALLENGE_SUBTYPES },
          observedKind: { type: 'string', required: true, enum: CHALLENGE_KINDS },
          observedSubtype: { type: 'string', required: true, enum: CHALLENGE_SUBTYPES },
          strategy: { type: 'string', required: true, enum: CHALLENGE_STRATEGIES },
          selectors: { type: 'array', required: true, items: str },
          autoFilled: bool,
          handoffRequired: reqBool,
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Auth challenge: kind=${value.kind}; subtype=${value.subtype}; observed=${value.observedKind}/${value.observedSubtype}; strategy=${value.strategy}; hasChallenge=${value.hasChallenge}; handoffRequired=${value.handoffRequired}${value.autoFilled && !value.handoffRequired ? '; verification auto-completed by the local Patrol solver' : ''}${value.selectors?.length ? `; selectors=${value.selectors.join(', ')}` : ''}`,
      }],
    },
    presentCall: args => ({ card: 'generic', title: 'Detect login verification', kind: 'other', rawInput: args }),
    execute: async (args, exec) => {
      const options = { timeoutMs, signal: exec?.signal }
      let classified = await observeAuthChallenge(bridge, args.tabId, options)
      let initiallyObserved = { kind: classified.kind, subtype: classified.subtype }
      let strategy = strategyForChallenge(initiallyObserved.kind, initiallyObserved.subtype)
      let autoFilled = false
      let imageAutomationRan = false

      if (classified.kind === 'captcha'
        && classified.subtype === 'image-code'
        && process.platform === 'win32') {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let filled = false
          try {
            filled = await tryFillImageCode(bridge, args.tabId, options)
          } catch {
            filled = false
          }
          if (!filled) break

          imageAutomationRan = true
          await sleep(900)
          try {
            classified = await observeAuthChallenge(bridge, args.tabId, options)
          } catch {
            classified = emptyClassification()
            break
          }
          if (classified.kind !== 'captcha' || classified.subtype !== 'image-code') break
        }
        autoFilled = imageAutomationRan && classified.hasChallenge === false
      }

      if (!imageAutomationRan) {
        let demo = { attempted: false, visibleKinds: [] }
        try {
          demo = await trySolveOwnedSiteChallenge(bridge, args.tabId, classified, options)
        } catch {
          demo = { attempted: false, visibleKinds: [] }
        }

        const ambiguous = ambiguousDemoFallback(classified, demo)
        if (ambiguous) {
          classified = ambiguous
          initiallyObserved = { kind: 'unknown', subtype: 'unknown' }
          strategy = 'manual-review'
        } else if (demo.attempted && typeof demo.strategy === 'string') {
          strategy = demo.strategy
          if (isWeakClassification(initiallyObserved)
            && typeof demo.observedKind === 'string'
            && typeof demo.observedSubtype === 'string') {
            initiallyObserved = { kind: demo.observedKind, subtype: demo.observedSubtype }
          }

          if (demo.completed) {
            await sleep(1000)
            try {
              classified = await observeAuthChallenge(bridge, args.tabId, options)
            } catch {
              classified = emptyClassification()
            }
          }

          let visibleProbe = { available: false, kinds: [] }
          try {
            visibleProbe = await probeOwnedSiteChallenge(bridge, args.tabId, options)
          } catch {
          }
          const explicitStillVisible = visibleProbe.available === true
            && Array.isArray(visibleProbe.kinds)
            && visibleProbe.kinds.includes(demo.observedSubtype)

          if (explicitStillVisible) {
            classified = explicitClassification(demo.observedKind, demo.observedSubtype, classified)
          }
          autoFilled = demo.completed === true && classified.hasChallenge === false && !explicitStillVisible
        }
      }

      return {
        ok: true,
        kind: classified.kind,
        subtype: classified.subtype,
        observedKind: initiallyObserved.kind,
        observedSubtype: initiallyObserved.subtype,
        strategy,
        hasChallenge: classified.hasChallenge,
        selectors: classified.selectors,
        autoFilled,
        handoffRequired: classified.kind !== 'none',
      }
    },
  })
  return ctx.tools.register(definition)
}

async function observeAuthChallenge(bridge, tabId, options) {
  const snapshot = await bridge.request('snapshot', {
    maxElements: 300,
    includeHidden: false,
    tabId,
  }, options)
  if (!snapshot || typeof snapshot !== 'object' || snapshot.ok === false) {
    throw new Error(String(snapshot?.error || 'auth challenge snapshot failed'))
  }
  const page = await bridge.request('readPage', {
    maxChars: 12000,
    tabId,
  }, options)
  if (!page || typeof page !== 'object' || page.ok === false) {
    throw new Error(String(page?.error || 'auth challenge page read failed'))
  }

  let extraSignals = []
  try {
    const signalResult = await bridge.request('challengeSignals', { tabId }, options)
    if (signalResult && typeof signalResult === 'object' && Array.isArray(signalResult.signals)) {
      extraSignals = signalResult.signals.filter(item => typeof item === 'string').slice(0, 40)
    }
  } catch {
  }

  const signalText = extraSignals.length > 0 ? `\n${extraSignals.join('\n')}` : ''
  return classifyAuthChallenge(snapshot, `${page.text || ''}${signalText}`)
}

function inferChallengeSubtype(kind, text) {
  if (kind === 'none') return 'none'
  if (kind === 'otp') return 'otp'
  if (kind === 'slider') return matchesAny(text, SLIDER_PUZZLE_RULES) ? 'slider-puzzle' : 'slider'
  if (kind === 'approval') return 'approval'
  if (kind === 'unknown') return 'unknown'
  if (matchesAny(text, THIRD_PARTY_RULES)) return 'third-party'
  if (matchesAny(text, CLICK_SEQUENCE_RULES)) return 'click-sequence'
  if (matchesAny(text, ROTATE_RULES)) return 'rotate'
  if (matchesAny(text, IMAGE_CODE_RULES)) return 'image-code'
  return 'generic-captcha'
}

function strategyForChallenge(kind, subtype) {
  if (kind === 'none') return 'none'
  if (kind === 'captcha' && subtype === 'image-code') return 'windows-system-ocr'
  if (kind === 'captcha' && subtype === 'click-sequence') return 'manual-click-sequence'
  if (kind === 'captcha' && subtype === 'third-party') return 'manual-third-party'
  if (kind === 'slider') return 'manual-slider'
  if (kind === 'otp') return 'manual-otp'
  if (kind === 'approval') return 'manual-approval'
  return 'manual-review'
}

function isWeakClassification(value) {
  return value?.kind === 'none'
    || (value?.kind === 'captcha' && value?.subtype === 'generic-captcha')
    || (value?.kind === 'slider' && value?.subtype === 'slider')
}

function explicitClassification(kind, subtype, previous) {
  return {
    kind,
    subtype,
    hasChallenge: true,
    selectors: Array.isArray(previous?.selectors) ? previous.selectors : [],
    evidence: Array.isArray(previous?.evidence) ? previous.evidence : [],
  }
}

function emptyClassification() {
  return { kind: 'none', subtype: 'none', hasChallenge: false, selectors: [], evidence: [] }
}

function matchesAny(text, rules) {
  return rules.some(rule => rule.test(text))
}

function compact(value, max) {
  const text = String(value || '').replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
