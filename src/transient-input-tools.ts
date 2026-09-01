import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { forgetTransientSecret, rememberTransientSecret } from '../browser-bridge-runtime/transient-secret-store.js'
import { assertSafePersistentText } from './security.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type { InspectionStep, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export const PATROL_TRANSIENT_INPUT_PROMPT = `Transient sensitive input:
- If the user directly supplied a password or other sensitive field value in the current conversation, do NOT stop merely because no Harness credential reference exists.
- Use patrol_type_transient. The plaintext stays only in process memory, while the Runbook records a short-lived transient reference so patrol_validate/patrol_run can replay the password during the CURRENT Harness process.
- If Harness is restarted and that reference expires, call patrol_begin_edit then patrol_reteach_transient for only that one stable step. Never rebuild unrelated Runbook steps.
- For durable scheduled execution across restarts, a Harness credential reference is still appropriate, but it is not required for interactive/test patrols.
- Ordinary image-text CAPTCHA values should normally be handled by patrol_detect_auth_challenge and Windows OCR, not by a human checkpoint.`

export function registerPatrolTransientInputTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const typeTransient = defineTool({
    name: 'patrol_type_transient',
    description: 'Type user-supplied sensitive text once and record only an in-memory transient reference so the same CURRENT Harness process can replay it during validation. The plaintext is never written to the Runbook or workspace.',
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
      if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('transient text must not be empty')
      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}; call patrol_begin_edit before teaching transient input`)

      const transientRef = rememberTransientSecret(args.text)
      const dispatched = await runner.dispatch('browser_type', {
        selector: args.selector,
        text: args.text,
        clear: args.clear ?? true,
      }, exec, [args.text])
      if (!dispatched.ok) {
        forgetTransientSecret(transientRef)
        return `Transient sensitive input failed and nothing was persisted. ${dispatched.error ?? dispatched.text}`
      }

      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: 'browser_type_transient_ref',
        arguments: { selector: args.selector, transientRef, clear: args.clear ?? true },
        sensitive: true,
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        recordedAt: new Date().toISOString(),
      }
      definition.steps.push(step)
      definition.schemaVersion = '0.2'
      definition.metadata.updatedAt = new Date().toISOString()
      await store.save(definition)

      return [
        `Typed transient sensitive text and recorded ${step.id} as a current-session transient reference.`,
        'The plaintext value was NOT written to the Patrol Runbook or workspace reports.',
        'patrol_validate/patrol_run can replay this step while the current Harness process remains alive.',
      ].join('\n')
    },
  })

  const reteachTransient = defineTool({
    name: 'patrol_reteach_transient',
    description: 'Replace one existing browser_type_transient_ref step with a newly supplied current-session value while preserving its stable step id. Use after process restart/expiry instead of rebuilding the Runbook.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      text: { type: 'string', required: true },
      clear: { type: 'boolean' },
      stepName: { type: 'string' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: 'Refresh transient sensitive step',
      kind: 'other',
      rawInput: {
        inspectionId: args.inspectionId,
        stepId: args.stepId,
        selector: args.selector,
        clear: args.clear,
        stepName: args.stepName,
        text: '[REDACTED]',
      },
    }),
    async execute(args, exec: ToolRunContext) {
      if (args.stepName !== undefined) assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('transient text must not be empty')
      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}; call patrol_begin_edit before re-teaching`)
      const index = definition.steps.findIndex(step => step.id === args.stepId)
      const current = index >= 0 ? definition.steps[index] : undefined
      if (current === undefined || current.kind !== 'tool' || current.tool !== 'browser_type_transient_ref') {
        throw new Error(`${args.stepId} is not a transient sensitive input step`)
      }

      const transientRef = rememberTransientSecret(args.text)
      const dispatched = await runner.dispatch('browser_type', {
        selector: args.selector,
        text: args.text,
        clear: args.clear ?? true,
      }, exec, [args.text])
      if (!dispatched.ok) {
        forgetTransientSecret(transientRef)
        return `Transient re-teach failed and the stored step was NOT changed. ${dispatched.error ?? dispatched.text}`
      }

      const replacement: ToolStep = {
        id: current.id,
        kind: 'tool',
        name: args.stepName ?? current.name,
        tool: 'browser_type_transient_ref',
        arguments: { selector: args.selector, transientRef, clear: args.clear ?? true },
        sensitive: true,
        ...(args.notes !== undefined ? { notes: args.notes } : current.notes === undefined ? {} : { notes: current.notes }),
        recordedAt: new Date().toISOString(),
      }
      definition.steps[index] = replacement
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.validatedAt
      await store.save(definition)
      return `Re-taught ${current.id} with a new current-session transient reference. No plaintext secret was persisted.`
    },
  })

  const disposers = [typeTransient, reteachTransient].map(tool => ctx.tools.register(tool))
  return () => { for (const dispose of disposers) dispose() }
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match !== null) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}
