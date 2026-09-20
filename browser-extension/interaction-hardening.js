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
  const requestedMaxWidth = Number(args.maxWidth)
  const quality = Number.isInteger(args.quality) ? Math.max(25, Math.min(args.quality, 95)) : 70
  let dataUrl
  let captureScale = 1
  let compactVisual = false
  let captureGeometry = interactionVisibleTabCaptureGeometry(before)

  if (format === 'jpeg'
    && Number.isFinite(requestedMaxWidth)
    && requestedMaxWidth >= 480
    && before?.width > requestedMaxWidth) {
    try {
      const compact = await interactionCaptureCompactScreenshot(tabId, requestedMaxWidth, quality, before)
      if (compact?.dataUrl) {
        dataUrl = compact.dataUrl
        captureScale = compact.scale
        compactVisual = true
        captureGeometry = compact.captureGeometry
      }
    } catch {
      // Keep the normal capture path as a safe compatibility fallback.
    }
  }
  if (!dataUrl) {
    dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format,
      ...(format === 'jpeg' ? { quality } : {}),
    })
  }

  const after = await interactionViewportState(tabId)
  const visualFrame = interactionRegisterVisualFrame(tabId, before, after, captureGeometry)

  return {
    ok: true,
    dataUrl,
    bytes: Math.floor(dataUrl.length * 0.75),
    compactVisual,
    captureScale,
    ...(visualFrame || {}),
  }
}

async function interactionCaptureCompactScreenshot(tabId, maxWidth, quality, before) {
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) return undefined
  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics')
    const viewport = metrics?.cssVisualViewport || metrics?.visualViewport
    const width = Number(viewport?.clientWidth)
    const height = Number(viewport?.clientHeight)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
    const scale = Math.max(0.1, Math.min(1, maxWidth / width))
    if (scale >= 0.995) return undefined
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: Number(viewport?.pageX || 0),
        y: Number(viewport?.pageY || 0),
        width,
        height,
        scale,
      },
    })
    if (!shot || typeof shot.data !== 'string' || !shot.data) return undefined
    const pageX = Number(viewport?.pageX)
    const pageY = Number(viewport?.pageY)
    const scrollX = Number(before?.scrollX || 0)
    const scrollY = Number(before?.scrollY || 0)
    const captureGeometry = {
      captureClientLeft: Number.isFinite(pageX) ? pageX - scrollX : Number(before?.offsetLeft || 0),
      captureClientTop: Number.isFinite(pageY) ? pageY - scrollY : Number(before?.offsetTop || 0),
      captureWidth: width,
      captureHeight: height,
      captureMode: 'cdp-css-visual-viewport',
    }
    return { dataUrl: `data:image/jpeg;base64,${shot.data}`, scale, captureGeometry }
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
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
    innerWidth: Number(window.innerWidth || document.documentElement?.clientWidth || 0),
    innerHeight: Number(window.innerHeight || document.documentElement?.clientHeight || 0),
    devicePixelRatio: Number(window.devicePixelRatio || 1),
  }
}

function interactionSameViewport(left, right, tolerance = 1) {
  if (!left || !right || left.urlIdentity !== right.urlIdentity) return false
  const core = ['width', 'height', 'offsetLeft', 'offsetTop', 'scale', 'scrollX', 'scrollY']
  if (!core.every(key =>
    Number.isFinite(Number(left[key]))
    && Number.isFinite(Number(right[key]))
    && Math.abs(Number(left[key]) - Number(right[key])) <= tolerance)) return false
  for (const key of ['innerWidth', 'innerHeight', 'devicePixelRatio']) {
    const l = Number(left[key])
    const r = Number(right[key])
    if (Number.isFinite(l) && Number.isFinite(r) && Math.abs(l - r) > tolerance) return false
  }
  return true
}

function interactionPruneVisualFrames() {
  const now = Date.now()
  for (const [id, frame] of interactionVisualFrames) {
    if (!frame || now - Number(frame.createdAt || 0) > INTERACTION_VISUAL_FRAME_TTL_MS) interactionVisualFrames.delete(id)
  }
}

function interactionVisibleTabCaptureGeometry(viewport) {
  if (!viewport || typeof viewport !== 'object') return undefined
  const width = Number(viewport.innerWidth || viewport.width)
  const height = Number(viewport.innerHeight || viewport.height)
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
  return {
    captureClientLeft: 0,
    captureClientTop: 0,
    captureWidth: width,
    captureHeight: height,
    captureMode: 'capture-visible-tab-layout-viewport',
  }
}

function interactionRegisterVisualFrame(tabId, before, after, captureGeometry) {
  if (!interactionSameViewport(before, after, 1)) return undefined
  const geometry = captureGeometry || interactionVisibleTabCaptureGeometry(before)
  if (!geometry
    || !Number.isFinite(Number(geometry.captureClientLeft))
    || !Number.isFinite(Number(geometry.captureClientTop))
    || !Number.isFinite(Number(geometry.captureWidth))
    || !Number.isFinite(Number(geometry.captureHeight))
    || Number(geometry.captureWidth) <= 0
    || Number(geometry.captureHeight) <= 0) return undefined
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
    captureClientLeft: Number(geometry.captureClientLeft),
    captureClientTop: Number(geometry.captureClientTop),
    captureWidth: Number(geometry.captureWidth),
    captureHeight: Number(geometry.captureHeight),
    captureMode: String(geometry.captureMode || 'unknown'),
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
    captureClientLeft: frame.captureClientLeft,
    captureClientTop: frame.captureClientTop,
    captureWidth: frame.captureWidth,
    captureHeight: frame.captureHeight,
    captureMode: frame.captureMode,
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
      typeof args.targetHint === 'string' ? args.targetHint.trim() : '',
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
  current = {
    ...current,
    captureClientLeft: Number.isFinite(Number(args.captureClientLeft)) ? Number(args.captureClientLeft) : current.offsetLeft,
    captureClientTop: Number.isFinite(Number(args.captureClientTop)) ? Number(args.captureClientTop) : current.offsetTop,
    captureWidth: Number.isFinite(Number(args.captureWidth)) ? Number(args.captureWidth) : current.width,
    captureHeight: Number.isFinite(Number(args.captureHeight)) ? Number(args.captureHeight) : current.height,
    captureMode: typeof args.captureMode === 'string' && args.captureMode.trim() ? args.captureMode.trim() : 'legacy-viewport',
  }

  const expectedTag = typeof args.expectedTag === 'string' ? args.expectedTag.trim().toLowerCase() : ''
  const expectedRole = typeof args.expectedRole === 'string' ? args.expectedRole.trim().toLowerCase() : ''
  const expectedTitle = typeof args.expectedTitle === 'string' ? args.expectedTitle.trim() : ''
  const expectedAriaLabel = typeof args.expectedAriaLabel === 'string' ? args.expectedAriaLabel.trim() : ''
  const clicked = await interactionPerformVisualClick(tabId, xRatio, yRatio, current, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, typeof args.targetHint === 'string' ? args.targetHint.trim() : '')
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

async function interactionPerformVisualClick(tabId, xRatio, yRatio, viewport, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, targetHint = '') {
  if (!chrome.scripting?.executeScript) throw new Error('visualClick requires chrome.scripting')
  const captureLeft = Number.isFinite(Number(viewport.captureClientLeft)) ? Number(viewport.captureClientLeft) : Number(viewport.offsetLeft || 0)
  const captureTop = Number.isFinite(Number(viewport.captureClientTop)) ? Number(viewport.captureClientTop) : Number(viewport.offsetTop || 0)
  const captureWidth = Number.isFinite(Number(viewport.captureWidth)) ? Number(viewport.captureWidth) : Number(viewport.width || 0)
  const captureHeight = Number.isFinite(Number(viewport.captureHeight)) ? Number(viewport.captureHeight) : Number(viewport.height || 0)
  if (captureWidth <= 0 || captureHeight <= 0) throw new Error('visualClick screenshot capture geometry is invalid')
  const clientX = captureLeft + Math.max(1, Math.min(captureWidth - 1, captureWidth * xRatio))
  const clientY = captureTop + Math.max(1, Math.min(captureHeight - 1, captureHeight * yRatio))

  let nativeError = ''
  if (chrome.debugger?.attach && chrome.debugger?.sendCommand && chrome.debugger?.detach) {
    let probe
    try {
      const probeResults = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: interactionMainWorldVisualClick,
        args: [clientX, clientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, true, targetHint],
      })
      probe = Array.isArray(probeResults) ? probeResults[0]?.result : undefined
      if (probe?.ok === false) throw new Error(probe.error || 'visual target probe failed')
    } catch (error) {
      nativeError = `target probe failed: ${safeError(error)}`
    }

    const hasExpectedFingerprint = Boolean(expectedTag || expectedRole || expectedTitle || expectedAriaLabel)
    const hasTargetHint = Boolean(String(targetHint || '').trim())
    if ((!hasExpectedFingerprint && !hasTargetHint) || (probe && typeof probe === 'object' && probe.ok !== false)) {
      try {
        const trustedX = Number.isFinite(Number(probe?.clickX)) ? Number(probe.clickX) : clientX
        const trustedY = Number.isFinite(Number(probe?.clickY)) ? Number(probe.clickY) : clientY
        await interactionDispatchTrustedMouseClick(tabId, trustedX, trustedY)
        await new Promise(resolve => setTimeout(resolve, 260))
        let afterProbe
        try {
          const afterResults = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'MAIN',
            func: interactionMainWorldVisualClick,
            args: [trustedX, trustedY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, true, targetHint],
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
      args: [clientX, clientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, false, targetHint],
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
    captureClientLeft: Number.isFinite(Number(viewport.captureClientLeft)) ? Number(viewport.captureClientLeft) : Number(viewport.offsetLeft || 0),
    captureClientTop: Number.isFinite(Number(viewport.captureClientTop)) ? Number(viewport.captureClientTop) : Number(viewport.offsetTop || 0),
    captureWidth: Number.isFinite(Number(viewport.captureWidth)) ? Number(viewport.captureWidth) : Number(viewport.width || 0),
    captureHeight: Number.isFinite(Number(viewport.captureHeight)) ? Number(viewport.captureHeight) : Number(viewport.height || 0),
    captureMode: typeof viewport.captureMode === 'string' ? viewport.captureMode : 'legacy-viewport',
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

async function interactionMainWorldVisualClick(clientX, clientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, probeOnly = false, targetHint = '') {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const roleOf = element => {
    const explicit = compact(element.getAttribute?.('role') || '').toLowerCase()
    if (explicit) return explicit
    const tag = element.tagName?.toLowerCase?.() || ''
    if (tag === 'button') return 'button'
    if (tag === 'a' && element.getAttribute?.('href')) return 'link'
    if (element instanceof HTMLTextAreaElement || element?.isContentEditable === true) return 'textbox'
    if (element instanceof HTMLInputElement && !['button', 'submit', 'reset'].includes(String(element.type || '').toLowerCase())) return 'textbox'
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
  const deepQueryAll = selector => {
    const out = []
    const roots = [document]
    const seenRoots = new Set()
    let scannedElements = 0
    while (roots.length && seenRoots.size < 64 && scannedElements < 12000) {
      const root = roots.shift()
      if (!root || seenRoots.has(root) || typeof root.querySelectorAll !== 'function') continue
      seenRoots.add(root)
      try { out.push(...root.querySelectorAll(selector)) } catch { return [] }
      let elements = []
      try { elements = [...root.querySelectorAll('*')] } catch {}
      scannedElements += elements.length
      for (const element of elements) {
        if (element?.shadowRoot && !seenRoots.has(element.shadowRoot)) roots.push(element.shadowRoot)
      }
    }
    return [...new Set(out)]
  }
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
  const isEditableTarget = element => element instanceof HTMLInputElement
    || element instanceof HTMLTextAreaElement
    || element?.isContentEditable === true
    || compact(element?.getAttribute?.('role') || '').toLowerCase() === 'textbox'
    || /(?:editor|input|textarea)/i.test(String(element?.tagName || ''))
  const normalizeHint = value => compact(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const hintCoreOf = value => normalizeHint(value)
    .replace(/current|截图|其中|中的|页面|视频|封面|按钮|图标|控件|链接|点击|打开|进入/g, '')
  const targetEvidence = element => {
    if (!(element instanceof Element)) return ''
    const context = element.closest?.('a[href],button,[role="button"],[role="link"],li,article,[data-action]') || element
    return compact([
      element.getAttribute?.('aria-label'), element.getAttribute?.('title'), element.getAttribute?.('placeholder'),
      element.getAttribute?.('id'), element.getAttribute?.('class'), element.getAttribute?.('href'),
      element.innerText, element.textContent,
      context !== element ? context.getAttribute?.('aria-label') : '',
      context !== element ? context.getAttribute?.('title') : '',
      context !== element ? context.getAttribute?.('href') : '',
      context !== element ? context.innerText : '',
    ].filter(Boolean).join(' '))
  }
  const hintScore = element => {
    const rawHint = compact(targetHint)
    if (!rawHint) return 0
    const evidence = normalizeHint(targetEvidence(element))
    const hintCore = hintCoreOf(rawHint)
    if (/点赞|大拇指|\blike\b|thumb/i.test(rawHint)) return /点赞|like|thumb|videolike|ariapressed/.test(evidence) ? 220 : 0
    if (/评论|回复|\bcomment\b|\breply\b/i.test(rawHint)) {
      if (!/评论|回复|comment|reply|editor|textarea|placeholder/.test(evidence)) return 0
      return isEditableTarget(element) ? 360 : 220
    }
    if (/搜索|\bsearch\b/i.test(rawHint)) return /搜索|search/.test(evidence) ? 220 : 0
    if (/发送|提交|\bsend\b|\bsubmit\b/i.test(rawHint)) return /发送|提交|send|submit/.test(evidence) ? 220 : 0
    if (hintCore.length < 3) return 0
    if (evidence.includes(hintCore)) return 180 + Math.min(80, hintCore.length)
    if (evidence.length >= 4 && hintCore.includes(evidence)) return 80
    return 0
  }
  const resolveHintTarget = (initialTarget, originalX, originalY) => {
    const rawHint = compact(targetHint)
    const hintCore = hintCoreOf(rawHint)
    const hasIntent = /点赞|大拇指|\blike\b|thumb|评论|回复|\bcomment\b|\breply\b|搜索|\bsearch\b|发送|提交|\bsend\b|\bsubmit\b/i.test(rawHint)
    const wantsEditable = /评论.*(?:输入|编辑)|回复.*(?:输入|编辑)|输入框|编辑框|comment.*(?:input|editor)|reply.*(?:input|editor)/i.test(rawHint)
    if (!rawHint || (!hasIntent && hintCore.length < 3)) return { target: initialTarget, clickX: originalX, clickY: originalY, snapped: false }
    if (hintScore(initialTarget) > 0 && (!wantsEditable || isEditableTarget(initialTarget))) {
      return { target: initialTarget, clickX: originalX, clickY: originalY, snapped: false }
    }

    const candidateSelector = [
      actionableSelector, 'textarea', 'input:not([type="hidden"])', '[contenteditable="true"]', '[role="textbox"]',
      'bili-comment-editor', 'bili-comments', '[title]', '[aria-label]',
    ].join(',')
    const uniqueTargets = []
    const seen = new Set()
    for (const candidate of deepQueryAll(candidateSelector)) {
      if (!visible(candidate) || disabled(candidate)) continue
      const resolved = chooseTarget(candidate)
      if (!(resolved instanceof Element) || !visible(resolved) || disabled(resolved) || seen.has(resolved)) continue
      const rect = resolved.getBoundingClientRect()
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue
      const score = hintScore(resolved)
      if (score <= 0) continue
      seen.add(resolved)
      uniqueTargets.push({ target: resolved, score, rect })
    }
    uniqueTargets.sort((left, right) => right.score - left.score)
    if (!uniqueTargets.length) throw new Error('visual targetHint does not match the DOM target at the requested point')
    const bestScore = uniqueTargets[0].score
    const best = uniqueTargets.filter(item => item.score === bestScore)
    if (best.length !== 1) throw new Error('visual targetHint matches multiple CURRENT DOM targets; refusing a coordinate guess')
    const chosen = best[0]
    return {
      target: chosen.target,
      clickX: Math.max(chosen.rect.left + 1, Math.min(chosen.rect.left + chosen.rect.width / 2, chosen.rect.right - 1)),
      clickY: Math.max(chosen.rect.top + 1, Math.min(chosen.rect.top + chosen.rect.height / 2, chosen.rect.bottom - 1)),
      snapped: true,
    }
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
  const initialTarget = hitIsIframe ? hit : chooseTarget(hit)
  if (!(initialTarget instanceof Element) || !visible(initialTarget) || disabled(initialTarget)) throw new Error('visual click target is not actionable')
  const resolved = hitIsIframe ? { target: initialTarget, clickX: clientX, clickY: clientY, snapped: false } : resolveHintTarget(initialTarget, clientX, clientY)
  const target = resolved.target
  const clickX = resolved.clickX
  const clickY = resolved.clickY
  const tag = target.tagName.toLowerCase()
  const role = roleOf(target)
  const title = compact(target.getAttribute('title') || '')
  const ariaLabel = compact(target.getAttribute('aria-label') || '')
  if (expectedTag && tag !== expectedTag) throw new Error('visual coordinate replay hit a different tag than teaching')
  if (expectedRole && role !== expectedRole) throw new Error('visual coordinate replay hit a different role than teaching')
  if (expectedTitle && title !== expectedTitle) throw new Error('visual coordinate replay hit a different title than teaching')
  if (expectedAriaLabel && ariaLabel !== expectedAriaLabel) throw new Error('visual coordinate replay hit a different aria-label than teaching')

  const rect = target.getBoundingClientRect()
  if (clickX < rect.left - 1 || clickX > rect.right + 1 || clickY < rect.top - 1 || clickY > rect.bottom + 1) throw new Error('visual click target no longer contains the resolved point')

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
    clickX,
    clickY,
    visualSnapped: resolved.snapped === true,
  }
  if (probeOnly) return descriptor

  target.focus?.({ preventScroll: true })
  const eventTarget = target
  if (typeof PointerEvent !== 'undefined') {
    for (const type of ['pointerover', 'pointermove', 'pointerdown', 'pointerup']) {
      eventTarget.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, clientX: clickX, clientY: clickY, pointerId: 1, pointerType: 'mouse', isPrimary: true, button: 0 }))
    }
  }
  for (const type of ['mouseover', 'mousemove', 'mousedown', 'mouseup']) {
    eventTarget.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY, button: 0 }))
  }
  if (typeof eventTarget.click === 'function') eventTarget.click()
  else eventTarget.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window, clientX: clickX, clientY: clickY, button: 0 }))

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
  const armed = await interactionFocusedEditorArm(tabId)
  if (!armed?.focusUsable) throw new Error('focused browser editor lost focus before text input')

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
  const after = await interactionFocusedEditorVerify(tabId, text)
  if (after?.inputVerified !== true) {
    throw new Error('focused editor did not expose inserted text or a trusted input event; refusing to claim text input succeeded')
  }
  return {
    ok: true,
    textLength: text.length,
    focusedTag: String(after?.focusedTag || before.focusedTag || ''),
    focusKind: String(after?.focusKind || before.focusKind || ''),
    observedText: typeof after?.observedText === 'string' ? after.observedText : '',
    inputVerified: true,
    verificationEvidence: String(after?.verificationEvidence || 'focused editor input event observed'),
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

async function interactionFocusedEditorArm(tabId) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: interactionMainWorldFocusedEditor,
    args: ['arm', {}],
  })
  return Array.isArray(results) ? results[0]?.result : undefined
}

async function interactionFocusedEditorVerify(tabId, text) {
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: interactionMainWorldFocusedEditor,
    args: ['verify', { text }],
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
  const PROBE_KEY = '__dshPatrolFocusedInputProbe'
  const cleanupProbe = () => {
    const probe = globalThis[PROBE_KEY]
    if (probe?.listener) {
      try { document.removeEventListener('input', probe.listener, true) } catch {}
    }
    try { delete globalThis[PROBE_KEY] } catch { globalThis[PROBE_KEY] = undefined }
    return probe
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

  if (mode === 'arm') {
    cleanupProbe()
    const probe = { eventSeen: false, listener: undefined }
    probe.listener = () => { probe.eventSeen = true }
    globalThis[PROBE_KEY] = probe
    document.addEventListener('input', probe.listener, true)
    return {
      ok: true,
      focusUsable,
      focusedTag: active instanceof Element ? active.tagName.toLowerCase() : host?.tagName?.toLowerCase?.() || '',
      focusKind: directEditable ? 'editable' : 'custom-focus-host',
    }
  }

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

  if (mode === 'verify') {
    const probe = cleanupProbe()
    const wanted = String(args.text || '')
    const textMatched = Boolean(wanted) && observedText.includes(wanted)
    const eventSeen = probe?.eventSeen === true
    const inputVerified = textMatched || eventSeen
    return {
      ok: true,
      focusUsable,
      focusedTag: active instanceof Element ? active.tagName.toLowerCase() : host?.tagName?.toLowerCase?.() || '',
      focusKind: directEditable ? 'editable' : 'custom-focus-host',
      observedText: observedText.slice(0, 500),
      inputVerified,
      verificationEvidence: textMatched
        ? 'focused editor contains inserted text'
        : eventSeen
          ? 'trusted input event observed from focused editor'
          : '',
    }
  }

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
