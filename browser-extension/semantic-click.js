// Atomic semantic click transport for DSH Patrol.
//
// This deliberately resolves the semantic target and performs the click inside
// one extension command. It does not depend on a content-script page bridge, so
// a CURRENT snapshot cannot go stale or acquire the wrong frame scope between
// "find" and "click". The command probes every accessible document with
// chrome.scripting in MAIN world, requires one globally best target, then
// re-resolves that target in the chosen frame immediately before clicking.

const semanticClickPreviousHandleCommand = handleCommand

handleCommand = async function semanticClickHandleCommand(cmd, args = {}) {
  if (cmd === 'semanticClick') return await semanticClickCommand(args)
  return await semanticClickPreviousHandleCommand(cmd, args)
}

async function semanticClickCommand(args) {
  if (!chrome.scripting?.executeScript) throw new Error('semantic click requires chrome.scripting.executeScript')
  const tabId = await resolveTabId(args.tabId)
  const spec = semanticSerializableSpec(args)
  if (!spec.locatorText && !spec.selectorHint && !spec.task) {
    throw new Error('semanticClick requires locatorText, selectorHint, or task context')
  }

  const frames = await semanticClickFrames(tabId)
  const candidates = []
  for (const frame of frames) {
    try {
      const result = await semanticClickExecute(tabId, frame.frameId, 'probe', spec)
      for (const candidate of Array.isArray(result?.candidates) ? result.candidates : []) {
        if (!candidate || typeof candidate !== 'object') continue
        candidates.push({ frame, candidate })
      }
    } catch {
      // Browser-internal frames may reject MAIN-world execution. Other frames
      // remain eligible; absence in one inaccessible frame is not a reason to
      // fall back to the fragile content-script bridge.
    }
  }

  if (candidates.length === 0) {
    throw new Error(`atomic semantic target not found for ${semanticDescribeSpec(spec)}`)
  }
  candidates.sort((left, right) => Number(right.candidate.score || 0) - Number(left.candidate.score || 0))
  const bestScore = Number(candidates[0]?.candidate?.score || 0)
  const best = candidates.filter(item => Number(item.candidate.score || 0) === bestScore)
  if (best.length !== 1) {
    const details = best.slice(0, 6).map(item => `${item.frame.frameId}:${String(item.candidate.text || item.candidate.selector || '?')}`).join(', ')
    throw new Error(`atomic semantic target is ambiguous (${best.length} equally ranked candidates): ${details}`)
  }

  const chosen = best[0]
  const clicked = await semanticClickExecute(tabId, chosen.frame.frameId, 'click', {
    ...spec,
    expectedFingerprint: chosen.candidate.fingerprint,
  })
  if (!clicked || clicked.ok === false) throw new Error(String(clicked?.error || 'atomic semantic click failed'))

  const innerSelector = typeof clicked.selector === 'string' ? clicked.selector : String(chosen.candidate.selector || '')
  const scopedSelector = semanticScopeSelector(chosen.frame, innerSelector)
  return {
    ok: true,
    selector: scopedSelector,
    text: String(clicked.text || chosen.candidate.text || ''),
    role: String(clicked.role || chosen.candidate.role || ''),
    tag: String(clicked.tag || chosen.candidate.tag || ''),
    frameId: chosen.frame.frameId,
    frameUrl: chosen.frame.url || '',
    transport: 'atomic-main-world-semantic-click',
  }
}

function semanticSerializableSpec(args) {
  const out = {}
  for (const key of ['locatorText', 'locatorRole', 'locatorTag', 'selectorHint', 'task']) {
    if (typeof args?.[key] === 'string' && args[key].trim()) out[key] = args[key].trim()
  }
  return out
}

async function semanticClickFrames(tabId) {
  let frames = []
  try { frames = await chrome.webNavigation.getAllFrames({ tabId }) || [] } catch { frames = [] }
  if (!Array.isArray(frames) || frames.length === 0) frames = [{ frameId: 0, parentFrameId: -1, url: '' }]
  return frames
    .filter(frame => Number.isInteger(frame?.frameId))
    .map(frame => ({ frameId: frame.frameId, parentFrameId: Number.isInteger(frame.parentFrameId) ? frame.parentFrameId : -1, url: typeof frame.url === 'string' ? frame.url : '' }))
    .sort((left, right) => left.frameId - right.frameId)
}

async function semanticClickExecute(tabId, frameId, mode, spec) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: semanticClickPageCommand,
    args: [mode, spec],
  })
  const value = Array.isArray(results) ? results[0]?.result : undefined
  if (!value || typeof value !== 'object') throw new Error(`semantic click returned no result in frame ${frameId}`)
  return value
}

function semanticScopeSelector(frame, selector) {
  if (!selector) return ''
  if (frame.frameId === 0) return `top-frame::${selector}`
  const url = typeof stableFrameUrl === 'function' ? stableFrameUrl(frame.url || '') : String(frame.url || '').split('#')[0].split('?')[0]
  return url ? `frame-url(${encodeURIComponent(url)})::${selector}` : selector
}

function semanticDescribeSpec(spec) {
  return JSON.stringify({ text: spec.locatorText || '', role: spec.locatorRole || '', tag: spec.locatorTag || '', task: spec.task || '' })
}

// Serialized into the page MAIN world. Keep self-contained.
async function semanticClickPageCommand(mode, spec) {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const normalize = value => compact(value).replace(/\s+/g, '').toLocaleLowerCase()
  const cssEscape = value => globalThis.CSS?.escape ? CSS.escape(String(value)) : String(value).replace(/[^a-zA-Z0-9_-]/g, char => `\\${char}`)
  const visible = element => {
    if (!(element instanceof Element) || !element.isConnected) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const disabled = element => element.matches?.(':disabled,[aria-disabled="true"]') === true
  const actionText = element => {
    const parts = [element.getAttribute?.('aria-label'), element.getAttribute?.('title')]
    if (element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase())) parts.push(element.value)
    parts.push(element.innerText, element.textContent)
    for (const img of element.querySelectorAll?.('img') || []) parts.push(img.getAttribute('alt'), img.getAttribute('title'))
    return compact(parts.filter(Boolean).join(' '))
  }
  const roleOf = element => compact(element.getAttribute?.('role') || (element.tagName === 'A' ? 'link' : element.tagName === 'BUTTON' ? 'button' : element instanceof HTMLInputElement && ['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase()) ? 'button' : ''))
  const stableSelector = element => {
    if (element.id) return `#${cssEscape(element.id)}`
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'name', 'menuid', 'aria-label']) {
      const value = element.getAttribute?.(attr)
      if (value) return `${element.tagName.toLowerCase()}[${attr}="${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
    }
    const classes = [...(element.classList || [])].filter(name => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)).slice(0, 2)
    if (classes.length) {
      const selector = `${element.tagName.toLowerCase()}.${classes.map(cssEscape).join('.')}`
      try { if (document.querySelectorAll(selector).length === 1) return selector } catch {}
    }
    const path = []
    let node = element
    while (node instanceof Element && node !== document.documentElement && path.length < 7) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter(child => child.tagName === node.tagName)
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`
      }
      path.unshift(part)
      const candidate = path.join(' > ')
      try { if (document.querySelectorAll(candidate).length === 1) return candidate } catch {}
      node = parent
    }
    return path.join(' > ')
  }
  const fingerprint = element => `${stableSelector(element)}|${normalize(actionText(element))}|${normalize(roleOf(element))}|${element.tagName.toLowerCase()}`
  const modalSelectors = ['[role="dialog"][aria-modal="true"]', '.ant-modal-content', '.el-dialog', '.ivu-modal-content', '.arco-modal', '.semi-modal']
  const modal = modalSelectors.flatMap(selector => [...document.querySelectorAll(selector)]).find(visible)
  const root = modal || document
  const selector = [
    'a', 'button', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[onclick]', '[bg-click]', '[ng-click]', '[data-action]', '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  const candidates = [...new Set([...root.querySelectorAll(selector)])].filter(element => visible(element) && !disabled(element))
  const wantedText = normalize(spec.locatorText || '')
  const wantedRole = normalize(spec.locatorRole || '')
  const wantedTag = normalize(spec.locatorTag || '')
  const task = normalize(spec.task || '')
  const selectorHint = String(spec.selectorHint || '').replace(/^top-frame::/, '').replace(/^frame-url\([^)]*\)::/, '')
  const ipTokens = String(spec.task || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []
  const actionTokens = String(spec.task || '').match(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi) || []
  const wantsLogo = /logo|徽标|标志/i.test(String(spec.task || ''))

  const scored = candidates.map(element => {
    const text = actionText(element)
    const role = roleOf(element)
    const tag = element.tagName.toLowerCase()
    const normText = normalize(text)
    if (wantedRole && normalize(role) !== wantedRole) return null
    if (wantedTag && normalize(tag) !== wantedTag) return null
    let score = 0
    if (wantedText) {
      if (normText === wantedText) score += 140
      else if (normText.includes(wantedText) || wantedText.includes(normText)) score += 80
      else return null
    }
    if (selectorHint) {
      try { if (element.matches(selectorHint)) score += 35 } catch {}
    }
    if (['a', 'button'].includes(tag) || role === 'button' || role === 'link' || role === 'menuitem') score += 12
    if (wantsLogo) {
      const logoEvidence = `${element.id || ''} ${element.className || ''} ${[...(element.querySelectorAll?.('img') || [])].map(img => `${img.id || ''} ${img.className || ''} ${img.getAttribute('src') || ''}`).join(' ')}`
      if (/logo/i.test(logoEvidence)) score += 120
    }
    const context = compact(element.closest?.('tr,li,form,nav,[role="dialog"],.ant-modal-content,.el-dialog')?.innerText || '')
    for (const token of ipTokens) if (context.includes(token)) score += 90
    for (const token of actionTokens) if (normalize(text).includes(normalize(token)) || normalize(context).includes(normalize(token))) score += 35
    if (!wantedText && !wantsLogo && task && normalize(`${text} ${context}`).includes(task)) score += 20
    return { element, text, role, tag, score, context }
  }).filter(Boolean).filter(item => item.score > 0)
  scored.sort((left, right) => right.score - left.score)
  if (!scored.length) return { ok: true, candidates: [] }
  const bestScore = scored[0].score
  const best = scored.filter(item => item.score === bestScore)

  if (mode === 'probe') {
    return {
      ok: true,
      candidates: best.slice(0, 8).map(item => ({
        score: item.score,
        selector: stableSelector(item.element),
        text: item.text,
        role: item.role,
        tag: item.tag,
        fingerprint: fingerprint(item.element),
        context: compact(item.context).slice(0, 240),
      })),
    }
  }
  if (best.length !== 1) throw new Error(`semantic click became ambiguous in selected frame: ${best.length} candidates`)
  const chosen = best[0]
  if (spec.expectedFingerprint && fingerprint(chosen.element) !== spec.expectedFingerprint) {
    // A framework re-render may create a new equivalent node. The semantic
    // fields are authoritative; fingerprint drift alone is not fatal as long as
    // the newly resolved target remains uniquely best.
  }
  const element = chosen.element
  element.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' })
  const frame = () => new Promise(resolve => requestAnimationFrame(resolve))
  const before = element.getBoundingClientRect()
  await frame(); await frame()
  if (!element.isConnected) throw new Error('semantic target detached before click')
  const after = element.getBoundingClientRect()
  if (Math.abs(before.left - after.left) > 1 || Math.abs(before.top - after.top) > 1 || Math.abs(before.width - after.width) > 1 || Math.abs(before.height - after.height) > 1) throw new Error('semantic target is not stable yet')
  const x = Math.max(after.left + 1, Math.min(after.left + after.width / 2, after.right - 1))
  const y = Math.max(after.top + 1, Math.min(after.top + after.height / 2, after.bottom - 1))
  const hit = document.elementFromPoint(x, y)
  if (hit && hit !== element && !element.contains(hit)) throw new Error(`semantic target is intercepted by <${hit.tagName.toLowerCase()}>`)
  element.focus?.({ preventScroll: true })
  if (typeof PointerEvent !== 'undefined') {
    for (const type of ['pointerover', 'pointermove', 'pointerdown', 'pointerup']) element.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }))
  }
  for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) element.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }))
  if (typeof element.click === 'function') element.click()
  else element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y, button: 0 }))
  return { ok: true, selector: stableSelector(element), text: chosen.text, role: chosen.role, tag: chosen.tag }
}
