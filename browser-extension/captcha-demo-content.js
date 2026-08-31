const DOCUMENT_KEY = globalThis.crypto && typeof globalThis.crypto.randomUUID === 'function'
  ? globalThis.crypto.randomUUID()
  : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const CHALLENGE_KEYS = new WeakMap()
let challengeSequence = 0
const CLICK_SEQUENCE_HINT = /依次点击|按(?:照|顺序).{0,20}点击|请.{0,20}(?:下图|图片).{0,20}点击|点击.{0,20}(?:文字|汉字|字符|目标|图标).{0,20}(?:顺序|依次)?|请选择.{0,20}(?:文字|汉字|字符|图标|目标)|选出.{0,20}(?:文字|汉字|字符|图标|目标)|click.{0,30}(?:characters?|words?|symbols?|icons?).{0,30}(?:order|sequence)|select.{0,30}(?:characters?|words?|symbols?|icons?)/i
const SLIDER_PUZZLE_HINT = /\bgeetest\b|\bjigsaw\b|\bpuzzle\b|拼图|缺口|滑块.{0,20}(?:拼图|缺口)|拖动.{0,20}(?:拼图|缺口)|drag.{0,30}(?:slider|puzzle)|slider.{0,30}(?:verify|puzzle)/i
const HANDLE_SELECTOR = '[role="slider"],[class*="slider"],[id*="slider"],[class*="drag"],[id*="drag"],[class*="handle"],[id*="handle"],button'

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
  const entry = findDemoEntryByKey(kind, args.challengeKey)
  if (!entry) throw new Error(`captcha challenge changed before capture for ${kind}`)
  const root = entry.root
  const challengeKey = challengeKeyFor(root)
  root.scrollIntoView({ block: 'center', inline: 'center' })
  await sleep(80)

  if (kind === 'click-sequence') {
    const image = root.querySelector('[data-dsh-patrol-captcha-image],img,canvas') || entry.image || findClickImage(root)
    if (!image || !isVisible(image)) throw new Error('click captcha image not found')
    const targetText = entry.targetText || extractTargetText(root)
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
    const assets = entry.assets || {
      background: root.querySelector('[data-dsh-patrol-captcha-background]'),
      piece: root.querySelector('[data-dsh-patrol-captcha-piece]'),
      handle: root.querySelector('[data-dsh-patrol-captcha-slider-handle]'),
    } || detectSliderAssets(root)
    const resolvedAssets = assets?.background && assets?.piece && assets?.handle ? assets : detectSliderAssets(root)
    const background = resolvedAssets?.background || null
    const piece = resolvedAssets?.piece || null
    const handle = resolvedAssets?.handle || null
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
  const clickEntry = findDemoEntry('click-sequence')
  if (clickEntry) entries.push(clickEntry)
  const sliderEntry = findDemoEntry('slider-puzzle')
  if (sliderEntry) entries.push(sliderEntry)
  return entries
}

function visibleDemoKinds() {
  return visibleDemoEntries().map(entry => entry.kind)
}

function findDemoRoot(kind) {
  return findDemoEntry(kind)?.root || null
}

function findDemoRootByKey(kind, key) {
  return findDemoEntryByKey(kind, key)?.root || null
}

function findDemoEntryByKey(kind, key) {
  if (typeof key !== 'string' || key.length === 0) return null
  return demoEntries(kind).find(entry => challengeKeyFor(entry.root) === key) || null
}

function findDemoEntry(kind) {
  return demoEntries(kind)[0] || null
}

function demoEntries(kind) {
  const explicit = explicitDemoEntries(kind)
  if (explicit.length > 0) return explicit
  const weak = weakDemoEntries(kind)
  weak.sort((a, b) => visibleScore(b.root) - visibleScore(a.root))
  return weak
}

function explicitDemoEntries(kind) {
  const selectors = kind === 'slider-puzzle'
    ? ['[data-dsh-patrol-captcha-kind="slider-puzzle"]', '[data-dsh-patrol-captcha-kind="slider"]']
    : [`[data-dsh-patrol-captcha-kind="${cssString(kind)}"]`]
  const seen = new Set()
  const entries = []
  for (const selector of selectors) {
    for (const root of document.querySelectorAll(selector)) {
      if (seen.has(root) || !isVisible(root)) continue
      seen.add(root)
      entries.push({ kind, root })
    }
  }
  entries.sort((a, b) => visibleScore(b.root) - visibleScore(a.root))
  return entries
}

function weakDemoEntries(kind) {
  if (kind === 'click-sequence') {
    const entry = detectWeakClickSequence()
    return entry ? [entry] : []
  }
  if (kind === 'slider-puzzle') {
    const entry = detectWeakSliderPuzzle()
    return entry ? [entry] : []
  }
  return []
}

function detectWeakClickSequence() {
  const images = visibleElements('img,canvas').filter(isLargeImageCandidate)
  const candidates = []
  for (const image of images) {
    const root = findNearestAncestor(image, node => looksLikeChallengeRoot(node, CLICK_SEQUENCE_HINT))
    if (!root) continue
    const targetText = extractTargetText(root)
    if (!targetText) continue
    candidates.push({ kind: 'click-sequence', root, image, targetText })
  }
  candidates.sort((a, b) => weakClickScore(b) - weakClickScore(a))
  return candidates[0] || null
}

function detectWeakSliderPuzzle() {
  const handles = visibleElements(HANDLE_SELECTOR)
  const candidates = []
  for (const handle of handles) {
    const root = findNearestAncestor(handle, node => looksLikeChallengeRoot(node, SLIDER_PUZZLE_HINT))
    if (!root) continue
    const assets = detectSliderAssets(root)
    if (!assets) continue
    candidates.push({ kind: 'slider-puzzle', root, assets })
  }
  candidates.sort((a, b) => weakSliderScore(b) - weakSliderScore(a))
  return candidates[0] || null
}

function findClickImage(root) {
  return firstVisibleDescendant(root, element => {
    const tag = tagNameOf(element)
    return (tag === 'img' || tag === 'canvas') && isLargeImageCandidate(element)
  })
}

function detectSliderAssets(root) {
  const images = visibleDescendants(root).filter(element => {
    const tag = tagNameOf(element)
    return (tag === 'img' || tag === 'canvas') && isVisible(element)
  })
  if (images.length < 2) return null
  images.sort((a, b) => visibleScore(b) - visibleScore(a))
  const background = images.find(isWideBackgroundCandidate)
  if (!background) return null
  const piece = images.find(image => image !== background && isPieceCandidate(image, background))
  if (!piece) return null
  const handles = visibleDescendants(root).filter(element => isHandleCandidate(element, background))
  const handle = handles.sort((a, b) => visibleScore(b) - visibleScore(a))[0] || null
  if (!handle) return null
  return { background, piece, handle }
}

function visibleElements(selector) {
  return [...document.querySelectorAll(selector)].filter(isVisible)
}

function visibleDescendants(root) {
  const results = []
  const queue = [...(Array.isArray(root?.children) ? root.children : [])]
  while (queue.length > 0) {
    const node = queue.shift()
    if (!node || node.nodeType !== Node.ELEMENT_NODE) continue
    if (isVisible(node)) results.push(node)
    if (Array.isArray(node.children)) queue.push(...node.children)
  }
  return results
}

function firstVisibleDescendant(root, predicate) {
  return visibleDescendants(root).find(predicate) || null
}

function findNearestAncestor(element, predicate, maxDepth = 5) {
  let node = element
  for (let depth = 0; node && depth <= maxDepth; depth += 1) {
    if (predicate(node)) return node
    node = node.parentElement
  }
  return null
}

function looksLikeChallengeRoot(element, hintRule) {
  if (!element || !isVisible(element)) return false
  const text = compactText([
    element.innerText,
    element.textContent,
    element.getAttribute?.('class'),
    element.getAttribute?.('id'),
    element.getAttribute?.('data-testid'),
  ].filter(Boolean).join(' '))
  return hintRule.test(text) || /\bcaptcha\b|\bverify\b|验证码|人机验证|机器人验证/i.test(text)
}

function isLargeImageCandidate(element) {
  const rect = element.getBoundingClientRect()
  return rect.width >= 120 && rect.height >= 80
}

function isWideBackgroundCandidate(element) {
  const rect = element.getBoundingClientRect()
  return rect.width >= 180 && rect.height >= 60 && rect.width >= rect.height * 1.3
}

function isPieceCandidate(element, background) {
  const rect = element.getBoundingClientRect()
  const bg = background.getBoundingClientRect()
  return rect.width >= 24
    && rect.height >= 24
    && rect.width <= bg.width * 0.45
    && rect.height <= bg.height * 0.65
    && rect.left >= bg.left - 40
    && rect.right <= bg.right + 40
    && rect.top >= bg.top - 40
    && rect.bottom <= bg.bottom + 80
}

function isHandleCandidate(element, background) {
  const rect = element.getBoundingClientRect()
  const bg = background.getBoundingClientRect()
  const text = compactText([
    element.getAttribute?.('class'),
    element.getAttribute?.('id'),
    element.getAttribute?.('role'),
    tagNameOf(element),
  ].filter(Boolean).join(' '))
  return rect.width >= 20
    && rect.width <= Math.max(90, bg.width * 0.35)
    && rect.height >= 20
    && rect.height <= Math.max(90, bg.height)
    && rect.top <= bg.bottom + 160
    && rect.bottom >= bg.bottom - 40
    && (/(?:slider|drag|handle|button|knob|thumb|block|滑块|拖动)/i.test(text) || tagNameOf(element) === 'button')
}

function weakClickScore(entry) {
  return visibleScore(entry.image || entry.root) + visibleScore(entry.root)
}

function weakSliderScore(entry) {
  return visibleScore(entry.root) + visibleScore(entry.assets.background) + visibleScore(entry.assets.handle)
}

function tagNameOf(element) {
  return String(element?.tagName || '').toLowerCase()
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim()
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
