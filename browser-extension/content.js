const SENSITIVE_INPUT = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|otp|captcha|verification)/i
const CHALLENGE_SIGNAL = /(captcha|recaptcha|hcaptcha|turnstile|geetest|slider|puzzle|human.?verify|verify.?human|verification.?code|otp|验证码|滑块|拼图|人机验证|机器人验证|二次验证|安全验证)/i
const IMAGE_CODE_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|verify[-_ ]?code|verification[-_ ]?code|validation[-_ ]?code|check[-_ ]?code|auth[-_ ]?code|\bcode\b|验证码|校验码|图形码)/i
const ACTION_TEXT_HINT = /(\[[^\]]{1,24}\]|\b(RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b|登录|访问|打开|连接|进入|查看|详情|配置|下载|确定|提交)/i
const BASE_INTERACTIVE_SELECTOR = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"],[onclick]'
const CUSTOM_INTERACTIVE_SELECTOR = '[tabindex],div,span,li,p,label,strong,img,svg'

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== 'dsh-patrol:command') return
  Promise.resolve(handle(message.cmd, message.args || {}))
    .then(value => sendResponse(value))
    .catch(error => sendResponse({ ok: false, error: safeError(error) }))
  return true
})

async function handle(cmd, args) {
  switch (cmd) {
    case 'snapshot': return snapshot(args)
    case 'readPage': return readPage(args)
    case 'challengeSignals': return challengeSignals()
    case 'imageCodeTarget': return await imageCodeTarget(args)
    case 'count': return count(args)
    case 'click': return click(args)
    case 'type': return typeText(args)
    case 'press': return press(args)
    case 'scroll': return scroll(args)
    case 'wait': return await wait(args)
    default: throw new Error(`unsupported DOM command: ${cmd}`)
  }
}

function snapshot(args) {
  const root = selectRoot(args.selector)
  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  const nodes = interactiveCandidates(root)
  const visible = nodes.filter(element => args.includeHidden === true || isVisible(element))
  const elements = visible.slice(0, max).map(element => {
    const input = element instanceof HTMLInputElement ? element : null
    const sensitive = input !== null && (input.type === 'password' || SENSITIVE_INPUT.test(input.name) || SENSITIVE_INPUT.test(input.id) || SENSITIVE_INPUT.test(input.autocomplete))
    return clean({
      tag: element.tagName.toLowerCase(),
      role: semanticRole(element),
      text: compactText(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '', 240),
      selector: stableSelector(element),
      type: input?.type || undefined,
      name: input?.name || undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      checked: input && ['checkbox', 'radio'].includes(input.type) ? input.checked : undefined,
      value: sensitive || input === null ? undefined : compactText(input.value, 120) || undefined,
    })
  })
  return { ok: true, url: location.href, title: document.title, elements, truncated: visible.length > elements.length }
}

function interactiveCandidates(root) {
  const selector = `${BASE_INTERACTIVE_SELECTOR},${CUSTOM_INTERACTIVE_SELECTOR}`
  const nodes = [...root.querySelectorAll(selector)]
  return nodes.filter(element => element.matches(BASE_INTERACTIVE_SELECTOR) || isLikelyClickable(element))
}

function isLikelyClickable(element) {
  const tabindex = element.getAttribute('tabindex')
  if (tabindex !== null && Number(tabindex) >= 0) return true
  const style = getComputedStyle(element)
  const label = compactText(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '', 160)
  if (label.length === 0) return false
  if (style.cursor === 'pointer') return true
  return ACTION_TEXT_HINT.test(label)
}

function semanticRole(element) {
  const explicit = element.getAttribute('role')
  if (explicit) return explicit
  const tag = element.tagName.toLowerCase()
  if (tag === 'button') return 'button'
  if (tag === 'a' && element.getAttribute('href')) return 'link'
  if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) return 'button'
  if (isLikelyClickable(element)) return 'button'
  return undefined
}

function readPage(args) {
  const root = selectRoot(args.selector)
  const maxChars = Number.isInteger(args.maxChars) ? Math.max(100, Math.min(args.maxChars, 100000)) : 20000
  const text = String(root.innerText || root.textContent || '').replace(/\u0000/g, '').trim()
  return { ok: true, url: location.href, title: document.title, text: text.slice(0, maxChars), truncated: text.length > maxChars }
}

function challengeSignals() {
  const nodes = [...document.querySelectorAll('img,iframe,canvas,[id],[class],[aria-label],[title]')].slice(0, 600)
  const signals = []
  for (const element of nodes) {
    const src = safeResourcePath(element.getAttribute('src'))
    const raw = compactText([
      element.tagName.toLowerCase(),
      element.id || '',
      typeof element.className === 'string' ? element.className : '',
      element.getAttribute('name') || '',
      element.getAttribute('role') || '',
      element.getAttribute('aria-label') || '',
      element.getAttribute('alt') || '',
      element.getAttribute('title') || '',
      src,
    ].join(' '), 360)
    if (raw && CHALLENGE_SIGNAL.test(raw)) signals.push(raw)
    if (signals.length >= 40) break
  }
  return { ok: true, signals: [...new Set(signals)].slice(0, 40) }
}

async function imageCodeTarget(args) {
  // Legacy systems often give the input a very explicit id such as #captcha
  // while the adjacent captcha image is just a generic <img>. Find the input
  // first and use its form/spatial relationship to locate the image instead of
  // requiring captcha-ish attributes on the image itself.
  const hintedInput = args.inputSelector ? requiredElement(args.inputSelector) : pickExplicitImageCodeInput()
  const image = args.imageSelector ? requiredElement(args.imageSelector) : pickImageCodeImage(hintedInput)
  if (!image) throw new Error('no conventional image-code image found')

  const input = hintedInput || pickImageCodeInput(image)
  if (!input) throw new Error('no conventional image-code input found')
  if (!isEditableCodeInput(input)) throw new Error('image-code target is not an editable input')

  image.scrollIntoView({ block: 'center', inline: 'center' })
  await sleep(80)
  const rect = image.getBoundingClientRect()
  if (rect.width <= 0 || rect.height <= 0) throw new Error('image-code image has empty bounds')
  if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= window.innerWidth || rect.top >= window.innerHeight) {
    throw new Error('image-code image is outside the visible viewport')
  }

  return {
    ok: true,
    imageSelector: stableSelector(image),
    inputSelector: stableSelector(input),
    rect: { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
    viewport: { width: window.innerWidth, height: window.innerHeight },
  }
}

function pickExplicitImageCodeInput() {
  const candidates = [...document.querySelectorAll('input,textarea')]
    .filter(element => isVisible(element) && isEditableCodeInput(element))
  let best
  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index]
    const attrs = imageCodeAttributes(element)
    if (!IMAGE_CODE_HINT.test(attrs)) continue
    let score = 12
    const maxLength = element instanceof HTMLInputElement ? element.maxLength : -1
    if (maxLength >= 2 && maxLength <= 12) score += 4
    if (/captcha|验证码/i.test(`${element.id || ''} ${element.getAttribute('name') || ''}`)) score += 8
    if (!best || score > best.score) best = { element, score, index }
  }
  return best?.element
}

function pickImageCodeImage(input) {
  const candidates = [...document.querySelectorAll('img,canvas,svg')].filter(isVisible)
  const inputRect = input?.getBoundingClientRect?.()
  const inputForm = input?.closest?.('form') || null
  let best
  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index]
    let score = imageCodeImageScore(element)
    if (inputRect) {
      const rect = element.getBoundingClientRect()
      const verticalDistance = Math.abs((rect.top + rect.height / 2) - (inputRect.top + inputRect.height / 2))
      const horizontalDistance = Math.abs((rect.left + rect.width / 2) - (inputRect.left + inputRect.width / 2))
      if (inputForm && element.closest?.('form') === inputForm) score += 7
      if (verticalDistance <= 70) score += 9
      else if (verticalDistance <= 180) score += 4
      if (horizontalDistance <= 260) score += 6
      else if (horizontalDistance <= 600) score += 2
      if (rect.left >= inputRect.left - 40) score += 2
    }
    const minimum = inputRect ? 9 : 8
    if (score < minimum) continue
    if (!best || score > best.score || (score === best.score && index < best.index)) best = { element, score, index }
  }
  return best?.element
}

function imageCodeImageScore(element) {
  const rect = element.getBoundingClientRect()
  const attrs = imageCodeAttributes(element)
  let score = IMAGE_CODE_HINT.test(attrs) ? 10 : 0
  if (rect.width >= 40 && rect.width <= 500 && rect.height >= 18 && rect.height <= 200) score += 2
  if (element.tagName.toLowerCase() === 'canvas') score += 1
  return score
}

function pickImageCodeInput(image) {
  const imageRect = image.getBoundingClientRect()
  const imageForm = image.closest('form')
  const candidates = [...document.querySelectorAll('input,textarea')]
    .filter(element => isVisible(element) && isEditableCodeInput(element))
  let best

  for (let index = 0; index < candidates.length; index += 1) {
    const element = candidates[index]
    const rect = element.getBoundingClientRect()
    const attrs = imageCodeAttributes(element)
    let score = IMAGE_CODE_HINT.test(attrs) ? 10 : 0
    const maxLength = element instanceof HTMLInputElement ? element.maxLength : -1
    if (maxLength >= 2 && maxLength <= 12) score += 3
    if (imageForm && element.closest('form') === imageForm) score += 4

    const verticalDistance = Math.abs((rect.top + rect.height / 2) - (imageRect.top + imageRect.height / 2))
    const horizontalDistance = Math.abs((rect.left + rect.width / 2) - (imageRect.left + imageRect.width / 2))
    if (verticalDistance <= 180) score += 4
    if (horizontalDistance <= 500) score += 1
    if (score < 7) continue
    if (!best || score > best.score) best = { element, score, index }
  }

  return best?.element
}

function isEditableCodeInput(element) {
  if (element instanceof HTMLTextAreaElement) return true
  if (!(element instanceof HTMLInputElement)) return false
  return !['password', 'hidden', 'submit', 'button', 'checkbox', 'radio', 'file'].includes(element.type)
}

function imageCodeAttributes(element) {
  return compactText([
    element.tagName.toLowerCase(),
    element.id || '',
    typeof element.className === 'string' ? element.className : '',
    element.getAttribute('name') || '',
    element.getAttribute('placeholder') || '',
    element.getAttribute('aria-label') || '',
    element.getAttribute('alt') || '',
    element.getAttribute('title') || '',
    safeResourcePath(element.getAttribute('src')),
  ].join(' '), 500)
}

function safeResourcePath(value) {
  if (!value) return ''
  try {
    const url = new URL(value, location.href)
    return `${url.origin}${url.pathname}`
  } catch {
    return String(value).split(/[?#]/, 1)[0]
  }
}

function count(args) {
  if (typeof args.selector !== 'string' || !args.selector) throw new Error('selector is required')
  let elements
  try { elements = [...document.querySelectorAll(args.selector)] } catch { throw new Error(`invalid selector: ${args.selector}`) }
  const visibleOnly = args.visibleOnly !== false
  const matched = visibleOnly ? elements.filter(isVisible) : elements
  return { ok: true, selector: args.selector, count: matched.length, visibleOnly }
}

function click(args) {
  const element = requiredElement(args.selector)
  element.scrollIntoView({ block: 'center', inline: 'center' })
  if (typeof element.click !== 'function') throw new Error(`selector ${args.selector} is not clickable`)
  element.click()
  return { ok: true, selector: args.selector, tag: element.tagName.toLowerCase(), text: compactText(element.innerText || element.textContent || '', 120) }
}

function typeText(args) {
  const element = requiredElement(args.selector)
  const text = typeof args.text === 'string' ? args.text : ''
  element.scrollIntoView({ block: 'center' })
  element.focus()
  if (element instanceof HTMLInputElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    if (!setter) throw new Error('input value setter unavailable')
    setter.call(element, args.clear === false ? element.value + text : text)
  } else if (element instanceof HTMLTextAreaElement) {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
    if (!setter) throw new Error('textarea value setter unavailable')
    setter.call(element, args.clear === false ? element.value + text : text)
  } else if (element.isContentEditable) {
    element.textContent = args.clear === false ? (element.textContent || '') + text : text
  } else {
    throw new Error(`selector ${args.selector} is not an editable field`)
  }
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return { ok: true, selector: args.selector }
}

function press(args) {
  const target = args.selector ? requiredElement(args.selector) : document.activeElement || document.body
  if (args.selector) target.focus()
  const key = String(args.key || '')
  if (!key) throw new Error('key is required')
  target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
  target.dispatchEvent(new KeyboardEvent('keyup', { key, bubbles: true }))
  if (key === 'Enter' && target instanceof HTMLInputElement && target.form) target.form.requestSubmit()
  return { ok: true, key }
}

function scroll(args) {
  const target = args.selector ? requiredElement(args.selector) : window
  const amount = Number.isFinite(args.amount) ? Number(args.amount) : Math.max(window.innerHeight * 0.8, 400)
  const direction = args.direction
  if (direction === 'top') scrollTarget(target, 0, 0, true)
  else if (direction === 'bottom') scrollTarget(target, 0, Number.MAX_SAFE_INTEGER, true)
  else if (direction === 'up') scrollTarget(target, 0, -amount)
  else if (direction === 'down') scrollTarget(target, 0, amount)
  else if (direction === 'left') scrollTarget(target, -amount, 0)
  else if (direction === 'right') scrollTarget(target, amount, 0)
  else throw new Error(`unsupported scroll direction: ${direction}`)
  const x = target === window ? window.scrollX : target.scrollLeft
  const y = target === window ? window.scrollY : target.scrollTop
  return { ok: true, x, y }
}

async function wait(args) {
  const timeoutMs = Number.isInteger(args.timeoutMs) ? Math.max(0, Math.min(args.timeoutMs, 60000)) : 10000
  if (!args.selector) {
    await sleep(timeoutMs)
    return { ok: true, found: false, timeoutMs }
  }
  const condition = args.condition === 'gone' ? 'gone' : 'visible'
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    const element = document.querySelector(args.selector)
    const visible = element !== null && isVisible(element)
    if ((condition === 'visible' && visible) || (condition === 'gone' && !visible)) {
      return { ok: true, found: true, selector: args.selector, timeoutMs }
    }
    await sleep(150)
  }
  return { ok: false, found: false, selector: args.selector, timeoutMs, error: `timed out waiting for ${condition} condition: ${args.selector}` }
}

function selectRoot(selector) {
  if (!selector) return document.body || document.documentElement
  return requiredElement(selector)
}

function requiredElement(selector) {
  if (typeof selector !== 'string' || !selector) throw new Error('selector is required')
  let element
  try { element = document.querySelector(selector) } catch { throw new Error(`invalid selector: ${selector}`) }
  if (!element) throw new Error(`element not found: ${selector}`)
  return element
}

function isVisible(element) {
  const style = getComputedStyle(element)
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
  const rect = element.getBoundingClientRect()
  return rect.width > 0 && rect.height > 0
}

function stableSelector(element) {
  if (element.id) return `#${CSS.escape(element.id)}`
  for (const attr of ['data-testid', 'data-test', 'data-cy']) {
    const value = element.getAttribute(attr)
    if (value) return `[${attr}="${cssString(value)}"]`
  }
  const name = element.getAttribute('name')
  if (name) {
    const candidate = `${element.tagName.toLowerCase()}[name="${cssString(name)}"]`
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

function cssString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function scrollTarget(target, x, y, absolute = false) {
  if (target === window) {
    if (absolute) window.scrollTo(x, y)
    else window.scrollBy(x, y)
  } else if (absolute) target.scrollTo(x, y)
  else target.scrollBy(x, y)
}

function compactText(value, max) {
  const text = String(value).replace(/\s+/g, ' ').trim()
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function clean(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined))
}

function sleep(ms) { return new Promise(resolve => setTimeout(resolve, ms)) }

function safeError(error) {
  return error && typeof error.message === 'string' ? error.message : String(error)
}
