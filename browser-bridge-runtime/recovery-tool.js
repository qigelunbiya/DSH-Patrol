import { defineTool } from '@deepseek-ai/dsh-tools'

const optInt = { type: 'integer' }

export function registerBrowserRecoveryTools(ctx, bridge, service, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60_000

  const recover = defineTool({
    name: 'patrol_browser_recover',
    description: 'Recover the DSH Patrol managed browser after a Patrol action reports timeout, disconnect, or unavailable browser. This is a transient runtime repair: it is NOT recorded in the Runbook and is safe to call once before retrying the failed patrol_* business action.',
    parameters: {},
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    presentCall: () => ({ card: 'generic', title: 'Recover Patrol browser', kind: 'other', rawInput: {} }),
    async execute(_args, exec) {
      const before = service.managedBrowserStatus?.() ?? {}
      try {
        const value = await bridge.request('listTabs', {}, { timeoutMs, signal: exec?.signal })
        const after = service.managedBrowserStatus?.() ?? {}
        const tabs = Array.isArray(value?.tabs) ? value.tabs.length : 0
        return [
          'Patrol browser transport is healthy.',
          `connected=${bridge.connected === true}`,
          `managedRunning=${after.running ?? before.running ?? 'unknown'}`,
          `managedStarting=${after.starting ?? false}`,
          `tabs=${tabs}`,
          'Retry the failed patrol_* action once. Do not repeat the business action if CURRENT evidence shows it already happened.',
        ].join('; ')
      } catch (error) {
        const after = service.managedBrowserStatus?.() ?? {}
        return [
          'Patrol browser recovery did not complete in the bounded foreground window.',
          `connected=${bridge.connected === true}`,
          `managedRunning=${after.running ?? before.running ?? 'unknown'}`,
          `managedStarting=${after.starting ?? false}`,
          `managedError=${after.error ?? 'none'}`,
          `error=${errorMessage(error)}`,
          'Automatic repair may still be finishing in the background. Wait briefly, call patrol_browser_recover once more, and if it still fails report the managedError instead of looping navigation.',
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

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
