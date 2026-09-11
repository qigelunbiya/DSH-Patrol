const DEFAULT_ATTEMPT_TIMEOUT_MS = 10_000
const DEFAULT_INITIAL_CONNECT_WAIT_MS = 18_000
const DEFAULT_REPAIR_WAIT_MS = 8_000
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
  const initialConnectWaitMs = positiveInt(options.initialConnectWaitMs, DEFAULT_INITIAL_CONNECT_WAIT_MS)
  const repairWaitMs = positiveInt(options.repairWaitMs, DEFAULT_REPAIR_WAIT_MS)
  const pollMs = positiveInt(options.pollMs, DEFAULT_POLL_MS)

  return {
    get connected() { return transportReady(service) },
    status: (...args) => service.bridge.status(...args),
    saveScreenshot: (...args) => service.bridge.saveScreenshot(...args),

    async request(cmd, args = {}, requestOptions = {}) {
      if (!transportReady(service)) {
        const resetWrongOrStaleOrigin = service.bridge.connected === true
        const ready = await kickRepairAndWait(service, initialConnectWaitMs, pollMs, logger, resetWrongOrStaleOrigin)
        if (!ready) {
          const state = managedState(service)
          throw new Error([
            `Patrol managed browser did not become ready within ${initialConnectWaitMs}ms.`,
            `running=${state.running ?? 'unknown'}`,
            `starting=${state.starting ?? 'unknown'}`,
            `connected=${state.connected ?? service.bridge.connected === true}`,
            `managedError=${state.error ?? 'none'}`,
            'The browser process is kept open for repair instead of being closed. Call patrol_browser_recover once; if it still fails, report its managedError instead of looping.',
          ].join(' '))
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
        const state = managedState(service)
        throw enrichTransportError(lastError, [
          `Automatic browser transport repair did not reconnect within ${repairWaitMs}ms.`,
          `running=${state.running ?? 'unknown'}`,
          `starting=${state.starting ?? 'unknown'}`,
          `managedError=${state.error ?? 'none'}.`,
          'The managed browser is intentionally kept open; call patrol_browser_recover once before retrying.',
        ].join(' '))
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
    try { service.bridge.resetConnection('Patrol transport recovery after a failed or mismatched connection') } catch {}
  }

  try {
    const pending = service?.ensureBrowser?.()
    if (pending && typeof pending.then === 'function') {
      void pending.catch(error => logger?.warn?.(`[dsh-patrol/browser-tools] managed-browser repair failed: ${errorMessage(error)}`))
    }
  } catch (error) {
    logger?.warn?.(`[dsh-patrol/browser-tools] could not start managed-browser repair: ${errorMessage(error)}`)
  }

  if (transportReady(service)) return true
  const deadline = Date.now() + Math.max(0, waitMs)
  while (Date.now() < deadline) {
    await delay(Math.min(pollMs, Math.max(1, deadline - Date.now())))
    if (transportReady(service)) return true
  }
  return transportReady(service)
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

function transportReady(service) {
  if (service?.bridge?.connected !== true) return false
  const state = managedState(service)
  if (typeof state.connected === 'boolean' && state.connected !== true) return false
  const bridgeState = typeof service?.bridge?.status === 'function' ? service.bridge.status() : undefined
  if (bridgeState && Object.prototype.hasOwnProperty.call(bridgeState, 'extension')) {
    if (bridgeState.extension === null || typeof bridgeState.extension !== 'object') return false
  }
  return true
}

function managedState(service) {
  try {
    return service?.managedBrowserStatus?.() ?? {}
  } catch {
    return {}
  }
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
