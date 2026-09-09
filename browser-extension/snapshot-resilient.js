// MAIN-world snapshot fallback for pages whose content-script/frame bridge is
// temporarily unavailable. Semantic Patrol clicks depend on browser_snapshot
// before they mutate the page, so snapshot must be at least as resilient as the
// click primitive itself.

const snapshotResilientPreviousSendDomCommand = sendDomCommand

sendDomCommand = async function snapshotResilientSendDomCommand(cmd, args = {}) {
  if (cmd !== 'snapshot' || !chrome.scripting?.executeScript) {
    return await snapshotResilientPreviousSendDomCommand(cmd, args)
  }

  try {
    const value = await snapshotResilientPreviousSendDomCommand(cmd, args)
    if (value && typeof value === 'object' && value.ok !== false) return value
  } catch {
    // Fall through to MAIN-world collection below.
  }

  const tabId = await resolveTabId(args.tabId)
  return await snapshotResilientFallback(tabId, args)
}

async function snapshotResilientFallback(tabId, args = {}) {
  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  const target = typeof args.selector === 'string' && args.selector
    ? parseFrameSelector(args.selector)
    : { selector: '', frameUrl: '', topFrame: false }
  let frames = await patrolFrames(tabId)
  if (target.topFrame === true) frames = frames.filter(frame => frame.frameId === 0)
  else if (target.frameUrl) {
    const preferred = frames.filter(frame => stableFrameUrl(frame.url) === target.frameUrl)
    if (preferred.length > 0) frames = preferred
  }
  if (frames.length === 0) throw new Error('no eligible document frame is available for snapshot')

  const elements = []
  let url = ''
  let title = ''
  let truncated = false
  for (const frame of frames) {
    if (elements.length >= max) {
      truncated = true
      break
    }
    let result
    try {
      result = await snapshotResilientExecute(tabId, frame.frameId, {
        selector: target.selector,
        maxElements: max - elements.length,
        includeHidden: args.includeHidden === true,
      })
    } catch {
      continue
    }
    if (!result || result.ok === false) continue
    if (frame.frameId === 0) {
      url = typeof result.url === 'string' ? result.url : url
      title = typeof result.title === 'string' ? result.title : title
    }
    truncated ||= result.truncated === true
    for (const item of Array.isArray(result.elements) ? result.elements : []) {
      if (!item || typeof item !== 'object') continue
      const rawSelector = typeof item.selector === 'string' ? item.selector : ''
      let selector = rawSelector
      if (rawSelector) {
        if (frame.frameId === 0) selector = `top-frame::${rawSelector}`
        else {
          const frameUrl = stableFrameUrl(frame.url || result.url || '')
          selector = frameUrl
            ? `frame-url(${encodeURIComponent(frameUrl)})::${rawSelector}`
            : rawSelector
        }
      }
      elements.push({ ...item, ...(selector ? { selector } : {}) })
      if (elements.length >= max) break
    }
  }

  if (elements.length === 0) {
    throw new Error('MAIN-world snapshot fallback found no observable interactive elements')
  }
  return {
    ok: true,
    url,
    title,
    elements: elements.slice(0, max),
    truncated,
    transport: 'main-world-snapshot-fallback',
  }
}

async function snapshotResilientExecute(tabId, frameId, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: snapshotMainWorld,
    args: [args],
  })
  const result = Array.isArray(results) ? results[0]?.result : undefined
  if (!result || typeof result !== 'object') {
    throw new Error(`MAIN-world snapshot returned no result in frame ${frameId}`)
  }
  return result
}

// Serialized into the page MAIN world. Keep this function self-contained.
function snapshotMainWorld(args = {}) {
  const BASE = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[contenteditable="true"],[onclick],[bg-click],[ng-click],[data-action]'
  const CUSTOM = 'div,span,li,p,label,strong,img,svg'
  const ACTION_TEXT = /(\[[^\]]{1,24}\]|\b(RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b|登录|访问|打开|连接|进入|查看|详情|配置|下载|确定|提交|工作台|工单)/i
  const SENSITIVE = /(pass(word|wd)?|pwd|secret|token|api[-_]?key|authorization|cookie|session[-_]?id|otp|captcha|verification)/i
  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  const compact = (value, limit = 240) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    return text.length > limit ? `${text.slice(0, limit)}…` : text
  }
  const cssEscape = value => {
    try {
      if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') return globalThis.CSS.escape(String(value))
    } catch {}
    return String(value).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`)
  }
  const cssString = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const visible = element => {
    if (!(element instanceof Element)) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const width = window.innerWidth || document.documentElement.clientWidth || 0
    const height = window.innerHeight || document.documentElement.clientHeight || 0
    return !(rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height)
  }
  const likelyClickable = element => {
    if (element.matches(BASE)) return true
    const tabindex = element.getAttribute('tabindex')
    if (tabindex !== null && Number(tabindex) >= 0) return true
    const style = getComputedStyle(element)
    const label = compact(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || '', 160)
    if (!label) return false
    return style.cursor === 'pointer' || ACTION_TEXT.test(label)
  }
  const role = element => {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'button') return 'button'
    if (tag === 'a' && element.getAttribute('href')) return 'link'
    if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(element.type)) return 'button'
    if (likelyClickable(element)) return 'button'
    return undefined
  }
  const unique = selector => {
    try { return document.querySelectorAll(selector).length === 1 } catch { return false }
  }
  const segment = node => {
    const tag = node.tagName.toLowerCase()
    const stableAttrs = ['data-testid', 'data-test', 'data-cy', 'menuid', 'data-menuid', 'data-menu-id', 'data-id', 'data-key', 'name', 'aria-controls']
    for (const attr of stableAttrs) {
      const value = node.getAttribute(attr)
      if (!value) continue
      const candidate = `${tag}[${attr}="${cssString(value)}"]`
      const parent = node.parentElement
      if (!parent) return candidate
      try {
        const siblingMatches = [...parent.children].filter(child => child.matches?.(candidate))
        if (siblingMatches.length === 1) return candidate
      } catch {}
    }
    const siblings = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : []
    return siblings.length > 1 ? `${tag}:nth-of-type(${siblings.indexOf(node) + 1})` : tag
  }
  const stableSelector = element => {
    if (element.id) return `#${cssEscape(element.id)}`
    for (const attr of ['data-testid', 'data-test', 'data-cy']) {
      const value = element.getAttribute(attr)
      if (!value) continue
      const candidate = `[${attr}="${cssString(value)}"]`
      if (unique(candidate)) return candidate
    }
    const path = []
    let node = element
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body) {
      if (node.id) {
        path.unshift(`#${cssEscape(node.id)}`)
        const candidate = path.join(' > ')
        if (unique(candidate)) return candidate
        break
      }
      path.unshift(segment(node))
      const candidate = path.join(' > ')
      if (unique(candidate)) return candidate
      node = node.parentElement
    }
    return path.join(' > ') || element.tagName.toLowerCase()
  }

  let root = document.body || document.documentElement
  if (args.selector) {
    try { root = document.querySelector(args.selector) } catch { throw new Error(`invalid snapshot root selector: ${args.selector}`) }
    if (!root) throw new Error(`snapshot root not found: ${args.selector}`)
  }
  let nodes
  try { nodes = [...root.querySelectorAll(`${BASE},${CUSTOM}`)] } catch { nodes = [] }
  const interactive = nodes.filter(likelyClickable)
  const shown = interactive.filter(element => args.includeHidden === true || visible(element))
  const elements = shown.slice(0, max).map(element => {
    const input = element instanceof HTMLInputElement ? element : null
    const sensitive = input !== null && (input.type === 'password' || SENSITIVE.test(input.name) || SENSITIVE.test(input.id) || SENSITIVE.test(input.autocomplete))
    const inputActionText = input !== null && ['button', 'submit', 'reset'].includes(String(input.type || '').toLowerCase())
      ? compact(input.value, 120)
      : ''
    const text = compact(element.innerText || element.textContent || element.getAttribute('aria-label') || element.getAttribute('title') || inputActionText || '', 240)
    return Object.fromEntries(Object.entries({
      tag: element.tagName.toLowerCase(),
      role: role(element),
      text: text || undefined,
      selector: stableSelector(element),
      type: input?.type || undefined,
      name: input?.name || undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      checked: input && ['checkbox', 'radio'].includes(input.type) ? input.checked : undefined,
      value: sensitive || input === null ? undefined : compact(input.value, 120) || undefined,
    }).filter(([, value]) => value !== undefined))
  })
  return {
    ok: true,
    url: location.href,
    title: document.title || '',
    elements,
    truncated: shown.length > elements.length,
  }
}
