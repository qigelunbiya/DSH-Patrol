import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveTransientSecret } from './transient-secret-store.js'

const reqStr = { type: 'string', required: true }
const optBool = { type: 'boolean' }
const optInt = { type: 'integer' }

export function registerTransientTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'browser_type_transient_ref',
    description: 'Replay a sensitive value from DSH Patrol encrypted local secret storage. The tool arguments contain only an opaque PATROL_SECRET reference and never the plaintext.',
    parameters: {
      selector: reqStr,
      transientRef: reqStr,
      clear: optBool,
      tabId: optInt,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          selector: reqStr,
          transientRef: reqStr,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Typed encrypted Patrol secret reference into ${value.selector}.` }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Type encrypted secret reference',
      kind: 'other',
      rawInput: { selector: args.selector, transientRef: args.transientRef, clear: args.clear },
    }),
    execute: async (args, exec) => {
      const value = resolveTransientSecret(args.transientRef)
      if (value === undefined) {
        throw new Error('This encrypted Patrol secret reference does not exist. Re-enter only this sensitive step with patrol_reteach_transient; do not rebuild unrelated Runbook steps.')
      }
      const result = await bridge.request('type', {
        selector: args.selector,
        text: value,
        clear: args.clear ?? true,
        tabId: args.tabId,
      }, { timeoutMs, signal: exec?.signal })
      if (!result || typeof result !== 'object' || result.ok === false) {
        throw new Error(String(result?.error || 'encrypted secret browser typing failed'))
      }
      return { ok: true, selector: args.selector, transientRef: args.transientRef }
    },
  })
  return ctx.tools.register(definition)
}
