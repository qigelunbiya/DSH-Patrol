import { INSPECTION_ARTIFACTS, type InspectionDefinition, type InspectionStep, type JsonObject, type JsonValue, type StepCondition, type TextExpectation } from './types.js'
import { isReplayableBrowserTool } from './browser.js'
import { assertSafeCheckpointPrompt, assertSafeForStorage, assertSafePersistentText, assertSafePublicInputText, collectCredentialReferences, credentialReferenceName } from './security.js'

const INSPECTION_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/
const STEP_ID = /^step-\d{3,}$/
const CHALLENGE_KINDS = ['otp', 'captcha', 'slider', 'approval', 'unknown'] as const
const CHALLENGE_SUBTYPES = ['otp', 'image-code', 'click-sequence', 'third-party', 'generic-captcha', 'slider', 'slider-puzzle', 'rotate', 'approval', 'unknown'] as const
const CHALLENGE_STRATEGIES = ['windows-system-ocr', 'ddddocr-click-sequence-demo', 'ddddocr-slider-demo', 'manual-click-sequence', 'manual-slider', 'manual-third-party', 'manual-otp', 'manual-approval', 'manual-review'] as const

export function assertInspectionId(id: string): void {
  if (!INSPECTION_ID.test(id)) {
    throw new Error('inspectionId must match /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/')
  }
}

export function asJsonObject(value: JsonValue): JsonObject {
  if (value === null || Array.isArray(value) || typeof value !== 'object') {
    throw new Error('tool arguments must be a JSON object')
  }
  return value
}

export function assertInspectionDefinition(value: unknown): asserts value is InspectionDefinition {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('inspection.json must contain an object')
  const candidate = value as Partial<InspectionDefinition>
  if (candidate.schemaVersion !== '0.1' && candidate.schemaVersion !== '0.2') throw new Error('unsupported inspection schemaVersion')
  if (typeof candidate.id !== 'string') throw new Error('inspection.id must be a string')
  assertInspectionId(candidate.id)
  if (typeof candidate.name !== 'string' || candidate.name.trim().length === 0) throw new Error('inspection.name is required')
  assertSafePersistentText(candidate.name, 'inspection.name')
  if (typeof candidate.description !== 'string' || candidate.description.trim().length === 0) throw new Error('inspection.description is required')
  assertSafePersistentText(candidate.description, 'inspection.description')
  if (candidate.status !== 'draft' && candidate.status !== 'ready') throw new Error('inspection.status is invalid')
  if (typeof candidate.expectedResult !== 'string' || candidate.expectedResult.trim().length === 0) throw new Error('inspection.expectedResult is required')
  assertSafePersistentText(candidate.expectedResult, 'inspection.expectedResult')
  if (!Array.isArray(candidate.artifacts) || candidate.artifacts.some(item => typeof item !== 'string' || !(INSPECTION_ARTIFACTS as readonly string[]).includes(item))) throw new Error(`inspection.artifacts must contain only: ${INSPECTION_ARTIFACTS.join(', ')}`)
  if (!Array.isArray(candidate.steps)) throw new Error('inspection.steps must be an array')

  const auth = candidate.auth as unknown
  if (auth === null || typeof auth !== 'object' || Array.isArray(auth)) throw new Error('inspection.auth must be an object')
  const authRecord = auth as Record<string, unknown>
  if (!['none', 'existing-session', 'manual-checkpoint', 'secret-ref'].includes(String(authRecord.mode ?? ''))) throw new Error('inspection.auth.mode is invalid')
  if (authRecord.notes !== undefined) {
    if (typeof authRecord.notes !== 'string') throw new Error('inspection.auth.notes must be a string')
    assertSafePersistentText(authRecord.notes, 'inspection.auth.notes')
  }
  if (authRecord.challengeProfiles !== undefined) assertChallengeProfiles(authRecord.challengeProfiles)

  const schedule = candidate.schedule as unknown
  if (schedule !== null) {
    if (schedule === undefined || typeof schedule !== 'object' || Array.isArray(schedule)) throw new Error('inspection.schedule must be null or an object')
    const scheduleRecord = schedule as Record<string, unknown>
    if (typeof scheduleRecord.enabled !== 'boolean') throw new Error('inspection.schedule.enabled must be boolean')
    if (scheduleRecord.cron !== undefined) {
      if (typeof scheduleRecord.cron !== 'string' || scheduleRecord.cron.trim().length === 0) throw new Error('inspection.schedule.cron must be a non-empty string')
      assertSafePersistentText(scheduleRecord.cron, 'inspection.schedule.cron')
    }
  }

  const metadata = candidate.metadata as unknown
  if (metadata === null || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('inspection.metadata must be an object')
  const metadataRecord = metadata as Record<string, unknown>
  if (typeof metadataRecord.createdAt !== 'string' || typeof metadataRecord.updatedAt !== 'string') throw new Error('inspection.metadata timestamps are required')
  if (metadataRecord.validatedAt !== undefined && typeof metadataRecord.validatedAt !== 'string') throw new Error('inspection.metadata.validatedAt must be a string')

  const target = candidate.target as unknown
  if (target === null || typeof target !== 'object' || Array.isArray(target)) throw new Error('inspection.target must be a browser target with url')
  const targetRecord = target as Record<string, unknown>
  if (targetRecord.type !== 'browser' || typeof targetRecord.url !== 'string' || targetRecord.url.length === 0) {
    throw new Error('inspection.target must be a browser target with url')
  }
  assertHttpUrl(targetRecord.url)
  assertSafeForStorage({ url: targetRecord.url })

  const seen = new Set<string>()
  for (const rawStep of candidate.steps) {
    assertStep(rawStep)
    if (seen.has(rawStep.id)) throw new Error(`duplicate step id ${rawStep.id}`)
    if (rawStep.when !== undefined && !seen.has(rawStep.when.sourceStepId)) {
      throw new Error(`step ${rawStep.id} condition must reference an earlier step; unavailable source ${rawStep.when.sourceStepId}`)
    }
    seen.add(rawStep.id)
  }
}

function assertChallengeProfiles(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('inspection.auth.challengeProfiles must be an array')
  if (value.length > 8) throw new Error('inspection.auth.challengeProfiles may contain at most 8 learned profiles')
  const seen = new Set<string>()
  for (let index = 0; index < value.length; index += 1) {
    const profile = value[index]
    if (profile === null || typeof profile !== 'object' || Array.isArray(profile)) throw new Error(`inspection.auth.challengeProfiles[${index}] must be an object`)
    const record = profile as Record<string, unknown>
    if (!(CHALLENGE_KINDS as readonly unknown[]).includes(record.kind)) throw new Error(`inspection.auth.challengeProfiles[${index}].kind is invalid`)
    if (!(CHALLENGE_SUBTYPES as readonly unknown[]).includes(record.subtype)) throw new Error(`inspection.auth.challengeProfiles[${index}].subtype is invalid`)
    if (!(CHALLENGE_STRATEGIES as readonly unknown[]).includes(record.strategy)) throw new Error(`inspection.auth.challengeProfiles[${index}].strategy is invalid`)
    if (typeof record.firstObservedAt !== 'string' || typeof record.lastObservedAt !== 'string') throw new Error(`inspection.auth.challengeProfiles[${index}] timestamps are required`)
    if (!Number.isInteger(record.occurrences) || Number(record.occurrences) < 1) throw new Error(`inspection.auth.challengeProfiles[${index}].occurrences must be a positive integer`)
    if (!Number.isInteger(record.autoCompletedOccurrences) || Number(record.autoCompletedOccurrences) < 0 || Number(record.autoCompletedOccurrences) > Number(record.occurrences)) {
      throw new Error(`inspection.auth.challengeProfiles[${index}].autoCompletedOccurrences is invalid`)
    }
    const key = `${String(record.kind)}/${String(record.subtype)}`
    if (seen.has(key)) throw new Error(`inspection.auth.challengeProfiles contains duplicate ${key}`)
    seen.add(key)
  }
}

function assertStep(value: unknown): asserts value is InspectionStep {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('inspection step must be an object')
  const step = value as Partial<InspectionStep>
  if (typeof step.id !== 'string' || !STEP_ID.test(step.id)) throw new Error('inspection step id is invalid')
  if (typeof step.name !== 'string' || step.name.trim().length === 0) throw new Error(`step ${step.id} name is required`)
  assertSafePersistentText(step.name, `step ${step.id} name`)
  if (typeof step.recordedAt !== 'string') throw new Error(`step ${step.id} recordedAt is required`)
  if (step.when !== undefined) assertCondition(step.when, `step ${step.id} when`)
  if (step.notes !== undefined) {
    if (typeof step.notes !== 'string') throw new Error(`step ${step.id} notes must be a string`)
    assertSafePersistentText(step.notes, `step ${step.id} notes`)
  }

  if (step.kind === 'checkpoint') {
    if (typeof step.prompt !== 'string' || step.prompt.trim().length === 0) throw new Error(`checkpoint ${step.id} prompt is required`)
    assertSafeCheckpointPrompt(step.prompt)
    if (!['login', 'otp', 'approval', 'other'].includes(step.reason ?? '')) throw new Error(`checkpoint ${step.id} reason is invalid`)
    return
  }
  if (step.kind !== 'tool') throw new Error(`step ${step.id} kind is invalid`)
  if (typeof step.tool !== 'string' || step.tool.length === 0) throw new Error(`tool step ${step.id} tool is required`)
  if (!isReplayableBrowserTool(step.tool)) throw new Error(`tool step ${step.id} uses non-replayable browser tool ${step.tool}`)
  if (step.arguments === undefined) throw new Error(`tool step ${step.id} arguments are required`)
  assertSafeForStorage(step.arguments)
  assertToolArgumentPolicy(step.id, step.tool, step.arguments)
  if (step.expectation !== undefined) assertExpectation(step.expectation, `step ${step.id} expectation`)
  if (step.sensitive !== undefined && typeof step.sensitive !== 'boolean') throw new Error(`step ${step.id} sensitive must be boolean`)
  if (step.locator !== undefined) {
    if (step.locator === null || typeof step.locator !== 'object' || Array.isArray(step.locator)) throw new Error(`step ${step.id} locator must be an object`)
    for (const [key, locatorValue] of Object.entries(step.locator)) {
      if (!['text', 'role', 'tag'].includes(key) || typeof locatorValue !== 'string' || locatorValue.trim().length === 0) {
        throw new Error(`step ${step.id} locator is invalid`)
      }
      assertSafePersistentText(locatorValue, `step ${step.id} locator.${key}`)
    }
  }
  if (step.artifact !== undefined && step.artifact !== 'page-text' && step.artifact !== 'screenshot') {
    throw new Error(`step ${step.id} artifact is invalid`)
  }
  if (step.artifact === 'page-text' && step.tool !== 'browser_read_page') throw new Error(`step ${step.id} page-text artifact requires browser_read_page`)
  if (step.artifact === 'screenshot' && step.tool !== 'browser_screenshot') throw new Error(`step ${step.id} screenshot artifact requires browser_screenshot`)
}

function assertToolArgumentPolicy(stepId: string, tool: string, args: JsonObject): void {
  if ('tabId' in args) {
    throw new Error(`step ${stepId} must not persist ephemeral browser tabId values`)
  }
  if (tool === 'browser_navigate') {
    const action = args.action ?? 'navigate'
    if (action !== 'navigate') throw new Error(`step ${stepId} browser_navigate must use an explicit URL, not history action ${String(action)}`)
    if (typeof args.url !== 'string' || args.url.length === 0) throw new Error(`step ${stepId} browser_navigate requires url`)
    if (args.newTab === true) throw new Error(`step ${stepId} browser_navigate must reuse the active tab; newTab is not replay-stable`)
  }
  const refs = collectCredentialReferences(args)
  if (tool === 'browser_type_credential') {
    const raw = args.credentialRef
    if (typeof raw !== 'string' || credentialReferenceName(raw) === undefined) {
      throw new Error(`step ${stepId} browser_type_credential must store credentialRef as \${credential:REF}`)
    }
    if (refs.size !== 1 || !refs.has(credentialReferenceName(raw) as string)) {
      throw new Error(`step ${stepId} browser_type_credential contains unexpected credential references`)
    }
    if ('text' in args) throw new Error(`step ${stepId} browser_type_credential must not store a text value`)
    return
  }
  if (refs.size > 0) throw new Error(`step ${stepId} may not embed credential references in ${tool}; use browser_type_credential`)
  if (tool === 'browser_type') {
    const text = args.text
    if (typeof text !== 'string') throw new Error(`step ${stepId} browser_type requires text`)
    assertSafePublicInputText(text)
  }
}

function assertCondition(condition: StepCondition, at: string): void {
  if (typeof condition.sourceStepId !== 'string' || !STEP_ID.test(condition.sourceStepId)) throw new Error(`${at}.sourceStepId is invalid`)
  assertExpectation(condition, at)
}

function assertExpectation(expectation: TextExpectation, at: string): void {
  if (expectation.mode !== 'contains' && expectation.mode !== 'not-contains') throw new Error(`${at}.mode is invalid`)
  if (typeof expectation.value !== 'string' || expectation.value.length === 0) throw new Error(`${at}.value is required`)
  assertSafePersistentText(expectation.value, `${at}.value`)
  if (typeof expectation.caseSensitive !== 'boolean') throw new Error(`${at}.caseSensitive must be boolean`)
}

function assertHttpUrl(value: string): void {
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`invalid target URL: ${value}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('inspection target URL must use http or https')
  if (parsed.username !== '' || parsed.password !== '') throw new Error('inspection target URL must not embed credentials')
}
