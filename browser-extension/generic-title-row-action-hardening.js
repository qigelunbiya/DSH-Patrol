// Generic precision layer for custom row actions rendered as title-backed spans/divs.
//
// The existing title-backed resolver deliberately stays as a compatibility path.
// This layer broadens it without changing target discovery: locatorText supplies
// the action label, while task/targetContext supplies one or more business identity
// tokens (IP, host name, ticket/device id, Chinese row name, etc.). Each identity is
// tried independently so unrelated identifiers in a long task do not poison the
// target by requiring every identifier to appear in the same row.
//
// Unlike ordinary semantic targets, these enterprise custom actions are handed back
// to the host for a Puppeteer/CDP input click after CURRENT target revalidation.
// This avoids synthetic element.click()/dispatchEvent behavior for actions that may
// require a browser user gesture to open a window or external protocol handler.
// If more than one logical row remains equally plausible, this layer refuses to
// guess and falls through to the previous semantic resolver.

const genericTitleRowPreviousHandleCommand = handleCommand

handleCommand = async function genericTitleRowHandleCommand(cmd, args = {}) {
  if (cmd === 'semanticClick' && genericTitleRowApplicable(args)) {
    try {
      const result = await genericTitleRowClick(args)
      if (result) return result
    } catch {
      // Precision-only layer. Existing Patrol behavior remains the fallback.
    }
  }
  return await genericTitleRowPreviousHandleCommand(cmd, args)
}

function genericTitleRowApplicable(args) {
  return typeof args?.locatorText === 'string'
    && args.locatorText.trim().length > 0
    && [args?.task, args?.targetContext].some(value => typeof value === 'string' && value.trim().length > 0)
}

function genericTitleRowNormalize(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
}

function genericTitleRowTokens(value) {
  const text = String(value || '').normalize('NFKC')
  const tokens = [
    ...(text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []),
    ...(text.match(/[A-Za-z0-9][A-Za-z0-9._:/-]{2,}/g) || []),
    ...(text.match(/[\u3400-\u9fff]{2,}/g) || []),
  ]
  return [...new Set(tokens.map(genericTitleRowNormalize).filter(Boolean))]
}

function genericTitleActionTokens(locatorText) {
  const normalized = genericTitleRowNormalize(locatorText)
  const tokens = genericTitleRowTokens(locatorText)
    .filter(token => !GENERIC_TITLE_ROW_STOP_WORDS.has(token))
  return tokens.length > 0 ? tokens : (normalized ? [normalized] : [])
}

function genericTitleIdentityTokens(args, actionTokens) {
  let source = [args?.task, args?.targetContext]
    .filter(value => typeof value === 'string')
    .join(' ')
  const locator = String(args?.locatorText || '').trim()
  if (locator) {
    const escaped = locator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try { source = source.replace(new RegExp(escaped, 'ig'), ' ') } catch {}
  }
  return genericTitleRowTokens(source)
    .filter(token => !actionTokens.includes(token))
    .filter(token => !GENERIC_TITLE_ROW_STOP_WORDS.has(token))
    .slice(0, 8)
}

function genericTitleIdentityWeight(token) {
  if (/\d|[._:/-]/.test(token)) return 320 + Math.min(80, token.length * 4)
  return 120 + Math.min(70, token.length * 3)
}

const GENERIC_TITLE_ROW_STOP_WORDS = new Set([
  'click', 'open', 'select', 'choose', 'press', 'button', 'action', 'row', 'item', 'target', 'current',
  '点击', '打开', '选择', '按下', '按钮', '操作', '这一行', '该行', '对应', '目标', '当前', '访问', '访问方式', '方式',
].map(genericTitleRowNormalize))

async function genericTitleRowClick(args) {
  if (typeof titleBackedRowActionPageCommand !== 'function') return undefined
  const actionTokens = genericTitleActionTokens(args.locatorText)
  const identityTokens = genericTitleIdentityTokens(args, actionTokens)
  if (actionTokens.length === 0 || identityTokens.length === 0) return undefined

  const tabId = await resolveTabId(args.tabId)
  const frames = await semanticClickFrames(tabId)
  const byTarget = new Map()

  for (const frame of frames) {
    for (const identityToken of identityTokens) {
      const spec = { identityTokens: [identityToken], actionTokens }
      let values
      try {
        values = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frame.frameId] },
          world: 'MAIN',
          func: titleBackedRowActionPageCommand,
          args: ['probe', spec],
        })
      } catch {
        continue
      }
      const value = Array.isArray(values) ? values[0]?.result : undefined
      for (const candidate of Array.isArray(value?.candidates) ? value.candidates : []) {
        if (!candidate || typeof candidate.selector !== 'string' || !candidate.selector) continue
        const weightedScore = Number(candidate.score || 0) + genericTitleIdentityWeight(identityToken)
        const key = `${frame.frameId}|${candidate.selector}`
        const previous = byTarget.get(key)
        if (!previous || weightedScore > previous.score) {
          byTarget.set(key, { frame, candidate, spec, score: weightedScore, identityToken })
        }
      }
    }
  }

  const candidates = [...byTarget.values()].sort((left, right) => right.score - left.score)
  if (candidates.length === 0) return undefined
  const bestScore = candidates[0].score
  const best = candidates.filter(item => item.score === bestScore)
  if (best.length !== 1) return undefined

  // Re-probe immediately before handing the target to the host. The host will
  // send the physical input, so this layer must not synthesize a click itself.
  const chosen = best[0]
  const verifiedResults = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [chosen.frame.frameId] },
    world: 'MAIN',
    func: titleBackedRowActionPageCommand,
    args: ['probe', chosen.spec],
  })
  const verifiedValue = Array.isArray(verifiedResults) ? verifiedResults[0]?.result : undefined
  const verifiedMatches = (Array.isArray(verifiedValue?.candidates) ? verifiedValue.candidates : [])
    .filter(candidate => candidate?.selector === chosen.candidate.selector)
  if (verifiedMatches.length !== 1) return undefined
  const verified = verifiedMatches[0]

  let pageUrl = ''
  try { pageUrl = String((await chrome.tabs.get(tabId))?.url || '') } catch {}

  return {
    ok: true,
    selector: semanticScopeSelector(chosen.frame, verified.selector),
    text: String(verified.text || chosen.candidate.text || ''),
    role: String(verified.role || chosen.candidate.role || 'button'),
    tag: String(verified.tag || chosen.candidate.tag || ''),
    frameId: chosen.frame.frameId,
    frameUrl: chosen.frame.url || '',
    pageUrl,
    trustedClickRequired: true,
    trustedSelector: verified.selector,
    transport: 'host-trusted-click-target',
  }
}
