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
  let targetPixelWidth
  let captureDevicePixelRatio
  let modelRasterWidth
  let modelRasterHeight
  let captureGeometry = interactionVisibleTabCaptureGeometry(before)
  const focusRegion = interactionNormalizeVisualFocusRegion(before, args)
  let focusedVisual = false

  if (focusRegion && format === 'jpeg' && Number.isFinite(requestedMaxWidth) && requestedMaxWidth >= 480) {
    try {
      const focused = await interactionCaptureFocusedScreenshot(tabId, requestedMaxWidth, quality, before, focusRegion)
      if (focused?.dataUrl) {
        dataUrl = focused.dataUrl
        captureScale = focused.scale
        compactVisual = true
        focusedVisual = true
        targetPixelWidth = focused.targetPixelWidth
        captureDevicePixelRatio = focused.devicePixelRatio
        captureGeometry = focused.captureGeometry
      }
    } catch {
      // Focus capture is a visual-precision enhancement. Fall back to the full
      // viewport screenshot rather than losing CURRENT-page observability.
    }
  }

  const estimatedPhysicalWidth = Number(before?.width || 0) * Math.max(1, Number(before?.devicePixelRatio || 1))
  if (!dataUrl
    && format === 'jpeg'
    && Number.isFinite(requestedMaxWidth)
    && requestedMaxWidth >= 480
    && estimatedPhysicalWidth > requestedMaxWidth) {
    try {
      const compact = await interactionCaptureCompactScreenshot(tabId, requestedMaxWidth, quality, before)
      if (compact?.dataUrl) {
        dataUrl = compact.dataUrl
        captureScale = compact.scale
        compactVisual = true
        targetPixelWidth = compact.targetPixelWidth
        captureDevicePixelRatio = compact.devicePixelRatio
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
    if (format === 'jpeg' && Number.isFinite(requestedMaxWidth) && requestedMaxWidth >= 480) {
      let resized
      try {
        resized = await interactionResizeCapturedDataUrl(tabId, dataUrl, requestedMaxWidth, quality)
      } catch {
        // Some sites/CSP/page lifecycles make MAIN-world Image/canvas resizing
        // unavailable. The extension worker fallback below is independent of
        // page JavaScript and is the final physical-raster budget enforcement.
      }
      if (!resized?.dataUrl) {
        try {
          resized = await interactionResizeCapturedDataUrlInWorker(dataUrl, requestedMaxWidth, quality)
        } catch {
          // Upper Patrol layers still verify the actual read_image dimensions
          // and will refuse an oversized frame rather than guess coordinates.
        }
      }
      if (resized?.dataUrl) {
        dataUrl = resized.dataUrl
        captureScale = resized.scale
        compactVisual = resized.scale < 0.995
        targetPixelWidth = requestedMaxWidth
        captureDevicePixelRatio = Math.max(1, Number(before?.devicePixelRatio || 1))
      }
    }
  }

  // Final encoded-raster postcondition. Do not trust a particular capture
  // branch (or an older DPR assumption) to have honored maxWidth: decode the
  // exact JPEG that will be returned to Patrol and enforce the physical-pixel
  // budget one last time inside the extension worker. This makes the contract
  // observable rather than advisory.
  if (format === 'jpeg' && Number.isFinite(requestedMaxWidth) && requestedMaxWidth >= 480) {
    const bounded = await interactionResizeCapturedDataUrlInWorker(dataUrl, requestedMaxWidth, quality)
    if (!bounded?.dataUrl) {
      throw new Error('Patrol could not enforce the requested visual screenshot pixel budget in the extension worker')
    }
    if (Number(bounded.width) > requestedMaxWidth + 1) {
      throw new Error(`Patrol visual screenshot remained ${bounded.width}px wide after maxWidth=${requestedMaxWidth} enforcement`)
    }
    dataUrl = bounded.dataUrl
    modelRasterWidth = Number(bounded.width)
    modelRasterHeight = Number(bounded.height)
    if (Number.isFinite(Number(bounded.scale))) {
      captureScale *= Number(bounded.scale)
      if (Number(bounded.scale) < 0.995) compactVisual = true
    }
    targetPixelWidth = requestedMaxWidth
    captureDevicePixelRatio = Math.max(1, Number(before?.devicePixelRatio || captureDevicePixelRatio || 1))
  }

  const ocrDataUrl = dataUrl
  let actionCandidates = []
  let actionMap = false
  let actionMapZoomDataUrl
  let actionMapZoomCount = 0
  const actionMapTargetHint = typeof args.actionMapTargetHint === 'string' ? args.actionMapTargetHint.trim() : ''
  const actionMapStrictTarget = /(?:关闭|移除|删除|清除|取消|目录|章节|搜索结果|百科|标题|条目|第\s*\d+|[×✕✖]|(?:^|[\s:_-])x(?:$|[\s:_-])|["“”'][^"“”']{2,}["“”'])/i.test(actionMapTargetHint)
    || /\d+\s*[.．。、:：-]\s*[\u3400-\u9fffA-Za-z]/.test(actionMapTargetHint)
  if (args.actionMap === true && format === 'jpeg') {
    actionCandidates = await interactionCollectVisualActionCandidates(tabId, captureGeometry, actionMapTargetHint)
    if (actionCandidates.length > 0) {
      const mapped = await interactionOverlayActionMapInWorker(dataUrl, actionCandidates, captureGeometry, Math.max(80, quality))
      if (!mapped?.dataUrl) throw new Error('Patrol could not render the visual action map')
      dataUrl = mapped.dataUrl
      modelRasterWidth = Number(mapped.width)
      modelRasterHeight = Number(mapped.height)
      if (actionCandidates.length <= 16) {
        const zoom = await interactionRenderActionCandidateZoomSheetInWorker(
          ocrDataUrl,
          actionCandidates,
          captureGeometry,
          Math.max(84, quality),
        )
        if (zoom?.dataUrl) {
          actionMapZoomDataUrl = zoom.dataUrl
          actionMapZoomCount = Number(zoom.count || 0)
        }
      }
      actionMap = true
    }
  }

  let coordinateGuide = false
  if ((args.coordinateGuide === true || (args.actionMap === true && !actionMap)) && !actionMap && format === 'jpeg') {
    const guided = await interactionOverlayCoordinateGuideInWorker(dataUrl, Math.max(78, quality))
    if (!guided?.dataUrl) throw new Error('Patrol could not render the visual coordinate guide')
    dataUrl = guided.dataUrl
    coordinateGuide = true
    modelRasterWidth = Number(guided.width)
    modelRasterHeight = Number(guided.height)
  }

  const after = await interactionViewportState(tabId)
  const visualFrame = interactionRegisterVisualFrame(tabId, before, after, captureGeometry, actionCandidates)

  return {
    ok: true,
    dataUrl,
    ...(coordinateGuide ? { ocrDataUrl } : {}),
    ...(actionMapZoomDataUrl ? { actionMapZoomDataUrl } : {}),
    bytes: Math.floor(dataUrl.length * 0.75),
    compactVisual,
    captureScale,
    coordinateGuide,
    actionMap,
    actionMapTargeted: args.actionMap === true && actionMapTargetHint.length > 0,
    actionMapTargetMiss: args.actionMap === true && actionMapTargetHint.length > 0 && actionCandidates.length === 0,
    actionMapStrictTargetMiss: args.actionMap === true && actionMapTargetHint.length > 0 && actionCandidates.length === 0 && actionMapStrictTarget,
    ...(actionMapTargetHint ? { actionMapTargetHint } : {}),
    ...(args.actionMap === true ? {
      actionCandidateCount: actionCandidates.length,
      actionCandidateSummary: actionCandidates.slice(0, 16).map(candidate => {
        const summaryText = value => String(value ?? '').replace(/\s+/g, ' ').trim()
        const label = summaryText(candidate.text || candidate.ariaLabel || candidate.title || candidate.ownerContext || candidate.actionText || '').slice(0, 96)
        const owner = summaryText(candidate.ownerContext || '').slice(0, 96)
        return [candidate.candidateId, candidate.activationKind, label ? `text=${label}` : '', owner && owner !== label ? `owner=${owner}` : ''].filter(Boolean).join(' | ')
      }).join('\n'),
    } : {}),
    ...(actionMapZoomDataUrl ? { actionMapZoom: true, actionMapZoomCount } : {}),
    focusedVisual,
    ...(focusedVisual && focusRegion ? {
      focusCenterXRatio: focusRegion.centerXRatio,
      focusCenterYRatio: focusRegion.centerYRatio,
      focusWidthRatio: focusRegion.widthRatio,
      focusHeightRatio: focusRegion.heightRatio,
    } : {}),
    ...(coordinateGuide ? { coordinateGridUnits: 1000 } : {}),
    ...(Number.isFinite(modelRasterWidth) ? { modelRasterWidth } : {}),
    ...(Number.isFinite(modelRasterHeight) ? { modelRasterHeight } : {}),
    ...(Number.isFinite(Number(targetPixelWidth)) ? { targetPixelWidth: Number(targetPixelWidth) } : {}),
    ...(Number.isFinite(Number(captureDevicePixelRatio)) ? { captureDevicePixelRatio: Number(captureDevicePixelRatio) } : {}),
    ...(visualFrame || {}),
  }
}

function interactionNormalizeVisualFocusRegion(viewport, args = {}) {
  if (!viewport || typeof viewport !== 'object') return undefined
  const centerXRatio = Number(args.focusXRatio)
  const centerYRatio = Number(args.focusYRatio)
  if (!Number.isFinite(centerXRatio) || !Number.isFinite(centerYRatio)
    || centerXRatio < 0 || centerXRatio > 1 || centerYRatio < 0 || centerYRatio > 1) return undefined
  const viewportWidth = Number(viewport.width || viewport.innerWidth || 0)
  const viewportHeight = Number(viewport.height || viewport.innerHeight || 0)
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(viewportHeight)
    || viewportWidth <= 0 || viewportHeight <= 0) return undefined

  const requestedWidthRatio = Number(args.focusWidthRatio)
  const requestedHeightRatio = Number(args.focusHeightRatio)
  const widthRatio = Number.isFinite(requestedWidthRatio)
    ? Math.max(0.12, Math.min(0.72, requestedWidthRatio))
    : 0.30
  const heightRatio = Number.isFinite(requestedHeightRatio)
    ? Math.max(0.12, Math.min(0.72, requestedHeightRatio))
    : 0.34

  const width = Math.max(120, Math.min(viewportWidth, viewportWidth * widthRatio))
  const height = Math.max(100, Math.min(viewportHeight, viewportHeight * heightRatio))
  const centerX = viewportWidth * centerXRatio
  const centerY = viewportHeight * centerYRatio
  const left = Math.max(0, Math.min(viewportWidth - width, centerX - width / 2))
  const top = Math.max(0, Math.min(viewportHeight - height, centerY - height / 2))
  return {
    left, top, width, height,
    centerXRatio, centerYRatio,
    widthRatio: width / viewportWidth,
    heightRatio: height / viewportHeight,
  }
}

async function interactionCaptureFocusedScreenshot(tabId, maxWidth, quality, before, focusRegion) {
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) return undefined
  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    const metrics = await chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics')
    const viewport = metrics?.cssVisualViewport || metrics?.visualViewport
    const viewportWidth = Number(viewport?.clientWidth)
    const viewportHeight = Number(viewport?.clientHeight)
    if (![viewportWidth, viewportHeight].every(Number.isFinite) || viewportWidth <= 0 || viewportHeight <= 0) return undefined

    const left = Math.max(0, Math.min(viewportWidth - 1, Number(focusRegion.left)))
    const top = Math.max(0, Math.min(viewportHeight - 1, Number(focusRegion.top)))
    const width = Math.max(1, Math.min(viewportWidth - left, Number(focusRegion.width)))
    const height = Math.max(1, Math.min(viewportHeight - top, Number(focusRegion.height)))
    const devicePixelRatio = Math.max(1, Number(before?.devicePixelRatio || 1))
    const physicalWidth = width * devicePixelRatio
    // Unlike the full-page path, a focused crop may be rendered above native
    // CSS scale (up to 2x) so small controls become materially larger to the
    // vision model while the final raster remains within maxWidth.
    const scale = Math.max(0.25, Math.min(2, maxWidth / Math.max(1, physicalWidth)))
    const pageX = Number(viewport?.pageX || 0)
    const pageY = Number(viewport?.pageY || 0)
    const shot = await chrome.debugger.sendCommand(target, 'Page.captureScreenshot', {
      format: 'jpeg',
      quality,
      fromSurface: true,
      captureBeyondViewport: false,
      clip: {
        x: pageX + left,
        y: pageY + top,
        width,
        height,
        scale,
      },
    })
    if (!shot || typeof shot.data !== 'string' || !shot.data) return undefined

    const scrollX = Number(before?.scrollX || 0)
    const scrollY = Number(before?.scrollY || 0)
    const visualLeft = Number.isFinite(Number(viewport?.pageX))
      ? Number(viewport.pageX) - scrollX + left
      : Number(before?.offsetLeft || 0) + left
    const visualTop = Number.isFinite(Number(viewport?.pageY))
      ? Number(viewport.pageY) - scrollY + top
      : Number(before?.offsetTop || 0) + top
    return {
      dataUrl: `data:image/jpeg;base64,${shot.data}`,
      scale,
      devicePixelRatio,
      targetPixelWidth: maxWidth,
      captureGeometry: {
        captureClientLeft: visualLeft,
        captureClientTop: visualTop,
        captureWidth: width,
        captureHeight: height,
        captureMode: 'cdp-focused-region',
      },
    }
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
}

async function interactionResizeCapturedDataUrl(tabId, dataUrl, maxWidth, quality) {
  if (!chrome.scripting?.executeScript) return undefined
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: interactionMainWorldResizeCapturedDataUrl,
    args: [dataUrl, maxWidth, quality],
  })
  const value = Array.isArray(results) ? results[0]?.result : undefined
  return value && typeof value === 'object' ? value : undefined
}

async function interactionMainWorldResizeCapturedDataUrl(source, targetWidth, jpegQuality) {
  const image = new Image()
  image.decoding = 'async'
  const loaded = new Promise((resolve, reject) => {
    image.onload = () => resolve(true)
    image.onerror = () => reject(new Error('captured image decode failed'))
  })
  image.src = source
  await loaded
  const originalWidth = Number(image.naturalWidth || image.width || 0)
  const originalHeight = Number(image.naturalHeight || image.height || 0)
  if (!Number.isFinite(originalWidth) || !Number.isFinite(originalHeight) || originalWidth <= 0 || originalHeight <= 0) return undefined
  const scale = Math.min(1, Number(targetWidth) / originalWidth)
  if (scale >= 0.995) {
    return { dataUrl: source, scale: 1, width: originalWidth, height: originalHeight, originalWidth, originalHeight }
  }
  const width = Math.max(1, Math.round(originalWidth * scale))
  const height = Math.max(1, Math.round(originalHeight * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const context = canvas.getContext('2d', { alpha: false })
  if (!context) throw new Error('captured image resize canvas unavailable')
  context.drawImage(image, 0, 0, width, height)
  return {
    dataUrl: canvas.toDataURL('image/jpeg', Math.max(0.25, Math.min(0.95, Number(jpegQuality) / 100))),
    scale,
    width,
    height,
    originalWidth,
    originalHeight,
  }
}

async function interactionResizeCapturedDataUrlInWorker(source, targetWidth, jpegQuality) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return undefined
  if (typeof dataUrlToBlob !== 'function' || typeof blobToDataUrl !== 'function') return undefined
  const bitmap = await createImageBitmap(dataUrlToBlob(source))
  try {
    const originalWidth = Number(bitmap.width || 0)
    const originalHeight = Number(bitmap.height || 0)
    if (!Number.isFinite(originalWidth) || !Number.isFinite(originalHeight) || originalWidth <= 0 || originalHeight <= 0) return undefined
    const scale = Math.min(1, Number(targetWidth) / originalWidth)
    if (scale >= 0.995) {
      return { dataUrl: source, scale: 1, width: originalWidth, height: originalHeight, originalWidth, originalHeight }
    }
    const width = Math.max(1, Math.round(originalWidth * scale))
    const height = Math.max(1, Math.round(originalHeight * scale))
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) throw new Error('extension worker screenshot resize canvas unavailable')
    context.drawImage(bitmap, 0, 0, originalWidth, originalHeight, 0, 0, width, height)
    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: Math.max(0.25, Math.min(0.95, Number(jpegQuality) / 100)),
    })
    return {
      dataUrl: await blobToDataUrl(blob),
      scale,
      width,
      height,
      originalWidth,
      originalHeight,
    }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

async function interactionCollectVisualActionCandidates(tabId, captureGeometry, targetHint = '') {
  if (!chrome.scripting?.executeScript || !captureGeometry) return []
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: interactionMainWorldCollectVisualActionCandidates,
      args: [{
        left: Number(captureGeometry.captureClientLeft || 0),
        top: Number(captureGeometry.captureClientTop || 0),
        width: Number(captureGeometry.captureWidth || 0),
        height: Number(captureGeometry.captureHeight || 0),
      }, typeof targetHint === 'string' ? targetHint : ''],
    })
    const value = Array.isArray(results) ? results[0]?.result : undefined
    return Array.isArray(value) ? value.slice(0, 60) : []
  } catch {
    return []
  }
}

function interactionMainWorldCollectVisualActionCandidates(capture, targetHint = '') {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const normalize = value => compact(value).replace(/[\s._·。．、,:：;；/\\()（）\[\]【】{}<>《》“”‘’'"\-—–]+/g, '').toLocaleLowerCase()
  const capLeft = Number(capture?.left || 0)
  const capTop = Number(capture?.top || 0)
  const capWidth = Number(capture?.width || 0)
  const capHeight = Number(capture?.height || 0)
  const capRight = capLeft + capWidth
  const capBottom = capTop + capHeight
  if (![capLeft, capTop, capWidth, capHeight].every(Number.isFinite) || capWidth <= 0 || capHeight <= 0) return []

  const interactiveRoles = new Set([
    'button','link','checkbox','radio','switch','tab','menuitem','option',
    'combobox','textbox','searchbox','spinbutton','slider',
  ])
  const strongTags = new Set(['button','a','input','textarea','select','summary'])
  const roots = [document]
  const elements = []
  const seen = new Set()
  while (roots.length && elements.length < 12000) {
    const root = roots.pop()
    let nodes = []
    try { nodes = [...root.querySelectorAll('*')] } catch {}
    for (const element of nodes) {
      if (!(element instanceof Element) || seen.has(element)) continue
      seen.add(element)
      elements.push(element)
      if (element.shadowRoot) roots.push(element.shadowRoot)
    }
  }

  const rowLikeSelector = [
    'tr', '[role="row"]', '.ant-table-row', '.el-table__row', '.ivu-table-row', '.arco-table-tr', '.vxe-body--row',
    '[class*="table-row"]', '[class*="list-row"]', '[data-row-key]', '[aria-rowindex]', '[data-index]',
  ].join(',')
  const rowVisible = element => {
    if (!(element instanceof Element) || !element.isConnected) return false
    const style = getComputedStyle(element)
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false
    const rect = element.getBoundingClientRect()
    return rect.width > 0 && rect.height > 0
  }
  const rowKey = row => {
    if (!(row instanceof Element)) return ''
    for (const attr of ['data-row-key', 'data-key', 'row-key', 'data-index', 'aria-rowindex']) {
      const value = row.getAttribute?.(attr)
      if (value !== null && value !== undefined && String(value).trim()) return `${attr}:${String(value).trim()}`
    }
    return ''
  }
  const rowOrdinal = row => {
    if (!(row instanceof Element) || !(row.parentElement instanceof Element)) return -1
    const peers = [...row.parentElement.children].filter(child => child.matches?.(rowLikeSelector))
    return peers.indexOf(row)
  }
  const closestRow = element => {
    let node = element
    let guard = 0
    while (node instanceof Element && guard < 24) {
      if (node.matches?.(rowLikeSelector)) return node
      const parent = node.parentElement
      if (parent) node = parent
      else {
        const root = node.getRootNode?.()
        node = root && root.host instanceof Element ? root.host : null
      }
      guard += 1
    }
    return null
  }
  const allRows = elements.filter(element => element.matches?.(rowLikeSelector) && rowVisible(element))
  const logicalRowContext = element => {
    const row = closestRow(element)
    if (!(row instanceof Element)) return { text: '', key: '', ordinal: -1 }
    const key = rowKey(row)
    const ordinal = rowOrdinal(row)
    const rect = row.getBoundingClientRect()
    const contexts = [compact(row.innerText || row.textContent || '')]
    for (const peer of allRows) {
      if (peer === row) continue
      const peerKey = rowKey(peer)
      const peerOrdinal = rowOrdinal(peer)
      const peerRect = peer.getBoundingClientRect()
      const sameKey = Boolean(key && peerKey && key === peerKey)
      const sameOrdinal = ordinal >= 0 && peerOrdinal >= 0 && ordinal === peerOrdinal && peer.parentElement !== row.parentElement
      const alignedTop = peer.parentElement !== row.parentElement && Math.abs(Number(peerRect.top) - Number(rect.top)) <= 6
      if (sameKey || sameOrdinal || alignedTop) contexts.push(compact(peer.innerText || peer.textContent || ''))
    }
    return {
      text: compact([...new Set(contexts.filter(Boolean))].join(' | ')).slice(0, 900),
      key,
      ordinal,
    }
  }
  const localCandidateContext = element => {
    const contexts = []
    let node = element
    for (let depth = 0; node instanceof Element && depth < 5; depth += 1) {
      const text = compact([
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.innerText,
        node.textContent,
      ].filter(Boolean).join(' '))
      if (text && text.length <= 360) contexts.push(text)
      const parent = node.parentElement
      if (parent) node = parent
      else {
        const root = node.getRootNode?.()
        node = root && root.host instanceof Element ? root.host : null
      }
    }
    return compact([...new Set(contexts.filter(Boolean))].join(' | ')).slice(0, 900)
  }
  const microActionOwnerContext = element => {
    let node = element?.parentElement
    for (let depth = 0; node instanceof Element && depth < 5; depth += 1) {
      const rect = node.getBoundingClientRect()
      const text = compact([
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.innerText,
        node.textContent,
      ].filter(Boolean).join(' '))
      const ownerCore = normalize(text)
      const closeOnly = /^(?:x|×|✕|✖|close|remove|delete|clear|dismiss|关闭|移除|删除|清除|取消)$/.test(ownerCore)
      if (text && !closeOnly && ownerCore.length >= 2 && text.length <= 180
        && Number(rect.width) > 0 && Number(rect.height) > 0
        && Number(rect.width) <= 520 && Number(rect.height) <= 110) {
        return text
      }
      node = node.parentElement
    }
    return ''
  }
  const closeIntent = /(?:关闭|移除|删除|清除|取消|close|remove|delete|clear|dismiss|[×✕✖]|(?:^|[\s:_-])x(?:$|[\s:_-]))/i.test(String(targetHint || ''))
  const closeBusinessCore = normalize(String(targetHint || '')
    .replace(/(?:点击|帮我|请|关闭|移除|删除|清除|取消|筛选|搜索|标签|配置项|右侧|左侧|旁边|里面|其中|图标|按钮|控件|的|close|remove|delete|clear|dismiss|[x×✕✖])/gi, ' '))
  const genericBusinessCore = normalize(String(targetHint || '')
    .replace(/(?:点击|帮我|请|找到|定位|打开|进入|选择|跳转|当前|这个|那个|页面|区域|目录|搜索结果|结果|链接|按钮|图标|控件|标签|配置项|输入框|搜索栏|右侧|左侧|旁边|里面|其中|的|click|open|enter|select|target|current|page|link|button|icon|control)/gi, ' '))
  const strongTextIntent = /(?:目录|章节|搜索结果|百科|标题|条目|第\s*\d+|["“”'][^"“”']{2,}["“”'])/i.test(String(targetHint || ''))
    || /\d+\s*[.．。、:：-]\s*[\u3400-\u9fffA-Za-z]/.test(String(targetHint || ''))

  const structuredIdentities = [...new Set((String(targetHint || '').match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || []).map(compact).filter(Boolean))]
  const structuredActions = [...new Set((String(targetHint || '').match(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi) || []).map(value => String(value).toUpperCase()))]
  const structuredTarget = structuredIdentities.length > 0 && structuredActions.length > 0
  const candidateMatchesStructuredTarget = candidate => {
    if (!structuredTarget) return true
    const context = normalize(candidate.rowContext || '')
    const actionText = normalize(candidate.actionText || '')
    return structuredIdentities.every(token => context.includes(normalize(token)))
      && structuredActions.some(token => actionText.includes(normalize(token)))
  }

  const roleOf = element => compact(element.getAttribute?.('role') || '').toLowerCase()
  const tagOf = element => element.tagName?.toLowerCase?.() || ''
  const typeOf = element => compact(element.getAttribute?.('type') || '').toLowerCase()
  const isEditable = element => {
    const tag = tagOf(element)
    const role = roleOf(element)
    const type = typeOf(element)
    return element.isContentEditable === true || tag === 'textarea'
      || (tag === 'input' && !['button','submit','reset','checkbox','radio','range','file','color','hidden'].includes(type))
      || role === 'textbox' || role === 'searchbox'
  }
  const isStrongAction = element => {
    const tag = tagOf(element)
    const role = roleOf(element)
    const type = typeOf(element)
    if (tag === 'a') return element.hasAttribute('href')
    if (tag === 'input') return type !== 'hidden'
    return strongTags.has(tag)
      || interactiveRoles.has(role)
      || element.isContentEditable === true
      || typeof element.onclick === 'function'
      || element.hasAttribute('onclick')
  }
  const hasStrongActionDescendant = element => {
    if (!(element instanceof Element)) return false
    let descendants = []
    try { descendants = [...element.querySelectorAll('a[href],button,input:not([type="hidden"]),textarea,select,summary,[role="button"],[role="link"],[role="textbox"],[role="checkbox"],[role="radio"],[role="switch"],[contenteditable="true"],[contenteditable="plaintext-only"],[onclick]')] } catch {}
    return descendants.some(child => child instanceof Element && child !== element)
  }
  const isMicroCloseAction = (element, rect, style) => {
    if (!(element instanceof Element)) return false
    if (!rect || rect.width < 6 || rect.height < 6 || rect.width > 72 || rect.height > 72) return false
    const evidence = compact([
      element.id,
      element.getAttribute?.('class'),
      element.getAttribute?.('title'),
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('data-action'),
      element.getAttribute?.('data-icon'),
      element.innerText,
      element.textContent,
    ].filter(Boolean).join(' ')).toLowerCase()
    const closeToken = /(?:^|[-_\s])(?:close|remove|delete|clear|dismiss|times|cross|cancel)(?:$|[-_\s])|o_facet_remove|fa-times|fa-close|icon-close|关闭|移除|删除|清除|[×✕✖]/i.test(evidence)
      || /^[x×✕✖]$/i.test(compact(element.textContent || ''))
    if (!closeToken) return false
    const parent = element.parentElement
    const pointerish = style?.cursor === 'pointer'
      || typeof element.onclick === 'function'
      || element.hasAttribute?.('onclick')
      || parent?.matches?.('button,[role="button"],[onclick]')
      || (parent instanceof Element && getComputedStyle(parent).cursor === 'pointer')
    return pointerish
  }
  const within = (element, hit) => element === hit || (hit instanceof Node && element.contains(hit))
  const safePointFor = (element, rect) => {
    const insetX = Math.min(Math.max(3, rect.width * 0.16), Math.max(3, rect.width / 2 - 1))
    const insetY = Math.min(Math.max(3, rect.height * 0.16), Math.max(3, rect.height / 2 - 1))
    const points = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + insetX, rect.top + rect.height / 2],
      [rect.right - insetX, rect.top + rect.height / 2],
      [rect.left + rect.width / 2, rect.top + insetY],
      [rect.left + rect.width / 2, rect.bottom - insetY],
      [rect.left + insetX, rect.top + insetY],
      [rect.right - insetX, rect.top + insetY],
      [rect.left + insetX, rect.bottom - insetY],
      [rect.right - insetX, rect.bottom - insetY],
    ]
    for (const [x,y] of points) {
      if (x < capLeft || x > capRight || y < capTop || y > capBottom) continue
      let hit
      try { hit = document.elementFromPoint(x, y) } catch {}
      if (!(hit instanceof Element)) continue
      let shadowHit = hit
      let guard = 0
      while (shadowHit instanceof Element && shadowHit.shadowRoot && guard < 8) {
        const inner = shadowHit.shadowRoot.elementFromPoint?.(x, y)
        if (!(inner instanceof Element) || inner === shadowHit) break
        shadowHit = inner
        guard += 1
      }
      if (within(element, shadowHit)) return { x, y, hitTag: tagOf(shadowHit) }
    }
    return undefined
  }

  const candidates = []
  const captureArea = capWidth * capHeight
  for (const element of elements) {
    const tag = tagOf(element)
    const role = roleOf(element)
    const type = typeOf(element)
    const style = getComputedStyle(element)
    if (!style || style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) continue
    const rawRect = element.getBoundingClientRect()
    const left = Math.max(capLeft, Number(rawRect.left))
    const top = Math.max(capTop, Number(rawRect.top))
    const right = Math.min(capRight, Number(rawRect.right))
    const bottom = Math.min(capBottom, Number(rawRect.bottom))
    const width = right - left
    const height = bottom - top
    if (![left,top,right,bottom,width,height].every(Number.isFinite) || width < 8 || height < 8) continue
    if (tag === 'input' && type === 'hidden') continue

    const editable = isEditable(element)
    const strongAction = isStrongAction(element)
    const microCloseAction = isMicroCloseAction(element, rawRect, style)
    const pointerAction = style.cursor === 'pointer'
    const labeledPointer = pointerAction && Boolean(
      compact(element.getAttribute?.('title') || '')
      || compact(element.getAttribute?.('aria-label') || '')
      || compact(element.textContent || '').slice(0, 80)
    )
    const tabIndexAttr = element.getAttribute?.('tabindex')
    const tabIndex = tabIndexAttr === null || tabIndexAttr === undefined || String(tabIndexAttr).trim() === ''
      ? Number.NaN
      : Number(tabIndexAttr)
    const weakPointerOnly = !strongAction && !editable
      && (labeledPointer || (Number.isFinite(tabIndex) && tabIndex >= 0 && pointerAction))
    if (!(strongAction || editable || weakPointerOnly || microCloseAction)) continue

    // A broad pointer-styled card wrapper must never compete with the real
    // anchor/button nested inside it. This was the main source of Bilibili
    // "correct box, no navigation" failures.
    if (weakPointerOnly && !microCloseAction && hasStrongActionDescendant(element)) continue

    const area = width * height
    if (!editable && area > captureArea * 0.38) continue
    if (!editable && (width > capWidth * 0.88 || height > capHeight * 0.75)) continue

    const clippedRect = { left, top, right, bottom, width, height }
    const safePoint = safePointFor(element, clippedRect)
    if (!safePoint) continue

    let score = 0
    if (tag === 'a' && element.hasAttribute('href')) score += 780
    else if (tag === 'button') score += 740
    else if (strongAction) score += 560
    if (interactiveRoles.has(role)) score += 420
    if (editable) score += 360
    if (pointerAction) score += 120
    if (compact(element.getAttribute?.('aria-label') || '')) score += 80
    if (compact(element.getAttribute?.('title') || '')) score += 60
    if (area < 24000) score += 60
    if (area < 8000) score += 40
    if (weakPointerOnly) score -= 220
    if (microCloseAction) score += 980

    const rowContext = logicalRowContext(element)
    const localContext = localCandidateContext(element)
    const ownerContext = microCloseAction ? microActionOwnerContext(element) : ''
    const candidateText = compact(element.innerText || element.textContent || '').slice(0, 120)
    const candidateTitle = compact(element.getAttribute?.('title') || '')
    const candidateAriaLabel = compact(element.getAttribute?.('aria-label') || '')
    const candidatePlaceholder = compact(element.getAttribute?.('placeholder') || '')
    const candidateName = compact(element.getAttribute?.('name') || '')
    const actionText = compact([
      candidateAriaLabel,
      candidateTitle,
      candidatePlaceholder,
      candidateName,
      candidateText,
      element instanceof HTMLInputElement ? element.value : '',
      element.id,
      [...(element.classList || [])].join(' '),
    ].filter(Boolean).join(' ')).slice(0, 360)
    candidates.push({
      tag,
      role,
      text: candidateText,
      title: candidateTitle,
      ariaLabel: candidateAriaLabel,
      actionText,
      localContext,
      ownerContext,
      rowContext: rowContext.text,
      rowKey: rowContext.key,
      rowOrdinal: rowContext.ordinal,
      href: tag === 'a' ? compact(element.getAttribute?.('href') || '') : '',
      id: compact(element.id || ''),
      className: compact([...(element.classList || [])].join(' ')).slice(0, 220),
      left, top, width, height,
      centerX: left + width / 2,
      centerY: top + height / 2,
      safeX: safePoint.x,
      safeY: safePoint.y,
      safePointKind: safePoint.hitTag ? `verified-hit:${safePoint.hitTag}` : 'verified-hit',
      activationKind: microCloseAction
        ? 'micro-close'
        : tag === 'a' && element.hasAttribute('href')
          ? 'anchor'
          : tag === 'button' || role === 'button'
            ? 'button'
            : editable
              ? 'editable'
              : weakPointerOnly
                ? 'pointer-wrapper'
                : 'interactive',
      microActionKind: microCloseAction ? 'close' : '',
      score,
    })
  }

  candidates.sort((a,b) => b.score - a.score || a.top - b.top || a.left - b.left)
  const kept = []
  for (const candidate of candidates) {
    const duplicate = kept.some(existing => {
      const ix = Math.max(0, Math.min(existing.left + existing.width, candidate.left + candidate.width) - Math.max(existing.left, candidate.left))
      const iy = Math.max(0, Math.min(existing.top + existing.height, candidate.top + candidate.height) - Math.max(existing.top, candidate.top))
      const intersection = ix * iy
      const smaller = Math.min(existing.width * existing.height, candidate.width * candidate.height)
      const centersClose = Math.hypot(existing.safeX - candidate.safeX, existing.safeY - candidate.safeY) <= 4
      return (smaller > 0 && intersection / smaller > 0.94 && existing.activationKind === candidate.activationKind) || centersClose
    })
    if (!duplicate) kept.push(candidate)
    if (kept.length >= 60) break
  }

  let narrowed = structuredTarget ? kept.filter(candidateMatchesStructuredTarget) : kept
  if (!structuredTarget && closeIntent) {
    const preciseClose = narrowed.filter(candidate => candidate.microActionKind === 'close')
    if (preciseClose.length > 0) {
      const contextualClose = closeBusinessCore.length >= 2
        ? preciseClose.filter(candidate => normalize(candidate.ownerContext || '').includes(closeBusinessCore))
        : []
      if (closeBusinessCore.length >= 2) {
        narrowed = contextualClose.length > 0
          ? contextualClose
          : preciseClose.length === 1 ? preciseClose : []
      } else {
        narrowed = preciseClose
      }
    } else {
      // Explicit close/remove intent must never degrade to unrelated controls
      // such as the surrounding search input. Fail closed and ask for a
      // fresher/tighter visual observation instead.
      narrowed = []
    }
  } else if (!structuredTarget && genericBusinessCore.length >= 2) {
    const textualMatches = narrowed.filter(candidate => {
      const action = normalize(candidate.actionText || '')
      const evidence = normalize([
        candidate.actionText,
        candidate.localContext,
        candidate.rowContext,
        candidate.href,
        candidate.id,
        candidate.className,
      ].filter(Boolean).join(' '))
      if (!evidence) return false
      if (evidence.includes(genericBusinessCore)) return true
      if (action.length >= 2 && genericBusinessCore.includes(action)) return true
      return false
    })
    // Targeted Action Map is a visual grounding aid, not a semantic click.
    // Narrow only when CURRENT DOM evidence gives a small, useful candidate
    // set. Otherwise preserve the full visual choice instead of guessing.
    if (textualMatches.length > 0 && textualMatches.length <= 16) narrowed = textualMatches
    else if (strongTextIntent && textualMatches.length === 0) narrowed = []
  }
  narrowed.sort((a,b) => a.top - b.top || a.left - b.left)
  return narrowed.map((candidate,index) => ({ ...candidate, candidateId: `A${index + 1}` }))
}
async function interactionOverlayActionMapInWorker(source, candidates, captureGeometry, jpegQuality) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return undefined
  if (typeof dataUrlToBlob !== 'function' || typeof blobToDataUrl !== 'function') return undefined
  const bitmap = await createImageBitmap(dataUrlToBlob(source))
  try {
    const width = Number(bitmap.width || 0)
    const height = Number(bitmap.height || 0)
    const capLeft = Number(captureGeometry?.captureClientLeft || 0)
    const capTop = Number(captureGeometry?.captureClientTop || 0)
    const capWidth = Number(captureGeometry?.captureWidth || 0)
    const capHeight = Number(captureGeometry?.captureHeight || 0)
    if (![width,height,capWidth,capHeight].every(Number.isFinite) || width <= 0 || height <= 0 || capWidth <= 0 || capHeight <= 0) return undefined
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0, width, height)

    const sx = width / capWidth
    const sy = height / capHeight
    const fontPx = Math.max(13, Math.min(22, Math.round(width / 52)))
    context.font = `700 ${fontPx}px sans-serif`
    context.textBaseline = 'top'
    for (const candidate of candidates) {
      const x = (Number(candidate.left) - capLeft) * sx
      const y = (Number(candidate.top) - capTop) * sy
      const w = Number(candidate.width) * sx
      const h = Number(candidate.height) * sy
      if (![x,y,w,h].every(Number.isFinite) || w < 2 || h < 2) continue
      context.strokeStyle = 'rgba(255,45,45,0.96)'
      context.lineWidth = Math.max(2, Math.round(width / 500))
      context.strokeRect(x, y, w, h)
      const safeX = (Number(candidate.safeX) - capLeft) * sx
      const safeY = (Number(candidate.safeY) - capTop) * sy
      if (Number.isFinite(safeX) && Number.isFinite(safeY)) {
        const radius = Math.max(3, Math.round(width / 320))
        context.fillStyle = 'rgba(0,255,110,0.96)'
        context.beginPath(); context.arc(safeX, safeY, radius, 0, Math.PI * 2); context.fill()
        context.strokeStyle = 'rgba(0,0,0,0.96)'
        context.lineWidth = 1
        context.beginPath(); context.moveTo(safeX - radius - 2, safeY); context.lineTo(safeX + radius + 2, safeY); context.stroke()
        context.beginPath(); context.moveTo(safeX, safeY - radius - 2); context.lineTo(safeX, safeY + radius + 2); context.stroke()
      }
      const label = String(candidate.candidateId || '')
      const metrics = context.measureText(label)
      const boxW = Math.ceil(metrics.width) + 8
      const boxH = fontPx + 7
      const labelX = Math.max(0, Math.min(width - boxW, x))
      const labelY = Math.max(0, Math.min(height - boxH, y - boxH))
      context.fillStyle = 'rgba(255,230,0,0.96)'
      context.fillRect(labelX, labelY, boxW, boxH)
      context.fillStyle = 'rgba(0,0,0,0.98)'
      context.fillText(label, labelX + 4, labelY + 3)
    }
    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: Math.max(0.68, Math.min(0.95, Number(jpegQuality) / 100)),
    })
    return { dataUrl: await blobToDataUrl(blob), width, height }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

async function interactionRenderActionCandidateZoomSheetInWorker(source, candidates, captureGeometry, jpegQuality) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return undefined
  if (typeof dataUrlToBlob !== 'function' || typeof blobToDataUrl !== 'function') return undefined
  if (!Array.isArray(candidates) || candidates.length < 1 || candidates.length > 16) return undefined
  const bitmap = await createImageBitmap(dataUrlToBlob(source))
  try {
    const sourceWidth = Number(bitmap.width || 0)
    const sourceHeight = Number(bitmap.height || 0)
    const capLeft = Number(captureGeometry?.captureClientLeft || 0)
    const capTop = Number(captureGeometry?.captureClientTop || 0)
    const capWidth = Number(captureGeometry?.captureWidth || 0)
    const capHeight = Number(captureGeometry?.captureHeight || 0)
    if (![sourceWidth, sourceHeight, capWidth, capHeight].every(Number.isFinite)
      || sourceWidth <= 0 || sourceHeight <= 0 || capWidth <= 0 || capHeight <= 0) return undefined

    const count = candidates.length
    const columns = count <= 4 ? count : count <= 8 ? 4 : 4
    const rows = Math.ceil(count / columns)
    const sheetWidth = 1024
    const headerHeight = 54
    const gap = 8
    const cardWidth = Math.floor((sheetWidth - gap * (columns + 1)) / columns)
    const cardHeight = 170
    const sheetHeight = headerHeight + gap + rows * (cardHeight + gap)
    const canvas = new OffscreenCanvas(sheetWidth, sheetHeight)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return undefined

    context.fillStyle = '#101216'
    context.fillRect(0, 0, sheetWidth, sheetHeight)
    context.fillStyle = '#ffffff'
    context.font = '700 20px sans-serif'
    context.textBaseline = 'top'
    context.fillText('PATROL TARGET ZOOM — choose A# only; these crop coordinates are NOT click XY', 14, 12)
    context.font = '500 13px sans-serif'
    context.fillStyle = '#b9c2cf'
    context.fillText('Each card magnifies real CURRENT-page pixels around one browser candidate. Green crosshair = exact safe point.', 14, 36)

    const sx = sourceWidth / capWidth
    const sy = sourceHeight / capHeight

    for (let index = 0; index < count; index += 1) {
      const candidate = candidates[index]
      const col = index % columns
      const row = Math.floor(index / columns)
      const cardX = gap + col * (cardWidth + gap)
      const cardY = headerHeight + gap + row * (cardHeight + gap)

      context.fillStyle = '#20242b'
      context.fillRect(cardX, cardY, cardWidth, cardHeight)
      context.strokeStyle = '#596273'
      context.lineWidth = 1
      context.strokeRect(cardX + 0.5, cardY + 0.5, cardWidth - 1, cardHeight - 1)

      const candidateX = (Number(candidate.left) - capLeft) * sx
      const candidateY = (Number(candidate.top) - capTop) * sy
      const candidateW = Math.max(2, Number(candidate.width) * sx)
      const candidateH = Math.max(2, Number(candidate.height) * sy)
      const safeX = (Number(candidate.safeX) - capLeft) * sx
      const safeY = (Number(candidate.safeY) - capTop) * sy

      const cropW = Math.min(sourceWidth, Math.max(120, candidateW * 4.0))
      const cropH = Math.min(sourceHeight, Math.max(88, candidateH * 4.0))
      const cropX = Math.max(0, Math.min(sourceWidth - cropW, candidateX + candidateW / 2 - cropW / 2))
      const cropY = Math.max(0, Math.min(sourceHeight - cropH, candidateY + candidateH / 2 - cropH / 2))

      const captionHeight = 34
      const imageX = cardX + 4
      const imageY = cardY + 4
      const imageW = cardWidth - 8
      const imageH = cardHeight - captionHeight - 8
      const scale = Math.min(imageW / cropW, imageH / cropH)
      const drawW = cropW * scale
      const drawH = cropH * scale
      const drawX = imageX + (imageW - drawW) / 2
      const drawY = imageY + (imageH - drawH) / 2

      context.fillStyle = '#ffffff'
      context.fillRect(imageX, imageY, imageW, imageH)
      context.drawImage(bitmap, cropX, cropY, cropW, cropH, drawX, drawY, drawW, drawH)

      const safeDrawX = drawX + (safeX - cropX) * scale
      const safeDrawY = drawY + (safeY - cropY) * scale
      if (Number.isFinite(safeDrawX) && Number.isFinite(safeDrawY)) {
        const radius = 7
        context.strokeStyle = '#00ff6a'
        context.lineWidth = 3
        context.beginPath(); context.arc(safeDrawX, safeDrawY, radius, 0, Math.PI * 2); context.stroke()
        context.beginPath(); context.moveTo(safeDrawX - 12, safeDrawY); context.lineTo(safeDrawX + 12, safeDrawY); context.stroke()
        context.beginPath(); context.moveTo(safeDrawX, safeDrawY - 12); context.lineTo(safeDrawX, safeDrawY + 12); context.stroke()
      }

      const label = String(candidate.candidateId || `A${index + 1}`)
      context.fillStyle = '#ffe600'
      context.fillRect(cardX + 5, cardY + cardHeight - captionHeight, 42, 27)
      context.fillStyle = '#111111'
      context.font = '800 18px sans-serif'
      context.fillText(label, cardX + 10, cardY + cardHeight - captionHeight + 3)

      const evidence = String(
        candidate.localContext
        || candidate.rowContext
        || candidate.actionText
        || candidate.ariaLabel
        || candidate.title
        || candidate.text
        || candidate.activationKind
        || '',
      ).replace(/\s+/g, ' ').trim().slice(0, 62)
      context.fillStyle = '#ffffff'
      context.font = '600 12px sans-serif'
      context.fillText(evidence || String(candidate.activationKind || 'interactive'), cardX + 52, cardY + cardHeight - captionHeight + 7)
    }

    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: Math.max(0.74, Math.min(0.96, Number(jpegQuality) / 100)),
    })
    return {
      dataUrl: await blobToDataUrl(blob),
      width: sheetWidth,
      height: sheetHeight,
      count,
    }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
  }
}

async function interactionOverlayCoordinateGuideInWorker(source, jpegQuality) {
  if (typeof OffscreenCanvas !== 'function' || typeof createImageBitmap !== 'function') return undefined
  if (typeof dataUrlToBlob !== 'function' || typeof blobToDataUrl !== 'function') return undefined
  const bitmap = await createImageBitmap(dataUrlToBlob(source))
  try {
    const width = Number(bitmap.width || 0)
    const height = Number(bitmap.height || 0)
    if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined
    const canvas = new OffscreenCanvas(width, height)
    const context = canvas.getContext('2d', { alpha: false })
    if (!context) return undefined
    context.drawImage(bitmap, 0, 0, width, height)

    // Overlay only; never crop/pad/resize. xRatio/yRatio therefore continue to
    // map 1:1 to the screenshot-bound capture geometry. The guide exists solely
    // to stop multimodal models from guessing OS/UI preview pixel dimensions.
    const fontPx = Math.max(10, Math.min(16, Math.round(width / 80)))
    context.font = `600 ${fontPx}px sans-serif`
    context.textBaseline = 'top'
    context.lineWidth = 1

    for (let step = 50; step < 1000; step += 50) {
      const x = width * step / 1000
      const y = height * step / 1000
      const major = step % 100 === 0
      context.strokeStyle = major ? 'rgba(255,64,64,0.30)' : 'rgba(255,255,255,0.14)'
      context.beginPath(); context.moveTo(x, 0); context.lineTo(x, height); context.stroke()
      context.beginPath(); context.moveTo(0, y); context.lineTo(width, y); context.stroke()
    }

    const label = (text, x, y) => {
      const metrics = context.measureText(text)
      const boxW = Math.ceil(metrics.width) + 6
      const boxH = fontPx + 5
      context.fillStyle = 'rgba(0,0,0,0.66)'
      context.fillRect(Math.max(0, x - 2), Math.max(0, y - 1), boxW, boxH)
      context.fillStyle = 'rgba(255,255,255,0.96)'
      context.fillText(text, Math.max(1, x + 1), Math.max(0, y + 1))
    }
    for (let step = 100; step < 1000; step += 100) {
      label(`X${step}`, width * step / 1000 + 2, 2)
      label(`Y${step}`, 2, height * step / 1000 + 2)
    }
    label('XY/1000', 3, 3)

    const blob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: Math.max(0.60, Math.min(0.95, Number(jpegQuality) / 100)),
    })
    return { dataUrl: await blobToDataUrl(blob), width, height }
  } finally {
    if (typeof bitmap.close === 'function') bitmap.close()
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
    const devicePixelRatio = Math.max(1, Number(before?.devicePixelRatio || 1))
    // Page.captureScreenshot applies clip.scale in CSS space and then rasterizes
    // at the page device scale. Treat maxWidth as the final encoded-pixel
    // budget (like Desktop Automation's geometry-faithful frame), otherwise a
    // DPR=2 page requested at maxWidth=1024 still becomes a ~2048px model image.
    const estimatedPhysicalWidth = width * devicePixelRatio
    const scale = Math.max(0.1, Math.min(1, maxWidth / estimatedPhysicalWidth))
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
    return {
      dataUrl: `data:image/jpeg;base64,${shot.data}`,
      scale,
      devicePixelRatio,
      targetPixelWidth: maxWidth,
      captureGeometry,
    }
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
  // Visual frames intentionally have no time-to-live or use-count limit.
  // CURRENT-page freshness is enforced at click time by tab + URL + scroll +
  // zoom + viewport equality, so an unchanged screenshot can be retried freely.
  for (const [id, frame] of interactionVisualFrames) {
    if (!frame || !Number.isInteger(frame.tabId)) interactionVisualFrames.delete(id)
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

function interactionCurrentReplayCaptureGeometry(viewport, recordedMode = '', recorded = {}) {
  if (!viewport || typeof viewport !== 'object') return undefined
  if (recordedMode === 'capture-visible-tab-layout-viewport') {
    return interactionVisibleTabCaptureGeometry(viewport)
  }
  if (recordedMode === 'cdp-focused-region') {
    const recordedViewportWidth = Number(recorded.viewportWidth)
    const recordedViewportHeight = Number(recorded.viewportHeight)
    const recordedLeft = Number(recorded.captureClientLeft)
    const recordedTop = Number(recorded.captureClientTop)
    const recordedWidth = Number(recorded.captureWidth)
    const recordedHeight = Number(recorded.captureHeight)
    const currentWidth = Number(viewport.width)
    const currentHeight = Number(viewport.height)
    if ([recordedViewportWidth, recordedViewportHeight, recordedLeft, recordedTop, recordedWidth, recordedHeight, currentWidth, currentHeight].every(Number.isFinite)
      && recordedViewportWidth > 0 && recordedViewportHeight > 0 && recordedWidth > 0 && recordedHeight > 0
      && currentWidth > 0 && currentHeight > 0) {
      const leftRatio = recordedLeft / recordedViewportWidth
      const topRatio = recordedTop / recordedViewportHeight
      const widthRatio = recordedWidth / recordedViewportWidth
      const heightRatio = recordedHeight / recordedViewportHeight
      return {
        captureClientLeft: Number(viewport.offsetLeft || 0) + leftRatio * currentWidth,
        captureClientTop: Number(viewport.offsetTop || 0) + topRatio * currentHeight,
        captureWidth: widthRatio * currentWidth,
        captureHeight: heightRatio * currentHeight,
        captureMode: 'cdp-focused-region',
      }
    }
    return undefined
  }
  const captureClientLeft = Number(viewport.offsetLeft || 0)
  const captureClientTop = Number(viewport.offsetTop || 0)
  const captureWidth = Number(viewport.width)
  const captureHeight = Number(viewport.height)
  if (![captureClientLeft, captureClientTop, captureWidth, captureHeight].every(Number.isFinite)
    || captureWidth <= 0 || captureHeight <= 0) return undefined
  return {
    captureClientLeft,
    captureClientTop,
    captureWidth,
    captureHeight,
    captureMode: recordedMode === 'cdp-css-visual-viewport'
      ? 'cdp-css-visual-viewport'
      : recordedMode === 'cdp-focused-region'
        ? 'cdp-focused-region'
        : 'legacy-viewport-current',
  }
}

function interactionRegisterVisualFrame(tabId, before, after, captureGeometry, actionCandidates = []) {
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
    actionCandidates: Array.isArray(actionCandidates) ? actionCandidates.map(candidate => ({ ...candidate })) : [],
  }
  interactionVisualFrames.set(frameId, frame)
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

function interactionStructuredRowCandidateMismatch(candidate, targetHint) {
  const source = String(targetHint || '')
  const identities = [...new Set(source.match(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g) || [])]
  const actions = [...new Set((source.match(/\b(?:RDP|SSH|VNC|SFTP|FTP|HTTP|HTTPS)\b/gi) || []).map(value => String(value).toUpperCase()))]
  if (identities.length === 0 || actions.length === 0) return ''
  const normalize = value => String(value || '').replace(/\s+/g, '').toLocaleLowerCase()
  const context = normalize(candidate?.rowContext || '')
  const actionText = normalize(candidate?.actionText || [candidate?.ariaLabel, candidate?.title, candidate?.text].filter(Boolean).join(' '))
  const identityOk = identities.every(token => context.includes(normalize(token)))
  const actionOk = actions.some(token => actionText.includes(normalize(token)))
  if (identityOk && actionOk) return ''
  return `candidate business context mismatch: expected row ${identities.join(',')} + action ${actions.join('/')}; candidate row=${JSON.stringify(String(candidate?.rowContext || '').slice(0, 260))}; candidate action=${JSON.stringify(String(candidate?.actionText || '').slice(0, 160))}`
}

async function interactionVisualClick(args) {
  const tabId = await resolveTabId(args.tabId)
  interactionPruneVisualFrames()
  const frameId = typeof args.frameId === 'string' ? args.frameId.trim() : ''
  const requestedCandidateId = typeof args.candidateId === 'string' ? args.candidateId.trim().toUpperCase() : ''
  let xRatio = Number(args.xRatio)
  let yRatio = Number(args.yRatio)
  if (frameId) {
    const targetHint = typeof args.targetHint === 'string' ? args.targetHint.trim() : ''
    if (targetHint.length < 2) throw new Error('live visualClick requires targetHint as a business-intent label for post-click DOM/semantic learning and verification')
    const frame = interactionVisualFrames.get(frameId)
    if (!frame) throw new Error('browser visual frame is unavailable; use a visualFrameId previously returned by patrol_observe(includeImage=true)')
    if (frame.tabId !== tabId) throw new Error('browser visual frame belongs to a different tab; capture a fresh visual observation')
    let selectedCandidate
    if (requestedCandidateId) {
      selectedCandidate = Array.isArray(frame.actionCandidates)
        ? frame.actionCandidates.find(candidate => String(candidate?.candidateId || '').toUpperCase() === requestedCandidateId)
        : undefined
      if (!selectedCandidate) throw new Error(`visual action candidate ${requestedCandidateId} is unavailable on this frame; capture a fresh patrol_observe(includeImage=true, actionMap=true, targetHint=...)`)
      const structuredMismatch = interactionStructuredRowCandidateMismatch(selectedCandidate, targetHint)
      if (structuredMismatch) {
        throw new Error(`visual action candidate ${requestedCandidateId} was REFUSED before physical input because it does not belong to the requested structured-row target. ${structuredMismatch}. Capture a fresh targeted action map with patrol_observe(includeImage=true, actionMap=true, targetHint=${JSON.stringify(targetHint)}).`)
      }
      const captureLeft = Number(frame.captureClientLeft || 0)
      const captureTop = Number(frame.captureClientTop || 0)
      const captureWidth = Number(frame.captureWidth || frame.width || 0)
      const captureHeight = Number(frame.captureHeight || frame.height || 0)
      const selectedX = Number.isFinite(Number(selectedCandidate.safeX))
        ? Number(selectedCandidate.safeX)
        : Number(selectedCandidate.centerX)
      const selectedY = Number.isFinite(Number(selectedCandidate.safeY))
        ? Number(selectedCandidate.safeY)
        : Number(selectedCandidate.centerY)
      xRatio = (selectedX - captureLeft) / captureWidth
      yRatio = (selectedY - captureTop) / captureHeight
    }
    if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)
      || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
      throw new Error('visualClick requires either candidateId from an action-map frame or xRatio/yRatio between 0 and 1')
    }
    const current = await interactionViewportState(tabId)
    if (!interactionSameViewport(frame, current, 2)) {
      throw new Error('browser visual frame is stale: URL/scroll/zoom/viewport changed after screenshot; capture a fresh visual observation')
    }
    const expectedTag = typeof args.expectedTag === 'string' && args.expectedTag.trim()
      ? args.expectedTag.trim().toLowerCase()
      : requestedCandidateId && typeof selectedCandidate?.tag === 'string'
        ? selectedCandidate.tag.trim().toLowerCase()
        : ''
    const expectedRole = typeof args.expectedRole === 'string' && args.expectedRole.trim()
      ? args.expectedRole.trim().toLowerCase()
      : requestedCandidateId && typeof selectedCandidate?.role === 'string'
        ? selectedCandidate.role.trim().toLowerCase()
        : ''
    const expectedTitle = typeof args.expectedTitle === 'string' && args.expectedTitle.trim()
      ? args.expectedTitle.trim()
      : requestedCandidateId && typeof selectedCandidate?.title === 'string'
        ? selectedCandidate.title.trim()
        : ''
    const expectedAriaLabel = typeof args.expectedAriaLabel === 'string' && args.expectedAriaLabel.trim()
      ? args.expectedAriaLabel.trim()
      : requestedCandidateId && typeof selectedCandidate?.ariaLabel === 'string'
        ? selectedCandidate.ariaLabel.trim()
        : ''
    const visualAuthority = args.visualAuthority === true
    const explicitExpectedVisualText = typeof args.expectedVisualText === 'string' ? args.expectedVisualText.trim() : ''
    const candidateExpectedVisualText = requestedCandidateId
      ? [selectedCandidate?.text, selectedCandidate?.ariaLabel, selectedCandidate?.title]
          .map(value => typeof value === 'string' ? value.trim() : '')
          .find(value => value.length >= 2) || ''
      : ''
    const expectedVisualText = explicitExpectedVisualText || candidateExpectedVisualText
    const pointerAction = ['left-click', 'right-click', 'hover', 'mark'].includes(String(args.pointerAction || ''))
      ? String(args.pointerAction)
      : 'left-click'
    if (pointerAction !== 'left-click') {
      const captureLeft = Number(frame.captureClientLeft || 0)
      const captureTop = Number(frame.captureClientTop || 0)
      const captureWidth = Number(frame.captureWidth || frame.width || 0)
      const captureHeight = Number(frame.captureHeight || frame.height || 0)
      const clientX = captureLeft + Math.max(1, Math.min(captureWidth - 1, captureWidth * xRatio))
      const clientY = captureTop + Math.max(1, Math.min(captureHeight - 1, captureHeight * yRatio))
      const descriptor = await interactionDescribeVisualPoint(tabId, clientX, clientY)
      if (pointerAction === 'mark') {
        await interactionShowVisualMarker(tabId, clientX, clientY, xRatio, yRatio)
      } else if (pointerAction === 'hover') {
        await interactionDispatchTrustedMouseAction(tabId, clientX, clientY, 'hover')
        await interactionShowVisualMarker(tabId, clientX, clientY, xRatio, yRatio)
      } else if (pointerAction === 'right-click') {
        await interactionShowVisualMarker(tabId, clientX, clientY, xRatio, yRatio)
        await interactionDispatchTrustedMouseAction(tabId, clientX, clientY, 'right-click')
      }
      return interactionVisualClickResult({
        ...descriptor,
        ok: true,
        clickX: clientX,
        clickY: clientY,
        requestedClickX: clientX,
        requestedClickY: clientY,
        visualSnapped: false,
        snapDistance: 0,
        visualAuthority: true,
        pointerAction,
        ...(requestedCandidateId ? { candidateId: requestedCandidateId } : {}),
        targetStateChanged: false,
        stateEvidence: `visual pointer diagnostic ${pointerAction} executed at the exact screenshot coordinate`,
        inputTransport: 'chrome-debugger',
      }, frame, xRatio, yRatio, 'bound-current-visual-frame')
    }
    const clicked = await interactionPerformVisualClick(
      tabId,
      xRatio,
      yRatio,
      frame,
      expectedTag,
      expectedRole,
      expectedTitle,
      expectedAriaLabel,
      targetHint,
      visualAuthority,
      expectedVisualText,
    )
    if (requestedCandidateId && clicked && typeof clicked === 'object') {
      clicked.candidateId = requestedCandidateId
      clicked.actionCandidateKind = selectedCandidate?.activationKind || ''
      clicked.actionCandidateHref = selectedCandidate?.href || ''
      clicked.actionCandidateSafePoint = selectedCandidate?.safePointKind || ''
      clicked.actionCandidateExpectedText = candidateExpectedVisualText
      clicked.actionCandidateFingerprint = [
        selectedCandidate?.tag ? `tag=${selectedCandidate.tag}` : '',
        selectedCandidate?.role ? `role=${selectedCandidate.role}` : '',
        selectedCandidate?.ariaLabel ? `aria=${selectedCandidate.ariaLabel}` : '',
        selectedCandidate?.title ? `title=${selectedCandidate.title}` : '',
      ].filter(Boolean).join('; ')
    }
    return interactionVisualClickResult(clicked, frame, xRatio, yRatio, requestedCandidateId ? 'bound-action-map-candidate' : 'bound-current-visual-frame')
  }

  if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio)
    || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
    throw new Error('visualClick replay requires xRatio/yRatio between 0 and 1')
  }

  const selectorHint = typeof args.selectorHint === 'string' ? args.selectorHint.trim() : ''
  const learnedLocatorText = typeof args.learnedLocatorText === 'string' ? args.learnedLocatorText.trim() : ''
  const learnedLocatorRole = typeof args.learnedLocatorRole === 'string' ? args.learnedLocatorRole.trim() : ''
  const learnedLocatorTag = typeof args.learnedLocatorTag === 'string' ? args.learnedLocatorTag.trim() : ''
  if (learnedLocatorText && typeof semanticClickCommand === 'function') {
    try {
      const learned = await semanticClickCommand({
        locatorText: learnedLocatorText,
        ...(learnedLocatorRole ? { locatorRole: learnedLocatorRole } : {}),
        ...(learnedLocatorTag ? { locatorTag: learnedLocatorTag } : {}),
        ...(selectorHint ? { selectorHint } : {}),
        task: typeof args.targetHint === 'string' ? args.targetHint : learnedLocatorText,
        tabId,
      })
      if (learned?.ok === true) {
        return {
          ok: true,
          selectorHint: typeof learned.selector === 'string' ? learned.selector : selectorHint,
          xRatio,
          yRatio,
          transport: `visual-learned-semantic-replay+${learned.transport || 'atomic-semantic'}`,
          targetStateChanged: learned.targetStateChanged === true,
          ...(typeof learned.stateEvidence === 'string' ? { stateEvidence: learned.stateEvidence } : {}),
          ...(typeof learned.tag === 'string' ? { targetTag: learned.tag } : {}),
          ...(typeof learned.role === 'string' && learned.role ? { targetRole: learned.role } : {}),
          ...(typeof learned.text === 'string' && learned.text ? { targetText: learned.text } : {}),
        }
      }
    } catch {
      // Learned semantic identity is an optimization. Dynamic pages may drift;
      // selector and guarded coordinate replay remain available below.
    }
  }
  if (selectorHint) {
    try {
      const validated = await interactionValidateVisualReplaySelector(tabId, selectorHint, args)
      if (validated?.ok === true && validated.fingerprintMatched === true) {
        const clicked = await sendDomCommand('click', { selector: selectorHint, tabId })
        return {
          ok: true,
          selectorHint,
          xRatio,
          yRatio,
          transport: 'visual-selector-replay+fingerprint-verified',
          targetStateChanged: clicked?.targetStateChanged === true,
          ...(typeof clicked?.stateEvidence === 'string' ? { stateEvidence: clicked.stateEvidence } : {
            stateEvidence: 'recorded visual selector replayed only after CURRENT target fingerprint verification',
          }),
          ...(typeof validated.tag === 'string' ? { targetTag: validated.tag } : {}),
          ...(typeof validated.role === 'string' && validated.role ? { targetRole: validated.role } : {}),
          ...(typeof validated.text === 'string' && validated.text ? { targetText: validated.text } : {}),
          ...(typeof validated.title === 'string' && validated.title ? { targetTitle: validated.title } : {}),
          ...(typeof validated.ariaLabel === 'string' && validated.ariaLabel ? { targetAriaLabel: validated.ariaLabel } : {}),
          ...(typeof validated.id === 'string' && validated.id ? { targetId: validated.id } : {}),
          ...(typeof validated.className === 'string' && validated.className ? { targetClassName: validated.className } : {}),
        }
      }
    } catch {
      // Selector drift is expected on dynamic pages. Do not physically click an
      // unverified match; continue into semantic/CDP/geometry replay below.
    }
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
  const recordedCaptureMode = typeof args.captureMode === 'string' && args.captureMode.trim()
    ? args.captureMode.trim()
    : 'legacy-viewport'
  const replayCapture = interactionCurrentReplayCaptureGeometry(current, recordedCaptureMode, args)
  if (!replayCapture) throw new Error('visualClick replay could not derive CURRENT capture geometry')
  const recordedCaptureWidth = Number(args.captureWidth)
  const recordedCaptureHeight = Number(args.captureHeight)
  if (Number.isFinite(recordedCaptureWidth) && recordedCaptureWidth > 0) {
    const ratio = replayCapture.captureWidth / recordedCaptureWidth
    if (ratio < 0.80 || ratio > 1.20) throw new Error('visualClick replay CURRENT capture width differs too much from teaching')
  }
  if (Number.isFinite(recordedCaptureHeight) && recordedCaptureHeight > 0) {
    const ratio = replayCapture.captureHeight / recordedCaptureHeight
    if (ratio < 0.80 || ratio > 1.20) throw new Error('visualClick replay CURRENT capture height differs too much from teaching')
  }
  // xRatio/yRatio are normalized against the final corrected teaching point.
  // Always project them through CURRENT capture geometry; replaying the old
  // absolute capture rectangle would re-introduce offset after a small resize.
  current = { ...current, ...replayCapture }

  const expectedTag = typeof args.expectedTag === 'string' ? args.expectedTag.trim().toLowerCase() : ''
  const expectedRole = typeof args.expectedRole === 'string' ? args.expectedRole.trim().toLowerCase() : ''
  const expectedTitle = typeof args.expectedTitle === 'string' ? args.expectedTitle.trim() : ''
  const expectedAriaLabel = typeof args.expectedAriaLabel === 'string' ? args.expectedAriaLabel.trim() : ''
  const clicked = await interactionPerformVisualClick(tabId, xRatio, yRatio, current, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, typeof args.targetHint === 'string' ? args.targetHint.trim() : '')
  return interactionVisualClickResult(clicked, current, xRatio, yRatio, 'visual-coordinate-replay')
}

async function interactionValidateVisualReplaySelector(tabId, rawSelector, args) {
  if (!chrome.scripting?.executeScript) return undefined
  const parsed = parseFrameSelector(rawSelector)
  // Persisted visual selectors are deliberately limited to document-addressable
  // targets. Shadow/CDP-only targets replay through semantic/geometry recovery.
  if (parsed.topFrame !== true) return undefined
  const results = await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    world: 'MAIN',
    func: interactionMainWorldValidateVisualReplaySelector,
    args: [parsed.selector, {
      expectedTag: typeof args.expectedTag === 'string' ? args.expectedTag : '',
      expectedRole: typeof args.expectedRole === 'string' ? args.expectedRole : '',
      expectedTitle: typeof args.expectedTitle === 'string' ? args.expectedTitle : '',
      expectedAriaLabel: typeof args.expectedAriaLabel === 'string' ? args.expectedAriaLabel : '',
      targetTextHint: typeof args.targetTextHint === 'string' ? args.targetTextHint : '',
      targetIdHint: typeof args.targetIdHint === 'string' ? args.targetIdHint : '',
      targetClassHint: typeof args.targetClassHint === 'string' ? args.targetClassHint : '',
    }],
  })
  const value = Array.isArray(results) ? results[0]?.result : undefined
  return value && typeof value === 'object' ? value : undefined
}

function interactionMainWorldValidateVisualReplaySelector(selector, fingerprint = {}) {
  const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
  const normalize = value => compact(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
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
  let matches
  try { matches = [...document.querySelectorAll(selector)] } catch { return { ok: false, fingerprintMatched: false, reason: 'invalid-selector' } }
  const visible = matches.filter(element => {
    const style = getComputedStyle(element)
    const rect = element.getBoundingClientRect()
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0 && rect.width > 0 && rect.height > 0
  })
  if (visible.length !== 1) return { ok: false, fingerprintMatched: false, reason: `selector-visible-count-${visible.length}` }
  const element = visible[0]
  const tag = element.tagName.toLowerCase()
  const role = roleOf(element)
  const title = compact(element.getAttribute('title') || '')
  const ariaLabel = compact(element.getAttribute('aria-label') || '')
  const id = compact(element.id || '')
  const className = compact([...(element.classList || [])].join(' '))
  const text = compact(element.innerText || element.textContent || ariaLabel || title || '').slice(0, 240)

  if (fingerprint.expectedTag && tag !== String(fingerprint.expectedTag).toLowerCase()) return { ok: false, fingerprintMatched: false, reason: 'tag-mismatch' }
  if (fingerprint.expectedRole && role !== String(fingerprint.expectedRole).toLowerCase()) return { ok: false, fingerprintMatched: false, reason: 'role-mismatch' }
  if (fingerprint.expectedTitle && title !== String(fingerprint.expectedTitle)) return { ok: false, fingerprintMatched: false, reason: 'title-mismatch' }
  if (fingerprint.expectedAriaLabel && ariaLabel !== String(fingerprint.expectedAriaLabel)) return { ok: false, fingerprintMatched: false, reason: 'aria-label-mismatch' }
  if (fingerprint.targetIdHint && id !== String(fingerprint.targetIdHint)) return { ok: false, fingerprintMatched: false, reason: 'id-mismatch' }

  const classHints = compact(fingerprint.targetClassHint).split(/\s+/)
    .filter(Boolean)
    .filter(token => !/^(?:active|selected|current|checked|focus|focused|hover|on|off)$/i.test(token))
  if (classHints.length > 0 && !classHints.some(token => element.classList?.contains(token))) {
    return { ok: false, fingerprintMatched: false, reason: 'class-mismatch' }
  }
  const textHint = normalize(fingerprint.targetTextHint)
  if (textHint && !/^\d+$/.test(textHint)) {
    const actual = normalize(text)
    if (!actual || (!actual.includes(textHint) && !textHint.includes(actual))) {
      return { ok: false, fingerprintMatched: false, reason: 'text-mismatch' }
    }
  }

  const strongEvidence = Boolean(
    fingerprint.expectedRole || fingerprint.expectedTitle || fingerprint.expectedAriaLabel
    || fingerprint.targetIdHint || classHints.length > 0 || (textHint && !/^\d+$/.test(textHint)),
  )
  if (!strongEvidence) return { ok: false, fingerprintMatched: false, reason: 'insufficient-fingerprint' }
  return { ok: true, fingerprintMatched: true, tag, role, title, ariaLabel, id, className, text }
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


function interactionWantsEditableTarget(targetHint) {
  return /评论.*(?:输入|编辑)|回复.*(?:输入|编辑)|输入框|编辑框|comment.*(?:input|editor)|reply.*(?:input|editor)/i.test(String(targetHint || ''))
}

function interactionCdpNodeAttributes(node) {
  const attrs = Array.isArray(node?.attributes) ? node.attributes : []
  const out = {}
  for (let index = 0; index + 1 < attrs.length; index += 2) {
    out[String(attrs[index] || '').toLowerCase()] = String(attrs[index + 1] || '')
  }
  return out
}

function interactionCdpNodeContext(node, attrs, ancestorContext) {
  return [
    ancestorContext,
    String(node?.nodeName || '').toLowerCase(),
    attrs.id,
    attrs.class,
    attrs.name,
    attrs.placeholder,
    attrs['data-placeholder'],
    attrs['aria-label'],
    attrs.title,
    attrs.role,
  ].filter(Boolean).join(' ')
}

function interactionCdpEditableNode(node, attrs) {
  const name = String(node?.nodeName || '').toLowerCase()
  if (name === 'textarea') return true
  if (name === 'input') return String(attrs.type || '').toLowerCase() !== 'hidden'
  if (String(attrs.role || '').toLowerCase() === 'textbox') return true
  if (Object.prototype.hasOwnProperty.call(attrs, 'contenteditable')) {
    const value = String(attrs.contenteditable || '').toLowerCase()
    return value === '' || value === 'true' || value === 'plaintext-only'
  }
  return false
}

function interactionCdpEditorActivatorNode(node, attrs) {
  const name = String(node?.nodeName || '').toLowerCase()
  if (name === 'bili-comments') return false
  if (name === 'bili-comment-editor') return true
  const evidence = [
    name, attrs.id, attrs.class, attrs.name, attrs.role,
    attrs.placeholder, attrs['data-placeholder'], attrs['aria-label'], attrs.title,
  ].filter(Boolean).join(' ').toLowerCase()
  return /(?:comment|reply)[-_ ]?(?:editor|input)|(?:editor|input)[-_ ]?(?:wrap|box|area)/i.test(evidence)
}

function interactionCdpEditableHintScore(targetHint, context) {
  const hint = String(targetHint || '').toLowerCase()
  const evidence = String(context || '').toLowerCase()
  let score = 100
  if (/评论|回复|comment|reply/i.test(hint)) {
    if (/评论|回复|comment|reply|editor|textarea|textbox|placeholder/.test(evidence)) score += 420
    else score -= 80
  }
  const normalizedHint = hint.replace(/current|截图|其中|中的|页面|视频|封面|按钮|图标|控件|链接|点击|打开|进入|输入框|编辑框/g, '').replace(/[^\p{L}\p{N}]+/gu, '')
  const normalizedEvidence = evidence.replace(/[^\p{L}\p{N}]+/gu, '')
  if (normalizedHint.length >= 3 && normalizedEvidence.includes(normalizedHint)) score += 180
  return score
}


function interactionWantsPublishTarget(targetHint) {
  return /发布|发表|发送|提交|\bpost\b|\bsend\b|\bsubmit\b/i.test(String(targetHint || ''))
}

function interactionCdpNodeText(node, maxChars = 420) {
  const out = []
  const stack = [node]
  let scanned = 0
  while (stack.length && scanned < 80 && out.join(' ').length < maxChars) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    scanned += 1
    if (current.nodeType === 3 && typeof current.nodeValue === 'string') out.push(current.nodeValue)
    if (typeof current.nodeValue === 'string' && current.nodeValue.trim()) out.push(current.nodeValue)
    const attrs = interactionCdpNodeAttributes(current)
    out.push(
      String(current.nodeName || '').toLowerCase(),
      attrs.id || '', attrs.class || '', attrs.role || '',
      attrs['aria-label'] || '', attrs.title || '', attrs.value || '',
      attrs.placeholder || '', attrs['data-placeholder'] || '',
    )
    const children = [
      ...(Array.isArray(current.children) ? current.children : []),
      ...(Array.isArray(current.shadowRoots) ? current.shadowRoots : []),
    ]
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index])
  }
  return out.filter(Boolean).join(' ').replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function interactionCdpActionNode(node, attrs) {
  const name = String(node?.nodeName || '').toLowerCase()
  const role = String(attrs.role || '').toLowerCase()
  const type = String(attrs.type || '').toLowerCase()
  if (name === 'button') return true
  if (name === 'input' && ['button', 'submit'].includes(type)) return true
  if (role === 'button') return true
  const evidence = [
    name, attrs.id, attrs.class, attrs.name, attrs['aria-label'], attrs.title,
  ].filter(Boolean).join(' ').toLowerCase()
  if (name === 'a' && !/(?:btn|button|send|submit|publish|post|comment-action)/i.test(evidence)) return false
  return /(?:btn|button|send|submit|publish|post|comment-action)/i.test(evidence)
}

function interactionCdpVisibleText(node, maxChars = 160) {
  const out = []
  const stack = [node]
  let scanned = 0
  while (stack.length && scanned < 80 && out.join(' ').length < maxChars) {
    const current = stack.pop()
    if (!current || typeof current !== 'object') continue
    scanned += 1
    if (current.nodeType === 3 && typeof current.nodeValue === 'string' && current.nodeValue.trim()) out.push(current.nodeValue)
    const children = [
      ...(Array.isArray(current.children) ? current.children : []),
      ...(Array.isArray(current.shadowRoots) ? current.shadowRoots : []),
    ]
    for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index])
  }
  return out.join(' ').replace(/\s+/g, ' ').trim().slice(0, maxChars)
}

function interactionAxValue(node, key) {
  const value = node?.[key]?.value
  return typeof value === 'string' ? value : ''
}

function interactionPublishLabelScore(value) {
  const text = String(value || '').replace(/\s+/g, '').toLowerCase()
  if (!text) return 0
  if (/^(发布|发表|发送|提交|post|send|submit)$/.test(text)) return 700
  if (/发布|发表|发送|提交/.test(text)) return 360
  if (/\bpost\b|\bsend\b|\bsubmit\b/i.test(String(value || ''))) return 320
  return 0
}

async function interactionResolvePiercedActionPoint(tabId, targetHint, originalX, originalY) {
  if (!interactionWantsPublishTarget(targetHint)) return undefined
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) return undefined
  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    const [documentResult, layoutMetrics, axTree] = await Promise.all([
      chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1, pierce: true }),
      chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics').catch(() => undefined),
      chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree').catch(() => undefined),
    ])
    const root = documentResult?.root
    if (!root || typeof root !== 'object') return undefined
    const viewport = layoutMetrics?.cssVisualViewport || layoutMetrics?.visualViewport
    const viewportWidth = Number(viewport?.clientWidth)
    const viewportHeight = Number(viewport?.clientHeight)
    const byBackend = new Map()
    const addCandidate = candidate => {
      if (!Number.isInteger(candidate?.backendNodeId)) return
      const previous = byBackend.get(candidate.backendNodeId)
      if (!previous || Number(candidate.score || 0) > Number(previous.score || 0)) byBackend.set(candidate.backendNodeId, candidate)
    }

    for (const axNode of Array.isArray(axTree?.nodes) ? axTree.nodes : []) {
      const backendNodeId = Number(axNode?.backendDOMNodeId)
      if (!Number.isInteger(backendNodeId)) continue
      const name = interactionAxValue(axNode, 'name')
      const role = interactionAxValue(axNode, 'role').toLowerCase()
      const labelScore = interactionPublishLabelScore(name)
      if (labelScore <= 0) continue
      addCandidate({
        backendNodeId,
        tag: '',
        role,
        evidence: name,
        score: 900 + labelScore + (role === 'button' ? 180 : 0),
        source: 'accessibility',
      })
    }

    const stack = [root]
    let scanned = 0
    while (stack.length && scanned < 24000 && byBackend.size < 160) {
      const node = stack.pop()
      if (!node || typeof node !== 'object') continue
      scanned += 1
      const attrs = interactionCdpNodeAttributes(node)
      const tag = String(node.nodeName || '').toLowerCase()
      const visibleText = interactionCdpVisibleText(node)
      const evidence = interactionCdpNodeText(node)
      const labelScore = Math.max(
        interactionPublishLabelScore(visibleText),
        interactionPublishLabelScore(attrs['aria-label']),
        interactionPublishLabelScore(attrs.title),
        interactionPublishLabelScore(attrs.value),
      )
      const actionish = interactionCdpActionNode(node, attrs)
      if (Number.isInteger(node.backendNodeId) && labelScore > 0) {
        // Ordinary recommendation anchors must never become publish controls
        // merely because a descendant happens to mention “发布/发送”.
        const ordinaryLink = tag === 'a' && !actionish
        if (!ordinaryLink) {
          addCandidate({
            backendNodeId: node.backendNodeId,
            tag,
            role: String(attrs.role || '').toLowerCase(),
            evidence: visibleText || evidence,
            score: labelScore + (actionish ? 420 : 120)
              + (/^(?:button|input)$/i.test(tag) ? 180 : 0)
              + (String(attrs.role || '').toLowerCase() === 'button' ? 140 : 0),
            source: actionish ? 'dom-action' : 'dom-exact-label',
          })
        }
      }
      const children = [
        ...(Array.isArray(node.children) ? node.children : []),
        ...(Array.isArray(node.shadowRoots) ? node.shadowRoots : []),
        ...(node.contentDocument && typeof node.contentDocument === 'object' ? [node.contentDocument] : []),
      ]
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push(children[index])
    }
    if (!byBackend.size) return undefined

    const measured = []
    for (const candidate of byBackend.values()) {
      try {
        const resolved = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId: candidate.backendNodeId })
        const objectId = resolved?.object?.objectId
        if (!objectId) continue
        const rectResult = await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(){
            if (!(this instanceof Element)) return null;
            const r=this.getBoundingClientRect();
            const s=getComputedStyle(this);
            return {left:r.left,top:r.top,width:r.width,height:r.height,cursor:s.cursor,display:s.display,visibility:s.visibility,opacity:s.opacity,disabled:this.matches?.(':disabled,[aria-disabled="true"]')===true,text:(this.innerText||this.textContent||'').trim(),tag:this.tagName?.toLowerCase?.()||'',role:this.getAttribute?.('role')||''};
          }`,
          returnByValue: true,
        })
        const info = rectResult?.result?.value
        if (!info || info.disabled === true || info.display === 'none' || info.visibility === 'hidden' || Number(info.opacity) === 0) continue
        const left = Number(info.left), top = Number(info.top), width = Number(info.width), height = Number(info.height)
        if (![left, top, width, height].every(Number.isFinite) || width < 24 || height < 16) continue
        if (Number.isFinite(viewportWidth) && (left >= viewportWidth || left + width <= 0 || width > viewportWidth * 0.55)) continue
        if (Number.isFinite(viewportHeight) && (top >= viewportHeight || top + height <= 0 || height > viewportHeight * 0.28)) continue
        const exactRuntimeLabel = interactionPublishLabelScore(info.text) >= 700
        const runtimeActionable = info.cursor === 'pointer' || info.tag === 'button' || info.role === 'button'
        if (candidate.source === 'dom-exact-label' && !exactRuntimeLabel) continue
        if (candidate.source === 'dom-exact-label' && !runtimeActionable) continue
        const x = left + width / 2
        const y = top + height / 2
        const distance = Number.isFinite(Number(originalX)) && Number.isFinite(Number(originalY))
          ? Math.hypot(x - Number(originalX), y - Number(originalY))
          : 0
        measured.push({ ...candidate, tag: candidate.tag || info.tag, role: candidate.role || info.role, x, y, width, height, distance })
      } catch {}
    }
    if (!measured.length) return undefined
    measured.sort((left, right) => right.score - left.score || left.distance - right.distance)
    const best = measured[0]
    const runnerUp = measured[1]
    if (runnerUp && runnerUp.score === best.score && Math.abs(runnerUp.distance - best.distance) < 10) return undefined
    return {
      x: best.x,
      y: best.y,
      tag: best.tag,
      role: best.role || 'button',
      backendNodeId: best.backendNodeId,
      evidence: best.evidence,
      distance: best.distance,
      source: best.source === 'accessibility' ? 'cdp-ax-publish-action' : 'cdp-pierced-publish-action',
    }
  } catch {
    return undefined
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
}

async function interactionResolvePiercedSemanticPoint(tabId, locatorText, locatorRole = '', originalX, originalY) {
  const wanted = String(locatorText || '').replace(/\s+/g, '').toLocaleLowerCase()
  if (wanted.length < 2 || !chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) return undefined
  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    const [axTree, layoutMetrics] = await Promise.all([
      chrome.debugger.sendCommand(target, 'Accessibility.getFullAXTree'),
      chrome.debugger.sendCommand(target, 'Page.getLayoutMetrics').catch(() => undefined),
    ])
    const viewport = layoutMetrics?.cssVisualViewport || layoutMetrics?.visualViewport
    const viewportWidth = Number(viewport?.clientWidth)
    const viewportHeight = Number(viewport?.clientHeight)
    const wantedRole = String(locatorRole || '').trim().toLowerCase()
    const candidates = []
    for (const node of Array.isArray(axTree?.nodes) ? axTree.nodes : []) {
      const backendNodeId = Number(node?.backendDOMNodeId)
      if (!Number.isInteger(backendNodeId) || node?.ignored === true) continue
      const name = interactionAxValue(node, 'name')
      const normalizedName = name.replace(/\s+/g, '').toLocaleLowerCase()
      if (!normalizedName) continue
      const exact = normalizedName === wanted
      const contains = wanted.length >= 4 && (normalizedName.includes(wanted) || wanted.includes(normalizedName))
      if (!exact && !contains) continue
      const role = interactionAxValue(node, 'role').toLowerCase()
      if (wantedRole && role !== wantedRole) continue
      candidates.push({ backendNodeId, name, role, score: exact ? 1000 : 620 })
    }
    if (!candidates.length) return undefined
    const measured = []
    for (const candidate of candidates) {
      try {
        const resolved = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId: candidate.backendNodeId })
        const objectId = resolved?.object?.objectId
        if (!objectId) continue
        const result = await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: `function(){if(!(this instanceof Element))return null;const r=this.getBoundingClientRect();const s=getComputedStyle(this);return {left:r.left,top:r.top,width:r.width,height:r.height,display:s.display,visibility:s.visibility,opacity:s.opacity,disabled:this.matches?.(':disabled,[aria-disabled="true"]')===true,tag:this.tagName?.toLowerCase?.()||'',role:this.getAttribute?.('role')||''};}`,
          returnByValue: true,
        })
        const info = result?.result?.value
        if (!info || info.disabled === true || info.display === 'none' || info.visibility === 'hidden' || Number(info.opacity) === 0) continue
        const left=Number(info.left), top=Number(info.top), width=Number(info.width), height=Number(info.height)
        if (![left,top,width,height].every(Number.isFinite) || width <= 2 || height <= 2) continue
        if (Number.isFinite(viewportWidth) && (left >= viewportWidth || left + width <= 0)) continue
        if (Number.isFinite(viewportHeight) && (top >= viewportHeight || top + height <= 0)) continue
        const x=left+width/2, y=top+height/2
        const distance = Number.isFinite(Number(originalX)) && Number.isFinite(Number(originalY))
          ? Math.hypot(x-Number(originalX), y-Number(originalY)) : 0
        measured.push({ ...candidate, tag: info.tag, role: candidate.role || info.role, x, y, distance })
      } catch {}
    }
    if (!measured.length) return undefined
    measured.sort((left,right)=>right.score-left.score || left.distance-right.distance)
    const best=measured[0], runnerUp=measured[1]
    if (runnerUp && runnerUp.score===best.score && Math.abs(runnerUp.distance-best.distance)<8) return undefined
    return { ...best, source: 'cdp-accessibility-semantic' }
  } catch {
    return undefined
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
}

async function interactionResolvePiercedEditablePoint(tabId, targetHint, originalX, originalY) {
  if (!interactionWantsEditableTarget(targetHint)) return undefined
  if (!chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) return undefined

  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    const documentResult = await chrome.debugger.sendCommand(target, 'DOM.getDocument', { depth: -1, pierce: true })
    const root = documentResult?.root
    if (!root || typeof root !== 'object') return undefined

    const candidates = []
    const stack = [{ node: root, context: '' }]
    let scanned = 0
    while (stack.length && scanned < 20000 && candidates.length < 80) {
      const current = stack.pop()
      const node = current?.node
      if (!node || typeof node !== 'object') continue
      scanned += 1
      const attrs = interactionCdpNodeAttributes(node)
      const context = interactionCdpNodeContext(node, attrs, current.context)
      const editable = interactionCdpEditableNode(node, attrs)
      const activator = !editable && interactionCdpEditorActivatorNode(node, attrs)
      if ((editable || activator) && Number.isInteger(node.backendNodeId)) {
        candidates.push({
          backendNodeId: node.backendNodeId,
          tag: String(node.nodeName || '').toLowerCase(),
          role: editable ? (String(attrs.role || '').toLowerCase() || 'textbox') : '',
          context,
          kind: editable ? 'editable' : 'activator',
          score: interactionCdpEditableHintScore(targetHint, context) + (editable ? 500 : 260),
        })
      }
      const nextContext = context.slice(-1200)
      const children = [
        ...(Array.isArray(node.children) ? node.children : []),
        ...(Array.isArray(node.shadowRoots) ? node.shadowRoots : []),
        ...(node.contentDocument && typeof node.contentDocument === 'object' ? [node.contentDocument] : []),
      ]
      for (let index = children.length - 1; index >= 0; index -= 1) stack.push({ node: children[index], context: nextContext })
    }
    if (!candidates.length) return undefined

    const measured = []
    const hasOrigin = Number.isFinite(Number(originalX)) && Number.isFinite(Number(originalY))
    for (const candidate of candidates) {
      try {
        const resolved = await chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId: candidate.backendNodeId })
        const objectId = resolved?.object?.objectId
        if (!objectId) continue
        const rectResult = await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
          objectId,
          functionDeclaration: 'function(){const r=this.getBoundingClientRect();return {left:r.left,top:r.top,right:r.right,bottom:r.bottom,width:r.width,height:r.height};}',
          returnByValue: true,
        })
        const rect = rectResult?.result?.value
        if (!rect || !Number.isFinite(Number(rect.left)) || !Number.isFinite(Number(rect.top))
          || !Number.isFinite(Number(rect.width)) || !Number.isFinite(Number(rect.height))
          || Number(rect.width) <= 2 || Number(rect.height) <= 2) continue
        const left = Number(rect.left)
        const top = Number(rect.top)
        const width = Number(rect.width)
        const height = Number(rect.height)
        const centerX = left + width / 2
        const centerY = top + height / 2
        if (centerX < -2 || centerY < -2) continue
        if (candidate.kind === 'activator' && (width < 60 || height < 18 || height > 220)) continue
        measured.push({
          ...candidate,
          rect: { left, top, width, height, right: left + width, bottom: top + height },
          x: centerX,
          y: centerY,
          distance: hasOrigin ? Math.hypot(centerX - Number(originalX), centerY - Number(originalY)) : 0,
        })
      } catch {}
    }
    if (!measured.length) return undefined
    measured.sort((left, right) => right.score - left.score
      || (right.kind === 'editable' ? 1 : 0) - (left.kind === 'editable' ? 1 : 0)
      || left.distance - right.distance)
    const best = measured[0]
    const runnerUp = measured[1]
    if (runnerUp && runnerUp.score === best.score && (!hasOrigin || Math.abs(runnerUp.distance - best.distance) < 8)) return undefined
    return {
      x: best.x,
      y: best.y,
      tag: best.tag,
      role: best.role,
      backendNodeId: best.backendNodeId,
      distance: best.distance,
      rect: best.rect,
      kind: best.kind,
      source: best.kind === 'editable' ? 'cdp-pierced-shadow-editor' : 'cdp-pierced-editor-activator',
    }
  } catch {
    return undefined
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
}

async function interactionVerifyPiercedTargetHit(tabId, backendNodeId, clientX, clientY) {
  if (!Number.isInteger(Number(backendNodeId))
    || !chrome.debugger?.attach || !chrome.debugger?.sendCommand || !chrome.debugger?.detach) return false
  const target = { tabId }
  let attached = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    const hit = await chrome.debugger.sendCommand(target, 'DOM.getNodeForLocation', {
      x: Math.round(Number(clientX)),
      y: Math.round(Number(clientY)),
      includeUserAgentShadowDOM: true,
    })
    const hitBackendNodeId = Number(hit?.backendNodeId)
    if (!Number.isInteger(hitBackendNodeId)) return false
    if (hitBackendNodeId === Number(backendNodeId)) return true

    // A click on a legitimate descendant of the resolved control is safe too.
    // Compare object identity/containment through CDP so closed Shadow DOM does
    // not get flattened back to a visible host by MAIN-world probing.
    const [resolvedTarget, resolvedHit] = await Promise.all([
      chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId: Number(backendNodeId) }),
      chrome.debugger.sendCommand(target, 'DOM.resolveNode', { backendNodeId: hitBackendNodeId }),
    ])
    const targetObjectId = resolvedTarget?.object?.objectId
    const hitObjectId = resolvedHit?.object?.objectId
    if (!targetObjectId || !hitObjectId) return false
    const contains = await chrome.debugger.sendCommand(target, 'Runtime.callFunctionOn', {
      objectId: targetObjectId,
      functionDeclaration: 'function(hit){ return Boolean(hit) && (this === hit || this.contains?.(hit) === true); }',
      arguments: [{ objectId: hitObjectId }],
      returnByValue: true,
    })
    return contains?.result?.value === true
  } catch {
    return false
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
}

function interactionPiercedDescriptor(resolved, requestedX, requestedY, clickX, clickY) {
  return {
    ok: true,
    selector: '',
    replaySelectorSafe: false,
    tag: typeof resolved?.tag === 'string' ? resolved.tag : '',
    role: typeof resolved?.role === 'string' ? resolved.role : '',
    text: typeof resolved?.evidence === 'string' ? resolved.evidence.slice(0, 240) : '',
    title: '',
    ariaLabel: '',
    id: '',
    className: '',
    targetStateChanged: false,
    targetFocusedEditable: false,
    stateSignature: '',
    stateEvidence: '',
    focusedEditorText: '',
    requestedClickX: requestedX,
    requestedClickY: requestedY,
    clickX,
    clickY,
    visualSnapped: Math.hypot(clickX - requestedX, clickY - requestedY) > 0.5,
    snapDistance: Math.hypot(clickX - requestedX, clickY - requestedY),
  }
}

function interactionPiercedEditableIsLocalToVisualPoint(resolved, x, y) {
  const rect = resolved?.rect
  if (!rect || ![rect.left, rect.top, rect.width, rect.height].every(value => Number.isFinite(Number(value)))) return false
  const left = Number(rect.left), top = Number(rect.top)
  const right = left + Number(rect.width), bottom = top + Number(rect.height)
  const margin = 32
  if (Number(x) >= left - margin && Number(x) <= right + margin && Number(y) >= top - margin && Number(y) <= bottom + margin) return true
  const distance = Number(resolved?.distance)
  return Number.isFinite(distance) && distance <= 180
}

function interactionSameProbeTarget(before, after) {
  if (!before || !after || typeof before !== 'object' || typeof after !== 'object') return false
  if (before.selector && after.selector && before.selector === after.selector) return true
  if (before.id && after.id && before.id === after.id && before.tag === after.tag) return true
  if (before.ariaLabel && after.ariaLabel && before.ariaLabel === after.ariaLabel && before.tag === after.tag) return true
  if (before.title && after.title && before.title === after.title && before.tag === after.tag) return true
  return false
}

async function interactionPerformVisualClick(tabId, xRatio, yRatio, viewport, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, targetHint = '', visualAuthority = false, expectedVisualText = '') {
  if (!chrome.scripting?.executeScript) throw new Error('visualClick requires chrome.scripting')
  const captureLeft = Number.isFinite(Number(viewport.captureClientLeft)) ? Number(viewport.captureClientLeft) : Number(viewport.offsetLeft || 0)
  const captureTop = Number.isFinite(Number(viewport.captureClientTop)) ? Number(viewport.captureClientTop) : Number(viewport.offsetTop || 0)
  const captureWidth = Number.isFinite(Number(viewport.captureWidth)) ? Number(viewport.captureWidth) : Number(viewport.width || 0)
  const captureHeight = Number.isFinite(Number(viewport.captureHeight)) ? Number(viewport.captureHeight) : Number(viewport.height || 0)
  if (captureWidth <= 0 || captureHeight <= 0) throw new Error('visualClick screenshot capture geometry is invalid')
  const clientX = captureLeft + Math.max(1, Math.min(captureWidth - 1, captureWidth * xRatio))
  const clientY = captureTop + Math.max(1, Math.min(captureHeight - 1, captureHeight * yRatio))

  const piercedEditable = visualAuthority ? undefined : await interactionResolvePiercedEditablePoint(tabId, targetHint, clientX, clientY)
  const piercedAction = visualAuthority || piercedEditable ? undefined : await interactionResolvePiercedActionPoint(tabId, targetHint, clientX, clientY)
  const preResolved = piercedEditable || piercedAction
  const probeClientX = Number.isFinite(Number(preResolved?.x)) ? Number(preResolved.x) : clientX
  const probeClientY = Number.isFinite(Number(preResolved?.y)) ? Number(preResolved.y) : clientY

  if (preResolved) {
    if (expectedTag && preResolved.tag && String(preResolved.tag).toLowerCase() !== expectedTag) {
      throw new Error('CDP-resolved visual target has a different tag than teaching')
    }
    if (expectedRole && preResolved.role && String(preResolved.role).toLowerCase() !== expectedRole) {
      throw new Error('CDP-resolved visual target has a different role than teaching')
    }
    const label = String(preResolved.evidence || '').trim()
    if (expectedTitle && label && label !== expectedTitle) throw new Error('CDP-resolved visual target has a different title/accessible label than teaching')
    if (expectedAriaLabel && label && label !== expectedAriaLabel) throw new Error('CDP-resolved visual target has a different aria-label/accessible label than teaching')
    if (!await interactionVerifyPiercedTargetHit(tabId, preResolved.backendNodeId, probeClientX, probeClientY)) {
      throw new Error('CDP-resolved visual target is not the final topmost hit at its calibrated click point; refusing physical input')
    }
  }

  let nativeError = ''
  let nativeMouseDispatched = false
  let probe
  let beforeFocusedEditor
  if (interactionWantsPublishTarget(targetHint)) {
    try { beforeFocusedEditor = await interactionFocusedEditorProbe(tabId, false) } catch {}
  }

  if (chrome.debugger?.attach && chrome.debugger?.sendCommand && chrome.debugger?.detach) {
    try {
      try {
        const probeResults = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [0] },
          world: 'MAIN',
          func: interactionMainWorldVisualClick,
          args: [probeClientX, probeClientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, true, targetHint, visualAuthority, expectedVisualText],
        })
        probe = Array.isArray(probeResults) ? probeResults[0]?.result : undefined
        if (probe?.ok === false) throw new Error(probe.error || 'visual target probe failed')
      } catch (error) {
        if (!preResolved) throw error
        // Closed Shadow DOM/CDP targets are already verified by backend identity.
        // MAIN may see only the host; that must never replace the pierced target.
        probe = undefined
      }

      const hasExpectedFingerprint = Boolean(expectedTag || expectedRole || expectedTitle || expectedAriaLabel)
      const hasTargetHint = Boolean(String(targetHint || '').trim())
      const wantsPublish = interactionWantsPublishTarget(targetHint)
      if (!visualAuthority && wantsPublish && !piercedAction && probe?.publishActionVerified !== true) {
        throw new Error('publish/send coordinate replay requires an exact CURRENT publish action resolved from DOM/Accessibility')
      }
      const canDispatch = visualAuthority || Boolean(preResolved)
        || ((!hasExpectedFingerprint && !hasTargetHint) || (probe && typeof probe === 'object' && probe.ok !== false))
      if (canDispatch) {
        // CDP identity owns the final coordinate when available. MAIN-world
        // correction is used only when no pierced target was resolved.
        let trustedX = visualAuthority
          ? clientX
          : preResolved
            ? probeClientX
            : Number.isFinite(Number(probe?.clickX)) ? Number(probe.clickX) : probeClientX
        let trustedY = visualAuthority
          ? clientY
          : preResolved
            ? probeClientY
            : Number.isFinite(Number(probe?.clickY)) ? Number(probe.clickY) : probeClientY
        const clickedTarget = preResolved
          ? interactionPiercedDescriptor(preResolved, clientX, clientY, trustedX, trustedY)
          : probe

        await interactionDispatchTrustedMouseClick(tabId, trustedX, trustedY)
        nativeMouseDispatched = true
        await new Promise(resolve => setTimeout(resolve, piercedEditable?.kind === 'activator' ? 180 : 260))

        let activatedEditor
        let postVisualEditorFocus = false
        if (visualAuthority && interactionWantsEditableTarget(targetHint)) {
          let currentFocus
          try { currentFocus = await interactionFocusedEditorProbe(tabId, false) } catch {}
          if (currentFocus?.focusUsable !== true) {
            try {
              const mountedEditor = await interactionResolvePiercedEditablePoint(tabId, targetHint, clientX, clientY)
              if (mountedEditor?.kind === 'editable'
                && interactionPiercedEditableIsLocalToVisualPoint(mountedEditor, clientX, clientY)
                && Number.isFinite(Number(mountedEditor.x))
                && Number.isFinite(Number(mountedEditor.y))) {
                const nextX = Number(mountedEditor.x)
                const nextY = Number(mountedEditor.y)
                if (await interactionVerifyPiercedTargetHit(tabId, mountedEditor.backendNodeId, nextX, nextY)) {
                  await interactionDispatchTrustedMouseClick(tabId, nextX, nextY)
                  nativeMouseDispatched = true
                  activatedEditor = mountedEditor
                  postVisualEditorFocus = true
                  await new Promise(resolve => setTimeout(resolve, 180))
                }
              }
            } catch {}
          }
        }
        if (piercedEditable?.kind === 'activator' && interactionWantsEditableTarget(targetHint)) {
          try {
            activatedEditor = await interactionResolvePiercedEditablePoint(tabId, targetHint, trustedX, trustedY)
            if (activatedEditor?.kind === 'editable'
              && Number.isFinite(Number(activatedEditor.x))
              && Number.isFinite(Number(activatedEditor.y))) {
              const nextX = Number(activatedEditor.x)
              const nextY = Number(activatedEditor.y)
              if (!await interactionVerifyPiercedTargetHit(tabId, activatedEditor.backendNodeId, nextX, nextY)) {
                throw new Error('mounted editor is not the topmost hit at its CDP-resolved point')
              }
              trustedX = nextX
              trustedY = nextY
              await interactionDispatchTrustedMouseClick(tabId, trustedX, trustedY)
              nativeMouseDispatched = true
              await new Promise(resolve => setTimeout(resolve, 180))
            }
          } catch (error) {
            return {
              ...(clickedTarget && typeof clickedTarget === 'object' ? clickedTarget : {}),
              ok: true,
              targetStateChanged: false,
              targetFocusedEditable: false,
              requestedClickX: clientX,
              requestedClickY: clientY,
              clickX: trustedX,
              clickY: trustedY,
              visualSnapped: Math.hypot(trustedX - clientX, trustedY - clientY) > 0.5,
              snapDistance: Math.hypot(trustedX - clientX, trustedY - clientY),
              cdpPiercedTarget: Boolean(preResolved),
              cdpPiercedActivator: true,
              cdpPiercedFollowupEditor: false,
              cdpPiercedAction: Boolean(piercedAction),
              physicalClickUncertain: true,
              stateEvidence: `editor activator click was dispatched, but follow-up editor verification failed; refusing a second synthetic click: ${safeError(error)}`,
              inputTransport: 'chrome-debugger',
            }
          }
        }

        let afterProbe
        try {
          const afterResults = await chrome.scripting.executeScript({
            target: { tabId, frameIds: [0] },
            world: 'MAIN',
            func: interactionMainWorldVisualClick,
            args: [trustedX, trustedY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, true, targetHint, visualAuthority, expectedVisualText],
          })
          afterProbe = Array.isArray(afterResults) ? afterResults[0]?.result : undefined
        } catch {}

        const sameProbeTarget = !preResolved && interactionSameProbeTarget(probe, afterProbe)
        let targetStateChanged = Boolean(
          sameProbeTarget
          && typeof probe?.stateSignature === 'string'
          && typeof afterProbe?.stateSignature === 'string'
          && probe.stateSignature !== afterProbe.stateSignature
        )
        let focusedEditor
        if (interactionWantsEditableTarget(targetHint) || interactionWantsPublishTarget(targetHint)) {
          try { focusedEditor = await interactionFocusedEditorProbe(tabId, false) } catch {}
        }
        const beforeEditorText = typeof beforeFocusedEditor?.observedText === 'string'
          ? beforeFocusedEditor.observedText
          : typeof probe?.focusedEditorText === 'string' ? probe.focusedEditorText : ''
        const afterEditorText = typeof focusedEditor?.observedText === 'string' ? focusedEditor.observedText : ''
        const editorClearedAfterPublish = interactionWantsPublishTarget(targetHint)
          && beforeEditorText.trim().length > 0
          && afterEditorText.trim().length === 0
        if (editorClearedAfterPublish) targetStateChanged = true

        let unexpectedNavigation = false
        try {
          const afterViewport = await interactionViewportState(tabId)
          if ((interactionWantsPublishTarget(targetHint) || interactionWantsEditableTarget(targetHint)
              || /点赞|投币|收藏|\blike\b|favorite/i.test(String(targetHint || '')))
            && viewport?.urlIdentity && afterViewport?.urlIdentity
            && viewport.urlIdentity !== afterViewport.urlIdentity) {
            unexpectedNavigation = true
            targetStateChanged = false
          }
        } catch {}

        const targetFocusedEditable = focusedEditor?.focusUsable === true
          || (!preResolved && afterProbe?.targetFocusedEditable === true)
        const snapDistance = Math.hypot(trustedX - clientX, trustedY - clientY)
        return {
          ...(clickedTarget && typeof clickedTarget === 'object' ? clickedTarget : {}),
          ok: true,
          targetStateChanged,
          targetFocusedEditable,
          requestedClickX: clientX,
          requestedClickY: clientY,
          clickX: visualAuthority ? clientX : trustedX,
          clickY: visualAuthority ? clientY : trustedY,
          visualSnapped: visualAuthority ? false : snapDistance > 0.5,
          snapDistance: visualAuthority ? 0 : snapDistance,
          postVisualEditorFocus,
          cdpPiercedTarget: Boolean(preResolved),
          cdpPiercedActivator: piercedEditable?.kind === 'activator',
          cdpPiercedFollowupEditor: activatedEditor?.kind === 'editable',
          cdpPiercedAction: Boolean(piercedAction),
          unexpectedNavigation,
          physicalClickUncertain: false,
          stateEvidence: unexpectedNavigation
            ? 'in-page visual control unexpectedly navigated away; never treat this as business success'
            : editorClearedAfterPublish
              ? 'comment editor cleared after trusted publish/send click'
              : postVisualEditorFocus
                ? 'exact visual click activated the local comment component; a post-click Shadow-DOM focus recovery then focused its mounted editable control'
                : targetStateChanged
                  ? preResolved
                    ? 'trusted native click changed verified business state after CDP target resolution'
                    : 'trusted native click changed the same pre-click visual target own DOM state'
                  : targetFocusedEditable
                    ? activatedEditor?.kind === 'editable'
                      ? 'trusted native click activated the comment editor and then focused its mounted editable control'
                      : piercedEditable
                        ? 'trusted native click focused an editor resolved through pierced Shadow DOM/editor targeting'
                        : 'trusted native click focused an editable control'
                    : '',
          inputTransport: 'chrome-debugger',
        }
      }
    } catch (error) {
      if (nativeMouseDispatched || error?.physicalClickDispatched === true) {
        return {
          ...(probe && typeof probe === 'object' ? probe : {}),
          ok: true,
          targetStateChanged: false,
          targetFocusedEditable: false,
          requestedClickX: clientX,
          requestedClickY: clientY,
          clickX: probeClientX,
          clickY: probeClientY,
          physicalClickUncertain: true,
          stateEvidence: `trusted native physical click outcome became uncertain; refusing synthetic duplicate: ${safeError(error)}`,
          inputTransport: 'chrome-debugger',
        }
      }
      nativeError = `trusted mouse failed before physical dispatch was confirmed: ${safeError(error)}`
      if (preResolved) {
        // Never flatten a verified closed-shadow/CDP target back into a MAIN
        // synthetic click merely because debugger input failed.
        throw new Error(nativeError)
      }
    }
  }

  // Coordinate replay keeps strict publish/send DOM proof. Live visual teaching
  // does not: the screenshot point owns the click and business-state verification
  // after the click decides whether it is teachable.
  if (!visualAuthority && interactionWantsPublishTarget(targetHint)) {
    let fallbackProbe
    try {
      const fallbackProbeResults = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'MAIN',
        func: interactionMainWorldVisualClick,
        args: [probeClientX, probeClientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, true, targetHint, visualAuthority, expectedVisualText],
      })
      fallbackProbe = Array.isArray(fallbackProbeResults) ? fallbackProbeResults[0]?.result : undefined
    } catch (error) {
      throw new Error([
        nativeError,
        `publish/send safety probe failed before synthetic fallback: ${safeError(error)}`,
      ].filter(Boolean).join('; '))
    }
    if (fallbackProbe?.publishActionVerified !== true) {
      throw new Error([
        nativeError,
        'publish/send visual click requires an exact CURRENT publish action resolved from DOM/Accessibility; refusing a coordinate-only physical click',
      ].filter(Boolean).join('; '))
    }
  }

  let results
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: interactionMainWorldVisualClick,
      args: [probeClientX, probeClientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, false, targetHint, visualAuthority, expectedVisualText],
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

async function interactionDispatchTrustedMouseAction(tabId, clientX, clientY, action = 'left-click') {
  const target = { tabId }
  let attached = false
  let mousePressed = false
  try {
    await chrome.debugger.attach(target, '1.3')
    attached = true
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved', x: clientX, y: clientY, button: 'none', buttons: 0,
    })
    if (action === 'hover') return { physicalClickDispatched: false }
    const button = action === 'right-click' ? 'right' : 'left'
    const buttons = button === 'right' ? 2 : 1
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: clientX, y: clientY, button, buttons, clickCount: 1,
    })
    mousePressed = true
    await chrome.debugger.sendCommand(target, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: clientX, y: clientY, button, buttons: 0, clickCount: 1,
    })
    return { physicalClickDispatched: true }
  } catch (error) {
    if (mousePressed && error && typeof error === 'object') {
      try { error.physicalClickDispatched = true } catch {}
    }
    throw error
  } finally {
    if (attached) {
      try { await chrome.debugger.detach(target) } catch {}
    }
  }
}

async function interactionDispatchTrustedMouseClick(tabId, clientX, clientY) {
  return await interactionDispatchTrustedMouseAction(tabId, clientX, clientY, 'left-click')
}

async function interactionDescribeVisualPoint(tabId, clientX, clientY) {
  if (!chrome.scripting?.executeScript) return { ok: true }
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: (x, y) => {
        const compact = value => String(value || '').replace(/\s+/g, ' ').trim()
        let element = document.elementFromPoint(x, y)
        let guard = 0
        while (element instanceof Element && element.shadowRoot && guard < 8) {
          const inner = element.shadowRoot.elementFromPoint?.(x, y)
          if (!(inner instanceof Element) || inner === element) break
          element = inner
          guard += 1
        }
        if (!(element instanceof Element)) return { ok: true }
        const role = compact(element.getAttribute('role') || '')
        return {
          ok: true,
          tag: element.tagName.toLowerCase(),
          role,
          text: compact(element.innerText || element.textContent || '').slice(0, 240),
          title: compact(element.getAttribute('title') || ''),
          ariaLabel: compact(element.getAttribute('aria-label') || ''),
          id: compact(element.id || ''),
          className: compact([...(element.classList || [])].join(' ')),
          replaySelectorSafe: false,
          visualAuthority: true,
        }
      },
      args: [clientX, clientY],
    })
    const value = Array.isArray(results) ? results[0]?.result : undefined
    return value && typeof value === 'object' ? value : { ok: true }
  } catch {
    return { ok: true }
  }
}

async function interactionShowVisualMarker(tabId, clientX, clientY, xRatio, yRatio) {
  if (!chrome.scripting?.executeScript) return false
  try {
    await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: (x, y, xr, yr) => {
        document.getElementById('__dsh_patrol_visual_marker')?.remove()
        const marker = document.createElement('div')
        marker.id = '__dsh_patrol_visual_marker'
        marker.style.cssText = [
          'position:fixed','z-index:2147483647','pointer-events:none',
          'width:22px','height:22px','margin-left:-11px','margin-top:-11px',
          'border:3px solid #ff2d2d','border-radius:50%','box-sizing:border-box',
          'left:'+x+'px','top:'+y+'px','background:rgba(255,255,255,.15)',
          'box-shadow:0 0 0 2px rgba(255,255,255,.95),0 0 8px rgba(0,0,0,.85)',
        ].join(';')
        const h = document.createElement('div')
        h.style.cssText = 'position:absolute;left:-10px;top:8px;width:36px;height:2px;background:#ff2d2d'
        const v = document.createElement('div')
        v.style.cssText = 'position:absolute;left:8px;top:-10px;width:2px;height:36px;background:#ff2d2d'
        const label = document.createElement('div')
        label.textContent = 'X'+Math.round(xr*1000)+' Y'+Math.round(yr*1000)
        label.style.cssText = 'position:absolute;left:16px;top:16px;padding:2px 4px;background:rgba(0,0,0,.8);color:white;font:12px monospace;white-space:nowrap;border-radius:3px'
        marker.append(h, v, label)
        document.documentElement.appendChild(marker)
        setTimeout(() => marker.remove(), 12000)
      },
      args: [clientX, clientY, xRatio, yRatio],
    })
    return true
  } catch {
    return false
  }
}

function interactionVisualClickResult(clicked, viewport, xRatio, yRatio, transport) {
  const captureLeft = Number.isFinite(Number(viewport.captureClientLeft)) ? Number(viewport.captureClientLeft) : Number(viewport.offsetLeft || 0)
  const captureTop = Number.isFinite(Number(viewport.captureClientTop)) ? Number(viewport.captureClientTop) : Number(viewport.offsetTop || 0)
  const captureWidth = Number.isFinite(Number(viewport.captureWidth)) ? Number(viewport.captureWidth) : Number(viewport.width || 0)
  const captureHeight = Number.isFinite(Number(viewport.captureHeight)) ? Number(viewport.captureHeight) : Number(viewport.height || 0)
  const resolvedX = Number.isFinite(Number(clicked.clickX)) ? Number(clicked.clickX) : undefined
  const resolvedY = Number.isFinite(Number(clicked.clickY)) ? Number(clicked.clickY) : undefined
  const effectiveXRatio = resolvedX !== undefined && captureWidth > 0
    ? Math.max(0, Math.min(1, (resolvedX - captureLeft) / captureWidth))
    : xRatio
  const effectiveYRatio = resolvedY !== undefined && captureHeight > 0
    ? Math.max(0, Math.min(1, (resolvedY - captureTop) / captureHeight))
    : yRatio
  const rawSelector = clicked?.replaySelectorSafe === false
    ? ''
    : typeof clicked.selector === 'string' ? clicked.selector.trim() : ''
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
    xRatio: effectiveXRatio,
    yRatio: effectiveYRatio,
    requestedXRatio: xRatio,
    requestedYRatio: yRatio,
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
    ...(Number.isFinite(Number(clicked.requestedClickX)) ? { requestedClickX: Number(clicked.requestedClickX) } : {}),
    ...(Number.isFinite(Number(clicked.requestedClickY)) ? { requestedClickY: Number(clicked.requestedClickY) } : {}),
    ...(Number.isFinite(Number(clicked.clickX)) ? { resolvedClickX: Number(clicked.clickX) } : {}),
    ...(Number.isFinite(Number(clicked.clickY)) ? { resolvedClickY: Number(clicked.clickY) } : {}),
    visualSnapped: clicked.visualSnapped === true,
    selectorReplaySafe: clicked.replaySelectorSafe !== false,
    ...(typeof clicked.selectorQuality === 'string' ? { selectorQuality: clicked.selectorQuality } : {}),
    bindingActionable: clicked.bindingActionable === true,
    ...(typeof clicked.bindingSource === 'string' ? { bindingSource: clicked.bindingSource } : {}),
    visualAuthority: clicked.visualAuthority === true,
    cdpPiercedTarget: clicked.cdpPiercedTarget === true,
    cdpPiercedActivator: clicked.cdpPiercedActivator === true,
    cdpPiercedFollowupEditor: clicked.cdpPiercedFollowupEditor === true,
    postVisualEditorFocus: clicked.postVisualEditorFocus === true,
    cdpPiercedAction: clicked.cdpPiercedAction === true,
    physicalClickUncertain: clicked.physicalClickUncertain === true,
    ...(typeof clicked.pointerAction === 'string' ? { pointerAction: clicked.pointerAction } : {}),
    ...(typeof clicked.candidateId === 'string' ? { candidateId: clicked.candidateId } : {}),
    ...(typeof clicked.actionCandidateKind === 'string' && clicked.actionCandidateKind ? { actionCandidateKind: clicked.actionCandidateKind } : {}),
    ...(typeof clicked.actionCandidateHref === 'string' && clicked.actionCandidateHref ? { actionCandidateHref: clicked.actionCandidateHref } : {}),
    ...(typeof clicked.actionCandidateSafePoint === 'string' && clicked.actionCandidateSafePoint ? { actionCandidateSafePoint: clicked.actionCandidateSafePoint } : {}),
    ...(typeof clicked.actionCandidateFingerprint === 'string' && clicked.actionCandidateFingerprint ? { actionCandidateFingerprint: clicked.actionCandidateFingerprint } : {}),
    ...(Number.isInteger(clicked.openedTabId) ? { openedTabId: clicked.openedTabId } : {}),
    ...(typeof clicked.openedTabUrl === 'string' && clicked.openedTabUrl ? { openedTabUrl: clicked.openedTabUrl } : {}),
    ...(Number.isFinite(Number(clicked.snapDistance)) ? { snapDistance: Number(clicked.snapDistance) } : {}),
  }
}

async function interactionMainWorldVisualClick(clientX, clientY, expectedTag, expectedRole, expectedTitle, expectedAriaLabel, probeOnly = false, targetHint = '', visualAuthority = false, expectedVisualText = '') {
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
  const deepElementFromPoint = (x, y) => {
    let hit = document.elementFromPoint(x, y)
    let guard = 0
    while (hit instanceof Element && hit.shadowRoot && guard < 8) {
      const inner = hit.shadowRoot.elementFromPoint?.(x, y)
      if (!(inner instanceof Element) || inner === hit) break
      hit = inner
      guard += 1
    }
    return hit
  }
  const shadowHostContext = element => {
    const parts = []
    let node = element
    let guard = 0
    while (node instanceof Element && guard < 5) {
      const root = node.getRootNode?.()
      const host = root instanceof ShadowRoot ? root.host : null
      if (!(host instanceof Element)) break
      parts.push(
        host.tagName?.toLowerCase?.() || '',
        host.id || '',
        host.getAttribute?.('class') || '',
        host.getAttribute?.('aria-label') || '',
        host.getAttribute?.('title') || '',
        host.getAttribute?.('placeholder') || '',
        host.getAttribute?.('data-placeholder') || '',
        host.innerText || host.textContent || '',
      )
      node = host
      guard += 1
    }
    return compact(parts.filter(Boolean).join(' '))
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
  const wantsPublishTarget = /发布|发表|发送|提交|\bpost\b|\bsend\b|\bsubmit\b/i.test(String(targetHint || ''))
  const exactPublishLabel = element => {
    if (!(element instanceof Element)) return false
    const labels = [
      element.getAttribute?.('aria-label'),
      element.getAttribute?.('title'),
      element instanceof HTMLInputElement ? element.value : '',
      element.innerText,
      element.textContent,
    ]
      .filter(Boolean)
      .map(value => compact(value).replace(/\s+/g, '').toLowerCase())
    return labels.some(label => /^(发布|发表|发送|提交|post|send|submit)$/.test(label))
  }
  const resolveExactPublishTarget = (originalX, originalY) => {
    const candidates = []
    for (const element of deepQueryAll('*')) {
      if (!visible(element) || disabled(element) || !exactPublishLabel(element)) continue
      const tag = element.tagName?.toLowerCase?.() || ''
      const role = roleOf(element)
      const style = getComputedStyle(element)
      const actionable = element.matches?.(actionableSelector)
        || role === 'button'
        || tag === 'button'
        || (tag === 'input' && ['button', 'submit'].includes(String(element.type || '').toLowerCase()))
        || style.cursor === 'pointer'
      if (!actionable) continue
      if (tag === 'a' && role !== 'button' && !/(?:send|submit|publish|post|comment-action|btn|button)/i.test(
        compact([element.id, element.getAttribute?.('class'), element.getAttribute?.('data-action')].filter(Boolean).join(' ')),
      )) continue
      const rect = element.getBoundingClientRect()
      if (rect.width < 24 || rect.height < 16 || rect.width > innerWidth * 0.5 || rect.height > Math.min(180, innerHeight * 0.28)) continue
      if (rect.right <= 0 || rect.bottom <= 0 || rect.left >= innerWidth || rect.top >= innerHeight) continue
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      candidates.push({
        target: element,
        rect,
        clickX: centerX,
        clickY: centerY,
        distance: Math.hypot(centerX - originalX, centerY - originalY),
        strength: (tag === 'button' ? 4 : 0) + (role === 'button' ? 3 : 0) + (style.cursor === 'pointer' ? 1 : 0),
      })
    }
    candidates.sort((left, right) => right.strength - left.strength || left.distance - right.distance)
    if (!candidates.length) return undefined
    const best = candidates[0]
    const runnerUp = candidates[1]
    if (runnerUp && runnerUp.strength === best.strength && Math.abs(runnerUp.distance - best.distance) < 8) return undefined
    return {
      target: best.target,
      clickX: best.clickX,
      clickY: best.clickY,
      snapped: Math.hypot(best.clickX - originalX, best.clickY - originalY) > 0.5,
      snapDistance: Math.hypot(best.clickX - originalX, best.clickY - originalY),
      publishActionVerified: true,
    }
  }
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
  const normalizeHint = value => compact(value).toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
  const hintCoreOf = value => normalizeHint(value)
    .replace(/current|截图|其中|中的|页面|视频|封面|卡片|按钮|图标|控件|链接|点击|打开|进入|区域/g, '')
  const isDirectlyActionable = element => element instanceof Element
    && (element.matches?.(actionableSelector) || isEditableTarget(element))
  const isBroadShellTarget = element => {
    if (!(element instanceof Element)) return true
    if (isDirectlyActionable(element)) return false
    const rect = element.getBoundingClientRect()
    const viewportArea = Math.max(1, innerWidth * innerHeight)
    const area = Math.max(0, rect.width) * Math.max(0, rect.height)
    return area / viewportArea > 0.16 || rect.width > innerWidth * 0.72 || rect.height > innerHeight * 0.62
  }
  const localizedAncestorEvidence = element => {
    let node = element
    for (let depth = 0; node instanceof Element && depth < 6; depth += 1, node = node.parentElement) {
      const rect = node.getBoundingClientRect()
      const viewportArea = Math.max(1, innerWidth * innerHeight)
      const areaRatio = Math.max(0, rect.width) * Math.max(0, rect.height) / viewportArea
      let actionableCount = 0
      try { actionableCount = node.querySelectorAll(actionableSelector).length } catch {}
      const text = compact([
        node.getAttribute?.('aria-label'), node.getAttribute?.('title'),
        node.innerText, node.textContent,
      ].filter(Boolean).join(' '))
      if (text && areaRatio <= 0.18 && rect.width <= innerWidth * 0.52
        && rect.height <= innerHeight * 0.62 && actionableCount <= 4) return text
    }
    return ''
  }
  const isLocalizedCommentEditorActivator = element => {
    if (!(element instanceof Element) || isEditableTarget(element)) return false
    const tag = element.tagName?.toLowerCase?.() || ''
    if (tag === 'bili-comments') return false
    const evidence = compact([
      tag, element.id, element.getAttribute?.('class'), element.getAttribute?.('role'),
      element.getAttribute?.('placeholder'), element.getAttribute?.('data-placeholder'),
      element.getAttribute?.('aria-label'), element.getAttribute?.('title'),
      element.innerText, element.textContent, shadowHostContext(element),
    ].filter(Boolean).join(' ')).toLowerCase()
    if (tag !== 'bili-comment-editor' && !/(?:comment|reply)[-_ ]?(?:editor|input)|(?:editor|input)[-_ ]?(?:wrap|box|area)/i.test(evidence)) return false
    const rect = element.getBoundingClientRect()
    return rect.width >= 60 && rect.height >= 18 && rect.height <= 220
      && rect.width <= innerWidth * 0.96 && rect.height <= innerHeight * 0.35
  }
  const targetEvidence = element => {
    if (!(element instanceof Element)) return ''
    const context = element.closest?.('a[href],button,[role="button"],[role="link"],li,article,[data-action]') || element
    return compact([
      element.getAttribute?.('aria-label'), element.getAttribute?.('title'), element.getAttribute?.('placeholder'),
      element.getAttribute?.('id'), element.getAttribute?.('class'), element.getAttribute?.('href'),
      element.innerText, element.textContent,
      localizedAncestorEvidence(element),
      shadowHostContext(element),
      context !== element ? context.getAttribute?.('aria-label') : '',
      context !== element ? context.getAttribute?.('title') : '',
      context !== element ? context.getAttribute?.('href') : '',
      context !== element ? context.innerText : '',
    ].filter(Boolean).join(' '))
  }
  const visualPointMatchesExpectedText = (element, expected) => {
    const wanted = normalizeHint(expected)
    if (wanted.length < 4) return true
    const evidence = normalizeHint(targetEvidence(element))
    return evidence.includes(wanted) || (evidence.length >= 8 && wanted.includes(evidence))
  }
  const hintScore = element => {
    const rawHint = compact(targetHint)
    if (!rawHint) return 0
    const evidence = normalizeHint(targetEvidence(element))
    const hintCore = hintCoreOf(rawHint)
    if (/点赞|大拇指|\blike\b|thumb/i.test(rawHint)) return /点赞|like|thumb|videolike|ariapressed/.test(evidence) ? 220 : 0
    if (/评论|回复|\bcomment\b|\breply\b/i.test(rawHint)) {
      if (!/评论|回复|comment|reply|editor|textarea|placeholder/.test(evidence)) return 0
      if (isEditableTarget(element)) return 420
      if (isLocalizedCommentEditorActivator(element)) return 360
      return isBroadShellTarget(element) ? 0 : 120
    }
    if (/搜索|\bsearch\b/i.test(rawHint)) return /搜索|search/.test(evidence) ? 220 : 0
    if (/发布|发表|发送|提交|\bpost\b|\bsend\b|\bsubmit\b/i.test(rawHint)) return /发布|发表|发送|提交|post|send|submit/.test(evidence) ? 320 : 0
    if (hintCore.length < 3) return 0
    if (evidence.includes(hintCore)) return 180 + Math.min(80, hintCore.length)
    if (evidence.length >= 4 && hintCore.includes(evidence)) return 80
    return 0
  }
  const resolveHintTarget = (initialTarget, originalX, originalY) => {
    const rawHint = compact(targetHint)
    const hintCore = hintCoreOf(rawHint)
    const hasIntent = /点赞|大拇指|\blike\b|thumb|评论|回复|\bcomment\b|\breply\b|搜索|\bsearch\b|发布|发表|发送|提交|\bpost\b|\bsend\b|\bsubmit\b/i.test(rawHint)
    const wantsEditable = /评论.*(?:输入|编辑)|回复.*(?:输入|编辑)|输入框|编辑框|comment.*(?:input|editor)|reply.*(?:input|editor)/i.test(rawHint)
    if (wantsPublishTarget) {
      const publish = resolveExactPublishTarget(originalX, originalY)
      if (!publish) throw new Error('CURRENT DOM has no unique exact publish/send action; refusing a coordinate-only click')
      return publish
    }
    if (!rawHint || (!hasIntent && hintCore.length < 3)) return { target: initialTarget, clickX: originalX, clickY: originalY, snapped: false }
    if (hintScore(initialTarget) > 0
      && !isBroadShellTarget(initialTarget)
      && (!wantsEditable || isEditableTarget(initialTarget) || isLocalizedCommentEditorActivator(initialTarget))) {
      return { target: initialTarget, clickX: originalX, clickY: originalY, snapped: false }
    }

    const candidateSelector = [
      actionableSelector, 'textarea', 'input:not([type="hidden"])', '[contenteditable="true"]', '[role="textbox"]',
      'bili-comment-editor', 'bili-comments', '[title]', '[aria-label]', 'h1', 'h2', 'h3', 'h4', '[class*="title" i]',
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
      if (wantsEditable && !isEditableTarget(resolved) && !isLocalizedCommentEditorActivator(resolved)) continue
      if (!wantsEditable && isBroadShellTarget(resolved)) continue
      const centerX = rect.left + rect.width / 2
      const centerY = rect.top + rect.height / 2
      const distance = Math.hypot(centerX - originalX, centerY - originalY)
      seen.add(resolved)
      uniqueTargets.push({ target: resolved, score, rect, distance })
    }
    uniqueTargets.sort((left, right) => right.score - left.score || left.distance - right.distance)
    if (!uniqueTargets.length) {
      if (wantsEditable && hintScore(initialTarget) > 0 && isLocalizedCommentEditorActivator(initialTarget)) {
        return {
          target: initialTarget,
          clickX: originalX,
          clickY: originalY,
          snapped: false,
          rawPointPreserved: true,
        }
      }
      throw new Error('visual targetHint does not match any CURRENT DOM target; refusing a coordinate-only click')
    }
    const bestScore = uniqueTargets[0].score
    const best = uniqueTargets.filter(item => item.score === bestScore)
    const chosen = best[0]
    if (best.length > 1 && Math.abs(best[0].distance - best[1].distance) < 8) {
      throw new Error('visual targetHint matches multiple equally-near CURRENT DOM targets; refusing a coordinate guess')
    }
    const clickX = Math.max(chosen.rect.left + 1, Math.min(chosen.rect.left + chosen.rect.width / 2, chosen.rect.right - 1))
    const clickY = Math.max(chosen.rect.top + 1, Math.min(chosen.rect.top + chosen.rect.height / 2, chosen.rect.bottom - 1))
    return {
      target: chosen.target,
      clickX,
      clickY,
      snapped: true,
      snapDistance: Math.hypot(clickX - originalX, clickY - originalY),
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
    || compact(element?.getAttribute?.('role') || '').toLowerCase() === 'textbox'

  const hit = deepElementFromPoint(clientX, clientY)
  if (!(hit instanceof Element)) throw new Error('visual click point does not hit a DOM element')
  const hitIsIframe = hit.tagName?.toLowerCase?.() === 'iframe'
  if (hitIsIframe && !probeOnly) throw new Error('visual click point lands on an iframe surface; synthetic MAIN-world click cannot safely enter a cross-origin frame')
  const initialTarget = hitIsIframe ? hit : chooseTarget(hit)
  if (!(initialTarget instanceof Element) || !visible(initialTarget) || disabled(initialTarget)) throw new Error('visual click target is not actionable')
  const wantsCloseTarget = /(?:关闭|移除|删除|清除|取消|close|remove|delete|clear|dismiss|[×✕✖]|(?:^|[\s:_-])x(?:$|[\s:_-]))/i.test(String(targetHint || ''))
  if (visualAuthority && wantsCloseTarget) {
    const closeEvidence = normalizeHint([
      targetEvidence(hit),
      targetEvidence(initialTarget),
    ].filter(Boolean).join(' | '))
    const closeBusinessCore = normalizeHint(String(targetHint || ''))
      .replace(/点击|帮我|请|关闭|移除|删除|清除|取消|筛选|搜索|标签|配置项|右侧|左侧|旁边|里面|其中|图标|按钮|控件|的|close|remove|delete|clear|dismiss|times|cross|cancel|x/g, '')
    const hasCloseEvidence = /close|remove|delete|clear|dismiss|times|cross|cancel|facetremove|faclose|fatimes|关闭|移除|删除|清除|取消|×|✕|✖/.test(closeEvidence)
    const hasBusinessContext = closeBusinessCore.length < 2 || closeEvidence.includes(closeBusinessCore)
    if (!hasCloseEvidence || !hasBusinessContext) {
      throw new Error(`visual close/remove preflight rejected this point before physical input: targetHint=${JSON.stringify(String(targetHint || ''))}; CURRENT point evidence=${JSON.stringify(closeEvidence.slice(0, 320) || '(empty)')}. Try the same fresh screenshot with the other visual strategy (precise XY versus targeted Action Map) instead of clicking this mismatched point.`)
    }
  }
  if (visualAuthority && compact(expectedVisualText) && !visualPointMatchesExpectedText(initialTarget, expectedVisualText)) {
    throw new Error(`visual screenshot point is not inside the item labeled ${JSON.stringify(expectedVisualText)}; refusing trusted input without relocating the coordinate`)
  }
  // In live screenshot-bound teaching, the visual model owns the physical point.
  // DOM/Shadow DOM is sampled AFTER/AT that point for learning; it is not allowed
  // to silently relocate the click to a semantically guessed neighbor.
  const resolved = hitIsIframe || visualAuthority
    ? { target: initialTarget, clickX: clientX, clickY: clientY, snapped: false, visualAuthority: visualAuthority === true }
    : resolveHintTarget(initialTarget, clientX, clientY)
  const target = resolved.target
  const clickX = resolved.clickX
  const clickY = resolved.clickY
  const tag = target.tagName.toLowerCase()
  const role = roleOf(target)
  const title = compact(target.getAttribute('title') || '')
  const ariaLabel = compact(target.getAttribute('aria-label') || '')
  if (!visualAuthority && expectedTag && tag !== expectedTag) throw new Error('visual coordinate replay hit a different tag than teaching')
  if (!visualAuthority && expectedRole && role !== expectedRole) throw new Error('visual coordinate replay hit a different role than teaching')
  if (!visualAuthority && expectedTitle && title !== expectedTitle) throw new Error('visual coordinate replay hit a different title than teaching')
  if (!visualAuthority && expectedAriaLabel && ariaLabel !== expectedAriaLabel) throw new Error('visual coordinate replay hit a different aria-label than teaching')

  const rect = target.getBoundingClientRect()
  if (clickX < rect.left - 1 || clickX > rect.right + 1 || clickY < rect.top - 1 || clickY > rect.bottom + 1) throw new Error('visual click target no longer contains the resolved point')

  const before = signature(target)
  const targetRoot = target.getRootNode?.()
  const replaySelectorSafe = targetRoot === document
  const learnedSelector = replaySelectorSafe ? stableSelector(target) : ''
  const selectorQuality = !learnedSelector
    ? 'none'
    : target.id || /\[(?:data-testid|data-test|data-cy|data-action|name|title|aria-label)=/.test(learnedSelector)
      ? 'strong'
      : /:nth-of-type\(/.test(learnedSelector) || learnedSelector.includes(' > ')
        ? 'weak'
        : 'medium'
  const bindingActionable = isDirectlyActionable(target) || getComputedStyle(target).cursor === 'pointer'
  const descriptor = {
    ok: true,
    selector: learnedSelector,
    replaySelectorSafe,
    selectorQuality,
    bindingActionable,
    bindingSource: visualAuthority ? 'visual-hit-test-post-click-learning' : 'dom-assisted-coordinate-replay',
    visualAuthority: visualAuthority === true,
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
    focusedEditorText: editable(deepActiveElement())
      ? compact(deepActiveElement()?.innerText || deepActiveElement()?.textContent || deepActiveElement()?.value || '').slice(0, 240)
      : '',
    requestedClickX: clientX,
    requestedClickY: clientY,
    clickX,
    clickY,
    visualSnapped: resolved.snapped === true,
    rawPointPreserved: resolved.rawPointPreserved === true,
    publishActionVerified: resolved.publishActionVerified === true,
    snapDistance: Number.isFinite(Number(resolved.snapDistance)) ? Number(resolved.snapDistance) : Math.hypot(clickX - clientX, clickY - clientY),
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
  // A committed HTTP(S) document can usually be captured while Chrome still
  // reports status=loading (redirect chains, anti-bot interstitials, slow
  // subresources). Do not turn that transient loading bit into a hard Patrol
  // error. Geometry freshness is still checked before/after capture, so an
  // actually moving document simply will not yield a reusable visualFrameId.
  if (!interactionTabHasCapturableUrl(tab)) {
    const url = typeof tab?.url === 'string' ? tab.url : ''
    const status = typeof tab?.status === 'string' ? tab.status : 'unknown'
    throw new Error(`target tab has no capturable HTTP(S) document: url=${JSON.stringify(url)} status=${status}`)
  }
  return tab
}

function interactionTabHasCapturableUrl(tab) {
  if (!tab || typeof tab !== 'object') return false
  const url = typeof tab.url === 'string' ? tab.url.trim() : ''
  return /^https?:\/\//i.test(url)
}

function interactionTabIsCapturable(tab) {
  return interactionTabHasCapturableUrl(tab) && tab.status !== 'loading'
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
