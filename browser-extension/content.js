const SENSITIVE_INPUT = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|otp|captcha|verification)/i

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
  const nodes = [...root.querySelectorAll('a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[contenteditable="true"],[onclick]')]
  const visible = nodes.filter(element => args.includeHidden === true || isVisible(element))
  const elements = visible.slice(0, max).map(element => {
    const input = element instanceof HTMLInputElement ? element : null
    const sensitive = input !== null && (input.type === 'password' || SENSITIVE_INPUT.test(input.name) || SENSITIVE_INPUT.test(input.id) || SENSITIVE_INPUT.test(input.autocomplete))
    return clean({
      tag: element.tagName.toLowerCase(),
      role: element.getAttribute('role') || undefined,
      text: compactText(element.innerText || element.textContent || element.getAttribute('aria-label') || '', 240),
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

function readPage(args) {
  const root = selectRoot(args.selector)
  const maxChars = Number.isInteger(args.maxChars) ? Math.max(100, Math.min(args.maxChars, 100000)) : 20000
  const text = String(root.innerText || root.textContent || '').replace(/\u0000/g, '').trim()
  return { ok: true, url: location.href, title: document.title, text: text.slice(0, maxChars), truncated: text.length > maxChars }
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
  return { ok: true, found: false, selector: args.selector, timeoutMs }
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
