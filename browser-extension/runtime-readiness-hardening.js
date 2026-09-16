// Replay readiness hardening layered last in background-entry.js.
//
// The reusable Runbook must have the same timing semantics in single-flow and
// serial batch execution. A navigation is therefore not considered complete
// until Chromium reports the target tab as loaded, and selector-bound actions
// get a small bounded retry window for late-rendered DOM after navigation.
// This layer never changes selectors, Runbook steps, or business logic.

const READINESS_NAVIGATION_TIMEOUT_MS = 15000
const READINESS_NAVIGATION_POLL_MS = 100
const READINESS_ELEMENT_RETRY_MS = [0, 150, 350, 700, 1200]
const readinessPreviousHandleCommand = handleCommand
const readinessPreviousSendDomCommand = sendDomCommand

handleCommand = async function readinessHardenedHandleCommand(cmd, args = {}) {
  if (cmd === 'navigate') {
    const value = await readinessPreviousHandleCommand(cmd, args)
    const tabId = Number.isInteger(value?.tab?.id)
      ? value.tab.id
      : await resolveTabId(args.tabId)
    const tab = await readinessWaitForTabComplete(tabId, READINESS_NAVIGATION_TIMEOUT_MS)
    return { ...value, tab: tabInfo(tab) }
  }
  return await readinessPreviousHandleCommand(cmd, args)
}

sendDomCommand = async function readinessHardenedSendDomCommand(cmd, args = {}) {
  if (!readinessShouldRetryElementCommand(cmd, args)) {
    return await readinessPreviousSendDomCommand(cmd, args)
  }

  let lastError
  for (let index = 0; index < READINESS_ELEMENT_RETRY_MS.length; index += 1) {
    const waitMs = READINESS_ELEMENT_RETRY_MS[index]
    if (waitMs > 0) await delay(waitMs)
    try {
      return await readinessPreviousSendDomCommand(cmd, args)
    } catch (error) {
      lastError = error
      if (!readinessIsElementNotReadyError(error) || index === READINESS_ELEMENT_RETRY_MS.length - 1) {
        throw error
      }
    }
  }
  throw lastError
}

async function readinessWaitForTabComplete(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  let lastTab
  while (Date.now() <= deadline) {
    lastTab = await chrome.tabs.get(tabId)
    if (lastTab?.status === 'complete') return lastTab
    await delay(READINESS_NAVIGATION_POLL_MS)
  }
  const url = typeof lastTab?.url === 'string' && lastTab.url ? ` at ${lastTab.url}` : ''
  throw new Error(`navigation did not reach tab status=complete within ${timeoutMs}ms${url}`)
}

function readinessShouldRetryElementCommand(cmd, args) {
  if (!['click', 'type', 'press', 'select'].includes(cmd)) return false
  return typeof args?.selector === 'string' && args.selector.trim().length > 0
}

function readinessIsElementNotReadyError(error) {
  const text = safeError(error)
  return /element not found(?: in any accessible frame)?|no element matches|selector[^\n]*(?:not found|did not match)/i.test(text)
}
