const VISUAL_IMAGE_CODE_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|verify[-_ ]?code|verification[-_ ]?code|validation[-_ ]?code|check[-_ ]?code|auth[-_ ]?code|\bcode\b|验证码|校验码|图形码)/i

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'dsh-patrol:visual-command') return
  Promise.resolve(handleVisualCommand(message.cmd, message.args || {}))
    .then(value => sendResponse(value))
    .catch(error => sendResponse({ ok: false, error: visualSafeError(error) }))
  return true
})

async function handleVisualCommand(cmd, args) {
  if (cmd === 'snapshotVisuals') return snapshotVisuals(args)
  if (cmd === 'imageCodeTarget') return await visualImageCodeTarget(args)
  throw new Error(`unsupported visual command: ${cmd}`)
}

function snapshotVisuals(args) {
  const root = visualSelectRoot(args.selector)
  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  const candidates = visualCandidates(root)
  const elements = candidates.slice(0, max).map(element => ({
    tag: element.tagName.toLowerCase(),
    role: element.getAttribute('role') || undefined,
    text: visualSummary(element),
    selector: visualStableSelector(element),
  }))
  return {
    ok: true,
    elements: elements.map(visualClean),
    truncated: candidates.length > elements.length,
  }
}

async function visualImageCodeTarget(args) {
  const input = args.inputSelector
    ? visualRequiredElement(args.inputSelector)
    : pickVisualImageCodeInput()
  if (!input) throw new Error('no conventional image-code input found')
  if (!visualEditableCodeInput(input)) throw new Error('image-code target is not an editable input')

  const image = args.imageSelector
    ? visualRequiredElement(args.imageSelector)
    : pickVisualImageCodeImage(input)

  input.scrollIntoView({ block: 'center', inline: 'nearest' })
  if (image) image.scrollIntoView({ block: 'center', inline: 'center' })
  await visualSleep(80)

  const viewport = { width: window.innerWidth, height: window.innerHeight }
  if (image) {
    const rect = visualRect(image)
    assertVisibleRect(rect, viewport, 'image-code image')
    const sourceDataUrl = directVisualDataUrl(image)
    return visualClean({
      ok: true,
      captureMode: sourceDataUrl ? 'direct-source' : 'element-crop',
      imageSelector: visualStableSelector(image),
      inputSelector: visualStableSelector(input),
      rect,
      viewport,
      sourceDataUrl,
    })
  }

  const rect = neighborCaptureRect(input)
  assertVisibleRect(rect, viewport, 'image-code neighbor region')
  return {
    ok: true,
    captureMode: 'neighbor-region',
    imageSelector: '',
    inputSelector: visualStableSelector(input),
    rect,
    viewport,
  }
}

function visualCandidates(root) {
  const queryRoot = root && typeof root.querySelectorAll === 'function' ? root : document
  const media = [...queryRoot.querySelectorAll('img,canvas,svg')]
  const backgrounds = []
  const all = [...queryRoot.querySelectorAll('*')].slice(0, 1800)
  for (const element of all) {
    if (media.includes(element) || !visualIsVisible(element)) continue
    const background = getComputedStyle(element).backgroundImage
    if (background && background !== 'none' && /url\(/i.test(background)) backgrounds.push(element)
    if (backgrounds.length >= 120) break
  }
  return [...new Set([...media, ...backgrounds])].filter(visualIsVisible)
}

function pickVisualImageCodeInput() {
  const candidates = [...document.querySelectorAll('input,textarea')]
    .filter(element => visualIsVisible(element) && visualEditableCodeInput(element))
  let best
  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index]
    const attrs = visualAttributes(element)
    if (!VISUAL_IMAGE_CODE_HINT.test(attrs)) continue
    let score = 12
    if (/captcha|验证码/i.test(`${element.id || ''} ${element.getAttribute('name') || ''} ${element.getAttribute('placeholder') || ''}`)) score += 10
    const maxLength = element instanceof HTMLInputElement ? element.maxLength : -1
    if (maxLength >= 2 && maxLength <= 12) score += 4
    if (!best || score > best.score) best = { element, score, index }
  }
  return best?.element
}

function pickVisualImageCodeImage(input) {
  const candidates = visualCandidates(document)
  const inputRect = input.getBoundingClientRect()
  const inputForm = input.closest?.('form') || null
  let best

  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index]
    if (element === input || element.contains?.(input)) continue
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) continue

    const attrs = visualAttributes(element)
    const parentAttrs = visualAttributes(element.parentElement)
    const semanticHint = VISUAL_IMAGE_CODE_HINT.test(`${attrs} ${parentAttrs}`)
    const sameForm = !!inputForm && element.closest?.('form') === inputForm
    const nearAncestor = sharesNearAncestor(element, input)
    const verticalDistance = Math.abs(centerY(rect) - centerY(inputRect))
    const horizontalDistance = Math.abs(centerX(rect) - centerX(inputRect))

    // A generic brand/logo image should never win merely because it has a
    // captcha-like size. Without semantic evidence, require strong row/form/
    // ancestor proximity to the explicit captcha input.
    if (!semanticHint && verticalDistance > 140 && !sameForm && !nearAncestor) continue

    let score = semanticHint ? 12 : 0
    if (rect.width >= 35 && rect.width <= 500 && rect.height >= 18 && rect.height <= 220) score += 5
    if (sameForm) score += 10
    if (verticalDistance <= 28) score += 15
    else if (verticalDistance <= 70) score += 10
    else if (verticalDistance <= 160) score += 3
    if (horizontalDistance <= 260) score += 9
    else if (horizontalDistance <= 600) score += 2
    if (rect.left >= inputRect.right - 8) score += 5
    if (nearAncestor) score += 8
    if (directVisualDataUrl(element)) score += 4

    if (score < 13) continue
    if (!best || score > best.score || (score === best.score && index < best.index)) best = { element, score, index }
  }
  return best?.element
}

function neighborCaptureRect(input) {
  const inputRect = input.getBoundingClientRect()
  let node = input.parentElement
  let best
  let depth = 0
  while (node && node !== document.body && depth < 6) {
    const rect = node.getBoundingClientRect()
    if (visualIsVisible(node)
      && rect.width >= inputRect.width + 35
      && rect.height <= Math.max(140, inputRect.height * 3.5)
      && rect.left <= inputRect.left + 4
      && rect.right >= inputRect.right - 4) {
      best = rect
      break
    }
    node = node.parentElement
    depth += 1
  }

  const container = best || {
    left: Math.max(0, inputRect.left - inputRect.width),
    right: Math.min(window.innerWidth, inputRect.right + inputRect.width * 2),
    top: Math.max(0, inputRect.top - 8),
    bottom: Math.min(window.innerHeight, inputRect.bottom + 8),
    width: inputRect.width * 3,
    height: inputRect.height + 16,
  }

  const gap = 2
  const rightWidth = Math.max(0, container.right - inputRect.right - gap)
  const leftWidth = Math.max(0, inputRect.left - container.left - gap)
  if (rightWidth >= 35) {
    return clampRect({ left: inputRect.right + gap, top: container.top, width: rightWidth, height: container.bottom - container.top })
  }
  if (leftWidth >= 35) {
    return clampRect({ left: container.left, top: container.top, width: leftWidth, height: container.bottom - container.top })
  }
  return clampRect({
    left: Math.max(0, inputRect.left - 8),
    top: Math.max(0, inputRect.top - 8),
    width: Math.min(window.innerWidth - Math.max(0, inputRect.left - 8), inputRect.width + 220),
    height: Math.min(window.innerHeight - Math.max(0, inputRect.top - 8), inputRect.height + 16),
  })
}

function directVisualDataUrl(element) {
  const tag = element?.tagName?.toLowerCase?.() || ''
  if (tag === 'img') {
    const value = String(element.currentSrc || element.src || element.getAttribute('src') || '')
    if (/^data:image\//i.test(value)) return value
  }
  const background = element ? getComputedStyle(element).backgroundImage : ''
  const match = /^url\(["']?(data:image\/[^"')]+)["']?\)$/i.exec(String(background || '').trim())
  return match?.[1]
}

function visualSummary(element) {
  const tag = element.tagName.toLowerCase()
  const rect = element.getBoundingClientRect()
  const alt = element.getAttribute('alt') || ''
  const title = element.getAttribute('title') || ''
  const aria = element.getAttribute('aria-label') || ''
  let resource = ''
  if (tag === 'img') resource = resourceSummary(element.currentSrc || element.src || element.getAttribute('src') || '')
  else {
    const background = getComputedStyle(element).backgroundImage
    if (background && background !== 'none') resource = resourceSummary(background)
  }
  const text = String(element.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80)
  return [`visual:${tag}`, alt || aria || title || text, resource, `${Math.round(rect.width)}x${Math.round(rect.height)}`]
    .filter(Boolean)
    .join(' ')
}

function resourceSummary(value) {
  const text = String(value || '').trim()
  if (!text) return ''
  if (/data:image\//i.test(text)) {
    const mime = /data:(image\/[^;,]+)/i.exec(text)?.[1] || 'image/*'
    return `src=${mime};base64`
  }
  return `src=${text.replace(/^url\(["']?|["']?\)$/g, '').slice(0, 160)}`
}

function visualAttributes(element) {
  if (!element) return ''
  return [
    element.tagName?.toLowerCase?.() || '',
    element.id || '',
    typeof element.className === 'string' ? element.className : '',
    element.getAttribute?.('name') || '',
    element.getAttribute?.('placeholder') || '',
    element.getAttribute?.('aria-label') || '',
    element.getAttribute?.('alt') || '',
    element.getAttribute?.('title') || '',
    resourceSummary(element.getAttribute?.('src') || ''),
  ].join(' ')
}

function sharesNearAncestor(left, right) {
  // BODY/HTML are page roots, not evidence that two visible elements belong to
  // the same visual component. Counting them as "near" allowed a distant brand
  // logo to beat the explicit #captcha neighbor screenshot fallback.
  const roots = new Set([document.body, document.documentElement].filter(Boolean))
  const ancestors = new Set()
  let node = left?.parentElement
  let depth = 0
  while (node && depth < 4) {
    if (roots.has(node)) break
    ancestors.add(node)
    node = node.parentElement
    depth += 1
  }
  node = right?.parentElement
  depth = 0
  while (node && depth < 4) {
    if (roots.has(node)) break
    if (ancestors.has(node)) return true
    node = node.parentElement
    depth += 1
  }
  return false
}

function visualEditableCodeInput(element) {
  if (element instanceof HTMLTextAreaElement) return true
  if (!(element instanceof HTMLInputElement)) return false
  return !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(element.type)
}

function visualSelectRoot(selector) {
  if (!selector) return document.body || document.documentElement
  return visualRequiredElement(selector)
}

function visualRequiredElement(selector) {
  if (typeof selector !== 'string' || !selector) throw new Error('selector is required')
  let element
  try { element = document.querySelector(selector) } catch { throw new Error(`invalid selector: ${selector}`) }
  if (!element) throw new Error(`element not found: ${selector}`)
  return element
}

function visualIsVisible(element) {
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function visualRect(element) {
  const rect = element.getBoundingClientRect()
  return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
}

function assertVisibleRect(rect, viewport, name) {
  if (rect.width <= 0 || rect.height <= 0) throw new Error(`${name} has empty bounds`)
  if (rect.left + rect.width <= 0 || rect.top + rect.height <= 0 || rect.left >= viewport.width || rect.top >= viewport.height) {
    throw new Error(`${name} is outside the visible viewport`)
  }
}

function clampRect(rect) {
  const left = Math.max(0, Number(rect.left) || 0)
  const top = Math.max(0, Number(rect.top) || 0)
  const right = Math.min(window.innerWidth, left + Math.max(1, Number(rect.width) || 1))
  const bottom = Math.min(window.innerHeight, top + Math.max(1, Number(rect.height) || 1))
  return { left, top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
}

function centerX(rect) { return rect.left + rect.width / 2 }
function centerY(rect) { return rect.top + rect.height / 2 }

function visualStableSelector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`
  for (const attr of ['data-testid', 'data-test', 'data-cy']) {
    const value = element.getAttribute(attr)
    if (value) return `[${attr}="${visualCssString(value)}"]`
  }
  const name = element.getAttribute('name')
  if (name) {
    const candidate = `${element.tagName.toLowerCase()}[name="${visualCssString(name)}"]`
    if (document.querySelectorAll(candidate).length === 1) return candidate
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

function visualCssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function visualClean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function visualSleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }
function visualSafeError(error) { return error && typeof error.message === 'string' ? error.message : String(error) }
