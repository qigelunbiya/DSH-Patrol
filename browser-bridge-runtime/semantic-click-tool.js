import { defineTool } from '@deepseek-ai/dsh-tools'

const reqBool = { type: 'boolean', required: true }
const reqStr = { type: 'string', required: true }
const optStr = { type: 'string' }
const optInt = { type: 'integer' }

export function registerSemanticClickTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const tool = defineTool({
    name: 'browser_semantic_click',
    description: 'Internal Patrol primitive: resolve one CURRENT semantic target across frames and click it atomically in page MAIN world. This avoids snapshot-to-click selector/frame races. Use through Patrol recording tools, not directly from the model.',
    parameters: {
      locatorText: optStr,
      locatorRole: optStr,
      locatorTag: optStr,
      selectorHint: optStr,
      task: optStr,
      tabId: optInt,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: reqBool,
          selector: reqStr,
          text: optStr,
          role: optStr,
          tag: optStr,
          frameId: optInt,
          frameUrl: optStr,
          transport: optStr,
        },
      },
      render: (_args, result) => [{ type: 'text', text: `Atomically clicked ${result.selector}${result.text ? ` (${result.text})` : ''}.` }],
    },
    presentCall: args => ({ card: 'generic', title: 'Atomic semantic click', kind: 'other', rawInput: { locatorText: args.locatorText, locatorRole: args.locatorRole, locatorTag: args.locatorTag, selectorHint: args.selectorHint, task: args.task } }),
    async execute(args, exec) {
      if (![args.locatorText, args.selectorHint, args.task].some(value => typeof value === 'string' && value.trim())) {
        throw new Error('browser_semantic_click requires locatorText, selectorHint, or task')
      }
      const capabilities = bridge.status?.()?.extension?.capabilities
      if (Array.isArray(capabilities) && !capabilities.includes('semanticClick')) {
        throw new Error('live Patrol extension semanticClick capability is missing; use the verified unique-selector fallback or restart the managed browser after updating')
      }
      const result = await bridge.request('semanticClick', {
        locatorText: args.locatorText,
        locatorRole: args.locatorRole,
        locatorTag: args.locatorTag,
        selectorHint: args.selectorHint,
        task: args.task,
        tabId: args.tabId,
      }, { timeoutMs, signal: exec?.signal })
      if (!result || typeof result !== 'object') throw new Error('semanticClick returned an invalid browser response')
      if (result.ok === false) throw new Error(String(result.error || 'semanticClick failed'))
      if (typeof result.selector !== 'string' || !result.selector) throw new Error('semanticClick returned no reusable selector')
      return {
        ok: true,
        selector: result.selector,
        ...(typeof result.text === 'string' ? { text: result.text } : {}),
        ...(typeof result.role === 'string' ? { role: result.role } : {}),
        ...(typeof result.tag === 'string' ? { tag: result.tag } : {}),
        ...(Number.isInteger(result.frameId) ? { frameId: result.frameId } : {}),
        ...(typeof result.frameUrl === 'string' ? { frameUrl: result.frameUrl } : {}),
        ...(typeof result.transport === 'string' ? { transport: result.transport } : {}),
      }
    },
  })
  return ctx.tools.register(tool)
}
