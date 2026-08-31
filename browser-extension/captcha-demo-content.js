const DOCUMENT_KEY = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const CHALLENGE_KEYS = new WeakMap()
let challengeSequence = 0

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'dsh-patrol:captcha-demo') return
  Promise.resolve(handleCaptchaDemo(message.cmd, message.args || {}))
    .then(value => sendResponse(value))
    .catch(error => sendResponse({ ok: false, error: safeError(error) }))
  return true
})

async function handleCaptchaDemo(cmd, args) {
  switch (cmd) {
    case 'captchaDemoInfo': return captchaDemoInfo()
    case 'captchaDemoTarget': return await captchaDemoTarget(args)
    case 'captchaDemoClickPoints': return await captchaDemoClickPoints(args)
    case 'captchaDemoDrag': return await captchaDemoDrag(args)
    default: throw new Error(`unsupported captcha demo command: ${cmd}`)
  }
}

function captchaDemoInfo() {
  const entries = visibleDemoEntries()
  const challengeKeys = {}
  for (const entry of entries) challengeKeys[entry.kind] = challengeKeyFor(entry.root)
  return {
    ok: true,
    origin: location.origin,
    documentKey: DOCUMENT_KEY,
    available: entries.length > 0,
    kinds: entries.map(entry => entry.kind),
    challengeKeys,
  }
}

async function captchaDemoTarget(args) {
  assertDocumentKey(args.documentKey)
  const kind = String(args.kind || '')
  const root = findDemoRootByKey(kind, args.challengeKey)
  if (!root) throw new Error(`captcha challenge changed before capture for ${kind}`)
  const challengeKey = challengeKeyFor(root)
  root.scrollIntoView({ block: 'center', inline: 'center' })
  await sleep(80)

  if (kind === 'click-sequence') {
    const image = root.querySelector('[data-dsh-patrol-captcha-image],img,canvas')
    if (!image || !isVisible(image)) throw new Error('click captcha image not found')
    const targetText = extractTargetText(root)
    if (!targetText) throw new Error('click captcha target text not found')
    return {
      ok: true,
      origin: location.origin,
      documentKey: DOCUMENT_KEY,
      challengeKey,
      available: true,
      kind,
      targetText,
      imageSelector: stableSelector(image),
      imageRect: rectValue(image),
      viewport: viewportValue(),
    }
  }

  if (kind === 'slider-puzzle') {
    const background = root.querySelector('[data-dsh-patrol-captcha-background]')
    const piece = root.querySelector('[data-dsh-patrol-captcha-piece]')
    const handle = root.querySelector('[data-dsh-patrol-captcha-slider-handle]')
    if (!background || !piece || !handle) throw new Error('slider demo requires background, piece, and handle markers')
    if (![background, piece, handle].every(isVisible)) throw new Error('slider demo assets must be visible')
    return {
      ok: true,
      origin: location.origin,
      documentKey: DOCUMENT_KEY,
      challengeKey,
      available: true,
      kind,
      backgroundSelector: stableSelector(background),
      pieceSelector: stableSelector(piece),
      handleSelector: stableSelector(handle),
      backgroundRect: rectValue(background),
      pieceRect: rectValue(piece),
      viewport: viewportValue(),
    }
  }

  throw new Error(`captcha demo does not support ${kind}`)
}

async function captchaDemoClickPoints(args) {
  assertDocumentKey(args.documentKey)
  assertCurrentChallenge(args.kind, args.challengeKey)
  const element = requiredElement(args.selector)
  const points = Array.isArray(args.points) ? args.points : []
  if (points.length < 1 || points.length > 12) throw new Error('captcha demo click points must contain 1-12 points')
  element.scrollIntoView({ block: 'center', inline: 'center' })
  await sleep(50)
  const rect = element.getBoundingClientRect()
  for (const point of points) {
    const nx = Number(point?.x)
    const ny = Number(point?.y)
    if (!Number.isFinite(nx) || !Number.isFinite(ny) || nx < 0 || nx > 1 || ny < 0 || ny > 1) {
      throw new Error('captcha demo point must use normalized x/y coordinates')
    }
    const x = rect.left + rect.width * nx
    const y = rect.top + rect.height * ny
    dispatchMouseSequence(element, x, y)
    await sleep(110)
  }
  return { ok: true, documentKey: DOCUMENT_KEY, challengeKey: args.challengeKey, clicks: points.length }
}

async function captchaDemoDrag(args) {
  assertDocumentKey(args.documentKey)
  assertCurrentChallenge(args.kind, args.challengeKey)
  const handle = requiredElement(args.handleSelector)
  const background = requiredElement(args.backgroundSelector)
  const normalizedX = Number(args.normalizedX)
  if (!Number.isFinite(normalizedX) || normalizedX < 0 || normalizedX > 1) throw new Error('captcha demo drag normalizedX must be 0..1')
  handle.scrollIntoView({ block: 'center', inline: 'center' })
  await sleep(50)

  const handleRect = handle.getBoundingClientRect()
  const backgroundRect = background.getBoundingClientRect()
  const startX = handleRect.left + handleRect.width / 2
  const startY = handleRect.top + handleRect.height / 2
  const requestedDistance = backgroundRect.width * normalizedX
  const targetX = Math.max(0, Math.min(window.innerWidth - 1, startX + requestedDistance))
  const distance = targetX - startX
  const steps = Math.max(10, Math.min(36, Math.ceil(Math.abs(distance) / 8)))

  dispatchPointer(handle, 'pointerdown', startX, startY, 1)
  dispatchMouse(handle, 'mousedown', startX, startY, 1)
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps
    const eased = 1 - Math.pow(1 - t, 2.2)
    const x = startX + distance * eased
    const y = startY + Math.sin(t * Math.PI) * 1.5
    dispatchPointer(document, 'pointermove', x, y, 1)
    dispatchMouse(document, 'mousemove', x, y, 1)
    await sleep(12 + Math.floor(index % 3) * 4)
  }
  dispatchPointer(document, 'pointerup', targetX, startY, 0)
  dispatchMouse(document, 'mouseup', targetX, startY, 0)
  handle.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, documentKey: DOCUMENT_KEY, challengeKey: args.challengeKey, normalizedX, distance }
}

function visibleDemoEntries() {
  const entries = []
  const clickRoot = findDemoRoot('click-sequence')
  if (clickRoot) entries.push({ kind: 'click-sequence', root: clickRoot })
  const sliderRoot = findDemoRoot('slider-puzzle')
  if (sliderRoot) entries.push({ kind: 'slider-puzzle', root: sliderRoot })
  return entries
}

function visibleDemoKinds() {
  return visibleDemoEntries().map(entry => entry.kind)
}

function findDemoRoot(kind) {
  return demoRoots(kind)[0] || null
}

function findDemoRootByKey(kind, key) {
  if (typeof key !== 'string' || key.length === 0) return null
  return demoRoots(kind).find(root => challengeKeyFor(root) === key) || null
}

function demoRoots(kind) {
  const selectors = kind === 'slider-puzzle'
    ? ['[data-dsh-patrol-captcha-kind="slider-puzzle"]', '[data-dsh-patrol-captcha-kind="slider"]']
    : [`[data-dsh-patrol-captcha-kind="${cssString(kind)}"]`]
  const seen = new Set()
  const candidates = []
  for (const selector of selectors) {
    for (const element of document.querySelectorAll(selector)) {
      if (seen.has(element) || !isVisible(element)) continue
      seen.add(element)
      candidates.push(element)
    }
  }
  candidates.sort((a, b) => visibleScore(b) - visibleScore(a))
  return candidates
}

function visibleScore(element) {
  const rect = element.getBoundingClientRect()
  const left = Math.max(0, rect.left)
  const top = Math.max(0, rect.top)
  const right = Math.min(window.innerWidth, rect.right)
  const bottom = Math.min(window.innerHeight, rect.bottom)
  const width = Math.max(0, right - left)
  const height = Math.max(0, bottom - top)
  return width * height
}

function challengeKeyFor(root) {
  let key = CHALLENGE_KEYS.get(root)
  if (!key) {
    challengeSequence += 1
    key = `${DOCUMENT_KEY}:${challengeSequence}`
    CHALLENGE_KEYS.set(root, key)
  }
  return key
}

function assertCurrentChallenge(kind, key) {
  if (!findDemoRootByKey(String(kind || ''), key)) {
    throw new Error('captcha challenge changed before the requested action; rediscover the current challenge')
  }
}

function extractTargetText(root) {
  const direct = root.getAttribute('data-target-text') || root.getAttribute('data-click-sequence')
  if (direct) return compactTarget(direct)
  const target = root.querySelector('[data-dsh-patrol-captcha-target]')
  if (target) return compactTarget(target.getAttribute('data-dsh-patrol-captcha-target') || target.textContent || '')
  const text = String(root.innerText || root.textContent || '')
  const match = /(?:依次点击|按顺序点击|click\s+in\s+order)\s*[:：]?\s*([^\n\r]{1,24})/i.exec(text)
  return match ? compactTarget(match[1]) : ''
}

function compactTarget(value) {
  return String(value || '')
    .replace(/[\s,，.。:：;；|/\\\-_'"`~!！?？()（）\[\]{}<>《》]+/g, '')
    .slice(0, 12)
}

function assertDocumentKey(value) {
  if (typeof value !== 'string' || value !== DOCUMENT_KEY) {
    throw new Error('captcha page changed before the requested action; rediscover the current challenge')
  }
}

function requiredElement(selector) {
  if (typeof selector !== 'string' || !selector) throw new Error('selector is required')
  let element
  try { element = document.querySelector(selector) } catch { throw new Error(`invalid selector: ${selector}`) }
  if (!element) throw new Error(`element not found: ${selector}`)
  if (!isVisible(element)) throw new Error(`element is not visible: ${selector}`)
  return element
}

function isVisible(element) {
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function rectValue(element) {
  const rect = element.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) throw new Error('captcha demo asset has empty bounds')
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
    throw new Error('captcha demo asset is outside the visible viewport')
  }
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function viewportValue() {
  return { width: window.innerWidth, height: window.innerHeight }
}

function stableSelector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`
  for (const attr of ['data-dsh-patrol-captcha-image', 'data-dsh-patrol-captcha-background', 'data-dsh-patrol-captcha-piece', 'data-dsh-patrol-captcha-slider-handle', 'data-testid', 'data-test', 'data-cy']) {
    if (element.hasAttribute(attr)) {
      const value = element.getAttribute(attr)
      const candidate = value ? `[${attr}="${cssString(value)}"]` : `[${attr}]`
      if (document.querySelectorAll(candidate).length === 1) return candidate
    }
  }
  const path = []
  let node = element
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
    const tag = node.tagName.toLowerCase()
    const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : []
    const nth = siblings.length > 1 ? `:nth-of-type(${siblings.indexOf(node) + 1})` : ''
    path.unshift(tag + nth)
    const candidate = path.join(' > ')
    if (document.querySelectorAll(candidate).length === 1) return candidate
    node = node.parentElement
  }
  return path.join(' > ') || element.tagName.toLowerCase()
}

function dispatchMouseSequence(element, x, y) {
  dispatchPointer(element, 'pointerdown', x, y, 1)
  dispatchMouse(element, 'mousedown', x, y, 1)
  dispatchPointer(element, 'pointerup', x, y, 0)
  dispatchMouse(element, 'mouseup', x, y, 0)
  dispatchMouse(element, 'click', x, y, 0)
}

function dispatchPointer(target, type, x, y, buttons) {
  const event = new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons, pointerId: 1, pointerType: 'mouse', isPrimary: true })
  target.dispatchEvent(event)
}

function dispatchMouse(target, type, x, y, buttons) {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons })
  target.dispatchEvent(event)
}

function cssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function safeError(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
