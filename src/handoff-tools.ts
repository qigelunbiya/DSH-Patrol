import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type { CheckpointStep, InspectionDefinition, InspectionStep, JsonObject, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export interface PatrolHandoffToolsOptions {
  maxSteps: number
}

export function registerPatrolHandoffTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolHandoffToolsOptions,
): () => void {
  const handoff = defineTool({
    name: 'patrol_prepare_verification_handoff',
    description: 'Record the standard human-verification handoff after a patrol_detect_auth_challenge step: conditional screenshot, then conditional checkpoint. If a challenge is visible now, also capture an immediate workspace screenshot and return its path and detected subtype. This tool never solves or submits the challenge.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      detectorStepId: { type: 'string', required: true, description: 'Existing browser_detect_auth_challenge step id.' },
      tabId: { type: 'integer', description: 'Optional current teaching-session tab id. Used only for the immediate evidence re-check/capture and never persisted in the Runbook.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definition = await loadEditable(store, args.inspectionId, options.maxSteps, 2)
      const detector = definition.steps.find(step => step.id === args.detectorStepId)
      if (detector?.kind !== 'tool' || detector.tool !== 'browser_detect_auth_challenge') {
        throw new Error(`step ${args.detectorStepId} is not a recorded auth-challenge detector`)
      }
      if (definition.steps.some(step => step.when?.sourceStepId === args.detectorStepId && step.kind === 'tool' && step.tool === 'browser_screenshot')) {
        throw new Error(`verification handoff already exists for detector step ${args.detectorStepId}`)
      }

      const condition = {
        sourceStepId: args.detectorStepId,
        mode: 'not-contains' as const,
        value: 'kind=none',
        caseSensitive: false,
      }
      const screenshotStep: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: 'Capture human-verification evidence',
        tool: 'browser_screenshot',
        arguments: { format: 'png' },
        when: condition,
        artifact: 'screenshot',
        notes: 'Automatic evidence capture before human verification handoff.',
        recordedAt: new Date().toISOString(),
      }
      const checkpointStep: CheckpointStep = {
        id: nextStepId([...definition.steps, screenshotStep]),
        kind: 'checkpoint',
        name: 'Complete human verification',
        prompt: 'Complete the verification shown in the managed Patrol browser. Patrol has captured evidence in the workspace artifacts. After completing the verification, ask Patrol to resume the same run.',
        reason: 'other',
        when: condition,
        notes: 'Used for CAPTCHA, slider, OTP, approval, passkey, or other human verification. No challenge answer is stored.',
        recordedAt: new Date().toISOString(),
      }

      definition.steps.push(screenshotStep, checkpointStep)
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.validatedAt
      await store.save(definition)

      const detected = await runner.dispatch('browser_detect_auth_challenge', compactObject({ tabId: args.tabId }), exec)
      if (!detected.ok) {
        return `Recorded ${screenshotStep.id} and ${checkpointStep.id}. Current challenge re-check failed: ${detected.error ?? detected.text}`
      }
      const kind = objectString(detected.value, 'kind') ?? challengeKindFromText(detected.text)
      const subtype = objectString(detected.value, 'subtype') ?? challengeSubtypeFromText(detected.text)
      if (kind === 'none') {
        return `Recorded ${screenshotStep.id} and ${checkpointStep.id}. No human verification is visible right now; future runs will automatically screenshot and pause if one appears.`
      }

      const shot = await runner.dispatch('browser_screenshot', compactObject({ tabId: args.tabId, format: 'png' }), exec)
      if (!shot.ok) {
        return `Recorded ${screenshotStep.id} and ${checkpointStep.id}. Current verification kind=${kind}; subtype=${subtype}, but immediate evidence capture failed: ${shot.error ?? shot.text}`
      }
      let path = objectString(shot.value, 'path')
      const workspaceRoot = exec.agent?.session.header.cwd
      if (path !== undefined && workspaceRoot !== undefined && workspaceRoot.trim() !== '') {
        try {
          path = await store.organizeTeachingScreenshot(args.inspectionId, path, workspaceRoot)
        } catch {
          // Keep the provider path as a fallback if workspace organization fails.
        }
      }
      return [
        `Recorded ${screenshotStep.id} and ${checkpointStep.id}.`,
        `Current verification kind=${kind}; subtype=${subtype}.`,
        path === undefined ? 'Immediate verification screenshot was captured, but the provider returned no path.' : `Verification screenshot: ${path}`,
        'Do not solve or submit the challenge automatically. Complete the verification manually in the managed browser, then resume Patrol.',
      ].join('\n')
    },
  })

  const dispose = ctx.tools.register(handoff)
  return () => dispose()
}

async function loadEditable(store: PatrolStore, id: string, maxSteps: number, additional: number): Promise<InspectionDefinition> {
  const definition = await store.load(id)
  if (definition.status !== 'draft') throw new Error(`inspection ${id} is ready; call patrol_begin_edit before changing its verification flow`)
  if (definition.steps.length + additional > maxSteps) throw new Error(`inspection ${id} would exceed maxSteps=${maxSteps}`)
  return definition
}

function nextStepId(steps: readonly InspectionStep[]): string {
  const used = new Set(steps.map(step => step.id))
  for (let index = 1; index <= 9999; index += 1) {
    const id = `step-${String(index).padStart(3, '0')}`
    if (!used.has(id)) return id
  }
  throw new Error('unable to allocate Patrol step id')
}

function compactObject(value: Record<string, unknown>): JsonObject {
  return Object.fromEntries(Object.entries(value).filter(([, child]) => child !== undefined)) as JsonObject
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'string' ? child : undefined
}

function challengeKindFromText(text: string): string {
  const match = /\bkind=(none|otp|captcha|slider|approval|unknown)\b/i.exec(text)
  return match?.[1]?.toLowerCase() ?? 'unknown'
}

function challengeSubtypeFromText(text: string): string {
  const match = /\bsubtype=([a-z-]+)\b/i.exec(text)
  return match?.[1]?.toLowerCase() ?? 'unknown'
}
