import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolDefinition, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSafeForStorage, assertSafePersistentText, untrustedPageData } from './security.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type {
  InspectionDefinition,
  InspectionStep,
  JsonObject,
  RunArtifact,
  SemanticLocator,
  StepCondition,
  TextExpectation,
  ToolStep,
} from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export interface PatrolActionToolsOptions {
  maxSteps: number
}

interface CommonRecordArgs {
  inspectionId: string
  stepName: string
  expectedText?: string
  expectationMode?: string
  caseSensitive?: boolean
  conditionSourceStepId?: string
  conditionExpectedText?: string
  conditionMode?: string
  locatorText?: string
  locatorRole?: string
  locatorTag?: string
  notes?: string
}

interface RecordActionInput extends CommonRecordArgs {
  tool: string
  browserArgs: JsonObject
  artifact?: ToolStep['artifact']
  untrustedOutput?: boolean
}

interface TeachingResultRecorder {
  recordTeachingStepResult?: (
    inspectionId: string,
    stepId: string,
    update: { output?: string; artifacts?: RunArtifact[]; pageText?: string },
  ) => Promise<RunArtifact[]>
}

export function registerPatrolActionTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolActionToolsOptions,
): () => void {
  const definitions = createDefinitions(store, runner, options)
  const disposers = definitions.map(definition => ctx.tools.register(definition))
  return () => { for (const dispose of disposers) dispose() }
}

function createDefinitions(store: PatrolStore, runner: PatrolRunner, options: PatrolActionToolsOptions): ToolDefinition[] {
  const navigate = defineTool({
    name: 'patrol_navigate',
    description: 'Navigate to a URL and record the step. Prefer this over patrol_browser_step so no nested JSON arguments object is needed.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      url: { type: 'string', required: true },
      tabId: { type: 'integer' },
      newTab: { type: 'boolean' },
      expectedText: { type: 'string' },
      expectationMode: { type: 'string', enum: ['contains', 'not-contains'] },
      caseSensitive: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        ...common(args),
        tool: 'browser_navigate',
        browserArgs: compactObject({ url: args.url, action: 'navigate', tabId: args.tabId, newTab: args.newTab }),
      })
    },
  })

  const snapshot = defineTool({
    name: 'patrol_snapshot',
    description: 'Take and record a safe interactive-element snapshot with flat parameters.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string' },
      maxElements: { type: 'integer' },
      includeHidden: { type: 'boolean' },
      tabId: { type: 'integer' },
      expectedText: { type: 'string' },
      expectationMode: { type: 'string', enum: ['contains', 'not-contains'] },
      caseSensitive: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        ...common(args),
        tool: 'browser_snapshot',
        browserArgs: compactObject({ selector: args.selector, maxElements: args.maxElements, includeHidden: args.includeHidden, tabId: args.tabId }),
        untrustedOutput: true,
      })
    },
  })

  const readPage = defineTool({
    name: 'patrol_read_page',
    description: 'Read visible page text and record the step with flat parameters. capturePageText defaults to true so summaries and weekly reports keep source material.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string' },
      maxChars: { type: 'integer' },
      tabId: { type: 'integer' },
      capturePageText: { type: 'boolean' },
      expectedText: { type: 'string' },
      expectationMode: { type: 'string', enum: ['contains', 'not-contains'] },
      caseSensitive: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        ...common(args),
        tool: 'browser_read_page',
        browserArgs: compactObject({ selector: args.selector, maxChars: args.maxChars, tabId: args.tabId }),
        ...(args.capturePageText === false ? {} : { artifact: 'page-text' as const }),
        untrustedOutput: true,
      })
    },
  })

  const count = defineTool({
    name: 'patrol_count',
    description: 'Count visible DOM elements matching a stable observed selector and optionally assert an exact expected count.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      visibleOnly: { type: 'boolean' },
      tabId: { type: 'integer' },
      expectedCount: { type: 'integer', description: 'When provided, store an exact count assertion for replay.' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (args.expectedCount !== undefined && (!Number.isInteger(args.expectedCount) || args.expectedCount < 0)) {
        throw new Error('expectedCount must be a non-negative integer')
      }
      return await recordAction(store, runner, options.maxSteps, exec, {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        ...(args.expectedCount === undefined ? {} : {
          expectedText: `: ${args.expectedCount} element(s)`,
          expectationMode: 'contains',
          caseSensitive: false,
        }),
        ...(args.conditionSourceStepId === undefined ? {} : { conditionSourceStepId: args.conditionSourceStepId }),
        ...(args.conditionExpectedText === undefined ? {} : { conditionExpectedText: args.conditionExpectedText }),
        ...(args.conditionMode === undefined ? {} : { conditionMode: args.conditionMode }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        tool: 'browser_count',
        browserArgs: compactObject({ selector: args.selector, visibleOnly: args.visibleOnly, tabId: args.tabId }),
      })
    },
  })

  const loginState = defineTool({
    name: 'patrol_login_state',
    description: 'Detect and record whether the current page already has an authenticated Patrol browser session or visibly requires login. Use immediately after target navigation; condition credential/login-click steps on login-state=login-required so persistent browser cookies are reused instead of logging in repeatedly.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      tabId: { type: 'integer' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        ...(args.conditionSourceStepId === undefined ? {} : { conditionSourceStepId: args.conditionSourceStepId }),
        ...(args.conditionExpectedText === undefined ? {} : { conditionExpectedText: args.conditionExpectedText }),
        ...(args.conditionMode === undefined ? {} : { conditionMode: args.conditionMode }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        tool: 'browser_login_state',
        browserArgs: compactObject({ tabId: args.tabId }),
      })
    },
  })

  const detectAuthChallenge = defineTool({
    name: 'patrol_detect_auth_challenge',
    description: 'Classify whether the current login flow shows secondary human verification and record the classification. It detects only; it does not solve or bypass challenges.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      tabId: { type: 'integer' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        ...(args.conditionSourceStepId === undefined ? {} : { conditionSourceStepId: args.conditionSourceStepId }),
        ...(args.conditionExpectedText === undefined ? {} : { conditionExpectedText: args.conditionExpectedText }),
        ...(args.conditionMode === undefined ? {} : { conditionMode: args.conditionMode }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        tool: 'browser_detect_auth_challenge',
        browserArgs: compactObject({ tabId: args.tabId }),
      })
    },
  })

  const click = defineTool({
    name: 'patrol_click',
    description: 'Click an observed CSS selector and record the step. Optional semantic locator fields enable conservative self-healing on replay.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      tabId: { type: 'integer' },
      expectedText: { type: 'string' },
      expectationMode: { type: 'string', enum: ['contains', 'not-contains'] },
      caseSensitive: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      locatorText: { type: 'string' },
      locatorRole: { type: 'string' },
      locatorTag: { type: 'string' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        ...common(args),
        tool: 'browser_click',
        browserArgs: compactObject({ selector: args.selector, tabId: args.tabId }),
      })
    },
  })

  const press = defineTool({
    name: 'patrol_press',
    description: 'Press a key and record the step with flat parameters.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      key: { type: 'string', required: true },
      selector: { type: 'string' },
      tabId: { type: 'integer' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        ...(args.conditionSourceStepId === undefined ? {} : { conditionSourceStepId: args.conditionSourceStepId }),
        ...(args.conditionExpectedText === undefined ? {} : { conditionExpectedText: args.conditionExpectedText }),
        ...(args.conditionMode === undefined ? {} : { conditionMode: args.conditionMode }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        tool: 'browser_press',
        browserArgs: compactObject({ key: args.key, selector: args.selector, tabId: args.tabId }),
      })
    },
  })

  const scroll = defineTool({
    name: 'patrol_scroll',
    description: 'Scroll and record the step with flat parameters.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      direction: { type: 'string', required: true, enum: ['up', 'down', 'left', 'right', 'top', 'bottom'] },
      amount: { type: 'integer' },
      selector: { type: 'string' },
      tabId: { type: 'integer' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        ...(args.conditionSourceStepId === undefined ? {} : { conditionSourceStepId: args.conditionSourceStepId }),
        ...(args.conditionExpectedText === undefined ? {} : { conditionExpectedText: args.conditionExpectedText }),
        ...(args.conditionMode === undefined ? {} : { conditionMode: args.conditionMode }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        tool: 'browser_scroll',
        browserArgs: compactObject({ direction: args.direction, amount: args.amount, selector: args.selector, tabId: args.tabId }),
      })
    },
  })

  const wait = defineTool({
    name: 'patrol_wait',
    description: 'Wait for a selector or sleep, then record the step with flat parameters.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string' },
      condition: { type: 'string', enum: ['visible', 'gone'] },
      timeoutMs: { type: 'integer' },
      tabId: { type: 'integer' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        ...(args.conditionSourceStepId === undefined ? {} : { conditionSourceStepId: args.conditionSourceStepId }),
        ...(args.conditionExpectedText === undefined ? {} : { conditionExpectedText: args.conditionExpectedText }),
        ...(args.conditionMode === undefined ? {} : { conditionMode: args.conditionMode }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        tool: 'browser_wait',
        browserArgs: compactObject({ selector: args.selector, condition: args.condition, timeoutMs: args.timeoutMs, tabId: args.tabId }),
      })
    },
  })

  const screenshot = defineTool({
    name: 'patrol_screenshot',
    description: 'Capture a screenshot and record it as a Patrol artifact without nested JSON arguments.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      tabId: { type: 'integer' },
      format: { type: 'string', enum: ['png', 'jpeg'] },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      return await recordAction(store, runner, options.maxSteps, exec, {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        ...(args.conditionSourceStepId === undefined ? {} : { conditionSourceStepId: args.conditionSourceStepId }),
        ...(args.conditionExpectedText === undefined ? {} : { conditionExpectedText: args.conditionExpectedText }),
        ...(args.conditionMode === undefined ? {} : { conditionMode: args.conditionMode }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        tool: 'browser_screenshot',
        browserArgs: compactObject({ tabId: args.tabId, format: args.format }),
        artifact: 'screenshot',
      })
    },
  })

  return [navigate, snapshot, readPage, count, loginState, detectAuthChallenge, click, press, scroll, wait, screenshot]
}

async function recordAction(
  store: PatrolStore,
  runner: PatrolRunner,
  maxSteps: number,
  exec: ToolRunContext,
  input: RecordActionInput,
): Promise<string> {
  assertSafePersistentText(input.stepName, 'stepName')
  if (input.notes !== undefined) assertSafePersistentText(input.notes, 'step notes')
  if (input.expectedText !== undefined) assertSafePersistentText(input.expectedText, 'expectedText')
  if (input.conditionExpectedText !== undefined) assertSafePersistentText(input.conditionExpectedText, 'conditionExpectedText')
  if (input.locatorText !== undefined) assertSafePersistentText(input.locatorText, 'locatorText')
  assertSafeForStorage(input.browserArgs)

  const definition = await loadEditable(store, input.inspectionId, maxSteps)
  const dispatched = await runner.dispatch(input.tool, input.browserArgs, exec)
  if (!dispatched.ok) {
    return `Teaching action failed and was NOT recorded. ${dispatched.error ?? 'Unknown browser error'}\n${dispatched.text}`
  }

  const step: ToolStep = {
    id: nextStepId(definition.steps),
    kind: 'tool',
    name: input.stepName,
    tool: input.tool,
    arguments: input.browserArgs,
    ...optionalExpectation(input.expectedText, input.expectationMode, input.caseSensitive),
    ...optionalCondition(input.conditionSourceStepId, input.conditionExpectedText, input.conditionMode),
    ...optionalLocator(input.locatorText, input.locatorRole, input.locatorTag),
    ...(input.artifact === undefined ? {} : { artifact: input.artifact }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
    recordedAt: new Date().toISOString(),
  }
  definition.steps.push(step)
  definition.schemaVersion = '0.2'
  definition.metadata.updatedAt = new Date().toISOString()
  await store.save(definition)

  let displayText = dispatched.text
  const teachingArtifacts: RunArtifact[] = []
  if (input.tool === 'browser_screenshot') {
    const providerPath = objectString(dispatched.value, 'path')
    const workspaceRoot = exec.agent?.session.header.cwd
    if (providerPath !== undefined && workspaceRoot !== undefined && workspaceRoot.trim() !== '') {
      try {
        const organizedPath = await store.organizeTeachingScreenshot(input.inspectionId, providerPath, workspaceRoot)
        teachingArtifacts.push({ kind: 'screenshot', path: organizedPath })
        displayText = displayText.includes(providerPath)
          ? displayText.split(providerPath).join(organizedPath)
          : `${displayText}\nPatrol workspace screenshot: ${organizedPath}`
        displayText = `${displayText}\n\n![巡检截图](${markdownImagePath(organizedPath)})`
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        displayText = `${displayText}\nScreenshot organization warning: ${message}`
      }
    }
  }

  const output = input.untrustedOutput === true ? untrustedPageData(displayText) : displayText
  await (store as TeachingResultRecorder).recordTeachingStepResult?.(input.inspectionId, step.id, {
    output,
    ...(teachingArtifacts.length === 0 ? {} : { artifacts: teachingArtifacts }),
    ...(input.tool === 'browser_read_page' && input.artifact === 'page-text' ? { pageText: displayText } : {}),
  })
  return `Executed and recorded ${step.id} (${input.tool}).\n${output}`
}

function common(args: CommonRecordArgs): CommonRecordArgs {
  return {
    inspectionId: args.inspectionId,
    stepName: args.stepName,
    ...(args.expectedText === undefined ? {} : { expectedText: args.expectedText }),
    ...(args.expectationMode === undefined ? {} : { expectationMode: args.expectationMode }),
    ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
    ...(args.conditionSourceStepId === undefined ? {} : { conditionSourceStepId: args.conditionSourceStepId }),
    ...(args.conditionExpectedText === undefined ? {} : { conditionExpectedText: args.conditionExpectedText }),
    ...(args.conditionMode === undefined ? {} : { conditionMode: args.conditionMode }),
    ...(args.locatorText === undefined ? {} : { locatorText: args.locatorText }),
    ...(args.locatorRole === undefined ? {} : { locatorRole: args.locatorRole }),
    ...(args.locatorTag === undefined ? {} : { locatorTag: args.locatorTag }),
    ...(args.notes === undefined ? {} : { notes: args.notes }),
  }
}

function compactObject(value: Record<string, string | number | boolean | undefined>): JsonObject {
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) {
    if (child !== undefined) out[key] = child
  }
  return out
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'string' && child.length > 0 ? child : undefined
}

function markdownImagePath(path: string): string {
  return `<${path.replace(/\\/g, '/')}>`
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; call patrol_begin_edit for an existing READY runbook`)
  if (definition.steps.length >= maxSteps) throw new Error(`runbook reached maxSteps=${maxSteps}`)
  return definition
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match !== null) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}

function optionalExpectation(expectedText: string | undefined, mode: string | undefined, caseSensitive: boolean | undefined): { expectation?: TextExpectation } {
  if (expectedText === undefined) return {}
  return {
    expectation: {
      mode: mode === 'not-contains' ? 'not-contains' : 'contains',
      value: expectedText,
      caseSensitive: caseSensitive ?? false,
    },
  }
}

function optionalCondition(sourceStepId: string | undefined, expectedText: string | undefined, mode: string | undefined): { when?: StepCondition } {
  if (sourceStepId === undefined && expectedText === undefined) return {}
  if (sourceStepId === undefined || expectedText === undefined) throw new Error('conditional steps require both conditionSourceStepId and conditionExpectedText')
  return {
    when: {
      sourceStepId,
      mode: mode === 'not-contains' ? 'not-contains' : 'contains',
      value: expectedText,
      caseSensitive: false,
    },
  }
}

function optionalLocator(text: string | undefined, role: string | undefined, tag: string | undefined): { locator?: SemanticLocator } {
  const locator: SemanticLocator = {}
  if (text !== undefined && text.trim() !== '') locator.text = text.trim()
  if (role !== undefined && role.trim() !== '') locator.role = role.trim().toLowerCase()
  if (tag !== undefined && tag.trim() !== '') locator.tag = tag.trim().toLowerCase()
  return Object.keys(locator).length === 0 ? {} : { locator }
}
