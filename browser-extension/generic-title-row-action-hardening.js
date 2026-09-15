// Generic precision layer for custom row actions rendered as title-backed spans/divs.
//
// The existing title-backed resolver deliberately stays as a compatibility path.
// This layer broadens it without changing its click mechanics: locatorText supplies
// the action label, while task/targetContext supplies one or more business identity
// tokens (IP, host name, ticket/device id, Chinese row name, etc.). Each identity is
// tried independently so unrelated identifiers in a long task do not poison the
// target by requiring every identifier to appear in the same row.
//
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

  const chosen = best[0]
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [chosen.frame.frameId] },
    world: 'MAIN',
    func: titleBackedRowActionPageCommand,
    args: ['click', chosen.spec],
  })
  const clicked = Array.isArray(results) ? results[0]?.result : undefined
  if (!clicked || clicked.ok !== true || typeof clicked.selector !== 'string' || !clicked.selector) return undefined

  return {
    ok: true,
    selector: semanticScopeSelector(chosen.frame, clicked.selector),
    text: String(clicked.text || ''),
    role: String(clicked.role || 'button'),
    tag: String(clicked.tag || ''),
    frameId: chosen.frame.frameId,
    frameUrl: chosen.frame.url || '',
    transport: 'atomic-main-world-generic-title-row-action-click',
  }
}
