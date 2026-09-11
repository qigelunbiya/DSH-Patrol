const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000
const DEFAULT_REPAIR_WAIT_MS = 5_000
const DEFAULT_POLL_MS = 100

const PAGE_BRIDGE_RETRYABLE = new Set([
  'snapshot', 'readPage', 'challengeSignals', 'imageCodeTarget', 'captureImageCode', 'count',
  'click', 'semanticClick', 'select', 'type', 'press', 'scroll', 'wait',
])

const TRANSPORT_REPLAY_SAFE = new Set([
  'listTabs', 'activateTab', 'snapshot', 'readPage', 'challengeSignals', 'imageCodeTarget',
  'captureImageCode', 'count', 'screenshot', 'captchaDemoInfo', 'captchaDemoTarget',
])

export function createResilientBrowserBridge(service, options = {}) {
  if (!service?.bridge) throw new Error('resilient Patrol bridge requires patrolBrowserBridge service')
  const logger = options.logger ?? console
  const configuredTimeoutMs = positiveInt(options.commandTimeoutMs, 60_000)
  const attemptTimeoutMs = Math.min(configuredTimeoutMs, positiveInt(options.attemptTimeoutMs, DEFAULT_ATTEMPT_TIMEOUT_MS))
  const repairWaitMs = positiveInt(options.repairWaitMs, DEFAULT_REPAIR_WAIT_MS)
  const pollMs = positiveInt(options.pollMs, DEFAULT_POLL_MS)

  return {
    get connected() { return service.bridge.connected === true },
    status: (...args) => service.bridge.status(...args),
    saveScreenshot: (...args) => service.bridge.saveScreenshot(...args),

    async request(cmd, args = {}, requestOptions = {}) {
      if (!service.bridge.connected) {
        const ready = await kickRepairAndWait(service, repairWaitMs, pollMs, logger, false)
        if (!ready) {
          throw new Error(`Patrol managed browser is not connected after ${repairWaitMs}ms of bounded automatic repair. The repair continues in the background; call patrol_browser_recover once before retrying the failed Patrol action.`)
        }
      }

      const transientDelays = PAGE_BRIDGE_RETRYABLE.has(cmd) ? [0, 160, 360, 700] : [0]
      let lastError
      for (const delayMs of transientDelays) {
        if (delayMs > 0) await delay(delayMs)
        try {
          return await service.bridge.request(cmd, args, {
            ...requestOptions,
            timeoutMs: effectiveAttemptTimeout(cmd, args, requestOptions.timeoutMs, attemptTimeoutMs, configuredTimeoutMs),
          })
        } catch (error) {
          lastError = error
          if (isPageBridgeTransient(error) && PAGE_BRIDGE_RETRYABLE.has(cmd)) continue
          break
        }
      }

      if (!isTransportFailure(lastError)) throw lastError

      const replaySafe = isTransportReplaySafe(cmd, args)
      const ready = await kickRepairAndWait(service, repairWaitMs, pollMs, logger, true)
      if (!ready) {
        throw enrichTransportError(lastError, `Automatic browser repair was started but did not reconnect within ${repairWaitMs}ms. The repair is still allowed to finish in the background; call patrol_browser_recover before retrying.`)
      }
      if (!replaySafe) {
        throw enrichTransportError(lastError, 'The browser connection was repaired, but Patrol deliberately did not repeat this mutating command because the first attempt may already have changed the page. Observe CURRENT state and retry only if evidence shows the action did not happen.')
      }

      return await service.bridge.request(cmd, args, {
        ...requestOptions,
        timeoutMs: effectiveAttemptTimeout(cmd, args, requestOptions.timeoutMs, attemptTimeoutMs, configuredTimeoutMs),
      })
    },
  }
}

export async function kickRepairAndWait(service, waitMs = DEFAULT_REPAIR_WAIT_MS, pollMs = DEFAULT_POLL_MS, logger = console, resetStaleConnection = false) {
  if (resetStaleConnection && service?.bridge?.connected === true && typeof service.bridge.resetConnection === 'function') {
    try { service.bridge.resetConnection('Patrol transport recovery after a failed command') } catch {}
  }

  try {
    const pending = service?.ensureBrowser?.()
    if (pending && typeof pending.then === 'function') {
      void pending.catch(error => logger?.warn?.(`[dsh-patrol/browser-tools] background managed-browser repair failed: ${errorMessage(error)}`))
    }
  } catch (error) {
    logger?.warn?.(`[dsh-patrol/browser-tools] could not start managed-browser repair: ${errorMessage(error)}`)
  }

  if (service?.bridge?.connected === true) return true
  const deadline = Date.now() + Math.max(0, waitMs)
  while (Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    if (service?.bridge?.connected === true) return true
  }
  return service?.bridge?.connected === true
}

export function isTransportReplaySafe(cmd, args = {}) {
  if (TRANSPORT_REPLAY_SAFE.has(cmd)) return true
  if (cmd === 'wait') return true
  if (cmd === 'navigate') {
    const action = args?.action ?? 'navigate'
    return action === 'navigate' && args?.newTab !== true && typeof args?.url === 'string' && args.url.length > 0
  }
  return false
}

export function isTransportFailure(error) {
  const code = typeof error?.code === 'string' ? error.code.toUpperCase() : ''
  if (['NOT_CONNECTED', 'DISCONNECTED', 'TIMEOUT', 'SEND_FAILED'].includes(code)) return true
  if (code === 'ABORTED') return false
  return /not connected|disconnected|did not answer|failed to send browser command|websocket|socket.*closed|connection.*closed/i.test(errorMessage(error))
}

function isPageBridgeTransient(error) {
  return /page bridge unavailable|receiving end does not exist|could not establish connection|message port closed/i.test(errorMessage(error))
}

function effectiveAttemptTimeout(cmd, args, requested, attemptTimeoutMs, configuredTimeoutMs) {
  const callerTimeout = positiveInt(requested, configuredTimeoutMs)
  let desired = Math.min(callerTimeout, attemptTimeoutMs)
  if (cmd === 'wait') {
    const pageWaitMs = positiveInt(args?.timeoutMs, 10_000)
    desired = Math.min(callerTimeout, Math.max(desired, Math.min(pageWaitMs + 1_500, 12_000)))
  }
  return Math.max(1_000, desired)
}

function enrichTransportError(error, suffix) {
  const message = `${errorMessage(error)} ${suffix}`.trim()
  const wrapped = new Error(message)
  if (typeof error?.code === 'string') wrapped.code = error.code
  return wrapped
}

function positiveInt(value, fallback) {
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}
