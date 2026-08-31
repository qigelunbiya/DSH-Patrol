import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSafePersistentText } from './security.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export const PATROL_TRANSIENT_INPUT_PROMPT = `Transient sensitive input:
- If the user directly supplied a password, captcha text, short-lived verification value, or other sensitive field value in the current conversation, do NOT stop merely because no Harness credential reference exists.
- Use patrol_type_transient to type that already-supplied value once. It executes the browser input but NEVER appends the plaintext to the Runbook, reports, or workspace files.
- For a normal login flow, fill username first, then fill the user-supplied password with patrol_type_transient when no credential reference is configured, then run patrol_detect_auth_challenge. This ordering matters because conventional image-code OCR may submit the form after filling the captcha.
- A durable scheduled password step may still use patrol_type_credential, but credential setup is not required just to continue an interactive/test patrol.
- Captcha/OTP values are inherently short-lived and should normally be transient rather than persisted.`

export function registerPatrolTransientInputTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const typeTransient = defineTool({
    name: 'patrol_type_transient',
    description: 'Type user-supplied sensitive or short-lived text (password, captcha text, verification value) into the current Patrol browser WITHOUT recording the plaintext in the Runbook. Use when the value is already present in the conversation and a durable Harness credential reference is unnecessary.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      text: { type: 'string', required: true },
      clear: { type: 'boolean' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: 'Type transient sensitive text',
      kind: 'other',
      rawInput: {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        selector: args.selector,
        clear: args.clear,
        text: '[REDACTED]',
      },
    }),
    async execute(args, exec: ToolRunContext) {
      assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      if (!(await store.exists(args.inspectionId))) throw new Error(`inspection ${args.inspectionId} not found`)
      if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('transient text must not be empty')

      const dispatched = await runner.dispatch('browser_type', {
        selector: args.selector,
        text: args.text,
        clear: args.clear ?? true,
      }, exec, [args.text])
      if (!dispatched.ok) {
        return `Transient sensitive input failed and nothing was persisted. ${dispatched.error ?? dispatched.text}`
      }

      return [
        `Typed transient sensitive text into ${args.selector}.`,
        'The plaintext value was NOT appended to the Patrol Runbook or workspace reports.',
        'Continue the current browser flow. If durable replay of this password is later required, a Harness credential reference can be added separately without re-teaching unrelated steps.',
      ].join('\n')
    },
  })

  const dispose = ctx.tools.register(typeTransient)
  return () => dispose()
}
