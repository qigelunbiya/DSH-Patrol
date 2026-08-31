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
    case 'captureImageCode':
      return await captureImageCode(args)
    case 'captureCaptchaDemo':
      return await captureCaptchaDemo(args)
    case 'captchaDemoInfo':
    case 'captchaDemoClickPoints':
    case 'captchaDemoDrag':
      return await sendCaptchaDemoCommand(cmd, args)
    case 'snapshot':
    case 'readPage':
    case 'challengeSignals':
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

async function captureImageCode(args) {
  const tabId = await resolveTabId(args.tabId)
  const target = await sendDomCommand('imageCodeTarget', { ...args, tabId })
  if (!target || typeof target !== 'object' || target.ok === false) {
    throw new Error(target?.error || 'image-code target discovery failed')
  }
  const shot = await screenshot({ tabId, format: 'png' })
  const dataUrl = await cropVisibleTabDataUrl(shot.dataUrl, target.rect, target.viewport)
  return {
    ok: true,
    dataUrl,
    imageSelector: target.imageSelector,
    inputSelector: target.inputSelector,
    bytes: Math.floor(dataUrl.length * 0.75),
  }
}

async function captureCaptchaDemo(args) {
  const tabId = await resolveTabId(args.tabId)
  const kind = String(args.kind || '')
  if (!['click-sequence', 'slider-puzzle'].includes(kind)) throw new Error(`unsupported captcha demo capture kind: ${kind}`)
  const target = await sendCaptchaDemoCommand('captchaDemoTarget', { ...args, tabId, kind })
  if (!target || typeof target !== 'object' || target.ok === false || target.available !== true) {
    throw new Error(target?.error || 'captcha demo target discovery failed')
  }
  const shot = await screenshot({ tabId, format: 'png' })

  if (kind === 'click-sequence') {
    const imageDataUrl = await cropVisibleTabDataUrl(shot.dataUrl, target.imageRect, target.viewport)
    return {
      ok: true,
      origin: target.origin,
      documentKey: target.documentKey,
      available: true,
      kind,
      targetText: target.targetText,
      imageSelector: target.imageSelector,
      imageDataUrl,
    }
  }

  const backgroundDataUrl = await cropVisibleTabDataUrl(shot.dataUrl, target.backgroundRect, target.viewport)
  const pieceDataUrl = await cropVisibleTabDataUrl(shot.dataUrl, target.pieceRect, target.viewport)
  return {
    ok: true,
    origin: target.origin,
    documentKey: target.documentKey,
    available: true,
    kind,
    backgroundSelector: target.backgroundSelector,
    pieceSelector: target.pieceSelector,
    handleSelector: target.handleSelector,
    backgroundDataUrl,
    pieceDataUrl,
  }
}

async function cropVisibleTabDataUrl(dataUrl, rect, viewport) {
  const left = Number(rect?.left)
  const top = Number(rect?.top)
  const width = Number(rect?.width)
  const height = Number(rect?.height)
  const viewportWidth = Number(viewport?.width)
  const viewportHeight = Number(viewport?.height)
  if (![left, top, width, height, viewportWidth, viewportHeight].every(Number.isFinite)) {
    throw new Error('image crop geometry is invalid')
  }
  if (width <= 0 || height <= 0 || viewportWidth <= 0 || viewportHeight <= 0) {
    throw new Error('image crop geometry is empty')
  }
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') {
    throw new Error('image cropping is unavailable in this Chromium runtime')
  }

  const source = dataUrlToBlob(dataUrl)
  const bitmap = await createImageBitmap(source)
  try {
    const scaleX = bitmap.width / viewportWidth
    const scaleY = bitmap.height / viewportHeight
    const padding = 2
    const sx = Math.max(0, Math.floor(left * scaleX) - padding)
    const sy = Math.max(0, Math.floor(top * scaleY) - padding)
    const ex = Math.min(bitmap.width, Math.ceil((left + width) * scaleX) + padding)
    const ey = Math.min(bitmap.height, Math.ceil((top + height) * scaleY) + padding)
    const sw = Math.max(1, ex - sx)
    const sh = Math.max(1, ey - sy)

    const canvas = new OffscreenCanvas(sw, sh)
    const context = canvas.getContext('2d')
    if (!context) throw new Error('image crop canvas context is unavailable')
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh)
    const cropped = await canvas.convertToBlob({ type: 'image/png' })
    return await blobToDataUrl(cropped)
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

function dataUrlToBlob(value) {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(String(value || ''))
  if (!match) throw new Error('browser screenshot did not return a base64 image')
  const binary = atob(match[2])
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Blob([bytes], { type: match[1] })
}

async function blobToDataUrl(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunkSize = 0x8000
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize))
  }
  return `data:${blob.type || 'image/png'};base64,${btoa(binary)}`
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

async function sendCaptchaDemoCommand(cmd, args) {
  const tabId = await resolveTabId(args.tabId)
  try {
    const value = await chrome.tabs.sendMessage(tabId, { type: 'dsh-patrol:captcha-demo', cmd, args: { ...args, tabId: undefined } })
    if (!value || typeof value !== 'object') throw new Error('captcha demo page bridge returned an invalid response')
    if (value.ok === false) throw new Error(safeError(value.error || 'captcha demo page command failed'))
    return value
  } catch (error) {
    throw new Error(`captcha demo page bridge unavailable in tab ${tabId}: ${safeError(error)}. Reload the page and retry.`)
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
  socket?.close()
  socket = null
  connect(false)
})

chrome.runtime.onStartup.addListener(() => connect(false))
chrome.runtime.onInstalled.addListener(() => connect(false))
connect(false)
