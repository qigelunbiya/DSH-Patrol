// Resilient last-mile DOM execution for DSH Patrol.
//
// frame-support.js remains the primary route because its content-script bridge is
// fast and produces rich structured data. This layer only takes over when that
// bridge cannot execute a DOM command (for example while a portal replaces an
// iframe or immediately after navigation). It uses chrome.scripting in the page
// MAIN world, which avoids depending on a content-script lifecycle and lets
// framework/delegated click handlers receive the same DOM event sequence.
//
// The fallback deliberately preserves Patrol's safety semantics: a mutation is
// allowed only when the selector resolves to exactly one visible element across
// the eligible frames. It never "clicks the first match".

const RESILIENT_DOM_COMMANDS = new Set(['count', 'click', 'type', 'press', 'scroll', 'wait', 'readPage'])
const resilientPreviousSendDomCommand = sendDomCommand

sendDomCommand = async function resilientSendDomCommand(cmd, args = {}) {
  if (!RESILIENT_DOM_COMMANDS.has(cmd)) return await resilientPreviousSendDomCommand(cmd, args)
  try {
    return await resilientPreviousSendDomCommand(cmd, args)
  } catch (primaryError) {
    const tabId = await resolveTabId(args.tabId)
    try {
      const recovered = await resilientDomFallback(tabId, cmd, args)
      if (recovered !== undefined) return recovered
    } catch (fallbackError) {
      throw new Error(
        `Patrol DOM command failed on both the frame bridge and MAIN-world fallback. `
        + `bridge=${safeError(primaryError)}; fallback=${safeError(fallbackError)}`,
      )
    }
    throw primaryError
  }
}

async function resilientDomFallback(tabId, cmd, args) {
  if (!chrome.scripting?.executeScript) return undefined

  const rawSelector = typeof args.selector === 'string' && args.selector ? args.selector : ''
  const target = rawSelector ? parseFrameSelector(rawSelector) : { selector: '', frameUrl: '', topFrame: false }
  const frames = await resilientEligibleFrames(tabId, target)
  if (frames.length === 0) throw new Error('no eligible document frame is available')

  if (cmd === 'readPage') {
    const parts = []
    for (const frame of frames) {
      const value = await resilientExecute(tabId, frame.frameId, 'readPage', target.selector, args)
      if (value?.ok === true && typeof value.text === 'string' && value.text.trim()) {
        parts.push(`[${frame.frameId === 0 ? 'Top document' : `Frame ${frame.frameId}`} - ${frame.url || value.url || ''}]\n${value.text.trim()}`)
      }
    }
    if (parts.length === 0) throw new Error('MAIN-world readPage returned no readable document')
    const text = parts.join('\n\n')
    const maxChars = Number.isInteger(args.maxChars) ? Math.max(100, Math.min(args.maxChars, 100000)) : 20000
    return { ok: true, url: frames.find(frame => frame.frameId === 0)?.url || '', title: '', text: text.slice(0, maxChars), truncated: text.length > maxChars, transport: 'main-world-scripting-fallback' }
  }

  if (!target.selector && !['press', 'scroll', 'wait'].includes(cmd)) {
    throw new Error(`${cmd} requires a selector for MAIN-world recovery`)
  }

  // Selector mutations first probe every eligible frame. This keeps the same
  // strict uniqueness rule as patrol_click_target even when the content bridge
  // is temporarily unavailable.
  if (target.selector) {
    const matches = []
    for (const frame of frames) {
      const probe = await resilientExecute(tabId, frame.frameId, 'count', target.selector, { visibleOnly: true })
      const count = Number.isInteger(probe?.count) ? probe.count : 0
      if (count > 0) matches.push({ frame, count })
    }
    const total = matches.reduce((sum, item) => sum + item.count, 0)
    if (cmd === 'count') {
      return { ok: true, selector: rawSelector, count: total, visibleOnly: args.visibleOnly === true, transport: 'main-world-scripting-fallback' }
    }
    if (cmd === 'wait') {
      return await resilientWait(tabId, frames, target.selector, args)
    }
    if (total === 0) throw new Error(`element not found in any eligible frame: ${target.selector}`)
    if (total > 1) {
      const detail = matches.map(item => `${item.frame.frameId}:${item.count}`).join(', ')
      throw new Error(`ambiguous selector matched ${total} visible elements across frames (${detail}): ${rawSelector || target.selector}`)
    }
    const frame = matches.find(item => item.count === 1)?.frame
    if (!frame) throw new Error(`could not resolve one frame for selector: ${rawSelector || target.selector}`)
    const value = await resilientExecute(tabId, frame.frameId, cmd, target.selector, args)
    if (!value || value.ok === false) throw new Error(value?.error || `${cmd} failed in frame ${frame.frameId}`)
    return { ...value, selector: rawSelector || target.selector, transport: 'main-world-scripting-fallback' }
  }

  // Key presses / scrolling without a selector are top-document operations.
  const top = frames.find(frame => frame.frameId === 0) ?? frames[0]
  const value = await resilientExecute(tabId, top.frameId, cmd, '', args)
  if (!value || value.ok === false) throw new Error(value?.error || `${cmd} failed in frame ${top.frameId}`)
  return { ...value, transport: 'main-world-scripting-fallback' }
}

async function resilientEligibleFrames(tabId, target) {
  const frames = await patrolFrames(tabId)
  if (target.topFrame === true) return frames.filter(frame => frame.frameId === 0)
  if (target.frameUrl) {
    const preferred = frames.filter(frame => stableFrameUrl(frame.url) === target.frameUrl)
    if (preferred.length > 0) return preferred
  }
  return frames
}

async function resilientWait(tabId, frames, selector, args) {
  const condition = args.condition === 'gone' ? 'gone' : 'visible'
  const timeoutMs = Number.isInteger(args.timeoutMs) ? Math.max(0, Math.min(args.timeoutMs, 60000)) : 10000
  const deadline = Date.now() + timeoutMs
  do {
    let total = 0
    for (const frame of frames) {
      try {
        const probe = await resilientExecute(tabId, frame.frameId, 'count', selector, { visibleOnly: true })
        total += Number.isInteger(probe?.count) ? probe.count : 0
      } catch {
      }
    }
    const found = condition === 'gone' ? total === 0 : total > 0
    if (found) return { ok: true, found: true, selector, timeoutMs, transport: 'main-world-scripting-fallback' }
    if (Date.now() >= deadline) break
    await delay(120)
  } while (true)
  return { ok: true, found: false, selector, timeoutMs, transport: 'main-world-scripting-fallback' }
}

async function resilientExecute(tabId, frameId, cmd, selector, args) {
  let results
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      world: 'MAIN',
      func: patrolMainWorldDomCommand,
      args: [cmd, selector, resilientSerializableArgs(args)],
    })
  } catch (error) {
    throw new Error(`MAIN-world execution unavailable in frame ${frameId}: ${safeError(error)}`)
  }
  const result = Array.isArray(results) ? results[0]?.result : undefined
  if (!result || typeof result !== 'object') throw new Error(`MAIN-world execution returned no result in frame ${frameId}`)
  return result
}

function resilientSerializableArgs(args) {
  const out = {}
  for (const key of ['text', 'clear', 'key', 'direction', 'amount', 'condition', 'timeoutMs', 'maxChars', 'visibleOnly']) {
    const value = args?.[key]
    if (value !== undefined && ['string', 'number', 'boolean'].includes(typeof value)) out[key] = value
  }
  return out
}

// This function is serialized by chrome.scripting.executeScript. Keep it fully
// self-contained: it must not reference extension service-worker globals.
async function patrolMainWorldDomCommand(cmd, selector, args) {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const visible = element => {
    if (!(element instanceof Element)) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden') return false
    const rect = element.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    const width = window.innerWidth || document.documentElement.clientWidth || 0
    const height = window.innerHeight || document.documentElement.clientHeight || 0
    return !(rect.right <= 0 || rect.bottom <= 0 || rect.left >= width || rect.top >= height)
  }
  const query = value => {
    if (!value) return []
    try { return [...document.querySelectorAll(value)] } catch { throw new Error(`invalid selector: ${value}`) }
  }
  const matches = () => query(selector).filter(visible)
  const one = () => {
    const nodes = matches()
    if (nodes.length !== 1) throw new Error(nodes.length === 0 ? `element not found: ${selector}` : `selector matched ${nodes.length} visible elements: ${selector}`)
    return nodes[0]
  }
  const frame = () => new Promise(resolve => requestAnimationFrame(() => resolve()))
  const disabled = element => element.matches?.(':disabled,[aria-disabled="true"]') === true

  if (cmd === 'count') return { ok: true, count: args.visibleOnly === false ? query(selector).length : matches().length }
  if (cmd === 'readPage') {
    const root = selector ? one() : (document.body || document.documentElement)
    const text = compact(root?.innerText || root?.textContent || '')
    const maxChars = Number.isInteger(args.maxChars) ? Math.max(100, Math.min(args.maxChars, 100000)) : 20000
    return { ok: true, url: location.href, title: document.title || '', text: text.slice(0, maxChars), truncated: text.length > maxChars }
  }
  if (cmd === 'wait') return { ok: true, found: matches().length > 0 }
  if (cmd === 'scroll') {
    const amount = Number.isFinite(Number(args.amount)) ? Number(args.amount) : 700
    const direction = String(args.direction || 'down')
    const target = selector ? one() : window
    if (direction === 'top') target === window ? window.scrollTo(0, 0) : target.scrollTo(0, 0)
    else if (direction === 'bottom') target === window ? window.scrollTo(0, document.documentElement.scrollHeight) : target.scrollTo(0, target.scrollHeight)
    else {
      const dx = direction === 'left' ? -amount : direction === 'right' ? amount : 0
      const dy = direction === 'up' ? -amount : direction === 'down' ? amount : 0
      target === window ? window.scrollBy(dx, dy) : target.scrollBy(dx, dy)
    }
    return { ok: true, x: window.scrollX, y: window.scrollY }
  }
  if (cmd === 'press') {
    const target = selector ? one() : (document.activeElement || document.body)
    const key = String(args.key || '')
    if (!key) throw new Error('press requires key')
    for (const type of ['keydown', 'keyup']) target.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true }))
    return { ok: true, key }
  }
  if (cmd === 'type') {
    const element = one()
    if (disabled(element)) throw new Error(`target is disabled: ${selector}`)
    const text = String(args.text ?? '')
    element.focus?.()
    const prototype = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : element instanceof HTMLInputElement ? HTMLInputElement.prototype : null
    const descriptor = prototype ? Object.getOwnPropertyDescriptor(prototype, 'value') : null
    if (args.clear !== false) {
      if (descriptor?.set) descriptor.set.call(element, '')
      else if ('value' in element) element.value = ''
    }
    const current = 'value' in element ? String(element.value ?? '') : ''
    if (descriptor?.set) descriptor.set.call(element, `${current}${text}`)
    else if ('value' in element) element.value = `${current}${text}`
    element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }))
    element.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, tag: element.tagName.toLowerCase() }
  }
  if (cmd !== 'click') throw new Error(`unsupported MAIN-world command: ${cmd}`)

  const element = one()
  if (disabled(element)) throw new Error(`target is disabled: ${selector}`)
  element.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' })

  // Playwright-style bounded actionability checks: ensure the box settles and
  // that the click point actually receives pointer events instead of an overlay.
  const before = element.getBoundingClientRect()
  await frame()
  await frame()
  if (!element.isConnected) throw new Error(`target detached before click: ${selector}`)
  const after = element.getBoundingClientRect()
  if (Math.abs(before.left - after.left) > 1 || Math.abs(before.top - after.top) > 1 || Math.abs(before.width - after.width) > 1 || Math.abs(before.height - after.height) > 1) {
    throw new Error(`target is not stable yet: ${selector}`)
  }
  const x = Math.max(after.left + 1, Math.min(after.left + after.width / 2, after.right - 1))
  const y = Math.max(after.top + 1, Math.min(after.top + after.height / 2, after.bottom - 1))
  const hit = document.elementFromPoint(x, y)
  if (hit && hit !== element && !element.contains(hit)) {
    throw new Error(`target does not receive pointer events at click point; intercepted by <${hit.tagName.toLowerCase()}>`)
  }

  element.focus?.({ preventScroll: true })
  const mouse = type => new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0, buttons: type === 'mousedown' ? 1 : 0 })
  if (typeof PointerEvent !== 'undefined') {
    for (const type of ['pointerover', 'pointermove', 'pointerdown', 'pointerup']) {
      element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }))
    }
  }
  for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) element.dispatchEvent(mouse(type))
  if (typeof element.click === 'function') element.click()
  else element.dispatchEvent(mouse('click'))
  return { ok: true, tag: element.tagName.toLowerCase(), text: compact(element.innerText || element.textContent || '').slice(0, 200) }
}
