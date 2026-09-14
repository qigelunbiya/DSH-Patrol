// Contextual semantic-click hardening for table/list actions with duplicate labels.
//
// Enterprise consoles frequently render the identity columns and action columns
// in different DOM trees (fixed-right tables, virtualized grids, duplicated
// panes). A plain "RDP" semantic click then sees several equal labels even
// though the user named one host. This layer binds the requested business
// identity to the matching logical row before delegating to the base resolver.
// It is generic and does not hard-code any site, host or address.

const semanticRowContextPreviousHandleCommand = handleCommand

handleCommand = async function semanticRowContextHandleCommand(cmd, args = {}) {
  if (cmd === 'semanticClick' && semanticRowContextApplicable(args)) {
    try {
      const resolved = await semanticRowContextClick(args)
      if (resolved) return resolved
    } catch {
      // Fall through to the existing semantic resolver. This layer is a
      // precision improvement, never permission to guess an arbitrary row.
    }
  }
  return await semanticRowContextPreviousHandleCommand(cmd, args)
}

function semanticRowContextSource(args) {
  return [args?.task, args?.locatorText, args?.targetContext].filter(value => typeof value === 'string').join(' ')
}

function semanticRowContextApplicable(args) {
  const source = semanticRowContextSource(args)
  const identities = source.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []
  const actions = source.match(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi) || []
  return identities.length > 0 && actions.length > 0
}

async function semanticRowContextClick(args) {
  const source = semanticRowContextSource(args)
  const identityTokens = [...new Set(source.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [])]
  const actionTokens = [...new Set((source.match(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi) || []).map(value => value.toUpperCase()))]
  if (identityTokens.length === 0 || actionTokens.length === 0) return undefined

  const tabId = await resolveTabId(args.tabId)
  const frames = await semanticClickFrames(tabId)
  const candidates = []
  const spec = {
    identityTokens,
    actionTokens,
    locatorText: typeof args.locatorText === 'string' ? args.locatorText : '',
  }

  for (const frame of frames) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [frame.frameId] },
        world: 'MAIN',
        func: semanticRowContextPageCommand,
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
    func: semanticRowContextPageCommand,
    args: ['click', spec],
  })
  const clicked = Array.isArray(results) ? results[0]?.result : undefined
  if (!clicked || clicked.ok !== true || typeof clicked.selector !== 'string' || !clicked.selector) return undefined

  return {
    ok: true,
    selector: semanticScopeSelector(chosen.frame, clicked.selector),
    text: String(clicked.text || ''),
    role: String(clicked.role || ''),
    tag: String(clicked.tag || ''),
    frameId: chosen.frame.frameId,
    frameUrl: chosen.frame.url || '',
    transport: 'atomic-main-world-row-context-click',
  }
}

// Serialized into the page MAIN world. Keep this function self-contained.
function semanticRowContextPageCommand(mode, spec) {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const normalize = value => compact(value).replace(/\s+/g, '').toLocaleLowerCase()
  const cssEscape = value => globalThis.CSS?.escape
    ? CSS.escape(String(value))
    : String(value).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)
  const visible = element => {
    if (!(element instanceof Element) || !element.isConnected) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const actionText = element => compact([
    element.getAttribute?.('aria-label'),
    element.getAttribute?.('title'),
    element instanceof HTMLInputElement ? element.value : '',
    element.innerText,
    element.textContent,
  ].filter(Boolean).join(' '))
  const roleOf = element => compact(element.getAttribute?.('role') || (element.tagName === 'A' ? 'link' : element.tagName === 'BUTTON' ? 'button' : ''))
  const stableSelector = element => {
    if (element.id) return `#${cssEscape(element.id)}`
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-row-key', 'name', 'aria-label']) {
      const value = element.getAttribute?.(attr)
      if (value) return `${element.tagName.toLowerCase()}[${attr}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
    }
    const classes = [...(element.classList || [])].filter(name => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)).slice(0, 2)
    if (classes.length) {
      const candidate = `${element.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`
      try { if (document.querySelectorAll(candidate).length === 1) return candidate } catch {}
    }
    const path = []
    let node = element
    while (node instanceof Element && node !== document.documentElement && path.length < 10) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter(child => child.tagName === node.tagName)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
      }
      path.unshift(part)
      const candidate = path.join(' > ')
      try { if (document.querySelectorAll(candidate).length === 1) return candidate } catch {}
      node = parent
    }
    return path.join(' > ')
  }

  const identities = Array.isArray(spec.identityTokens) ? spec.identityTokens.map(normalize).filter(Boolean) : []
  const actions = Array.isArray(spec.actionTokens) ? spec.actionTokens.map(normalize).filter(Boolean) : []
  const wantedText = normalize(spec.locatorText || '')
  const actionSelector = [
    'a', 'button', 'input[type="button"]', 'input[type="submit"]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[onclick]', '[ng-click]', '[data-action]',
    'span', 'div',
  ].join(',')
  const nativeActionSelector = 'a,button,input[type="button"],input[type="submit"],[role="button"],[role="link"],[role="menuitem"],[onclick],[ng-click],[data-action]'
  const rowLikeSelector = [
    'tr', '[role="row"]', '.ant-table-row', '.el-table__row', '.ivu-table-row', '.arco-table-tr', '.vxe-body--row',
    '[class*="table-row"]', '[class*="list-row"]', '[data-row-key]', '[aria-rowindex]', '[data-index]',
  ].join(',')
  const rowKey = row => {
    if (!(row instanceof Element)) return ''
    for (const attr of ['data-row-key', 'data-key', 'row-key', 'data-index', 'aria-rowindex']) {
      const value = row.getAttribute?.(attr)
      if (value !== null && String(value).trim() !== '') return `${attr}:${String(value).trim()}`
    }
    return ''
  }
  const rowOrdinal = row => {
    if (!(row instanceof Element) || !(row.parentElement instanceof Element)) return -1
    const peers = [...row.parentElement.children].filter(child => child.matches?.(rowLikeSelector))
    return peers.indexOf(row)
  }
  const rowText = row => normalize(row?.innerText || row?.textContent || '')
  const allRows = [...new Set([...document.querySelectorAll(rowLikeSelector)])].filter(visible)
  const identityRows = allRows.filter(row => identities.length > 0 && identities.every(token => rowText(row).includes(token)))

  const correlateLogicalRow = actionRow => {
    if (!(actionRow instanceof Element) || identityRows.length === 0) return null
    const actionKey = rowKey(actionRow)
    const actionOrdinal = rowOrdinal(actionRow)
    const actionRect = actionRow.getBoundingClientRect()
    let best = null
    for (const identityRow of identityRows) {
      if (identityRow === actionRow) return { row: identityRow, bonus: 220, reason: 'same-row' }
      const identityKey = rowKey(identityRow)
      const identityOrdinal = rowOrdinal(identityRow)
      const identityRect = identityRow.getBoundingClientRect()
      let bonus = 0
      let reason = ''
      if (actionKey && identityKey && actionKey === identityKey) {
        bonus = 210
        reason = 'row-key'
      } else if (actionOrdinal >= 0 && identityOrdinal >= 0 && actionOrdinal === identityOrdinal && actionRow.parentElement !== identityRow.parentElement) {
        bonus = 165
        reason = 'parallel-row-ordinal'
      }
      const topDelta = Math.abs(actionRect.top - identityRect.top)
      if (topDelta <= 5 && actionRow.parentElement !== identityRow.parentElement && bonus < 150) {
        bonus = 150
        reason = 'parallel-row-top'
      }
      if (bonus > (best?.bonus || 0)) best = { row: identityRow, bonus, reason }
    }
    return best && best.bonus > 0 ? best : null
  }

  const scored = []
  for (const element of [...new Set([...document.querySelectorAll(actionSelector)])]) {
    if (!visible(element)) continue
    const text = actionText(element)
    const normText = normalize(text)
    const actionMatch = actions.some(token => normText === token || normText.includes(token))
      || (wantedText && (normText === wantedText || normText.includes(wantedText)))
    if (!actionMatch) continue

    const actionRow = element.closest?.(rowLikeSelector)
    let matchedContext = null
    let depth = 0
    let correlationBonus = 0
    let correlationReason = ''
    for (let ancestor = element; ancestor instanceof Element && depth <= 18; depth += 1, ancestor = ancestor.parentElement) {
      if (ancestor === document.body || ancestor === document.documentElement) break
      const contextText = normalize(ancestor.innerText || ancestor.textContent || '')
      if (identities.length > 0 && identities.every(token => contextText.includes(token))) {
        matchedContext = ancestor
        break
      }
    }

    if (!matchedContext && actionRow instanceof Element) {
      const correlated = correlateLogicalRow(actionRow)
      if (correlated) {
        matchedContext = actionRow
        correlationBonus = correlated.bonus
        correlationReason = correlated.reason
      }
    }
    if (!matchedContext) continue

    const directContextText = compact(matchedContext.innerText || matchedContext.textContent || '')
    const correlatedIdentity = correlationBonus > 0
      ? identityRows.find(row => {
          const correlated = correlateLogicalRow(actionRow)
          return correlated?.row === row
        })
      : null
    const evidenceContext = compact(`${correlatedIdentity?.innerText || correlatedIdentity?.textContent || ''} ${directContextText}`)
    const contextLengthPenalty = Math.min(80, Math.floor(evidenceContext.length / 18))
    const rowLikeBonus = matchedContext.matches?.(rowLikeSelector) ? 90 : 0
    const exactActionBonus = actions.some(token => normText === token || normText === `[${token}]`) ? 110 : 55
    const nativeActionBonus = element.matches?.(nativeActionSelector) ? 90 : 20
    const rect = element.getBoundingClientRect()
    const areaPenalty = Math.min(35, Math.floor((rect.width * rect.height) / 5000))
    // Nearest/smallest direct context wins. For split/fixed tables, row key,
    // aria-rowindex, parallel row ordinal or aligned row top supplies the
    // missing relationship between identity columns and action columns.
    const score = 600 + exactActionBonus + nativeActionBonus + rowLikeBonus + correlationBonus - depth * 35 - contextLengthPenalty - areaPenalty
    scored.push({ element, text, score, contextText: evidenceContext, depth, correlationReason })
  }

  scored.sort((left, right) => right.score - left.score)
  if (scored.length === 0) return { ok: true, candidates: [] }
  const bestScore = scored[0].score
  const best = scored.filter(item => item.score === bestScore)
  const serialized = best.slice(0, 8).map(item => ({
    score: item.score,
    selector: stableSelector(item.element),
    text: item.text,
    role: roleOf(item.element),
    tag: item.element.tagName.toLowerCase(),
    context: compact(item.contextText).slice(0, 320),
    depth: item.depth,
    correlation: item.correlationReason,
  }))
  if (mode === 'probe') return { ok: true, candidates: serialized }
  if (best.length !== 1) return { ok: false, error: `row-context target is ambiguous (${best.length})`, candidates: serialized }

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
    role: roleOf(element),
    tag: element.tagName.toLowerCase(),
    context: compact(chosen.contextText).slice(0, 320),
    correlation: chosen.correlationReason,
  }
}
