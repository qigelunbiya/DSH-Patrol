// Geometry-aware semantic-click fallback for repeated row actions.
//
// Enterprise UIs often render an identity column and an action column as
// separate DOM trees (fixed/sticky columns, virtualized grids, flex layouts),
// so a target such as "10.0.0.2 + RDP" may have no shared <tr> at all. The
// older row resolvers intentionally fail closed in that situation. This layer
// keeps that safety property but adds two CURRENT-page correlations:
//   1) the smallest common visible container that binds identity + action;
//   2) screen-space row alignment between the visible identity text and action.
// It therefore handles normal tables, div grids and split/fixed columns without
// asking the model to invent :has-text(), :contains(), XPath or nth-child CSS.

const semanticLayoutRowActionPreviousHandleCommand = handleCommand

handleCommand = async function semanticLayoutRowActionHandleCommand(cmd, args = {}) {
  if (cmd === 'semanticClick' && semanticLayoutRowActionApplicable(args)) {
    try {
      const result = await semanticLayoutRowActionClick(args)
      if (result) return result
    } catch {
      // Precision fallback only. Existing semantic layers remain available.
    }
  }
  return await semanticLayoutRowActionPreviousHandleCommand(cmd, args)
}

function semanticLayoutRowActionApplicable(args) {
  return typeof args?.locatorText === 'string'
    && args.locatorText.trim().length > 0
    && [args?.targetContext, args?.task].some(value => typeof value === 'string' && value.trim().length > 0)
}

function semanticLayoutNormalize(value) {
  return String(value || '').normalize('NFKC').replace(/\s+/g, '').toLocaleLowerCase()
}

const SEMANTIC_LAYOUT_STOP_WORDS = new Set([
  'empty', 'click', 'open', 'select', 'choose', 'press', 'button', 'action', 'row', 'item', 'target', 'current',
  '点击', '打开', '选择', '按下', '按钮', '操作', '这一行', '该行', '对应', '目标', '当前', '访问', '访问方式', '方式',
  '这台', '这个', '这条', '主机', '设备', '机器', '运维机', '链接',
].map(semanticLayoutNormalize))

function semanticLayoutTokens(value) {
  const text = String(value || '').normalize('NFKC')
  const tokens = [
    ...(text.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []),
    ...(text.match(/[A-Za-z0-9][A-Za-z0-9._:/-]{1,}/g) || []),
    ...(text.match(/[\u3400-\u9fff]{2,}/g) || []),
  ]
  return [...new Set(tokens.map(semanticLayoutNormalize).filter(Boolean))]
}

function semanticLayoutActionTokens(locatorText) {
  const normalized = semanticLayoutNormalize(locatorText)
  const tokens = semanticLayoutTokens(locatorText)
    .filter(token => !SEMANTIC_LAYOUT_STOP_WORDS.has(token))
  return tokens.length > 0 ? tokens : (normalized ? [normalized] : [])
}

function semanticLayoutIdentityTokens(args, actionTokens) {
  let source = [args?.targetContext, args?.task]
    .filter(value => typeof value === 'string' && value.trim())
    .join(' ')
  const locator = String(args?.locatorText || '').trim()
  if (locator) {
    const escaped = locator.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    try { source = source.replace(new RegExp(escaped, 'ig'), ' ') } catch {}
  }
  const tokens = semanticLayoutTokens(source)
    .filter(token => !actionTokens.includes(token))
    .filter(token => !SEMANTIC_LAYOUT_STOP_WORDS.has(token))
  const strong = tokens.filter(token => /\d|[._:/-]/.test(token))
  return (strong.length > 0 ? strong : tokens).slice(0, 6)
}

function semanticLayoutIdentityWeight(token) {
  if (/\d|[._:/-]/.test(token)) return 360 + Math.min(120, token.length * 5)
  return 160 + Math.min(80, token.length * 4)
}

async function semanticLayoutRowActionClick(args) {
  if (typeof semanticClickFrames !== 'function' || typeof semanticScopeSelector !== 'function') return undefined
  const actionTokens = semanticLayoutActionTokens(args.locatorText)
  const identityTokens = semanticLayoutIdentityTokens(args, actionTokens)
  if (actionTokens.length === 0 || identityTokens.length === 0) return undefined

  const tabId = await resolveTabId(args.tabId)
  const frames = await semanticClickFrames(tabId)
  const byTarget = new Map()

  for (const frame of frames) {
    let values
    try {
      values = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: semanticLayoutRowActionPageCommand,
        args: ['probe', { actionTokens, identityTokens }],
      })
    } catch {
      continue
    }
    const value = Array.isArray(values) ? values[0]?.result : undefined
    for (const candidate of Array.isArray(value?.candidates) ? value.candidates : []) {
      if (!candidate || typeof candidate.selector !== 'string' || !candidate.selector) continue
      const identityToken = typeof candidate.identityToken === 'string' ? candidate.identityToken : ''
      const weightedScore = Number(candidate.score || 0) + semanticLayoutIdentityWeight(identityToken)
      const key = `${frame.frameId}|${candidate.selector}`
      const previous = byTarget.get(key)
      if (!previous || weightedScore > previous.score) {
        byTarget.set(key, { frame, candidate, score: weightedScore })
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
    func: semanticLayoutRowActionPageCommand,
    args: ['click', {
      actionTokens,
      identityTokens,
      expectedSelector: chosen.candidate.selector,
    }],
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
    transport: 'atomic-main-world-layout-correlated-click',
  }
}

// Serialized into the page MAIN world. Keep this function self-contained.
async function semanticLayoutRowActionPageCommand(mode, spec) {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const normalize = value => compact(value).replace(/\s+/g, '').toLocaleLowerCase()
  const cssEscape = value => globalThis.CSS?.escape
    ? CSS.escape(String(value))
    : String(value).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)
  const cssString = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const visible = element => {
    if (!(element instanceof Element) || !element.isConnected) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const disabled = element => element.matches?.(':disabled,[aria-disabled="true"]') === true
  const unique = selector => {
    try { return document.querySelectorAll(selector).length === 1 } catch { return false }
  }
  const depth = element => {
    let value = 0
    let node = element
    while (node instanceof Element && node !== document.documentElement && value < 32) {
      value += 1
      node = node.parentElement
    }
    return value
  }
  const stableSelector = element => {
    if (element.id) return `#${cssEscape(element.id)}`
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'name', 'aria-label']) {
      const value = element.getAttribute?.(attr)
      if (!value) continue
      const selector = `${element.tagName.toLowerCase()}[${attr}="${cssString(value)}"]`
      if (unique(selector)) return selector
    }
    const title = element.getAttribute?.('title')
    if (title) {
      const selector = `${element.tagName.toLowerCase()}[title="${cssString(title)}"]`
      if (unique(selector)) return selector
    }
    const classes = [...(element.classList || [])]
      .filter(name => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name))
      .slice(0, 2)
    if (classes.length > 0) {
      const selector = `${element.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`
      if (unique(selector)) return selector
    }
    const parts = []
    let node = element
    while (node instanceof Element && node !== document.documentElement && parts.length < 12) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const peers = [...parent.children].filter(child => child.tagName === node.tagName)
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(node) + 1})`
      }
      parts.unshift(part)
      const selector = parts.join(' > ')
      if (unique(selector)) return selector
      node = parent
    }
    return parts.join(' > ')
  }
  const actionText = element => {
    const parts = [element.getAttribute?.('aria-label'), element.getAttribute?.('title')]
    if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase())) parts.push(element.value)
    if (element instanceof HTMLImageElement) parts.push(element.getAttribute('alt'))
    parts.push(element.innerText, element.textContent)
    for (const image of element.querySelectorAll?.('img') || []) parts.push(image.getAttribute('alt'), image.getAttribute('title'))
    return compact(parts.filter(Boolean).join(' '))
  }
  const roleOf = element => compact(element.getAttribute?.('role')
    || (element.tagName === 'A' ? 'link'
      : element.tagName === 'BUTTON' ? 'button'
        : element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase()) ? 'button' : ''))
  const rowLikeSelector = [
    'tr', '[role="row"]', '.ant-table-row', '.el-table__row', '.ivu-table-row', '.arco-table-tr', '.vxe-body--row',
    '[class*="table-row"]', '[class*="list-row"]', '[class*="data-row"]', '[data-row-key]', '[aria-rowindex]', '[data-index]',
  ].join(',')
  const rowText = row => normalize(row?.innerText || row?.textContent || '')
  const nearestRowKey = element => {
    let node = element
    for (let level = 0; node instanceof Element && level < 12; level += 1, node = node.parentElement) {
      for (const attr of ['data-row-key', 'data-key', 'row-key', 'aria-rowindex', 'data-index']) {
        const value = node.getAttribute?.(attr)
        if (value !== null && String(value).trim()) return `${attr}:${String(value).trim()}`
      }
    }
    return ''
  }
  const lowestCommonAncestor = (left, right) => {
    if (!(left instanceof Element) || !(right instanceof Element)) return null
    const seen = new Set()
    let node = left
    while (node instanceof Element) {
      seen.add(node)
      node = node.parentElement
    }
    node = right
    while (node instanceof Element) {
      if (seen.has(node)) return node
      node = node.parentElement
    }
    return null
  }
  const domDistance = (left, right, common) => {
    let distance = 0
    let node = left
    while (node instanceof Element && node !== common && distance < 24) {
      distance += 1
      node = node.parentElement
    }
    node = right
    while (node instanceof Element && node !== common && distance < 48) {
      distance += 1
      node = node.parentElement
    }
    return distance
  }
  const centerY = element => {
    const rect = element.getBoundingClientRect()
    return rect.top + rect.height / 2
  }
  const identityTokens = Array.isArray(spec?.identityTokens) ? spec.identityTokens.map(normalize).filter(Boolean) : []
  const actionTokens = Array.isArray(spec?.actionTokens) ? spec.actionTokens.map(normalize).filter(Boolean) : []
  if (identityTokens.length === 0 || actionTokens.length === 0) return { ok: true, candidates: [] }

  const root = document.body || document.documentElement
  if (!(root instanceof Element)) return { ok: true, candidates: [] }
  const identityAnchors = []
  const identitySeen = new Set()
  for (const token of identityTokens) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
    let textNode
    while ((textNode = walker.nextNode())) {
      if (!normalize(textNode.nodeValue).includes(token)) continue
      const element = textNode.parentElement
      if (!(element instanceof Element) || !visible(element)) continue
      const key = `${token}|${stableSelector(element)}`
      if (identitySeen.has(key)) continue
      identitySeen.add(key)
      identityAnchors.push({ element, token })
      if (identityAnchors.length >= 80) break
    }
    if (identityAnchors.length >= 80) break
  }
  if (identityAnchors.length === 0) return { ok: true, candidates: [] }

  const candidateSelector = [
    'a', 'button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[onclick]', '[data-action]', '[title]', '[tabindex]:not([tabindex="-1"])',
    '[class*="button" i]', '[class*="btn" i]', '[class*="action" i]', '[class*="act_" i]',
  ].join(',')
  const actionElements = [...new Set([...document.querySelectorAll(candidateSelector)])]
    .filter(element => visible(element) && !disabled(element))

  const actionMatchScore = element => {
    const text = normalize(actionText(element))
    if (!text) return 0
    const title = normalize(element.getAttribute?.('title') || '')
    const aria = normalize(element.getAttribute?.('aria-label') || '')
    let best = 0
    for (const token of actionTokens) {
      if (text === token) best = Math.max(best, 360)
      else if (text.includes(token)) best = Math.max(best, 230)
      if (title === token || aria === token) best = Math.max(best, 410)
      else if (title.includes(token) || aria.includes(token)) best = Math.max(best, 350)
    }
    if (best === 0) return 0
    const tag = element.tagName.toLowerCase()
    if (tag === 'a' || tag === 'button' || roleOf(element) === 'button' || roleOf(element) === 'link') best += 70
    best += Math.min(35, depth(element))
    return best
  }

  const relationScore = (action, anchor, token) => {
    const actionRect = action.getBoundingClientRect()
    const identityRect = anchor.getBoundingClientRect()
    let score = 0
    let reason = ''

    const actionRow = action.closest(rowLikeSelector)
    if (actionRow instanceof Element && rowText(actionRow).includes(token)) {
      score = 1500
      reason = 'same-structured-row'
    }

    const actionKey = nearestRowKey(action)
    const identityKey = nearestRowKey(anchor)
    if (actionKey && identityKey && actionKey === identityKey && score < 1450) {
      score = 1450
      reason = 'matching-row-key'
    }

    const common = lowestCommonAncestor(action, anchor)
    if (common instanceof Element && common !== document.body && common !== document.documentElement) {
      const rect = common.getBoundingClientRect()
      const distance = domDistance(action, anchor, common)
      const boundedHeight = rect.height <= Math.max(180, Math.max(actionRect.height, identityRect.height) * 5)
      if (boundedHeight) {
        let commonScore = 760 - Math.min(360, distance * 30)
        const marker = `${common.id || ''} ${common.getAttribute('class') || ''} ${common.getAttribute('role') || ''}`
        if (/row|item|record|entry|line/i.test(marker)) commonScore += 180
        if (commonScore > score) {
          score = commonScore
          reason = 'bounded-common-container'
        }
      }
    }

    const deltaY = Math.abs(centerY(action) - centerY(anchor))
    const threshold = Math.max(12, Math.min(56, (actionRect.height + identityRect.height) * 0.85 + 8))
    if (deltaY <= threshold) {
      const geometryScore = 980 - Math.min(620, deltaY * 12)
      if (geometryScore > score) {
        score = geometryScore
        reason = 'screen-row-alignment'
      }
    }

    return { score, reason }
  }

  const candidates = []
  for (const element of actionElements) {
    const actionScore = actionMatchScore(element)
    if (actionScore <= 0) continue
    let bestRelation = null
    for (const anchor of identityAnchors) {
      const relation = relationScore(element, anchor.element, anchor.token)
      if (relation.score < 520) continue
      const total = actionScore + relation.score
      if (!bestRelation || total > bestRelation.total) {
        bestRelation = { total, relation, anchor }
      }
    }
    if (!bestRelation) continue
    candidates.push({
      element,
      score: bestRelation.total,
      text: actionText(element),
      role: roleOf(element) || 'button',
      tag: element.tagName.toLowerCase(),
      identityToken: bestRelation.anchor.token,
      correlation: bestRelation.relation.reason,
    })
  }

  candidates.sort((left, right) => right.score - left.score)
  if (candidates.length === 0) return { ok: true, candidates: [] }

  if (typeof spec?.expectedSelector === 'string' && spec.expectedSelector) {
    const exact = candidates.find(item => stableSelector(item.element) === spec.expectedSelector)
    if (exact) {
      candidates.splice(0, candidates.length, exact)
    }
  }

  const bestScore = candidates[0].score
  const best = candidates.filter(item => item.score === bestScore)
  const serialized = best.slice(0, 8).map(item => ({
    score: item.score,
    selector: stableSelector(item.element),
    text: item.text,
    role: item.role,
    tag: item.tag,
    identityToken: item.identityToken,
    correlation: item.correlation,
  }))
  if (mode === 'probe') return { ok: true, candidates: serialized }
  if (best.length !== 1) return { ok: false, error: `layout-correlated action is ambiguous (${best.length})`, candidates: serialized }

  const chosen = best[0]
  const element = chosen.element
  element.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' })
  await new Promise(resolve => requestAnimationFrame(resolve))
  if (!element.isConnected || !visible(element)) return { ok: false, error: 'layout-correlated action detached before click' }
  const rect = element.getBoundingClientRect()
  const x = rect.left + Math.max(1, rect.width / 2)
  const y = rect.top + Math.max(1, rect.height / 2)
  element.focus?.({ preventScroll: true })
  if (typeof PointerEvent !== 'undefined') {
    for (const type of ['pointerover', 'pointermove', 'pointerdown', 'pointerup']) {
      element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }))
    }
  }
  for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) {
    element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }))
  }
  if (typeof element.click === 'function') element.click()
  else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }))

  return {
    ok: true,
    selector: stableSelector(element),
    text: chosen.text,
    role: chosen.role,
    tag: chosen.tag,
    identityToken: chosen.identityToken,
    correlation: chosen.correlation,
  }
}
