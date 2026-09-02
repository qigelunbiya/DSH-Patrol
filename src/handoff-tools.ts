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
  allowImageCodeHandoff?: boolean
}

export function registerPatrolHandoffTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolHandoffToolsOptions,
): () => void {
  const handoff = defineTool({
    name: 'patrol_prepare_verification_handoff',
    description: options.allowImageCodeHandoff
      ? 'Record a verification handoff for debugging. In test mode conventional image-code may also be handed off if desired; normal mode keeps image-code automation-only.'
      : 'Record a human-verification handoff ONLY for genuinely human-only verification such as OTP/device approval/passkey/third-party CAPTCHA. Conventional image-code is forbidden here: this tool re-checks the detector first and refuses to record any checkpoint for image-code, which must auto-fill or fail.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      detectorStepId: { type: 'string', required: true, description: 'Existing browser_detect_auth_challenge step id.' },
      tabId: { type: 'integer', description: 'Optional current teaching-session tab id. Used only for the immediate challenge re-check/capture and never persisted in the Runbook.' },
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

      const detected = await runner.dispatch('browser_detect_auth_challenge', compactObject({ tabId: args.tabId }), exec)
      if (!detected.ok) {
        throw new Error(`Verification detector failed; no human handoff was recorded. ${detected.error ?? detected.text}`)
      }
      const kind = objectString(detected.value, 'kind') ?? challengeKindFromText(detected.text)
      const subtype = objectString(detected.value, 'subtype') ?? challengeSubtypeFromText(detected.text)
      const observedSubtype = objectString(detected.value, 'observedSubtype') ?? challengeObservedSubtypeFromText(detected.text)
      const autoFilled = objectBoolean(detected.value, 'autoFilled')
      const handoffRequired = objectBoolean(detected.value, 'handoffRequired') ?? kind !== 'none'
      const imageCode = subtype === 'image-code' || observedSubtype === 'image-code'

      if (imageCode) {
        if (autoFilled === true || kind === 'none') {
          return 'Conventional image-code was handled automatically by the Patrol solver. No human verification handoff was recorded; continue with the observed login/submit step.'
        }
        if (options.allowImageCodeHandoff !== true) {
          throw new Error('Conventional image-code is automation-only. No human checkpoint was recorded; the patrol must fail if automatic recognition/fill did not succeed.')
        }
      }

      if ((kind === 'none' || handoffRequired === false) && !(imageCode && options.allowImageCodeHandoff === true)) {
        return 'No remaining human-only verification is visible. No handoff/checkpoint was recorded.'
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
        name: imageCode ? 'Capture image-code debug evidence' : 'Capture human-verification evidence',
        tool: 'browser_screenshot',
        arguments: { format: 'png' },
        when: condition,
        artifact: 'screenshot',
        notes: imageCode
          ? 'Test-mode debugging evidence for a conventional image-code CAPTCHA.'
          : 'Evidence capture only for genuinely human-only verification.',
        recordedAt: new Date().toISOString(),
      }
      const checkpointStep: CheckpointStep = {
        id: nextStepId([...definition.steps, screenshotStep]),
        kind: 'checkpoint',
        name: imageCode ? 'Complete image-code debug handoff' : 'Complete human verification',
        prompt: imageCode
          ? 'TEST MODE: complete the current image-code CAPTCHA in the managed Patrol browser if you want to continue this debugging run. After completing it, ask Patrol to resume the same run.'
          : 'Complete the human-only verification shown in the managed Patrol browser. After completing it, ask Patrol to resume the same run.',
        reason: 'other',
        when: condition,
        notes: imageCode
          ? 'Test-mode-only image-code checkpoint. Normal mode forbids this handoff.'
          : 'For OTP, device approval, passkey, QR confirmation, third-party CAPTCHA, or other explicitly unsupported human-only verification.',
        recordedAt: new Date().toISOString(),
      }

      definition.steps.push(screenshotStep, checkpointStep)
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.validatedAt
      await store.save(definition)

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
      return imageCode
        ? [
            `Recorded ${screenshotStep.id} and ${checkpointStep.id}.`,
            `Current test-mode image-code verification kind=${kind}; subtype=${subtype}; test-mode image-code handoff is enabled.`,
            path === undefined ? 'Immediate verification screenshot was captured, but the provider returned no path.' : `Verification screenshot: ${path}`,
            'Complete this verification in the managed browser, then resume Patrol.',
          ].join('\n')
        : [
            `Recorded ${screenshotStep.id} and ${checkpointStep.id}.`,
            `Current human-only verification kind=${kind}; subtype=${subtype}.`,
            path === undefined ? 'Immediate verification screenshot was captured, but the provider returned no path.' : `Verification screenshot: ${path}`,
            'Complete this human-only verification in the managed browser, then resume Patrol.',
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

function objectBoolean(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'boolean' ? child : undefined
}

function challengeKindFromText(text: string): string {
  const match = /\bkind=(none|otp|captcha|slider|approval|unknown)\b/i.exec(text)
  return match?.[1]?.toLowerCase() ?? 'unknown'
}

function challengeSubtypeFromText(text: string): string {
  const match = /\bsubtype=([a-z-]+)\b/i.exec(text)
  return match?.[1]?.toLowerCase() ?? 'unknown'
}

function challengeObservedSubtypeFromText(text: string): string {
  const match = /\bobserved=(?:none|otp|captcha|slider|approval|unknown)\/([a-z-]+)\b/i.exec(text)
  return match?.[1]?.toLowerCase() ?? 'unknown'
}
