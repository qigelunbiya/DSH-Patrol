import { defineTool } from '@deepseek-ai/dsh-tools'

const optInt = { type: 'integer' }

export function registerBrowserRecoveryTools(ctx, bridge, service, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60_000
  const recoveryTimeoutMs = config.recoveryTimeoutMs ?? 20_000

  const recover = defineTool({
    name: 'patrol_browser_recover',
    description: 'Recover the DSH Patrol managed browser after a Patrol action reports timeout, disconnect, or unavailable browser. This is a one-shot transient runtime repair: it is NOT recorded in the Runbook. Call it once, then either retry the failed Patrol action or report the returned managedError; do not loop this tool.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: () => ({ card: 'generic', title: 'Recover Patrol browser', kind: 'other', rawInput: {} }),
    async execute(_args, exec) {
      const before = service.managedBrowserStatus?.() ?? {}
      try {
        if (typeof service.ensureBrowser !== 'function') throw new Error('managed browser controller is unavailable')
        await withTimeout(service.ensureBrowser(), recoveryTimeoutMs, 'managed browser recovery')
        const afterEnsure = service.managedBrowserStatus?.() ?? {}
        if (afterEnsure.connected !== true || service.bridge.connected !== true) {
          throw new Error(afterEnsure.error || 'managed browser process is running but the Patrol extension bridge is still disconnected')
        }

        // Verify the actual raw transport once. Do not route this verification
        // through the resilient wrapper or a failed recovery could recursively
        // start another recovery cycle.
        const verifyTimeout = Math.min(5_000, timeoutMs)
        const value = await service.bridge.request('listTabs', {}, { timeoutMs: verifyTimeout, signal: exec?.signal })
        const after = service.managedBrowserStatus?.() ?? {}
        const tabs = Array.isArray(value?.tabs) ? value.tabs.length : 0
        return [
          'Patrol browser recovery succeeded.',
          `connected=${service.bridge.connected === true}`,
          `managedRunning=${after.running ?? before.running ?? 'unknown'}`,
          `managedStarting=${after.starting ?? false}`,
          `extensionMode=${after.extensionLoadMode ?? 'unknown'}`,
          `tabs=${tabs}`,
          'Retry the failed patrol_* action once. Do not repeat a mutating business action if CURRENT evidence shows it already happened.',
        ].join('; ')
      } catch (error) {
        const after = service.managedBrowserStatus?.() ?? {}
        return [
          'Patrol browser recovery failed.',
          `connected=${service.bridge.connected === true}`,
          `managedRunning=${after.running ?? before.running ?? 'unknown'}`,
          `managedStarting=${after.starting ?? false}`,
          `extensionMode=${after.extensionLoadMode ?? 'unknown'}`,
          `managedError=${after.error ?? 'none'}`,
          `error=${errorMessage(error)}`,
          'STOP browser recovery here and report managedError. Do not call patrol_browser_recover again in the same recovery attempt and do not guess a replacement URL.',
        ].join('; ')
      }
    },
  })

  const reload = defineTool({
    name: 'patrol_reload_current',
    description: 'Transiently reload the CURRENT Patrol tab when the same page is visibly stuck or only shows a loading/splash shell. This recovery action is NOT recorded in the reusable Runbook. Do not use it to replace a required business click or to guess a different internal URL.',
    parameters: { tabId: optInt },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: args => ({ card: 'generic', title: 'Reload current Patrol page', kind: 'other', rawInput: args }),
    async execute(args, exec) {
      await bridge.request('listTabs', {}, { timeoutMs, signal: exec?.signal })
      const value = await bridge.request('navigate', {
        action: 'reload',
        tabId: args.tabId,
      }, { timeoutMs, signal: exec?.signal })
      const url = typeof value?.tab?.url === 'string' ? value.tab.url : ''
      return `Reloaded the CURRENT Patrol tab as transient recovery${url ? `: ${url}` : ''}. This reload was not recorded in the Runbook; re-observe CURRENT state before the next business action.`
    },
  })

  const disposers = [ctx.tools.register(recover), ctx.tools.register(reload)]
  return () => { for (const dispose of disposers) dispose() }
}

async function withTimeout(promise, timeoutMs, label) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs}ms`)), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
