// Browser interaction hardening layered after frame-support/frame-resilient.
//
// Goals:
// 1. Make snapshot selectors frame-explicit so a selector copied from a top
//    document can never accidentally match the same CSS inside an iframe.
// 2. Prefer MAIN-world, actionability-checked clicks for ordinary Patrol clicks.
// 3. Keep tab/screenshot operations inside the Patrol browser window without
//    focusing that OS window and stealing the user's desktop.
// 4. Provide one deterministic native <select> operation across frames.

const INTERACTION_TOP_FRAME_PREFIX = 'top-frame::'
const INTERACTION_FRAME_PREFIX = 'frame-url('
const INTERACTION_SCREENSHOT_READY_TIMEOUT_MS = 3000
const INTERACTION_SCREENSHOT_READY_POLL_MS = 100
const INTERACTION_VISUAL_FRAME_TTL_MS = 120000
const INTERACTION_VISUAL_FRAME_MAX = 12
const interactionVisualFrames = new Map()
let interactionVisualFrameSequence = 0
const interactionPreviousSendDomCommand = sendDomCommand
const interactionPreviousHandleCommand = handleCommand

sendDomCommand = async function interactionHardenedSendDomCommand(cmd, args = {}) {
  // Many content sites (including Bilibili video cards) open the clicked item in
  // a child tab. Capture the tab set before every click so a successful DOM
  // click cannot be misdiagnosed merely because the source tab stayed put.
  const clickTabId = cmd === 'click' ? await resolveTabId(args.tabId) : undefined
  const clickTabsBefore = clickTabId === undefined ? undefined : await interactionTabBaseline(clickTabId)

  let value
  // The content-script click path can report success even when a framework
  // handler is bound in the page MAIN world. Use the resilient MAIN-world path
  // first for clicks; it already performs visibility/stability/hit-target checks
  // and strict cross-frame uniqueness. Fall back only if MAIN-world execution is
  // unavailable, never merely because the click produced an unexpected page.
  if (cmd === 'click' && clickTabId !== undefined && chrome.scripting?.executeScript && typeof resilientDomFallback === 'function') {
    try {
      value = await resilientDomFallback(clickTabId, 'click', args)
    } catch (mainWorldError) {
      try {
        value = await interactionPreviousSendDomCommand(cmd, args)
      } catch (bridgeError) {
        throw new Error(
          `Patrol click failed in MAIN-world and frame bridge. `
          + `main=${safeError(mainWorldError)}; bridge=${safeError(bridgeError)}`,
        )
      }
    }
  } else {
    value = await interactionPreviousSendDomCommand(cmd, args)
  }

  if (cmd === 'click' && clickTabId !== undefined) {
    const opened = await interactionAdoptSingleOpenedTab(clickTabId, clickTabsBefore)
    if (opened) {
      value = {
        ...value,
        openedTabId: opened.id,
        openedTabUrl: typeof opened.url === 'string' ? opened.url : '',
        stateEvidence: `click opened child tab ${opened.id}${opened.url ? ` (${opened.url})` : ''}`,
      }
    }
  }
  return cmd === 'snapshot' ? interactionNormalizeSnapshot(value) : value
}

handleCommand = async function interactionHardenedHandleCommand(cmd, args = {}) {
  if (cmd === 'activateTab') return await interactionActivateTab(args)
  if (cmd === 'screenshot') return await interactionScreenshot(args)
  if (cmd === 'visualClick') return await interactionVisualClick(args)
  if (cmd === 'typeFocused') return await interactionTypeFocused(args)
  if (cmd === 'select') return await interactionSelect(args)
  return await interactionPreviousHandleCommand(cmd, args)
}

function interactionNormalizeSnapshot(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.elements)) return value
  return {
    ...value,
    elements: value.elements.map(item => {
      if (!item || typeof item !== 'object') return item
      const rawSelector = typeof item.selector === 'string' ? item.selector : ''
      const selector = rawSelector
        && !rawSelector.startsWith(INTERACTION_TOP_FRAME_PREFIX)
        && !rawSelector.startsWith(INTERACTION_FRAME_PREFIX)
        ? `${INTERACTION_TOP_FRAME_PREFIX}${rawSelector}`
        : rawSelector
      const inputActionText = item.tag === 'input'
        && ['button', 'submit', 'reset'].includes(String(item.type || '').toLowerCase())
        && typeof item.value === 'string'
        ? item.value.trim()
        : ''
      return {
        ...item,
        ...(selector ? { selector } : {}),
        ...(!String(item.text || '').trim() && inputActionText ? { text: inputActionText } : {}),
      }
    }),
  }
}

async function interactionTabBaseline(sourceTabId) {
  if (!chrome.tabs?.query) return undefined
  try {
    const source = chrome.tabs.get ? await chrome.tabs.get(sourceTabId) : undefined
    const tabs = await chrome.tabs.query({})
    return {
      ids: new Set((Array.isArray(tabs) ? tabs : []).map(tab => tab?.id).filter(Number.isInteger)),
      windowId: Number.isInteger(source?.windowId) ? source.windowId : undefined,
    }
  } catch {
    return undefined
  }
}

async function interactionAdoptSingleOpenedTab(sourceTabId, baseline) {
  if (!baseline?.ids || !chrome.tabs?.query) return undefined
  for (const delayMs of [0, 80, 180, 320]) {
    if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs))
    let tabs
    try { tabs = await chrome.tabs.query({}) } catch { return undefined }
    const fresh = (Array.isArray(tabs) ? tabs : []).filter(tab => Number.isInteger(tab?.id) && !baseline.ids.has(tab.id))
    const children = fresh.filter(tab => tab.openerTabId === sourceTabId)
    const sameWindow = fresh.filter(tab => baseline.windowId === undefined || tab.windowId === baseline.windowId)
    const candidates = children.length > 0 ? children : sameWindow
    if (candidates.length !== 1) {
      if (fresh.length > 1 || children.length > 1) return undefined
      continue
    }
    const opened = candidates[0]
    try { await chrome.tabs.update(opened.id, { active: true }) } catch {}
    return opened
  }
  return undefined
}

async function interactionActivateTab(args) {
  const tabId = await resolveTabId(args.tabId)
  const tab = await chrome.tabs.update(tabId, { active: true })
  // Deliberately do NOT call chrome.windows.update(..., { focused: true }).
  // Patrol may change its own active tab while remaining behind the user's work.
  return { tab: tabInfo(tab) }
}

async function interactionScreenshot(args) {
  const tabId = await resolveTabId(args.tabId)
  const tab = await interactionWaitForCapturableTab(tabId)
  if (tab.windowId === undefined) throw new Error('target tab has no window')
  await chrome.tabs.update(tabId, { active: true })

  const before = await interactionViewportState(tabId)
  const format = args.format === 'jpeg' ? 'jpeg' : 'png'
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format })
  const after = await interactionViewportState(tabId)
  const visualFrame = interactionRegisterVisualFrame(tabId, before, after)

  return {
    ok: true,
    dataUrl,
    bytes: Math.floor(dataUrl.length * 0.75),
    ...(visualFrame || {}),
  }
}

async function interactionViewportState(tabId) {
  if (!chrome.scripting?.executeScript) return undefined
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: interactionMainWorldViewportState,
    })
    const value = Array.isArray(results) ? results[0]?.result : undefined
    return value && typeof value === 'object' ? value : undefined
  } catch {
    return undefined
  }
}

function interactionMainWorldViewportState() {
  const viewport = window.visualViewport
  return {
    urlIdentity: location.origin + location.pathname,
    width: Number(viewport?.width || window.innerWidth || 0),
    height: Number(viewport?.height || window.innerHeight || 0),
    offsetLeft: Number(viewport?.offsetLeft || 0),
    offsetTop: Number(viewport?.offsetTop || 0),
    scale: Number(viewport?.scale || 1),
    scrollX: Number(window.scrollX || 0),
    scrollY: Number(window.scrollY || 0),
  }
}

function interactionSameViewport(left, right, tolerance = 1) {
  if (!left || !right || left.urlIdentity !== right.urlIdentity) return false
  return ['width', 'height', 'offsetLeft', 'offsetTop', 'scale', 'scrollX', 'scrollY'].every(key =>
    Number.isFinite(Number(left[key]))
    && Number.isFinite(Number(right[key]))
    && Math.abs(Number(left[key]) - Number(right[key])) <= tolerance)
}

function interactionPruneVisualFrames() {
  const now = Date.now()
  for (const [id, frame] of interactionVisualFrames) {
    if (!frame || now - Number(frame.createdAt || 0) > INTERACTION_VISUAL_FRAME_TTL_MS) interactionVisualFrames.delete(id)
  }
}

function interactionRegisterVisualFrame(tabId, before, after) {
  if (!interactionSameViewport(before, after, 1)) return undefined
  interactionPruneVisualFrames()
  interactionVisualFrameSequence += 1
  const frameId = `browser-visual-${Date.now().toString(36)}-${interactionVisualFrameSequence.toString(36)}`
  const frame = {
    frameId,
    tabId,
    createdAt: Date.now(),
    urlIdentity: before.urlIdentity,
    width: before.width,
    height: before.height,
    offsetLeft: before.offsetLeft,
    offsetTop: before.offsetTop,
    scale: before.scale,
    scrollX: before.scrollX,
    scrollY: before.scrollY,
  }
  interactionVisualFrames.set(frameId, frame)
  while (interactionVisualFrames.size > INTERACTION_VISUAL_FRAME_MAX) {
    const oldest = interactionVisualFrames.keys().next().value
    if (!oldest) break
    interactionVisualFrames.delete(oldest)
  }
  return {
    visualFrameId: frameId,
    urlIdentity: frame.urlIdentity,
    viewportWidth: frame.width,
    viewportHeight: frame.height,
    viewportScale: frame.scale,
    scrollX: frame.scrollX,
    scrollY: frame.scrollY,
  }
}

async function interactionVisualClick(args) {
  const tabId = await resolveTabId(args.tabId)
  const xRatio = Number(args.xRatio)
  const yRatio = Number(args.yRatio)
  if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)
    || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
    throw new Error('visualClick requires xRatio/yRatio between 0 and 1')
  }

  interactionPruneVisualFrames()
  const frameId = typeof args.frameId === 'string' ? args.frameId.trim() : ''
  if (frameId) {
    const frame = interactionVisualFrames.get(frameId)
    if (!frame) throw new Error('browser visual frame is stale or unavailable; capture a fresh patrol_observe(includeImage=true)')
    if (frame.tabId !== tabId) throw new Error('browser visual frame belongs to a different tab; capture a fresh visual observation')
    const current = await interactionViewportState(tabId)
    if (!interactionSameViewport(frame, current, 2)) {
      throw new Error('browser visual frame is stale: URL/scroll/zoom/viewport changed after screenshot; capture a fresh visual observation')
    }
    const expectedTag = typeof args.expectedTag === 'string' ? args.expectedTag.trim().toLowerCase() : ''
    const expectedRole = typeof args.expectedRole === 'string' ? args.expectedRole.trim().toLowerCase() : ''
    const expectedTitle = typeof args.expectedTitle === 'string' ? args.expectedTitle.trim() : ''
    const expectedAriaLabel = typeof args.expectedAriaLabel === 'string' ? args.expectedAriaLabel.trim() : ''
    const clicked = await interactionPerformVisualClick(
      tabId,
      xRatio,
      yRatio,
      frame,
      expectedTag,
      expectedRole,
      expectedTitle,
      expectedAriaLabel,
    )
    interactionVisualFrames.delete(frameId)
    return interactionVisualClickResult(clicked, frame, xRatio, yRatio, 'bound-current-visual-frame')
  }

  const selectorHint = typeof args.selectorHint === 'string' ? args.selectorHint.trim() : ''
  if (selectorHint) {
    try {
      const clicked = await sendDomCommand('click', { selector: selectorHint, tabId })
      return {
        ok: true,
        selectorHint,
        xRatio,
        yRatio,
        transport: 'visual-selector-replay',
        targetStateChanged: false,
        stateEvidence: 'recorded visual selector replayed through normal browser click',
        ...(typeof clicked?.tag === 'string' ? { targetTag: clicked.tag } : {}),
        ...(typeof clicked?.text === 'string' ? { targetText: clicked.text } : {}),
      }
    } catch {}
  }

  const urlIdentity = typeof args.urlIdentity === 'string' ? args.urlIdentity.trim() : ''
  const viewportWidth = Number(args.viewportWidth)
  const viewportHeight = Number(args.viewportHeight)
  const scrollX = Number(args.scrollX)
  const scrollY = Number(args.scrollY)
  if (!urlIdentity || ![viewportWidth, viewportHeight, scrollX, scrollY].every(Number.isFinite)
    || viewportWidth <= 0 || viewportHeight <= 0) {
    throw new Error('visualClick replay requires selectorHint or recorded URL/viewport/scroll geometry')
  }

  let current = await interactionViewportState(tabId)
  if (!current || current.urlIdentity !== urlIdentity) {
    throw new Error('visualClick replay URL identity differs from the recorded page; refusing coordinate fallback')
  }
  await interactionSetScroll(tabId, scrollX, scrollY)
  await new Promise(resolve => setTimeout(resolve, 80))
  current = await interactionViewportState(tabId)
  if (!current || current.urlIdentity !== urlIdentity) throw new Error('visualClick replay page changed while restoring recorded geometry')
  if (Math.abs(current.scrollX - scrollX) > 3 || Math.abs(current.scrollY - scrollY) > 3) {
    throw new Error('visualClick replay could not restore the recorded scroll position')
  }
  const widthRatio = current.width / viewportWidth
  const heightRatio = current.height / viewportHeight
  if (widthRatio < 0.80 || widthRatio > 1.20 || heightRatio < 0.80 || heightRatio > 1.20) {
    throw new Error('visualClick replay viewport differs too much from teaching; refusing coordinate fallback')
  }

  const expectedTag = typeof args.expectedTag === 'string' ? args.expectedTag.trim().toLowerCase() : ''
  const expectedRole = typeof args.expectedRole === 'string' ? args.expectedRole.trim().toLowerCase() : ''
  const expectedTitle = typeof args.expectedTitle === 'string' ? args.expectedTitle.trim() : ''
  const expectedAriaLabel = typeof args.expectedAriaLabel === 'string' ? args.expectedAriaLabel.trim() : ''
  const clicked = await interactionPerformVisualClick(tabId, xRatio, yRatio, current, expectedTag, expectedRole, expectedTitle, expectedAriaLabel)
  return interactionVisualClickResult(clicked, current, xRatio, yRatio, 'visual-coordinate-replay')
}

async function interactionSetScroll(tabId, x, y) {
  if (!chrome.scripting?.executeScript) throw new Error('visualClick replay requires chrome.scripting')
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: (left, top) => { window.scrollTo(left, top) },
    args: [x, y],
  })
}

async function interactionPerformVisualClick(tabId, xRatio, yRatio, viewport, expectedTag, expectedRole, expectedTitle, expectedAriaLabel) {
  if (!chrome.scripting?.executeScript) throw new Error('visualClick requires chrome.scripting')
  const clientX = viewport.offsetLeft + Math.max(1, Math.min(viewport.width - 1, viewport.width * xRatio))
  const clientY = viewport.offsetTop + Math.max(1, Math.min(viewport.height - 1, viewport.height * yRatio))

  let nativeError = ''
  if (chrome.debugger?.attach && chrome.debugger?.sendCommand && chrome.debugger?.detach) {
    let probe
    try {
      const probeResults = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: interactionMainWorldVisualClick,
        args: [clientX, clientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, true],
      })
      probe = Array.isArray(probeResults) ? probeResults[0]?.result : undefined
      if (probe?.ok === false) throw new Error(probe.error || 'visual target probe failed')
    } catch (error) {
      nativeError = `target probe failed: ${safeError(error)}`
    }

    const hasExpectedFingerprint = Boolean(expectedTag || expectedRole || expectedTitle || expectedAriaLabel)
    if (!hasExpectedFingerprint || (probe && typeof probe === 'object' && probe.ok !== false)) {
      try {
        await interactionDispatchTrustedMouseClick(tabId, clientX, clientY)
        await new Promise(resolve => setTimeout(resolve, 260))
        let afterProbe
        try {
          const afterResults = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'MAIN',
            func: interactionMainWorldVisualClick,
            args: [clientX, clientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, true],
          })
          afterProbe = Array.isArray(afterResults) ? afterResults[0]?.result : undefined
        } catch {}
        const targetStateChanged = Boolean(
          probe && afterProbe
          && typeof probe.stateSignature === 'string'
          && typeof afterProbe.stateSignature === 'string'
          && probe.stateSignature !== afterProbe.stateSignature
        )
        const targetFocusedEditable = afterProbe?.targetFocusedEditable === true
        return {
          ok: true,
          ...(probe && typeof probe === 'object' ? probe : {}),
          ...(afterProbe && typeof afterProbe === 'object' ? afterProbe : {}),
          targetStateChanged,
          targetFocusedEditable,
          stateEvidence: targetStateChanged
            ? 'trusted native click changed the visual target own DOM state'
            : targetFocusedEditable
              ? 'trusted native click focused an editable control'
              : '',
          inputTransport: 'chrome-debugger',
        }
      } catch (error) {
        nativeError = [nativeError, `trusted mouse failed: ${safeError(error)}`].filter(Boolean).join('; ')
      }
    }
  }

  let results
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: interactionMainWorldVisualClick,
      args: [clientX, clientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, false],
    })
  } catch (error) {
    throw new Error([
      nativeError,
      `visualClick MAIN-world execution failed: ${safeError(error)}`,
    ].filter(Boolean).join('; '))
  }
  const value = Array.isArray(results) ? results[0]?.result : undefined
  if (!value || typeof value !== 'object' || value.ok === false) {
    throw new Error([
      nativeError,
      value?.error || 'visualClick MAIN-world execution returned no result',
    ].filter(Boolean).join('; '))
  }
  return { ...value, inputTransport: 'synthetic-main-world' }
}

async function interactionDispatchTrustedMouseClick(tabId, clientX, clientY) {
  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: clientX, y: clientY, button: 'none', buttons: 0,
    })
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: clientX, y: clientY, button: 'left', buttons: 1, clickCount: 1,
    })
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: clientX, y: clientY, button: 'left', buttons: 0, clickCount: 1,
    })
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
}

function interactionVisualClickResult(clicked, viewport, xRatio, yRatio, transport) {
  const rawSelector = typeof clicked.selector === 'string' ? clicked.selector.trim() : ''
  const selectorHint = rawSelector
    ? (rawSelector.startsWith(INTERACTION_TOP_FRAME_PREFIX) ? rawSelector : `${INTERACTION_TOP_FRAME_PREFIX}${rawSelector}`)
    : ''
  const effectiveTransport = clicked?.inputTransport === 'chrome-debugger'
    ? `${transport}+trusted-native-mouse`
    : clicked?.inputTransport === 'synthetic-main-world'
      ? `${transport}+synthetic-main-world`
      : transport
  return {
    ok: true,
    xRatio,
    yRatio,
    transport: effectiveTransport,
    ...(selectorHint ? { selectorHint } : {}),
    urlIdentity: viewport.urlIdentity,
    viewportWidth: viewport.width,
    viewportHeight: viewport.height,
    viewportScale: viewport.scale,
    scrollX: viewport.scrollX,
    scrollY: viewport.scrollY,
    targetStateChanged: clicked.targetStateChanged === true,
    targetFocusedEditable: clicked.targetFocusedEditable === true,
    ...(typeof clicked.stateEvidence === 'string' ? { stateEvidence: clicked.stateEvidence } : {}),
    ...(typeof clicked.tag === 'string' ? { targetTag: clicked.tag } : {}),
    ...(typeof clicked.role === 'string' && clicked.role ? { targetRole: clicked.role } : {}),
    ...(typeof clicked.text === 'string' && clicked.text ? { targetText: clicked.text } : {}),
    ...(typeof clicked.title === 'string' && clicked.title ? { targetTitle: clicked.title } : {}),
    ...(typeof clicked.ariaLabel === 'string' && clicked.ariaLabel ? { targetAriaLabel: clicked.ariaLabel } : {}),
    ...(typeof clicked.id === 'string' && clicked.id ? { targetId: clicked.id } : {}),
    ...(typeof clicked.className === 'string' && clicked.className ? { targetClassName: clicked.className } : {}),
  }
}

async function interactionMainWorldVisualClick(clientX, clientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, probeOnly = false) {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const roleOf = element => {
    const explicit = compact(element.getAttribute?.('role') || '').toLowerCase()
    if (explicit) return explicit
    const tag = element.tagName?.toLowerCase?.() || ''
    if (tag === 'button') return 'button'
    if (tag === 'a' && element.getAttribute?.('href')) return 'link'
    return ''
  }
  const visible = element => {
    if (!(element instanceof Element)) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const disabled = element => element.matches?.(':disabled') || element.getAttribute?.('aria-disabled') === 'true'
  const cssEscape = value => {
    if (globalThis.CSS?.escape) return CSS.escape(String(value))
    return String(value).replace(/[^A-Za-z0-9_-]/g, char => '\\\\' + char.codePointAt(0).toString(16) + ' ')
  }
  const cssString = value => String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const unique = selector => { try { return document.querySelectorAll(selector).length === 1 } catch { return false } }
  const stableSelector = element => {
    if (!(element instanceof Element)) return ''
    if (element.id) return '#' + cssEscape(element.id)
    for (const attr of ['data-testid', 'data-test', 'data-cy', 'data-action', 'name', 'title', 'aria-label']) {
      const value = element.getAttribute(attr)
      if (!value) continue
      const candidate = element.tagName.toLowerCase() + '[' + attr + '="' + cssString(value) + '"]'
      if (unique(candidate)) return candidate
    }
    const classes = [...(element.classList || [])].filter(name => /^[A-Za-z_-][A-Za-z0-9_-]*$/.test(name)).slice(0, 3)
    if (classes.length) {
      const candidate = element.tagName.toLowerCase() + '.' + classes.map(cssEscape).join('.')
      if (unique(candidate)) return candidate
    }
    const path = []
    let node = element
    while (node instanceof Element && node !== document.documentElement && path.length < 8) {
      let part = node.tagName.toLowerCase()
      const parent = node.parentElement
      if (parent) {
        const same = [...parent.children].filter(child => child.tagName === node.tagName)
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')'
      }
      path.unshift(part)
      const candidate = path.join(' > ')
      if (unique(candidate)) return candidate
      node = parent
    }
    return path.join(' > ')
  }
  const actionableSelector = [
    'button', 'a[href]', 'input[type="button"]', 'input[type="submit"]', 'input[type="reset"]',
    '[role="button"]', '[role="link"]', '[role="menuitem"]', '[role="tab"]',
    '[onclick]', '[data-action]', '[tabindex]:not([tabindex="-1"])',
  ].join(',')
  const chooseTarget = hit => {
    const semantic = hit.closest?.(actionableSelector)
    if (semantic && visible(semantic) && !disabled(semantic)) return semantic
    let node = hit
    for (let depth = 0; node instanceof Element && depth < 7; depth += 1, node = node.parentElement) {
      if (!visible(node) || disabled(node)) continue
      if (getComputedStyle(node).cursor === 'pointer') return node
    }
    return hit
  }
  const signature = element => {
    if (!(element instanceof Element)) return ''
    return [
      element.tagName.toLowerCase(),
      compact(element.getAttribute('class') || ''),
      compact(element.getAttribute('aria-pressed') || ''),
      compact(element.getAttribute('aria-checked') || ''),
      compact(element.getAttribute('data-state') || ''),
      compact(element.getAttribute('title') || ''),
      compact(element.innerText || element.textContent || '').slice(0, 320),
    ].join('|')
  }
  const deepActiveElement = () => {
    let active = document.activeElement
    let guard = 0
    while (active instanceof Element && active.shadowRoot?.activeElement instanceof Element && guard < 8) {
      active = active.shadowRoot.activeElement
      guard += 1
    }
    return active
  }
  const editable = element => element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element?.isContentEditable === true

  const hit = document.elementFromPoint(clientX, clientY)
  if (!(hit instanceof Element)) throw new Error('visual click point does not hit a DOM element')
  const hitIsIframe = hit.tagName?.toLowerCase?.() === 'iframe'
  if (hitIsIframe && !probeOnly) throw new Error('visual click point lands on an iframe surface; synthetic MAIN-world click cannot safely enter a cross-origin frame')
  const target = hitIsIframe ? hit : chooseTarget(hit)
  if (!(target instanceof Element) || !visible(target) || disabled(target)) throw new Error('visual click target is not actionable')
  const tag = target.tagName.toLowerCase()
  const role = roleOf(target)
  const title = compact(target.getAttribute('title') || '')
  const ariaLabel = compact(target.getAttribute('aria-label') || '')
  if (expectedTag && tag !== expectedTag) throw new Error('visual coordinate replay hit a different tag than teaching')
  if (expectedRole && role !== expectedRole) throw new Error('visual coordinate replay hit a different role than teaching')
  if (expectedTitle && title !== expectedTitle) throw new Error('visual coordinate replay hit a different title than teaching')
  if (expectedAriaLabel && ariaLabel !== expectedAriaLabel) throw new Error('visual coordinate replay hit a different aria-label than teaching')

  const rect = target.getBoundingClientRect()
  if (clientX < rect.left - 1 || clientX > rect.right + 1 || clientY < rect.top - 1 || clientY > rect.bottom + 1) throw new Error('visual click target no longer contains the recorded point')

  const before = signature(target)
  const descriptor = {
    ok: true,
    selector: stableSelector(target),
    tag,
    role,
    text: compact(target.innerText || target.textContent || target.getAttribute('aria-label') || target.getAttribute('title') || '').slice(0, 240),
    title,
    ariaLabel,
    id: compact(target.id || ''),
    className: compact([...(target.classList || [])].slice(0, 8).join(' ')),
    targetStateChanged: false,
    targetFocusedEditable: editable(deepActiveElement()),
    stateSignature: signature(target),
    stateEvidence: '',
  }
  if (probeOnly) return descriptor

  target.focus?.({ preventScroll: true })
  const eventTarget = hit
  if (typeof PointerEvent !== 'undefined') {
    for (const type of ['pointerover', 'pointermove', 'pointerdown', 'pointerup']) {
      eventTarget.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX, clientY, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }))
    }
  }
  for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) {
    eventTarget.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 }))
  }
  if (typeof eventTarget.click === 'function') eventTarget.click()
  else eventTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX, clientY, button: 0 }))

  await new Promise(resolve => setTimeout(resolve, 350))
  let targetStateChanged = false
  let stateEvidence = ''
  if (!target.isConnected || !eventTarget.isConnected) {
    targetStateChanged = true
    stateEvidence = 'clicked visual target detached/re-rendered'
  } else if (signature(target) !== before) {
    targetStateChanged = true
    stateEvidence = 'clicked visual target DOM state changed'
  }
  return {
    ...descriptor,
    targetStateChanged,
    targetFocusedEditable: editable(deepActiveElement()),
    stateSignature: signature(target),
    stateEvidence,
  }
}

async function interactionWaitForCapturableTab(tabId) {
  const deadline = Date.now() + INTERACTION_SCREENSHOT_READY_TIMEOUT_MS
  let tab = await chrome.tabs.get(tabId)
  while (!interactionTabIsCapturable(tab) && Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, INTERACTION_SCREENSHOT_READY_POLL_MS))
    tab = await chrome.tabs.get(tabId)
  }
  if (!interactionTabIsCapturable(tab)) {
    const url = typeof tab?.url === 'string' ? tab.url : ''
    const status = typeof tab?.status === 'string' ? tab.status : 'unknown'
    throw new Error(`target tab is not ready for screenshot: url=${JSON.stringify(url)} status=${status}`)
  }
  return tab
}

function interactionTabIsCapturable(tab) {
  if (!tab || typeof tab !== 'object') return false
  const url = typeof tab.url === 'string' ? tab.url.trim() : ''
  if (!/^https?:\/\//i.test(url)) return false
  return tab.status !== 'loading'
}

async function interactionTypeFocused(args) {
  const tabId = await resolveTabId(args.tabId)
  const text = typeof args.text === 'string' ? args.text : ''
  if (!text) throw new Error('typeFocused requires non-empty text')
  if (!chrome.scripting?.executeScript) throw new Error('typeFocused requires chrome.scripting')
  const before = await interactionFocusedEditorProbe(tabId, args.clear !== false)
  if (!before?.focusUsable) throw new Error('no focused browser editor is available; click/focus the intended input first')

  let trusted = false
  let attached = false
  const target = { tabId }
  try {
    if (chrome.debugger?.attach && chrome.debugger?.sendCommand && chrome.debugger?.detach) {
      await chrome.debugger.attach(target, '1.3')
      attached = true
      if (args.clear !== false && before.clearedByScript !== true) {
        for (const event of [
          { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: 2 },
          { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: 2 },
          { type: 'keyDown', key: 'Backspace', code: 'Backspace' },
          { type: 'keyUp', key: 'Backspace', code: 'Backspace' },
        ]) await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', event)
      }
      await chrome.debugger.sendCommand(target, 'Input.insertText', { text })
      trusted = true
    }
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
  if (!trusted) {
    const inserted = await interactionFocusedEditorInsertSynthetic(tabId, text)
    if (!inserted?.ok) throw new Error(inserted?.error || 'focused editor synthetic text insertion failed')
  }
  await new Promise(resolve => setTimeout(resolve, 80))
  const after = await interactionFocusedEditorProbe(tabId, false)
  return {
    ok: true,
    textLength: text.length,
    focusedTag: String(after?.focusedTag || before.focusedTag || ''),
    focusKind: String(after?.focusKind || before.focusKind || ''),
    observedText: typeof after?.observedText === 'string' ? after.observedText : '',
    transport: trusted ? 'chrome-debugger-insert-text' : 'main-world-focused-editor',
  }
}

async function interactionFocusedEditorProbe(tabId, clear) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: interactionMainWorldFocusedEditor,
    args: ['probe', { clear }],
  })
  return Array.isArray(results) ? results[0]?.result : undefined
}

async function interactionFocusedEditorInsertSynthetic(tabId, text) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: interactionMainWorldFocusedEditor,
    args: ['insert', { text }],
  })
  return Array.isArray(results) ? results[0]?.result : undefined
}

function interactionMainWorldFocusedEditor(mode, args = {}) {
  const deepActiveElement = () => {
    let active = document.activeElement
    let guard = 0
    while (active instanceof Element && active.shadowRoot?.activeElement instanceof Element && guard < 8) {
      active = active.shadowRoot.activeElement
      guard += 1
    }
    return active
  }
  const setNativeValue = (element, value) => {
    const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(element, value)
    else element.value = value
  }
  const active = deepActiveElement()
  const host = document.activeElement
  const directEditable = active instanceof HTMLInputElement
    || active instanceof HTMLTextAreaElement
    || active?.isContentEditable === true
  const nonBodyFocus = host instanceof Element && !['body', 'html'].includes(host.tagName.toLowerCase())
  const focusUsable = directEditable || nonBodyFocus
  if (!focusUsable) return { ok: false, focusUsable: false, error: 'document has no focused editor/control' }

  let clearedByScript = false
  if (mode === 'probe' && args.clear === true && directEditable) {
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) setNativeValue(active, '')
    else active.textContent = ''
    active.dispatchEvent(new Event('input', { bubbles: true, composed: true }))
    clearedByScript = true
  }
  if (mode === 'insert') {
    if (!directEditable) return { ok: false, focusUsable: true, error: 'focused custom host requires trusted Input.insertText' }
    const text = String(args.text || '')
    if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) {
      setNativeValue(active, String(active.value || '') + text)
    } else {
      const selection = getSelection()
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0)
        range.deleteContents()
        range.insertNode(document.createTextNode(text))
        range.collapse(false)
      } else active.textContent = String(active.textContent || '') + text
    }
    active.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text }))
    active.dispatchEvent(new Event('change', { bubbles: true, composed: true }))
  }
  const observedText = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
    ? String(active.value || '')
    : active?.isContentEditable === true ? String(active.textContent || '') : ''
  return {
    ok: true, focusUsable, clearedByScript,
    focusedTag: active instanceof Element ? active.tagName.toLowerCase() : host?.tagName?.toLowerCase?.() || '',
    focusKind: directEditable ? 'editable' : 'custom-focus-host',
    observedText: observedText.slice(0, 500),
  }
}

async function interactionSelect(args) {
  const tabId = await resolveTabId(args.tabId)
  const rawSelector = typeof args.selector === 'string' ? args.selector.trim() : ''
  if (!rawSelector) throw new Error('select requires selector')
  const hasValue = typeof args.value === 'string'
  const hasLabel = typeof args.label === 'string'
  const hasIndex = Number.isInteger(args.index)
  if (Number(hasValue) + Number(hasLabel) + Number(hasIndex) !== 1) {
    throw new Error('select requires exactly one of value, label, or index')
  }

  const target = parseFrameSelector(rawSelector)
  let frames = await patrolFrames(tabId)
  if (target.topFrame === true) frames = frames.filter(frame => frame.frameId === 0)
  else if (target.frameUrl) {
    const preferred = frames.filter(frame => stableFrameUrl(frame.url) === target.frameUrl)
    if (preferred.length > 0) frames = preferred
  }
  if (frames.length === 0) throw new Error('no eligible document frame is available for select')

  const matches = []
  for (const frame of frames) {
    try {
      const result = await interactionExecuteSelectScript(tabId, frame.frameId, 'count', target.selector, args)
      const count = Number.isInteger(result?.count) ? result.count : 0
      if (count > 0) matches.push({ frame, count })
    } catch {
    }
  }
  const total = matches.reduce((sum, item) => sum + item.count, 0)
  if (total === 0) throw new Error(`select element not found in any eligible frame: ${target.selector}`)
  if (total > 1) {
    const detail = matches.map(item => `${item.frame.frameId}:${item.count}`).join(', ')
    throw new Error(`ambiguous select selector matched ${total} visible elements across frames (${detail}): ${rawSelector}`)
  }
  const frame = matches.find(item => item.count === 1)?.frame
  if (!frame) throw new Error(`could not resolve one frame for select: ${rawSelector}`)
  const result = await interactionExecuteSelectScript(tabId, frame.frameId, 'select', target.selector, args)
  if (!result || result.ok === false) throw new Error(result?.error || 'select failed')
  return { ...result, selector: rawSelector }
}

async function interactionExecuteSelectScript(tabId, frameId, cmd, selector, args) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [frameId] },
    world: 'MAIN',
    func: interactionMainWorldSelect,
    args: [cmd, selector, {
      ...(typeof args.value === 'string' ? { value: args.value } : {}),
      ...(typeof args.label === 'string' ? { label: args.label } : {}),
      ...(Number.isInteger(args.index) ? { index: args.index } : {}),
    }],
  })
  const result = Array.isArray(results) ? results[0]?.result : undefined
  if (!result || typeof result !== 'object') throw new Error(`select MAIN-world execution returned no result in frame ${frameId}`)
  return result
}

// Serialized into the page MAIN world by chrome.scripting.executeScript.
function interactionMainWorldSelect(cmd, selector, args) {
  const visible = element => {
    if (!(element instanceof Element)) return false
    const style = getComputedStyle(element)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  let nodes
  try { nodes = [...document.querySelectorAll(selector)].filter(visible) } catch { throw new Error(`invalid selector: ${selector}`) }
  if (cmd === 'count') return { ok: true, count: nodes.length }
  if (nodes.length !== 1) throw new Error(nodes.length === 0 ? `select element not found: ${selector}` : `selector matched ${nodes.length} visible elements: ${selector}`)
  const element = nodes[0]
  if (!(element instanceof HTMLSelectElement)) throw new Error(`selector is not a native select element: ${selector}`)
  if (element.disabled || element.getAttribute('aria-disabled') === 'true') throw new Error(`select target is disabled: ${selector}`)

  let index = -1
  if (typeof args.value === 'string') index = [...element.options].findIndex(option => option.value === args.value)
  else if (typeof args.label === 'string') {
    const wanted = args.label.replace(/\s+/g, ' ').trim()
    index = [...element.options].findIndex(option => String(option.textContent || option.label || '').replace(/\s+/g, ' ').trim() === wanted)
  } else if (Number.isInteger(args.index) && args.index >= 0 && args.index < element.options.length) index = args.index
  if (index < 0) throw new Error('requested select option was not found')

  element.selectedIndex = index
  const option = element.options[index]
  element.dispatchEvent(new Event('input', { bubbles: true }))
  element.dispatchEvent(new Event('change', { bubbles: true }))
  return {
    ok: true,
    value: element.value,
    label: String(option?.textContent || option?.label || '').replace(/\s+/g, ' ').trim(),
    index,
  }
}
