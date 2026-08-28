import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool, type ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  BROWSER_ACTIONS,
  assertSafePlainTextInput,
  browserToolForAction,
  normalizeSemanticLocator,
  type BrowserAction,
} from './browser.js'
import { summarizeReport } from './report.js'
import {
  assertSafeCheckpointPrompt,
  assertSafeForStorage,
  assertSafePersistentText,
  assertSafePublicInputText,
  credentialPlaceholder,
  untrustedPageData,
} from './security.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type {
  AuthMode,
  CheckpointStep,
  InspectionDefinition,
  JsonObject,
  JsonValue,
  SemanticLocator,
  StepCondition,
  TextExpectation,
  ToolStep,
} from './types.js'
import { asJsonObject } from './validation.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export function registerPatrolEditTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const definitions = createEditDefinitions(ctx, store, runner)
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  return () => { for (const dispose of disposers) dispose() }
}

function createEditDefinitions(ctx: Context, store: PatrolStore, runner: PatrolRunner): ToolDefinition[] {
  const beginEdit = defineTool({
    name: 'patrol_begin_edit',
    description: 'Open an existing READY inspection for safe editing. The stored schedule is retained but scheduled execution pauses while the runbook is DRAFT.',
    parameters: { inspectionId: { type: 'string', required: true } },
    output: TEXT_OUTPUT,
    async execute(args) {
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await store.load(args.inspectionId)
      if (definition.status === 'draft') {
        return `Inspection ${definition.id} is already DRAFT. Edit/re-teach the affected steps, then run patrol_validate before patrol_confirm_edit.`
      }
      markEdited(definition)
      await store.save(definition)
      return `Inspection ${definition.id} is now DRAFT for editing. Stored schedule: ${scheduleText(definition)}. Scheduled execution is paused until the runbook is validated and confirmed again.`
    },
  })

  const updateInspection = defineTool({
    name: 'patrol_update_inspection',
    description: 'Edit high-level inspection metadata such as target URL, expected result, auth mode, or notes. Any change returns the runbook to DRAFT.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      name: { type: 'string' },
      description: { type: 'string' },
      targetUrl: { type: 'string' },
      expectedResult: { type: 'string' },
      authMode: { type: 'string', enum: ['none', 'existing-session', 'manual-checkpoint', 'secret-ref'] },
      authNotes: { type: 'string' },
      clearAuthNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await assertNoPendingRun(store, args.inspectionId)
      if (args.name === undefined && args.description === undefined && args.targetUrl === undefined
        && args.expectedResult === undefined && args.authMode === undefined && args.authNotes === undefined
        && args.clearAuthNotes !== true) {
        throw new Error('at least one inspection field must be supplied')
      }
      const definition = await store.load(args.inspectionId)
      if (args.name !== undefined) {
        assertSafePersistentText(args.name, 'inspection.name')
        definition.name = args.name
      }
      if (args.description !== undefined) {
        assertSafePersistentText(args.description, 'inspection.description')
        definition.description = args.description
      }
      if (args.targetUrl !== undefined) {
        assertHttpUrl(args.targetUrl)
        assertSafeForStorage({ url: args.targetUrl })
        definition.target.url = args.targetUrl
      }
      if (args.expectedResult !== undefined) {
        assertSafePersistentText(args.expectedResult, 'inspection.expectedResult')
        definition.expectedResult = args.expectedResult
      }
      if (args.authMode !== undefined) definition.auth.mode = args.authMode as AuthMode
      if (args.clearAuthNotes === true) delete definition.auth.notes
      else if (args.authNotes !== undefined) {
        assertSafePersistentText(args.authNotes, 'inspection.auth.notes')
        definition.auth.notes = args.authNotes
      }
      markEdited(definition)
      await store.save(definition)
      return `Updated inspection ${definition.id}. It is DRAFT and must be end-to-end validated before confirmation.${args.targetUrl === undefined ? '' : ' Re-teach the navigate step too if its stored URL must change.'}`
    },
  })

  const reteachBrowserStep = defineTool({
    name: 'patrol_reteach_browser_step',
    description: 'Re-execute and replace one existing non-typing browser step while preserving its stable step id. Use after patrol_begin_edit when a site changes.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: [...BROWSER_ACTIONS] },
      arguments: { type: 'json', required: true },
      stepName: { type: 'string' },
      expectedText: { type: 'string' },
      clearExpectedText: { type: 'boolean' },
      expectationMode: { type: 'string', enum: ['contains', 'not-contains'] },
      caseSensitive: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      clearCondition: { type: 'boolean' },
      locatorText: { type: 'string' },
      locatorRole: { type: 'string' },
      locatorTag: { type: 'string' },
      clearLocator: { type: 'boolean' },
      capturePageText: { type: 'boolean' },
      notes: { type: 'string' },
      clearNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await loadDraft(store, args.inspectionId)
      const current = requireToolStep(definition, args.stepId)
      if (current.tool === 'browser_type' || current.tool === 'browser_type_credential') {
        throw new Error(`${current.tool} must be re-taught with patrol_reteach_text or patrol_reteach_credential`)
      }
      if (args.stepName !== undefined) assertSafePersistentText(args.stepName, 'stepName')
      if (args.expectedText !== undefined) assertSafePersistentText(args.expectedText, 'expectedText')
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      if (args.locatorText !== undefined) assertSafePersistentText(args.locatorText, 'locatorText')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')

      const action = args.action as BrowserAction
      const tool = browserToolForAction(action)
      const jsonArguments = asJsonObject(args.arguments as JsonValue)
      assertSafeForStorage(jsonArguments)
      const dispatched = await runner.dispatch(tool, jsonArguments, exec)
      if (!dispatched.ok) return `Re-teach failed and the stored step was NOT changed. ${dispatched.error ?? dispatched.text}`

      const replacement: ToolStep = {
        id: current.id,
        kind: 'tool',
        name: args.stepName ?? current.name,
        tool,
        arguments: jsonArguments,
        ...updatedExpectation(current.expectation, args),
        ...updatedCondition(current.when, args),
        ...updatedLocator(current.locator, args),
        ...updatedArtifact(current, tool, args.capturePageText),
        ...updatedNotes(current.notes, args.notes, args.clearNotes),
        recordedAt: new Date().toISOString(),
      }
      replaceStep(definition, current.id, replacement)
      markEdited(definition)
      await store.save(definition)
      const output = tool === 'browser_read_page' || tool === 'browser_snapshot'
        ? untrustedPageData(dispatched.text)
        : dispatched.text
      return `Re-taught ${replacement.id} (${action} -> ${tool}) and kept its stable step id. Full runbook validation is now required.\n${output}`
    },
  })

  const reteachText = defineTool({
    name: 'patrol_reteach_text',
    description: 'Re-execute and replace an existing public text-input step, for example when a username or login selector changes.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      text: { type: 'string', required: true },
      clear: { type: 'boolean' },
      stepName: { type: 'string' },
      notes: { type: 'string' },
      clearNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await loadDraft(store, args.inspectionId)
      const current = requireToolStep(definition, args.stepId)
      if (current.tool !== 'browser_type') throw new Error(`${args.stepId} is ${current.tool}; patrol_reteach_text only replaces browser_type steps`)
      if (args.stepName !== undefined) assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      assertSafePlainTextInput(args.stepName ?? current.name, args.selector)
      assertSafePublicInputText(args.text)
      const browserArgs: JsonObject = { selector: args.selector, text: args.text, clear: args.clear ?? true }
      const dispatched = await runner.dispatch('browser_type', browserArgs, exec)
      if (!dispatched.ok) return `Re-teach failed and the stored username/public-text step was NOT changed. ${dispatched.error ?? dispatched.text}`
      const replacement: ToolStep = {
        id: current.id,
        kind: 'tool',
        name: args.stepName ?? current.name,
        tool: 'browser_type',
        arguments: browserArgs,
        ...(current.expectation === undefined ? {} : { expectation: current.expectation }),
        ...(current.when === undefined ? {} : { when: current.when }),
        ...(current.locator === undefined ? {} : { locator: current.locator }),
        ...updatedNotes(current.notes, args.notes, args.clearNotes),
        recordedAt: new Date().toISOString(),
      }
      replaceStep(definition, current.id, replacement)
      markEdited(definition)
      await store.save(definition)
      return `Re-taught ${current.id} public text input. The runbook remains DRAFT until patrol_validate passes and the user confirms it.`
    },
  })

  const reteachCredential = defineTool({
    name: 'patrol_reteach_credential',
    description: 'Re-execute and replace an existing credential-input step using a configured Harness credential reference. Use this when the password field selector or credential reference changes.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      credentialRef: { type: 'string', required: true },
      clear: { type: 'boolean' },
      stepName: { type: 'string' },
      notes: { type: 'string' },
      clearNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await loadDraft(store, args.inspectionId)
      const current = requireToolStep(definition, args.stepId)
      if (current.tool !== 'browser_type_credential') throw new Error(`${args.stepId} is ${current.tool}; patrol_reteach_credential only replaces browser_type_credential steps`)
      if (args.stepName !== undefined) assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      const credentials = ctx.get('credentials')
      if (credentials === undefined) throw new Error('Harness credential service is unavailable')
      const info = await credentials.describe(credentialRef(args.credentialRef))
      if (!info.configured) throw new Error(`Harness credential ${args.credentialRef} is not configured`)
      const runtimeArgs: JsonObject = { selector: args.selector, credentialRef: args.credentialRef, clear: args.clear ?? true }
      const dispatched = await runner.dispatch('browser_type_credential', runtimeArgs, exec)
      if (!dispatched.ok) return `Credential re-teach failed and the stored step was NOT changed. ${dispatched.error ?? dispatched.text}`
      const storedArgs: JsonObject = { selector: args.selector, credentialRef: credentialPlaceholder(args.credentialRef), clear: args.clear ?? true }
      const replacement: ToolStep = {
        id: current.id,
        kind: 'tool',
        name: args.stepName ?? current.name,
        tool: 'browser_type_credential',
        arguments: storedArgs,
        sensitive: true,
        ...(current.expectation === undefined ? {} : { expectation: current.expectation }),
        ...(current.when === undefined ? {} : { when: current.when }),
        ...(current.locator === undefined ? {} : { locator: current.locator }),
        ...updatedNotes(current.notes, args.notes, args.clearNotes),
        recordedAt: new Date().toISOString(),
      }
      replaceStep(definition, current.id, replacement)
      markEdited(definition)
      await store.save(definition)
      return `Re-taught ${current.id} with credential reference ${args.credentialRef}. No credential value was stored in the runbook. Full validation is required.`
    },
  })

  const reteachCheckpoint = defineTool({
    name: 'patrol_reteach_checkpoint',
    description: 'Edit an existing human checkpoint while keeping its stable step id, for example when a site changes from SMS verification to a generic approval step.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      stepName: { type: 'string' },
      prompt: { type: 'string' },
      reason: { type: 'string', enum: ['login', 'otp', 'approval', 'other'] },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      clearCondition: { type: 'boolean' },
      notes: { type: 'string' },
      clearNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await loadDraft(store, args.inspectionId)
      const current = requireCheckpointStep(definition, args.stepId)
      if (args.stepName !== undefined) assertSafePersistentText(args.stepName, 'stepName')
      if (args.prompt !== undefined) assertSafeCheckpointPrompt(args.prompt)
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      const replacement: CheckpointStep = {
        id: current.id,
        kind: 'checkpoint',
        name: args.stepName ?? current.name,
        prompt: args.prompt ?? current.prompt,
        reason: (args.reason ?? current.reason) as CheckpointStep['reason'],
        ...updatedCondition(current.when, args),
        ...updatedNotes(current.notes, args.notes, args.clearNotes),
        recordedAt: new Date().toISOString(),
      }
      replaceStep(definition, current.id, replacement)
      markEdited(definition)
      await store.save(definition)
      return `Updated checkpoint ${current.id}. Full DRAFT validation is required before the runbook can return to READY.`
    },
  })

  const validate = defineTool({
    name: 'patrol_validate',
    description: 'Run a complete DRAFT runbook end-to-end without making it READY. If a human checkpoint is reached, use patrol_resume_validation after the user completes it.',
    parameters: { inspectionId: { type: 'string', required: true } },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await loadDraft(store, args.inspectionId)
      const { report, paths } = await runner.run(definition, exec)
      if (report.status === 'passed') await markValidated(store, definition)
      return validationResultText(definition, report, paths, 'patrol_resume_validation')
    },
  })

  const resumeValidation = defineTool({
    name: 'patrol_resume_validation',
    description: 'Resume a persisted DRAFT validation run after the user completes its human checkpoint.',
    parameters: { inspectionId: { type: 'string', required: true } },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definition = await loadDraft(store, args.inspectionId)
      const { report, paths } = await runner.resume(definition, exec)
      if (report.status === 'passed') await markValidated(store, definition)
      return validationResultText(definition, report, paths, 'patrol_resume_validation')
    },
  })

  const confirmEdit = defineTool({
    name: 'patrol_confirm_edit',
    description: 'Return an edited DRAFT runbook to READY only after a successful full patrol_validate/patrol_resume_validation and explicit user confirmation.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      confirmed: { type: 'boolean', required: true },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!args.confirmed) throw new Error('explicit user confirmation is required')
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await loadDraft(store, args.inspectionId)
      assertValidatedAfterEdit(definition)
      assertRequiredArtifactsRepresented(definition)
      definition.status = 'ready'
      await store.save(definition)
      return `Edited runbook ${definition.id} is READY again with ${definition.steps.length} steps. Stored schedule resumes automatically if it is enabled: ${scheduleText(definition)}.`
    },
  })

  return [
    beginEdit,
    updateInspection,
    reteachBrowserStep,
    reteachText,
    reteachCredential,
    reteachCheckpoint,
    validate,
    resumeValidation,
    confirmEdit,
  ]
}

async function assertNoPendingRun(store: PatrolStore, inspectionId: string): Promise<void> {
  const pending = await store.loadResume(inspectionId)
  if (pending !== undefined) {
    throw new Error(`inspection ${inspectionId} has pending run ${pending.runId}; resume/abort it before editing or starting a new validation`)
  }
}

async function loadDraft(store: PatrolStore, inspectionId: string): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') throw new Error(`inspection ${inspectionId} is READY; call patrol_begin_edit before re-teaching or validation`)
  return definition
}

function requireToolStep(definition: InspectionDefinition, stepId: string): ToolStep {
  const step = definition.steps.find(item => item.id === stepId)
  if (step === undefined || step.kind !== 'tool') throw new Error(`tool step ${stepId} not found`)
  return step
}

function requireCheckpointStep(definition: InspectionDefinition, stepId: string): CheckpointStep {
  const step = definition.steps.find(item => item.id === stepId)
  if (step === undefined || step.kind !== 'checkpoint') throw new Error(`checkpoint ${stepId} not found`)
  return step
}

function replaceStep(definition: InspectionDefinition, stepId: string, replacement: ToolStep | CheckpointStep): void {
  const index = definition.steps.findIndex(item => item.id === stepId)
  if (index < 0) throw new Error(`step ${stepId} not found`)
  definition.steps[index] = replacement
}

function markEdited(definition: InspectionDefinition): void {
  definition.status = 'draft'
  definition.schemaVersion = '0.2'
  definition.metadata.updatedAt = new Date().toISOString()
  delete definition.metadata.validatedAt
}

async function markValidated(store: PatrolStore, definition: InspectionDefinition): Promise<void> {
  const latest = await store.load(definition.id)
  if (latest.status !== 'draft' || latest.metadata.updatedAt !== definition.metadata.updatedAt) {
    throw new Error('runbook changed while validation was running; validation result cannot be attached to the edited definition')
  }
  latest.metadata.validatedAt = new Date().toISOString()
  await store.save(latest)
}

function assertValidatedAfterEdit(definition: InspectionDefinition): void {
  const validatedAt = definition.metadata.validatedAt
  if (validatedAt === undefined) throw new Error('edited runbook has not passed patrol_validate yet')
  const validated = Date.parse(validatedAt)
  const updated = Date.parse(definition.metadata.updatedAt)
  if (!Number.isFinite(validated) || !Number.isFinite(updated) || validated < updated) {
    throw new Error('edited runbook changed after its last successful validation; run patrol_validate again')
  }
}

function updatedExpectation(current: TextExpectation | undefined, args: {
  expectedText?: string
  clearExpectedText?: boolean
  expectationMode?: string
  caseSensitive?: boolean
}): { expectation?: TextExpectation } {
  if (args.clearExpectedText === true) return {}
  if (args.expectedText === undefined) return current === undefined ? {} : { expectation: current }
  return {
    expectation: {
      mode: args.expectationMode === 'not-contains' ? 'not-contains' : 'contains',
      value: args.expectedText,
      caseSensitive: args.caseSensitive ?? false,
    },
  }
}

function updatedCondition(current: StepCondition | undefined, args: {
  conditionSourceStepId?: string
  conditionExpectedText?: string
  conditionMode?: string
  clearCondition?: boolean
}): { when?: StepCondition } {
  if (args.clearCondition === true) return {}
  const source = args.conditionSourceStepId
  const text = args.conditionExpectedText
  if (source === undefined && text === undefined) return current === undefined ? {} : { when: current }
  if (source === undefined || text === undefined) throw new Error('condition edits require both conditionSourceStepId and conditionExpectedText')
  return {
    when: {
      sourceStepId: source,
      mode: args.conditionMode === 'not-contains' ? 'not-contains' : 'contains',
      value: text,
      caseSensitive: false,
    },
  }
}

function updatedLocator(current: SemanticLocator | undefined, args: {
  locatorText?: string
  locatorRole?: string
  locatorTag?: string
  clearLocator?: boolean
}): { locator?: SemanticLocator } {
  if (args.clearLocator === true) return {}
  if (args.locatorText === undefined && args.locatorRole === undefined && args.locatorTag === undefined) {
    return current === undefined ? {} : { locator: current }
  }
  const locator = normalizeSemanticLocator({
    ...(args.locatorText === undefined ? {} : { text: args.locatorText }),
    ...(args.locatorRole === undefined ? {} : { role: args.locatorRole }),
    ...(args.locatorTag === undefined ? {} : { tag: args.locatorTag }),
  })
  return locator === undefined ? {} : { locator }
}

function updatedArtifact(current: ToolStep, tool: string, capturePageText: boolean | undefined): { artifact?: ToolStep['artifact'] } {
  if (tool === 'browser_screenshot') return { artifact: 'screenshot' }
  if (tool !== 'browser_read_page') return {}
  if (capturePageText === true) return { artifact: 'page-text' }
  if (capturePageText === false) return {}
  return current.tool === 'browser_read_page' && current.artifact === 'page-text' ? { artifact: 'page-text' } : {}
}

function updatedNotes(current: string | undefined, next: string | undefined, clear: boolean | undefined): { notes?: string } {
  if (clear === true) return {}
  if (next !== undefined) return { notes: next }
  return current === undefined ? {} : { notes: current }
}

function assertRequiredArtifactsRepresented(definition: InspectionDefinition): void {
  const requested = new Set(definition.artifacts.map(item => item.toLowerCase()))
  if (requested.has('screenshot') && !definition.steps.some(step => step.kind === 'tool' && step.tool === 'browser_screenshot')) {
    throw new Error('inspection requests screenshot but the runbook has no screenshot step')
  }
  if (requested.has('page-text')
    && !definition.steps.some(step => step.kind === 'tool' && step.tool === 'browser_read_page' && step.artifact === 'page-text')) {
    throw new Error('inspection requests page-text but no read-page step captures page text')
  }
  if (requested.has('page-summary')
    && !definition.steps.some(step => step.kind === 'tool' && step.tool === 'browser_read_page')) {
    throw new Error('inspection requests page-summary but the runbook has no read-page step')
  }
}

function validationResultText(
  definition: InspectionDefinition,
  report: Awaited<ReturnType<PatrolRunner['run']>>['report'],
  paths: Awaited<ReturnType<PatrolRunner['run']>>['paths'],
  resumeTool: string,
): string {
  const lines = [
    `DRAFT validation: ${summarizeReport(report)}`,
    `Run ID: ${report.runId}`,
    `Markdown report: ${paths.markdown}`,
    `JSON report: ${paths.json}`,
  ]
  const waiting = report.results.find(item => item.status === 'waiting')
  if (waiting !== undefined) {
    lines.push(`Validation checkpoint waiting: ${waiting.output ?? waiting.name}\nAfter the human verification is completed, call ${resumeTool} with inspectionId=${definition.id}.`)
  } else if (report.status === 'passed') {
    lines.push('Validation passed. Summarize the validated changes for the user and request explicit confirmation before patrol_confirm_edit.')
  } else {
    lines.push('Validation failed. Keep the runbook DRAFT, repair/re-teach the failed step, and validate again.')
  }
  return lines.join('\n')
}

function scheduleText(definition: InspectionDefinition): string {
  if (definition.schedule === null) return 'none'
  return `${definition.schedule.enabled ? 'enabled' : 'disabled'}${definition.schedule.cron ? ` (${definition.schedule.cron})` : ''}`
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
