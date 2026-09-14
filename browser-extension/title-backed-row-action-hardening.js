// Atomic semantic-click hardening for enterprise table/list actions rendered as
// title-backed spans/divs rather than native <a>/<button> elements.
//
// Typical examples are fixed/sticky action cells whose visible DOM is:
//   <span title="[RDP] [EMPTY]">[RDP] [EMPTY]</span>
// The action can still be genuinely clickable through a React/delegated parent
// handler. Guessing an <a> selector can therefore never work. This layer uses
// the user task's business identity (for example a host IP) plus the requested
// protocol/action, correlates the correct logical row, and clicks the actual
// title-backed node in the page MAIN world.

const titleBackedRowActionPreviousHandleCommand = handleCommand

handleCommand = async function titleBackedRowActionHandleCommand(cmd, args = {}) {
  if (cmd === 'semanticClick' && titleBackedRowActionApplicable(args)) {
    try {
      const result = await titleBackedRowActionClick(args)
      if (result) return result
    } catch {
      // Precision layer only. Fall through to the existing semantic resolver.
    }
  }
  return await titleBackedRowActionPreviousHandleCommand(cmd, args)
}

function titleBackedRowActionSource(args) {
  return [args?.task, args?.locatorText, args?.targetContext]
    .filter(value => typeof value === 'string')
    .join(' ')
}

function titleBackedRowActionApplicable(args) {
  const source = titleBackedRowActionSource(args)
  return /\b\d{1,3}(?:\.\d{1,3}){3}\b/.test(source)
    && /\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/i.test(source)
}

async function titleBackedRowActionClick(args) {
  const source = titleBackedRowActionSource(args)
  const identityTokens = [...new Set(source.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [])]
  const actionTokens = [...new Set((source.match(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi) || []).map(value => value.toUpperCase()))]
  if (identityTokens.length === 0 || actionTokens.length === 0) return undefined

  const tabId = await resolveTabId(args.tabId)
  const frames = await semanticClickFrames(tabId)
  const spec = { identityTokens, actionTokens }
  const candidates = []

  for (const frame of frames) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: titleBackedRowActionPageCommand,
        args: ['probe', spec],
      })
      const value = Array.isArray(results) ? results[0]?.result : undefined
      for (const candidate of Array.isArray(value?.candidates) ? value.candidates : []) {
        candidates.push({ frame, candidate })
      }
    } catch {
      // Other accessible frames remain eligible.
    }
  }

  if (candidates.length === 0) return undefined
  candidates.sort((left, right) => Number(right.candidate.score || 0) - Number(left.candidate.score || 0))
  const bestScore = Number(candidates[0]?.candidate?.score || 0)
  const best = candidates.filter(item => Number(item.candidate.score || 0) === bestScore)
  if (best.length !== 1) return undefined

  const chosen = best[0]
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [chosen.frame.frameId] },
    world: 'MAIN',
    func: titleBackedRowActionPageCommand,
    args: ['click', spec],
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
    transport: 'atomic-main-world-title-row-action-click',
  }
}

// Serialized into the page MAIN world. Keep this function self-contained.
function titleBackedRowActionPageCommand(mode, spec) {
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
  const unique = selector => {
    try { return document.querySelectorAll(selector).length === 1 } catch { return false }
  }
  const rowLikeSelector = [
    'tr', '[role="row"]', '.ant-table-row', '.el-table__row', '.ivu-table-row', '.arco-table-tr', '.vxe-body--row',
    '[class*="table-row"]', '[class*="list-row"]', '[data-row-key]', '[aria-rowindex]', '[data-index]',
  ].join(',')
  const rowText = row => normalize(row?.innerText || row?.textContent || '')
  const rowKey = row => {
    if (!(row instanceof Element)) return ''
    for (const attr of ['data-row-key', 'data-key', 'row-key', 'data-index', 'aria-rowindex']) {
      const value = row.getAttribute(attr)
      if (value !== null && String(value).trim()) return `${attr}:${String(value).trim()}`
    }
    return ''
  }
  const rowOrdinal = row => {
    if (!(row instanceof Element) || !(row.parentElement instanceof Element)) return -1
    const peers = [...row.parentElement.children].filter(child => child.matches?.(rowLikeSelector))
    return peers.indexOf(row)
  }
  const stableSelector = element => {
    if (element.id) return `#${cssEscape(element.id)}`
    const title = element.getAttribute('title')
    if (title) {
      const byTitle = `${element.tagName.toLowerCase()}[title="${cssString(title)}"]`
      if (unique(byTitle)) return byTitle
      const row = element.closest(rowLikeSelector)
      if (row instanceof Element) {
        const key = row.getAttribute('data-row-key')
        const ariaIndex = row.getAttribute('aria-rowindex')
        const dataIndex = row.getAttribute('data-index')
        let rowSelector = ''
        if (key) rowSelector = `[data-row-key="${cssString(key)}"]`
        else if (ariaIndex) rowSelector = `[aria-rowindex="${cssString(ariaIndex)}"]`
        else if (dataIndex) rowSelector = `[data-index="${cssString(dataIndex)}"]`
        else if (row.parentElement) {
          const peers = [...row.parentElement.children].filter(child => child.tagName === row.tagName)
          const index = peers.indexOf(row)
          if (index >= 0) {
            const parentClass = [...row.parentElement.classList].find(name => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name))
            rowSelector = `${parentClass ? `.${cssEscape(parentClass)} > ` : ''}${row.tagName.toLowerCase()}:nth-of-type(${index + 1})`
          }
        }
        if (rowSelector) {
          const candidate = `${rowSelector} ${byTitle}`
          if (unique(candidate)) return candidate
        }
      }
    }
    const parts = []
    let node = element
    while (node instanceof Element && node !== document.documentElement && parts.length < 12) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      const cls = [...node.classList].find(name => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name))
      if (cls) part += `.${cssEscape(cls)}`
      if (parent) {
        const peers = [...parent.children].filter(child => child.tagName === node.tagName)
        if (peers.length > 1) part += `:nth-of-type(${peers.indexOf(node) + 1})`
      }
      parts.unshift(part)
      const candidate = parts.join(' > ')
      if (unique(candidate)) return candidate
      node = parent
    }
    return parts.join(' > ')
  }

  const identities = Array.isArray(spec.identityTokens) ? spec.identityTokens.map(normalize).filter(Boolean) : []
  const actions = Array.isArray(spec.actionTokens) ? spec.actionTokens.map(normalize).filter(Boolean) : []
  const allRows = [...new Set([...document.querySelectorAll(rowLikeSelector)])].filter(visible)
  const identityRows = allRows.filter(row => identities.length > 0 && identities.every(token => rowText(row).includes(token)))
  if (identityRows.length === 0) return { ok: true, candidates: [] }

  const correlate = actionRow => {
    if (!(actionRow instanceof Element)) return null
    const directText = rowText(actionRow)
    if (identities.every(token => directText.includes(token))) {
      return { identityRow: actionRow, bonus: 500, reason: 'same-row' }
    }
    const actionKey = rowKey(actionRow)
    const actionOrdinal = rowOrdinal(actionRow)
    const actionRect = actionRow.getBoundingClientRect()
    let best = null
    for (const identityRow of identityRows) {
      const identityKey = rowKey(identityRow)
      const identityOrdinal = rowOrdinal(identityRow)
      const identityRect = identityRow.getBoundingClientRect()
      let bonus = 0
      let reason = ''
      if (actionKey && identityKey && actionKey === identityKey) {
        bonus = 450
        reason = 'row-key'
      } else if (actionOrdinal >= 0 && identityOrdinal >= 0 && actionOrdinal === identityOrdinal && actionRow.parentElement !== identityRow.parentElement) {
        bonus = 360
        reason = 'parallel-row-ordinal'
      }
      const topDelta = Math.abs(actionRect.top - identityRect.top)
      if (topDelta <= 8 && actionRow !== identityRow && bonus < 340) {
        bonus = 340
        reason = 'parallel-row-top'
      }
      if (bonus > (best?.bonus || 0)) best = { identityRow, bonus, reason }
    }
    return best && best.bonus > 0 ? best : null
  }

  const candidates = []
  for (const element of [...document.querySelectorAll('[title]')]) {
    if (!visible(element)) continue
    const title = compact(element.getAttribute('title'))
    const normalizedTitle = normalize(title)
    if (!actions.some(token => normalizedTitle.includes(token))) continue
    const actionRow = element.closest(rowLikeSelector)
    if (!(actionRow instanceof Element)) continue
    const correlation = correlate(actionRow)
    if (!correlation) continue

    const exactBracketBonus = actions.some(token => normalizedTitle.includes(`[${token}]`)) ? 180 : 100
    const titleSpecificity = Math.max(0, 80 - Math.min(80, title.length))
    const score = 1000 + correlation.bonus + exactBracketBonus + titleSpecificity
    candidates.push({
      element,
      score,
      text: title || compact(element.textContent),
      context: compact(`${correlation.identityRow?.innerText || correlation.identityRow?.textContent || ''} ${actionRow.innerText || actionRow.textContent || ''}`).slice(0, 320),
      correlation: correlation.reason,
    })
  }

  candidates.sort((left, right) => right.score - left.score)
  if (candidates.length === 0) return { ok: true, candidates: [] }
  const bestScore = candidates[0].score
  const best = candidates.filter(item => item.score === bestScore)
  const serialized = best.slice(0, 8).map(item => ({
    score: item.score,
    selector: stableSelector(item.element),
    text: item.text,
    role: item.element.getAttribute('role') || 'button',
    tag: item.element.tagName.toLowerCase(),
    context: item.context,
    correlation: item.correlation,
  }))
  if (mode === 'probe') return { ok: true, candidates: serialized }
  if (best.length !== 1) return { ok: false, error: `title-backed row action is ambiguous (${best.length})`, candidates: serialized }

  const chosen = best[0]
  const element = chosen.element
  element.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' })
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
    role: element.getAttribute('role') || 'button',
    tag: element.tagName.toLowerCase(),
    context: chosen.context,
    correlation: chosen.correlation,
  }
}
