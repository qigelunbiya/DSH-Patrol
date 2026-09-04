import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSafePublicInputText } from './security.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type { JsonObject } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const MAX_RECOVERY_TIMEOUT_MS = 15_000

/**
 * A deliberately tiny, non-recording browser escape hatch for model-on-exception
 * recovery. It is not a teaching API: no call here can mutate inspection.json.
 */
export function registerPatrolTransientRecoveryTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const recoveryAction = defineTool({
    name: 'patrol_recovery_action',
    description: 'Perform ONE transient browser action to unblock a failed deterministic Patrol run without modifying its Runbook. Requires a pending recovery resume. Use only after patrol_last_failure + patrol_observe, then call patrol_resume_flow once after the blocker is cleared.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: ['click', 'press', 'wait', 'scroll', 'type_text'] },
      selector: { type: 'string', description: 'CURRENT stable selector from patrol_observe. Required for click; optional for press/wait/scroll/type_text as applicable.' },
      key: { type: 'string', description: 'Key for action=press.' },
      text: { type: 'string', description: 'Non-sensitive CURRENT text for action=type_text. Secrets are forbidden.' },
      direction: { type: 'string', enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
      amount: { type: 'integer' },
      condition: { type: 'string', enum: ['visible', 'gone'] },
      timeoutMs: { type: 'integer' },
      tabId: { type: 'integer' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec: ToolRunContext) {
      const pending = await store.loadResume(args.inspectionId)
      if (pending === undefined) {
        throw new Error(`inspection ${args.inspectionId} has no pending deterministic run to recover`)
      }
      if (pending.reason !== 'recovery') {
        throw new Error(`inspection ${args.inspectionId} is waiting for ${pending.reason ?? 'a checkpoint'}, not transient model recovery`)
      }

      const action = String(args.action)
      let tool: string
      let browserArgs: JsonObject
      switch (action) {
        case 'click': {
          const selector = requiredString(args.selector, 'selector')
          tool = 'browser_click'
          browserArgs = compactObject({ selector, tabId: args.tabId })
          break
        }
        case 'press': {
          const key = requiredString(args.key, 'key')
          tool = 'browser_press'
          browserArgs = compactObject({ key, selector: cleanString(args.selector), tabId: args.tabId })
          break
        }
        case 'wait': {
          const timeoutMs = boundedTimeout(args.timeoutMs)
          tool = 'browser_wait'
          browserArgs = compactObject({
            selector: cleanString(args.selector),
            condition: args.condition,
            timeoutMs,
            tabId: args.tabId,
          })
          break
        }
        case 'scroll': {
          const direction = requiredString(args.direction, 'direction')
          tool = 'browser_scroll'
          browserArgs = compactObject({
            direction,
            amount: args.amount,
            selector: cleanString(args.selector),
            tabId: args.tabId,
          })
          break
        }
        case 'type_text': {
          const selector = requiredString(args.selector, 'selector')
          const text = requiredString(args.text, 'text')
          assertSafePublicInputText(text)
          tool = 'browser_type'
          browserArgs = compactObject({ selector, text, clear: true, tabId: args.tabId })
          break
        }
        default:
          throw new Error(`unsupported transient recovery action ${JSON.stringify(action)}`)
      }

      const dispatched = await runner.dispatch(tool, browserArgs, exec)
      if (!dispatched.ok) {
        throw new Error(`transient recovery ${action} failed: ${dispatched.error ?? dispatched.text}`)
      }
      return [
        `Transient recovery action ${action} succeeded for blocked step ${pending.blockedStepId ?? '(unknown)'}.`,
        'The Runbook was NOT modified. Observe again only if needed; once the blocker is cleared, call patrol_resume_flow exactly once.',
        dispatched.text,
      ].filter(Boolean).join('\n')
    },
  })

  return ctx.tools.register(recoveryAction)
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return 3000
  if (!Number.isInteger(value) || value < 0) throw new Error('timeoutMs must be a non-negative integer')
  return Math.min(value, MAX_RECOVERY_TIMEOUT_MS)
}

function requiredString(value: unknown, name: string): string {
  const text = cleanString(value)
  if (text === undefined) throw new Error(`${name} is required for this recovery action`)
  return text
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 ? text : undefined
}

function compactObject(value: Record<string, string | number | boolean | undefined>): JsonObject {
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = child
  }
  return out
}
