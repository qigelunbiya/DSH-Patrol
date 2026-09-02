import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import { assertSafePersistentText } from './security.js'
import type { PatrolRunner } from './runner.js'
import type { PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep, JsonObject, StepCondition, ToolStep } from './types.js'

const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function registerPatrolTotpTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: { maxSteps: number },
): () => void {
  const typeTotp = defineTool({
    name: 'patrol_type_totp_profile',
    description: 'Generate and type a fresh TOTP from an already configured encrypted Patrol token profile, then record only the profile id and selector as a replayable Runbook step. The seed and dynamic digits are never model-visible or persisted in the inspection.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      profileId: { type: 'string', required: true, description: 'Configured Patrol TOTP profile id. Never pass an otpauth URI, seed, or current code here.' },
      clear: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      assertTotpProfileId(args.profileId)

      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)
      const runtimeArgs: JsonObject = {
        selector: args.selector,
        profileId: args.profileId,
        clear: args.clear ?? true,
      }
      const dispatched = await runner.dispatch('browser_type_totp_profile', runtimeArgs, exec)
      if (!dispatched.ok) {
        return `TOTP typing failed and was NOT recorded. ${dispatched.error ?? dispatched.text}`
      }

      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: 'browser_type_totp_profile',
        arguments: runtimeArgs,
        sensitive: true,
        ...optionalCondition(args.conditionSourceStepId, args.conditionExpectedText, args.conditionMode),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        recordedAt: new Date().toISOString(),
      }
      await appendStep(store, definition, step)
      return `Executed and recorded ${step.id} using encrypted TOTP profile ${args.profileId}; neither the seed nor the generated dynamic code was exposed or persisted.`
    },
  })

  const definitions: ToolDefinition[] = [typeTotp]
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  return () => { for (const dispose of disposers) dispose() }
}

function assertTotpProfileId(value: string): void {
  if (!PROFILE_ID_PATTERN.test(value)) {
    throw new Error('TOTP profile id must be 1-64 characters using letters, numbers, dot, underscore, or hyphen')
  }
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') {
    throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; edit operations return it to draft before re-validation`)
  }
  if (definition.steps.length >= maxSteps) throw new Error(`runbook reached maxSteps=${maxSteps}`)
  return definition
}

async function appendStep(store: PatrolStore, definition: InspectionDefinition, step: InspectionStep): Promise<void> {
  definition.steps.push(step)
  definition.schemaVersion = '0.2'
  definition.metadata.updatedAt = new Date().toISOString()
  await store.save(definition)
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match !== null) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}

function optionalCondition(
  sourceStepId: string | undefined,
  expectedText: string | undefined,
  mode: 'contains' | 'not-contains' | undefined,
): { when?: StepCondition } {
  if (sourceStepId === undefined && expectedText === undefined) return {}
  if (!sourceStepId || expectedText === undefined) {
    throw new Error('conditionSourceStepId and conditionExpectedText must be provided together')
  }
  return {
    when: {
      sourceStepId,
      value: expectedText,
      mode: mode ?? 'contains',
      caseSensitive: false,
    },
  }
}
