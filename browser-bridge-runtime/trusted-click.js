// Host-side trusted click transport for custom controls that cannot safely be
// activated by synthetic DOM events. Puppeteer ElementHandle.click() scrolls the
// CURRENT element into view and dispatches real browser input through CDP.

export async function trustedClickManagedTarget(browser, spec = {}) {
  if (!browser || browser.connected === false) throw new Error('managed Patrol browser is not available for trusted click')

  const selector = cleanString(spec.selector)
  if (!selector) throw new Error('trusted click requires a CURRENT CSS selector')

  const pages = (await browser.pages?.())?.filter(page => page && page.isClosed?.() !== true) ?? []
  if (pages.length === 0) throw new Error('trusted click found no live managed-browser pages')

  const page = await selectPage(pages, spec, selector)
  await page.bringToFront?.()
  const frame = await selectFrame(page, spec, selector)
  const element = await frame.$(selector)
  if (!element) throw new Error(`trusted click target disappeared before physical input: ${selector}`)

  try {
    await element.click({ button: 'left', clickCount: 1 })
  } finally {
    try { await element.dispose?.() } catch {}
  }

  return {
    ok: true,
    selector,
    pageUrl: safeUrl(page),
    frameUrl: safeFrameUrl(frame),
    transport: 'puppeteer-trusted-click',
  }
}

async function selectPage(pages, spec, selector) {
  const requestedUrl = normalizeUrl(spec.pageUrl)
  let candidates = requestedUrl
    ? pages.filter(page => normalizeUrl(safeUrl(page)) === requestedUrl)
    : [...pages]
  if (candidates.length === 0) candidates = [...pages]
  if (candidates.length === 1) return candidates[0]

  const withTarget = []
  for (const page of candidates) {
    try {
      await selectFrame(page, spec, selector)
      withTarget.push(page)
    } catch {}
  }
  if (withTarget.length === 1) return withTarget[0]
  if (withTarget.length > 0) candidates = withTarget

  const focused = []
  for (const page of candidates) {
    try {
      if (await page.evaluate(() => document.visibilityState === 'visible' && document.hasFocus())) focused.push(page)
    } catch {}
  }
  if (focused.length === 1) return focused[0]

  throw new Error(`trusted click could not uniquely identify the CURRENT page (${candidates.length} candidates)`)
}

async function selectFrame(page, spec, selector) {
  const frames = typeof page.frames === 'function' ? page.frames() : []
  const mainFrame = page.mainFrame?.()
  if (Number(spec.frameId) === 0 && mainFrame) {
    if (await frameHasTarget(mainFrame, selector)) return mainFrame
    throw new Error(`trusted click target is no longer present in the top frame: ${selector}`)
  }

  const requestedFrameUrl = normalizeUrl(spec.frameUrl)
  let candidates = requestedFrameUrl
    ? frames.filter(frame => normalizeUrl(safeFrameUrl(frame)) === requestedFrameUrl)
    : frames
  if (candidates.length === 0) candidates = frames

  const matching = []
  for (const frame of candidates) {
    if (await frameHasTarget(frame, selector)) matching.push(frame)
  }
  if (matching.length === 1) return matching[0]
  if (matching.length === 0) throw new Error(`trusted click target is no longer present in any CURRENT frame: ${selector}`)
  throw new Error(`trusted click selector is ambiguous across ${matching.length} CURRENT frames: ${selector}`)
}

async function frameHasTarget(frame, selector) {
  let handle
  try {
    handle = await frame.$(selector)
    return Boolean(handle)
  } catch {
    return false
  } finally {
    try { await handle?.dispose?.() } catch {}
  }
}

function safeUrl(page) {
  try { return String(page.url?.() ?? '') } catch { return '' }
}

function safeFrameUrl(frame) {
  try { return String(frame.url?.() ?? '') } catch { return '' }
}

function normalizeUrl(value) {
  const text = cleanString(value)
  if (!text) return ''
  try {
    const parsed = new URL(text)
    parsed.hash = ''
    return parsed.href
  } catch {
    return text.split('#')[0]
  }
}

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}
