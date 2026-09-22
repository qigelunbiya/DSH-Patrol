import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { applyDesktopTargetDefaults, DESKTOP_ACTIONS, desktopArtifactForTool, desktopToolForAction, type DesktopAction } from './desktop.js'
import { assertSafeForStorage, assertSafePersistentText } from './security.js'
import { assertPersistedTaskChecklist, PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep, JsonObject, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export interface PatrolDesktopRecordToolsOptions {
  maxSteps: number
}

export function registerPatrolDesktopRecordTools(
  ctx: Context,
  store: PatrolStore,
  options: PatrolDesktopRecordToolsOptions,
): () => void {
  const tool = defineTool({
    name: 'patrol_record_desktop_step',
    description: 'Record a desktop/application business step that has ALREADY succeeded through a raw desktop_* CURRENT exploration call. This never re-executes the desktop action. It is intentionally separate from patrol_desktop_action so the proven 048b desktop visual execution surface stays unchanged.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: [...DESKTOP_ACTIONS] },
      storedArguments: { type: 'object', required: true, additionalProperties: true },
      executionInstruction: { type: 'string', required: true },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const action = args.action as DesktopAction
      const desktopTool = desktopToolForAction(action)
      assertSafePersistentText(args.stepName, 'stepName')
      assertSafePersistentText(args.executionInstruction, 'desktop execution instruction')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')

      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)
      const supplied = isPlainRecord(args.storedArguments) ? args.storedArguments as JsonObject : {}
      const stable = stripEphemeralDesktopArguments(supplied)
      const effectiveStoredArgs = applyDesktopTargetDefaults(definition, desktopTool, stable)
      assertSafeForStorage(effectiveStoredArgs)

      const artifact = desktopArtifactForTool(desktopTool)
      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: desktopTool,
        arguments: effectiveStoredArgs,
        executionPlane: 'desktop',
        executionInstruction: args.executionInstruction.trim(),
        ...(artifact === undefined ? {} : { artifact }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        recordedAt: new Date().toISOString(),
      }
      definition.steps.push(step)
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.flowHealth
      await store.save(definition)

      return `Recorded ${step.id} (${desktopTool}) without re-executing the desktop action.\nApplication instruction: ${step.executionInstruction}`
    },
  })

  return ctx.tools.register(tool)
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; call patrol_begin_edit for an existing saved Runbook`)
  assertPersistedTaskChecklist(definition)
  if (definition.steps.length >= maxSteps) throw new Error(`runbook reached maxSteps=${maxSteps}`)
  return definition
}

function stripEphemeralDesktopArguments(args: JsonObject): JsonObject {
  const out: JsonObject = { ...args }
  delete out.frameId
  delete out.hwnd
  delete out.processId
  delete out.frameHwnd
  delete out.frameX
  delete out.frameY
  delete out.frameWidth
  delete out.frameHeight
  return out
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match !== null) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
