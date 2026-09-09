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
const interactionPreviousSendDomCommand = sendDomCommand
const interactionPreviousHandleCommand = handleCommand

sendDomCommand = async function interactionHardenedSendDomCommand(cmd, args = {}) {
  // The content-script click path can report success even when a framework
  // handler is bound in the page MAIN world. Use the resilient MAIN-world path
  // first for clicks; it already performs visibility/stability/hit-target checks
  // and strict cross-frame uniqueness. Fall back only if MAIN-world execution is
  // unavailable, never merely because the click produced an unexpected page.
  if (cmd === 'click' && chrome.scripting?.executeScript && typeof resilientDomFallback === 'function') {
    const tabId = await resolveTabId(args.tabId)
    try {
      return await resilientDomFallback(tabId, 'click', args)
    } catch (mainWorldError) {
      try {
        return await interactionPreviousSendDomCommand(cmd, args)
      } catch (bridgeError) {
        throw new Error(
          `Patrol click failed in MAIN-world and frame bridge. `
          + `main=${safeError(mainWorldError)}; bridge=${safeError(bridgeError)}`,
        )
      }
    }
  }

  const value = await interactionPreviousSendDomCommand(cmd, args)
  return cmd === 'snapshot' ? interactionNormalizeSnapshot(value) : value
}

handleCommand = async function interactionHardenedHandleCommand(cmd, args = {}) {
  if (cmd === 'activateTab') return await interactionActivateTab(args)
  if (cmd === 'screenshot') return await interactionScreenshot(args)
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

async function interactionActivateTab(args) {
  const tabId = await resolveTabId(args.tabId)
  const tab = await chrome.tabs.update(tabId, { active: true })
  // Deliberately do NOT call chrome.windows.update(..., { focused: true }).
  // Patrol may change its own active tab while remaining behind the user's work.
  return { tab: tabInfo(tab) }
}

async function interactionScreenshot(args) {
  const tabId = await resolveTabId(args.tabId)
  const tab = await chrome.tabs.get(tabId)
  if (tab.windowId === undefined) throw new Error('target tab has no window')

  // captureVisibleTab captures the active tab of the specified window; the
  // window does not need to become the OS foreground window. Keeping the tab
  // active is internal to Patrol and avoids the old desktop-focus stealing.
  await chrome.tabs.update(tabId, { active: true })
  const format = args.format === 'jpeg' ? 'jpeg' : 'png'
  const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format })
  return { ok: true, dataUrl, bytes: Math.floor(dataUrl.length * 0.75) }
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
