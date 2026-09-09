import { defineTool } from '@deepseek-ai/dsh-tools'

const reqStr = { type: 'string', required: true }
const optStr = { type: 'string' }
const optInt = { type: 'integer' }

export function registerSelectTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const tool = defineTool({
    name: 'browser_select',
    description: 'Select one option from a native HTML <select> by exact value, exact visible label, or zero-based index. The selector must resolve to one visible select across eligible frames.',
    parameters: {
      selector: reqStr,
      value: optStr,
      label: optStr,
      index: optInt,
      tabId: optInt,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          selector: reqStr,
          value: { type: 'string' },
          label: { type: 'string' },
          index: { type: 'integer' },
        },
      },
      render: (_args, result) => [{
        type: 'text',
        text: `Selected ${JSON.stringify(result.label || result.value || String(result.index ?? ''))} in ${result.selector}.`,
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Select option',
      kind: 'other',
      rawInput: { selector: args.selector, value: args.value, label: args.label, index: args.index, tabId: args.tabId },
    }),
    async execute(args, exec) {
      const supplied = [typeof args.value === 'string', typeof args.label === 'string', Number.isInteger(args.index)].filter(Boolean).length
      if (supplied !== 1) throw new Error('browser_select requires exactly one of value, label, or index')
      if (Number.isInteger(args.index) && args.index < 0) throw new Error('browser_select index must be >= 0')
      const result = await bridge.request('select', {
        selector: args.selector,
        value: args.value,
        label: args.label,
        index: args.index,
        tabId: args.tabId,
      }, { timeoutMs, signal: exec?.signal })
      if (!result || typeof result !== 'object') throw new Error('select returned an invalid browser response')
      if (result.ok === false) throw new Error(String(result.error || 'select failed'))
      return {
        ok: true,
        selector: args.selector,
        ...(typeof result.value === 'string' ? { value: result.value } : {}),
        ...(typeof result.label === 'string' ? { label: result.label } : {}),
        ...(Number.isInteger(result.index) ? { index: result.index } : {}),
      }
    },
  })
  return ctx.tools.register(tool)
}
