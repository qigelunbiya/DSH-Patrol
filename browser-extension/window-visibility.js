// Live visibility control for the managed Patrol Chromium window.
// Loaded after background.js so it can extend handleCommand without changing
// any existing browser/Patrol command semantics.
const windowVisibilityPreviousHandleCommand = handleCommand

handleCommand = async function windowVisibilityHandleCommand(cmd, args = {}) {
  if (cmd !== 'setWindowVisibility') return await windowVisibilityPreviousHandleCommand(cmd, args)

  const visible = args.visible !== false
  const tabId = await resolveTabId(args.tabId)
  const tab = await chrome.tabs.get(tabId)
  if (tab.windowId === undefined) throw new Error('target tab has no browser window')
  const windowId = tab.windowId

  // Bounds cannot be changed while a Chrome window is maximized. Normalize the
  // state first, then either move it to a visible desktop position and maximize
  // it, or place the still-headful window well off-screen for background runs.
  await chrome.windows.update(windowId, { state: 'normal' })
  if (visible) {
    await chrome.windows.update(windowId, {
      left: 80,
      top: 60,
      width: 1280,
      height: 860,
      focused: true,
    })
    await chrome.windows.update(windowId, { state: 'maximized', focused: true })
  } else {
    await chrome.windows.update(windowId, {
      left: -32000,
      top: -32000,
      width: 1440,
      height: 900,
      focused: false,
    })
  }

  return { ok: true, visible, windowId }
}
