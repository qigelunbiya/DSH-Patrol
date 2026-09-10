// Foreground modal target hardening for DSH Patrol.
//
// Dynamic React/Vue/Ant Design login flows often render a modal after an
// earlier click. Positional selectors such as `div:nth-of-type(2) > form >
// button` are valid only for one render and can become stale as TOTP values or
// validation state re-render the modal. When a real blocking modal is visible,
// rebuild the TOP-document snapshot from that modal in the page MAIN world,
// generate class/attribute based stable selectors, and suppress background
// controls that cannot currently receive pointer events.
//
// This layer is intentionally modal-only. Ordinary pages keep the existing
// frame-aware snapshot behavior, so hardening one portal does not change target
// ranking across unrelated websites.

const modalTargetPreviousSendDomCommand = sendDomCommand

sendDomCommand = async function modalTargetHardenedSendDomCommand(cmd, args = {}) {
  if (cmd !== 'snapshot' || !chrome.scripting?.executeScript) {
    return await modalTargetPreviousSendDomCommand(cmd, args)
  }

  const base = await modalTargetPreviousSendDomCommand(cmd, args)
  const tabId = await resolveTabId(args.tabId)
  let modalSnapshot
  try {
    modalSnapshot = await modalTargetSnapshot(tabId, args)
  } catch {
    return base
  }
  if (!modalSnapshot?.modalActive || !Array.isArray(modalSnapshot.elements) || modalSnapshot.elements.length === 0) {
    return base
  }

  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  const elements = modalSnapshot.elements.slice(0, max).map(item => ({
    ...item,
    selector: typeof item.selector === 'string' && item.selector
      ? `top-frame::${item.selector}`
      : item.selector,
  }))

  return {
    ok: true,
    url: modalSnapshot.url || base?.url || '',
    title: modalSnapshot.title || base?.title || '',
    elements,
    truncated: modalSnapshot.truncated === true,
    foregroundModal: true,
    transport: 'main-world-modal-snapshot',
  }
}

async function modalTargetSnapshot(tabId, args = {}) {
  const maxElements = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: modalTargetCollectMainWorld,
    args: [{ maxElements }],
  })
  const value = Array.isArray(results) ? results[0]?.result : undefined
  if (!value || typeof value !== 'object') throw new Error('modal MAIN-world snapshot returned no result')
  return value
}

// Serialized into the page MAIN world. Keep this function self-contained.
function modalTargetCollectMainWorld(args = {}) {
  const MODAL_SELECTOR = [
    '[role="dialog"]',
    '[aria-modal="true"]',
    '.ant-modal-content',
    '.el-dialog',
    '.ivu-modal',
    '.arco-modal',
    '.semi-modal',
    '.modal-dialog',
  ].join(',')
  const BASE = 'a,button,input,select,textarea,[role="button"],[role="link"],[role="checkbox"],[role="tab"],[role="menuitem"],[contenteditable="true"],[onclick],[data-action]'
  const max = Number.isInteger(args.maxElements) ? Math.max(1, Math.min(args.maxElements, 500)) : 150

  const compact = (value, limit = 240) => {
    const text = String(value || '').replace(/\s+/g, ' ').trim()
    // UI frameworks sometimes render Chinese labels as "确 定" / "登 录".
    // Remove only whitespace between CJK characters so semantic locator text
    // "确定" remains exact without collapsing ordinary English word spacing.
    const cjkJoined = text.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1')
    return cjkJoined.length > limit ? `${cjkJoined.slice(0, limit)}…` : cjkJoined
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
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0 || style.pointerEvents === 'none') return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const width = window.innerWidth || document.documentElement.clientWidth || 0
    const height = window.innerHeight || document.documentElement.clientHeight || 0
    return !(rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height)
  }
  const receivesPointer = element => {
    if (!visible(element)) return false
    const rect = element.getBoundingClientRect()
    const x = Math.max(rect.left + 1, Math.min(rect.left + rect.width / 2, rect.right - 1))
    const y = Math.max(rect.top + 1, Math.min(rect.top + rect.height / 2, rect.bottom - 1))
    const hit = document.elementFromPoint(x, y)
    return !hit || hit === element || element.contains(hit)
  }
  const unique = selector => {
    try { return document.querySelectorAll(selector).length === 1 } catch { return false }
  }
  const stableClassTokens = element => {
    const tokens = [...(element.classList || [])]
      .filter(token => /^[A-Za-z_][A-Za-z0-9_-]{2,}$/.test(token))
      .filter(token => !/^(active|selected|checked|disabled|focus|focused|hover|show|shown|open|opened|hidden)$/i.test(token))
    return tokens.sort((left, right) => {
      const leftApp = /[_-]/.test(left) && !/^(ant|el|ivu|arco|semi)-/i.test(left) ? 1 : 0
      const rightApp = /[_-]/.test(right) && !/^(ant|el|ivu|arco|semi)-/i.test(right) ? 1 : 0
      return rightApp - leftApp || left.length - right.length || left.localeCompare(right)
    })
  }
  const stableSegment = node => {
    const tag = node.tagName.toLowerCase()
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name', 'data-key', 'data-id']) {
      const value = node.getAttribute(attr)
      if (!value) continue
      const candidate = `${tag}[${attr}="${cssString(value)}"]`
      if (unique(candidate)) return candidate
    }
    const classes = stableClassTokens(node)
    if (classes.length > 0) {
      const one = `${tag}.${cssEscape(classes[0])}`
      if (unique(one)) return one
      if (classes.length > 1) {
        const two = `${tag}.${cssEscape(classes[0])}.${cssEscape(classes[1])}`
        if (unique(two)) return two
      }
      // Even when not globally unique, a stable class segment is much more
      // durable inside the progressively-built modal path than nth-of-type.
      return one
    }
    const parent = node.parentElement
    const sameTag = parent ? [...parent.children].filter(child => child.tagName === node.tagName) : []
    return sameTag.length > 1 ? `${tag}:nth-of-type(${sameTag.indexOf(node) + 1})` : tag
  }
  const stableSelector = element => {
    if (element.id) return `#${cssEscape(element.id)}`
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'aria-label', 'name']) {
      const value = element.getAttribute(attr)
      if (!value) continue
      const candidate = `${element.tagName.toLowerCase()}[${attr}="${cssString(value)}"]`
      if (unique(candidate)) return candidate
    }
    const path = []
    let node = element
    let depth = 0
    while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.body && depth < 10) {
      if (node.id) {
        path.unshift(`#${cssEscape(node.id)}`)
      } else {
        path.unshift(stableSegment(node))
      }
      const candidate = path.join(' > ')
      if (unique(candidate)) return candidate
      if (node.id) break
      node = node.parentElement
      depth += 1
    }
    return path.join(' > ') || element.tagName.toLowerCase()
  }
  const role = element => {
    const explicit = element.getAttribute('role')
    if (explicit) return explicit
    const tag = element.tagName.toLowerCase()
    if (tag === 'button') return 'button'
    if (tag === 'a' && element.getAttribute('href')) return 'link'
    if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase())) return 'button'
    return undefined
  }

  const visibleModals = [...document.querySelectorAll(MODAL_SELECTOR)].filter(visible)
  if (visibleModals.length === 0) {
    return { ok: true, modalActive: false, url: location.href, title: document.title || '', elements: [], truncated: false }
  }

  // Prefer the last visible modal in DOM order. Portal frameworks append the
  // active confirmation dialog last; nested modal-content roots naturally win
  // over stale hidden wrappers because hidden nodes were filtered above.
  const modal = visibleModals[visibleModals.length - 1]
  const nodes = [
    ...(modal.matches?.(BASE) ? [modal] : []),
    ...modal.querySelectorAll(BASE),
  ]
  const actionable = [...new Set(nodes)].filter(receivesPointer)
  const elements = actionable.slice(0, max).map(element => {
    const input = element instanceof HTMLInputElement ? element : null
    const inputActionText = input && ['button', 'submit', 'reset'].includes(String(input.type || '').toLowerCase()) ? input.value : ''
    const text = compact(
      element.innerText
      || element.textContent
      || element.getAttribute('aria-label')
      || element.getAttribute('title')
      || inputActionText
      || '',
      240,
    )
    return Object.fromEntries(Object.entries({
      tag: element.tagName.toLowerCase(),
      role: role(element),
      text: text || undefined,
      selector: stableSelector(element),
      type: input?.type || undefined,
      name: input?.name || undefined,
      href: element instanceof HTMLAnchorElement ? element.href : undefined,
      checked: input && ['checkbox', 'radio'].includes(input.type) ? input.checked : undefined,
      value: input && input.type !== 'password' && !/(otp|token|secret|captcha|verification)/i.test(`${input.id} ${input.name}`)
        ? compact(input.value, 120) || undefined
        : undefined,
    }).filter(([, value]) => value !== undefined))
  })

  return {
    ok: true,
    modalActive: true,
    url: location.href,
    title: document.title || '',
    elements,
    truncated: actionable.length > elements.length,
  }
}
