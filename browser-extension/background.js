const DEFAULTS = {
  bridgeUrl: 'ws://127.0.0.1:3080/patrol-browser-bridge',
  autoConnect: true,
}

let socket = null
let state = 'disconnected'
let reconnectTimer = null
let currentUrl = DEFAULTS.bridgeUrl

async function settings() {
  return await chrome.storage.local.get(DEFAULTS)
}

async function connect(force = false) {
  const config = await settings()
  currentUrl = config.bridgeUrl || DEFAULTS.bridgeUrl
  if (!force && config.autoConnect === false) return
  if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return
  clearTimeout(reconnectTimer)
  state = 'connecting'
  try {
    const ws = new WebSocket(currentUrl)
    socket = ws
    ws.onopen = () => {
      if (socket !== ws) return
      state = 'connected'
      send({ type: 'hello', name: 'dsh-patrol-browser-extension', version: '0.2.0' })
    }
    ws.onmessage = event => onMessage(ws, event.data)
    ws.onerror = () => {
      if (socket === ws) state = 'error'
    }
    ws.onclose = () => {
      if (socket !== ws) return
      socket = null
      state = 'disconnected'
      scheduleReconnect()
    }
  } catch {
    state = 'error'
    scheduleReconnect()
  }
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer)
  reconnectTimer = setTimeout(() => connect(false), 2500)
}

function send(value) {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value))
}

async function onMessage(ws, raw) {
  if (socket !== ws) return
  let msg
  try { msg = JSON.parse(raw) } catch { return }
  if (!msg || typeof msg !== 'object') return
  if (msg.type === 'ping') {
    send({ type: 'pong' })
    return
  }
  if (msg.type !== 'request' || typeof msg.id !== 'string' || typeof msg.cmd !== 'string') return
  try {
    const value = await handleCommand(msg.cmd, msg.args || {})
    send({ type: 'response', id: msg.id, ok: true, value })
  } catch (error) {
    send({ type: 'response', id: msg.id, ok: false, error: safeError(error) })
  }
}

async function handleCommand(cmd, args) {
  switch (cmd) {
    case 'listTabs': {
      const tabs = await chrome.tabs.query({})
      return { tabs: tabs.map(tabInfo) }
    }
    case 'activateTab': {
      const tab = await chrome.tabs.update(args.tabId, { active: true })
      if (tab.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true })
      return { tab: tabInfo(tab) }
    }
    case 'navigate':
      return await navigate(args)
    case 'screenshot':
      return await screenshot(args)
    case 'snapshot':
    case 'readPage':
    case 'count':
    case 'click':
    case 'type':
    case 'press':
    case 'scroll':
    case 'wait':
      return await sendDomCommand(cmd, args)
    default:
      throw new Error(`unsupported browser command: ${cmd}`)
  }
}

async function navigate(args) {
  const action = args.action || 'navigate'
  if (action === 'navigate') {
    if (typeof args.url !== 'string' || args.url.length === 0) throw new Error('navigate requires url')
    if (args.newTab === true) {
      const tab = await chrome.tabs.create({ url: args.url, active: true })
      return { tab: tabInfo(tab) }
    }
    const tabId = await resolveTabId(args.tabId)
    const tab = await chrome.tabs.update(tabId, { url: args.url, active: true })
    return { tab: tabInfo(tab) }
  }
  const tabId = await resolveTabId(args.tabId)
  if (action === 'reload') await chrome.tabs.reload(tabId)
  else if (action === 'back') await chrome.tabs.goBack(tabId)
  else if (action === 'forward') await chrome.tabs.goForward(tabId)
  else throw new Error(`unsupported navigation action: ${action}`)
  return { tab: tabInfo(await chrome.tabs.get(tabId)) }
}

async function screenshot(args) {
  const tabId = await resolveTabId(args.tabId)
  const tab = await chrome.tabs.get(tabId)
  if (tab.windowId === undefined) throw new Error('target tab has no window')
  await chrome.tabs.update(tabId, { active: true })
  await chrome.windows.update(tab.windowId, { focused: true })
  const format = args.format === 'jpeg' ? 'jpeg' : 'png'
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format })
  return { ok: true, dataUrl, bytes: Math.floor(dataUrl.length * 0.75) }
}

async function sendDomCommand(cmd, args) {
  const tabId = await resolveTabId(args.tabId)
  try {
    const value = await chrome.tabs.sendMessage(tabId, { type: 'dsh-patrol:command', cmd, args: { ...args, tabId: undefined } })
    if (!value || typeof value !== 'object') throw new Error('page bridge returned an invalid response')
    if (value.ok === false) throw new Error(safeError(value.error || 'page command failed'))
    return value
  } catch (error) {
    throw new Error(`page bridge unavailable in tab ${tabId}: ${safeError(error)}. Reload the page after installing the extension and retry.`)
  }
}

async function resolveTabId(explicit) {
  if (Number.isInteger(explicit)) return explicit
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!active || active.id === undefined) throw new Error('no active browser tab')
  return active.id
}

function tabInfo(tab) {
  return {
    id: tab.id ?? -1,
    title: tab.title || '',
    url: tab.url || '',
    active: !!tab.active,
    windowId: tab.windowId ?? -1,
    index: tab.index ?? -1,
  }
}

function safeError(error) {
  const text = error && typeof error.message === 'string' ? error.message : String(error)
  return text.replace(/(password|passwd|pwd|token|secret|authorization|cookie|otp|captcha|验证码)\s*[:=：]\s*\S+/gi, '$1=[REDACTED]')
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'bridge:getStatus') {
    sendResponse({ connected: socket?.readyState === WebSocket.OPEN, state, bridgeUrl: currentUrl })
    return
  }
  if (message?.type === 'bridge:connect') {
    connect(true).then(() => sendResponse({ ok: true }))
    return true
  }
})

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || (!changes.bridgeUrl && !changes.autoConnect)) return
  try { socket?.close() } catch {}
  socket = null
  connect(false)
})

connect(false)
