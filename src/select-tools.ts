import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { assertSafeForStorage, assertSafePersistentText } from './security.js'
import { stepExecutionNotes } from './step-notes.js'
import type { PatrolRunner } from './runner.js'
import { assertPersistedTaskChecklist, type PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep, JsonObject, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function registerPatrolSelectTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: { maxSteps: number },
): () => void {
  const tool = defineTool({
    name: 'patrol_select',
    description: 'Select one option from a CURRENT native HTML <select> and record the deterministic replay step. Supply exactly one of value, label, or zero-based index.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      value: { type: 'string' },
      label: { type: 'string' },
      index: { type: 'integer' },
      tabId: { type: 'integer' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      const index = typeof args.index === 'number' && Number.isInteger(args.index) ? args.index : undefined
      const supplied = [typeof args.value === 'string', typeof args.label === 'string', index !== undefined].filter(Boolean).length
      if (supplied !== 1) throw new Error('patrol_select requires exactly one of value, label, or index')
      if (index !== undefined && index < 0) throw new Error('patrol_select index must be >= 0')

      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)
      const browserArgs: JsonObject = compactObject({
        selector: args.selector,
        value: args.value,
        label: args.label,
        index,
        tabId: args.tabId,
      })
      assertSafeForStorage(browserArgs)
      const dispatched = await runner.dispatch('browser_select', browserArgs, exec)
      if (!dispatched.ok) {
        return `Select failed and was NOT recorded. ${dispatched.error ?? dispatched.text ?? 'Unknown browser error'}`
      }

      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: 'browser_select',
        arguments: browserArgs,
        notes: stepExecutionNotes({
          tool: 'browser_select',
          args: browserArgs,
          providedNotes: args.notes,
        }),
        recordedAt: new Date().toISOString(),
      }
      definition.steps.push(step)
      definition.schemaVersion = '0.2'
      definition.metadata.updatedAt = new Date().toISOString()
      await store.save(definition)
      return `Executed and recorded ${step.id} (browser_select).\n${dispatched.text}`
    },
  })

  return ctx.tools.register(tool)
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; call patrol_begin_edit first`)
  assertPersistedTaskChecklist(definition)
  if (definition.steps.length >= maxSteps) throw new Error(`runbook reached maxSteps=${maxSteps}`)
  return definition
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match) max = Math.max(max, Number.parseInt(match[1] || '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}

function compactObject(value: Record<string, string | number | undefined>): JsonObject {
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) if (child !== undefined) out[key] = child
  return out
}
