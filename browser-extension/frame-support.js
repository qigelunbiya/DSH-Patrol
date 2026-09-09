// Frame-aware DOM routing for DSH Patrol.
// Loaded after background.js by background-entry.js so existing top-frame
// behavior remains the compatibility fallback while ordinary DOM commands can
// discover and operate inside nested same-origin or cross-origin frames.

const FRAME_BRIDGE_RETRY_MS = [0, 120, 280, 650]
const FRAME_DOM_COMMANDS = new Set(['snapshot', 'readPage', 'count', 'click', 'type', 'press', 'scroll', 'wait'])
const FRAME_SELECTOR_PREFIX = /^frame-url\(([^)]*)\)::([\s\S]+)$/
const TOP_FRAME_SELECTOR_PREFIX = /^top-frame::([\s\S]+)$/
const legacySendDomCommand = sendDomCommand

sendDomCommand = async function frameAwareSendDomCommand(cmd, args = {}) {
  if (!FRAME_DOM_COMMANDS.has(cmd)) return await legacySendDomCommand(cmd, args)
  const tabId = await resolveTabId(args.tabId)
  try {
    if (cmd === 'snapshot') return await frameSnapshot(tabId, args)
    if (cmd === 'readPage') return await frameReadPage(tabId, args)
    if (cmd === 'count') return await frameCount(tabId, args)
    if (cmd === 'wait') return await frameWait(tabId, args)
    return await frameMutation(tabId, cmd, args)
  } catch (error) {
    throw new Error(`frame-aware page bridge unavailable in tab ${tabId}: ${safeError(error)}. Patrol searched accessible document frames before failing.`)
  }
}

async function frameSnapshot(tabId, args) {
  const frames = await patrolFrames(tabId)
  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  const elements = []
  let title = ''
  let url = ''
  let truncated = false
  let topCaptured = false
  const childFrameCount = frames.filter(frame => frame.frameId !== 0).length
  // Keep room for content-frame actions. A shell with hundreds of decorative
  // nodes must not crowd every iframe target out of the semantic snapshot.
  const frameReserve = Math.min(Math.max(0, max - 1), childFrameCount * 25)
  const topMax = max - frameReserve

  // Preserve the richer legacy top-frame snapshot (including visual media)
  // whenever it is available.
  try {
    const top = await legacySendDomCommand('snapshot', { ...args, maxElements: topMax, tabId })
    if (top && typeof top === 'object' && top.ok !== false) {
      topCaptured = true
      title = typeof top.title === 'string' ? top.title : title
      url = typeof top.url === 'string' ? top.url : url
      truncated ||= top.truncated === true
      for (const item of Array.isArray(top.elements) ? top.elements : []) {
        if (item && typeof item === 'object') elements.push(item)
        if (elements.length >= max) break
      }
    }
  } catch {
    // The all-frame content script below is the fallback for the top document.
  }

  for (const frame of frames) {
    if (frame.frameId === 0 && topCaptured) continue
    if (elements.length >= max) {
      truncated = true
      break
    }
    let value
    try {
      value = await sendFrameDomCommand(tabId, frame.frameId, 'snapshot', {
        selector: args.selector,
        maxElements: max - elements.length,
        includeHidden: args.includeHidden === true,
      })
    } catch {
      continue
    }
    if (!value || value.ok === false) continue
    if (frame.frameId === 0) {
      title = typeof value.title === 'string' ? value.title : title
      url = typeof value.url === 'string' ? value.url : url
    }
    truncated ||= value.truncated === true
    for (const item of Array.isArray(value.elements) ? value.elements : []) {
      if (!item || typeof item !== 'object') continue
      const selector = typeof item.selector === 'string' ? item.selector : ''
      elements.push({
        ...item,
        ...(selector && frame.frameId !== 0 ? { selector: qualifyFrameSelector(frame, selector) } : {}),
      })
      if (elements.length >= max) break
    }
  }

  if (elements.length === 0 && !topCaptured) {
    return await legacySendDomCommand('snapshot', { ...args, tabId })
  }
  return { ok: true, url, title, elements: elements.slice(0, max), truncated }
}

async function frameReadPage(tabId, args) {
  const frames = await patrolFrames(tabId)
  const maxChars = Number.isInteger(args.maxChars) ? Math.max(100, Math.min(args.maxChars, 100000)) : 20000
  const results = []

  for (const frame of frames) {
    try {
      const value = await sendFrameDomCommand(tabId, frame.frameId, 'readPage', {
        selector: args.selector,
        maxChars: Math.max(maxChars, 12000),
      })
      if (!value || value.ok === false) continue
      results.push({ frame, value })
    } catch {
      // Some browser-internal frames cannot host content scripts. Ignore them.
    }
  }

  if (results.length === 0) return await legacySendDomCommand('readPage', { ...args, tabId })

  // Put data-bearing grids first so a maxChars limit cannot let a verbose portal
  // shell push the useful iframe table off the end of browser_read_page.
  results.sort((left, right) => {
    const leftTables = Array.isArray(left.value.tables) ? left.value.tables.length : 0
    const rightTables = Array.isArray(right.value.tables) ? right.value.tables.length : 0
    return rightTables - leftTables || left.frame.frameId - right.frame.frameId
  })

  const blocks = []
  for (const { frame, value } of results) {
    const frameUrl = stableFrameUrl(frame.url || value.url || '')
    const label = frame.frameId === 0 ? 'Top document' : `Frame ${frame.frameId}`
    const tables = renderStructuredTables(frame, value.tables)
    const visible = typeof value.text === 'string' ? value.text.trim() : ''
    const sections = [`[${label}${frameUrl ? ` - ${frameUrl}` : ''}]`]
    if (tables) sections.push(tables)
    if (visible) sections.push(`Visible text:\n${visible}`)
    blocks.push(sections.join('\n'))
  }

  const combined = blocks.join('\n\n')
  const top = results.find(item => item.frame.frameId === 0)
  return {
    ok: true,
    url: typeof top?.value?.url === 'string' ? top.value.url : (frames[0]?.url || ''),
    title: typeof top?.value?.title === 'string' ? top.value.title : '',
    text: combined.slice(0, maxChars),
    truncated: combined.length > maxChars || results.some(item => item.value.truncated === true),
  }
}

async function frameCount(tabId, args) {
  if (typeof args.selector !== 'string' || !args.selector) throw new Error('count requires selector')
  const target = parseFrameSelector(args.selector)
  const matches = await countAcrossFrames(tabId, target.selector, target.frameUrl, args.visibleOnly === true, target.topFrame === true)
  return {
    ok: true,
    selector: args.selector,
    count: matches.reduce((sum, item) => sum + item.count, 0),
    visibleOnly: args.visibleOnly === true,
  }
}

async function frameMutation(tabId, cmd, args) {
  const selectorValue = typeof args.selector === 'string' && args.selector ? args.selector : undefined
  if (!selectorValue) {
    // Key presses and page scrolling without a selector belong to the top document.
    return await sendFrameDomCommand(tabId, 0, cmd, stripTransportArgs(args))
  }

  const target = parseFrameSelector(selectorValue)
  const matches = await countAcrossFrames(tabId, target.selector, target.frameUrl, true, target.topFrame === true)
  const total = matches.reduce((sum, item) => sum + item.count, 0)
  if (total === 0) throw new Error(`element not found in any accessible frame: ${target.selector}`)
  if (total > 1) {
    const detail = matches.filter(item => item.count > 0).map(item => `${item.frame.frameId}:${item.count}`).join(', ')
    throw new Error(`ambiguous selector matched ${total} visible elements across frames (${detail}): ${selectorValue}`)
  }
  const match = matches.find(item => item.count === 1)
  if (!match) throw new Error(`could not resolve a unique frame for selector: ${selectorValue}`)
  return await sendFrameDomCommand(tabId, match.frame.frameId, cmd, {
    ...stripTransportArgs(args),
    selector: target.selector,
  })
}

async function frameWait(tabId, args) {
  if (typeof args.selector !== 'string' || !args.selector) {
    return await sendFrameDomCommand(tabId, 0, 'wait', stripTransportArgs(args))
  }
  const target = parseFrameSelector(args.selector)
  const frames = await patrolFrames(tabId, target.frameUrl, target.topFrame === true)
  const condition = args.condition === 'gone' ? 'gone' : 'visible'
  const attempts = await Promise.all(frames.map(async frame => {
    try {
      const value = await sendFrameDomCommand(tabId, frame.frameId, 'wait', {
        ...stripTransportArgs(args),
        selector: target.selector,
        condition,
      })
      return { frame, value }
    } catch {
      return { frame, value: { ok: true, found: condition === 'gone' } }
    }
  }))
  const found = condition === 'gone'
    ? attempts.every(item => item.value?.found === true)
    : attempts.some(item => item.value?.found === true)
  return {
    ok: true,
    found,
    selector: args.selector,
    timeoutMs: Number.isInteger(args.timeoutMs) ? args.timeoutMs : 10000,
  }
}

async function countAcrossFrames(tabId, selector, frameUrl, visibleOnly, topFrameOnly = false) {
  const frames = await patrolFrames(tabId, frameUrl, topFrameOnly)
  const results = []
  for (const frame of frames) {
    try {
      const value = await sendFrameDomCommand(tabId, frame.frameId, 'count', { selector, visibleOnly })
      const count = Number.isInteger(value?.count) ? value.count : 0
      results.push({ frame, count })
    } catch {
      results.push({ frame, count: 0 })
    }
  }

  // A URL-qualified frame can legitimately change its query string/path during
  // a workflow. If the preferred frame no longer contains the selector, retry
  // discovery across all frames using the durable inner CSS selector.
  if (frameUrl && !topFrameOnly && results.every(item => item.count === 0)) {
    return await countAcrossFrames(tabId, selector, '', visibleOnly)
  }
  return results
}

async function patrolFrames(tabId, preferredUrl = '', topFrameOnly = false) {
  let frames = []
  try {
    frames = await chrome.webNavigation.getAllFrames({ tabId }) || []
  } catch {
    frames = []
  }
  if (!Array.isArray(frames) || frames.length === 0) {
    frames = [{ frameId: 0, parentFrameId: -1, url: '' }]
  }
  frames = frames
    .filter(frame => Number.isInteger(frame?.frameId))
    .map(frame => ({
      frameId: frame.frameId,
      parentFrameId: Number.isInteger(frame.parentFrameId) ? frame.parentFrameId : -1,
      url: typeof frame.url === 'string' ? frame.url : '',
    }))
    .sort((left, right) => left.frameId - right.frameId)
  if (topFrameOnly) return frames.filter(frame => frame.frameId === 0)
  if (!preferredUrl) return frames
  const preferred = frames.filter(frame => stableFrameUrl(frame.url) === preferredUrl)
  return preferred.length > 0 ? preferred : frames
}

async function sendFrameDomCommand(tabId, frameId, cmd, args) {
  const value = await sendFrameMessageWithRetry(tabId, frameId, {
    type: 'dsh-patrol:frame-command',
    cmd,
    args,
  }, 'frame page bridge')
  if (!value || typeof value !== 'object') throw new Error('frame page bridge returned an invalid response')
  if (value.ok === false) throw new Error(safeError(value.error || 'frame page command failed'))
  return value
}

async function sendFrameMessageWithRetry(tabId, frameId, message, label) {
  let lastError
  for (let index = 0; index < FRAME_BRIDGE_RETRY_MS.length; index += 1) {
    const waitMs = FRAME_BRIDGE_RETRY_MS[index]
    if (waitMs > 0) await delay(waitMs)
    try {
      return await chrome.tabs.sendMessage(tabId, message, { frameId })
    } catch (error) {
      lastError = error
      if (!isTransientPageBridgeError(error) || index === FRAME_BRIDGE_RETRY_MS.length - 1) break
    }
  }
  throw new Error(`${label} unavailable in frame ${frameId} after bounded retry: ${safeError(lastError)}`)
}

function qualifyFrameSelector(frame, selector) {
  const url = stableFrameUrl(frame.url)
  if (!url) return selector
  return `frame-url(${encodeURIComponent(url)})::${selector}`
}

function parseFrameSelector(value) {
  const text = String(value || '')
  const topMatch = TOP_FRAME_SELECTOR_PREFIX.exec(text)
  if (topMatch) return { selector: topMatch[1], frameUrl: '', topFrame: true }
  const match = FRAME_SELECTOR_PREFIX.exec(text)
  if (!match) return { selector: text, frameUrl: '', topFrame: false }
  let frameUrl = ''
  try { frameUrl = decodeURIComponent(match[1]) } catch { frameUrl = match[1] }
  return { selector: match[2], frameUrl: stableFrameUrl(frameUrl), topFrame: false }
}

function stableFrameUrl(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  try {
    const url = new URL(text)
    if (url.protocol === 'http:' || url.protocol === 'https:' || url.protocol === 'file:') {
      return `${url.origin}${url.pathname}`
    }
  } catch {
  }
  return text.split('#')[0].split('?')[0]
}

function renderStructuredTables(frame, tables) {
  if (!Array.isArray(tables) || tables.length === 0) return ''
  const blocks = []
  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const table = tables[tableIndex]
    if (!table || typeof table !== 'object') continue
    const rows = Array.isArray(table.rows) ? table.rows : []
    if (rows.length === 0) continue
    const name = typeof table.id === 'string' && table.id ? ` id=${table.id}` : ''
    blocks.push(`[Structured table ${tableIndex + 1}${name}; rows=${rows.length}]`)
    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]
      const cells = Array.isArray(row?.cells) ? row.cells : []
      const fields = []
      for (const cell of cells) {
        if (!cell || typeof cell !== 'object') continue
        const column = typeof cell.column === 'string' && cell.column ? cell.column : `column-${fields.length + 1}`
        const value = typeof cell.value === 'string' ? cell.value : ''
        if (!value && cell.hidden === true) continue
        let field = `${column}=${JSON.stringify(value)}`
        if (cell.hidden === true) field += ' (hidden)'
        if (typeof cell.clickSelector === 'string' && cell.clickSelector) {
          const selector = frame.frameId === 0 ? cell.clickSelector : qualifyFrameSelector(frame, cell.clickSelector)
          field += ` [click ${JSON.stringify(selector)}]`
        }
        fields.push(field)
      }
      if (fields.length > 0) blocks.push(`Row ${rowIndex + 1}: ${fields.join(' | ')}`)
    }
  }
  return blocks.join('\n')
}

function stripTransportArgs(args) {
  const out = { ...args }
  delete out.tabId
  delete out.frameId
  return out
}
