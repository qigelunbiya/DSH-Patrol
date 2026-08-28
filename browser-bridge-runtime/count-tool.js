import { defineTool } from '@deepseek-ai/dsh-tools'

const reqStr = { type: 'string', required: true }
const reqBool = { type: 'boolean', required: true }
const optBool = { type: 'boolean' }
const optInt = { type: 'integer' }

export function registerCountTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'browser_count',
    description: 'Count DOM elements matching an observed CSS selector without returning their contents.',
    parameters: {
      selector: reqStr,
      visibleOnly: optBool,
      tabId: optInt,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: reqBool,
          selector: reqStr,
          count: { type: 'integer', required: true },
          visibleOnly: reqBool,
        },
      },
      render: (_args, value) => [{ type: 'text', text: `Count ${value.selector}: ${value.count} element(s)${value.visibleOnly ? ' (visible only)' : ''}.` }],
    },
    presentCall: args => ({ card: 'generic', title: 'Count page elements', kind: 'other', rawInput: args }),
    execute: async (args, exec) => {
      const value = await bridge.request('count', {
        selector: args.selector,
        visibleOnly: args.visibleOnly ?? true,
        tabId: args.tabId,
      }, { timeoutMs, signal: exec?.signal })
      if (!value || typeof value !== 'object') throw new Error('count returned an invalid browser response')
      if (value.ok === false) throw new Error(String(value.error || 'count failed'))
      return {
        ok: true,
        selector: args.selector,
        count: Number.isInteger(value.count) ? value.count : 0,
        visibleOnly: value.visibleOnly !== false,
      }
    },
  })
  return ctx.tools.register(definition)
}
