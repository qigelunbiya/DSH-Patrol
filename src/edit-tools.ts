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
        // Enter explicit edit persistence even when the flow is already DRAFT.
        // This clears any stale interactive-teaching lifecycle in production.
        await persistRunbookEdit(store, definition)
        return `Inspection ${definition.id} is already DRAFT and is now isolated for explicit Runbook editing. For additive Runbook-only changes, use the dedicated patrol_insert_* structural tools; for parameter-only changes to existing wait/screenshot/read/navigate steps, use patrol_update_* structural tools. Neither path should touch the CURRENT browser. Use patrol_reteach_* only when a live selector/action must actually be relearned. Verify the saved graph with patrol_show, then run patrol_validate before patrol_confirm_edit.`
      }
      markEdited(definition)
      await persistRunbookEdit(store, definition)
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
      targetUrl: { type: 'string', description: 'Browser-target URL only.' },
      desktopApp: { type: 'string', description: 'Desktop-target app label only.' },
      desktopProcessName: { type: 'string' },
      clearDesktopProcessName: { type: 'boolean' },
      desktopTitleContains: { type: 'string' },
      clearDesktopTitleContains: { type: 'boolean' },
      expectedResult: { type: 'string' },
      authMode: { type: 'string', enum: ['none', 'existing-session', 'manual-checkpoint', 'secret-ref'] },
      authNotes: { type: 'string' },
      clearAuthNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await assertNoPendingRun(store, args.inspectionId)
      if (args.name === undefined && args.description === undefined && args.targetUrl === undefined
        && args.desktopApp === undefined && args.desktopProcessName === undefined && args.clearDesktopProcessName !== true
        && args.desktopTitleContains === undefined && args.clearDesktopTitleContains !== true
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
        if (definition.target.type !== 'browser') throw new Error('targetUrl can only update a browser-target inspection')
        assertHttpUrl(args.targetUrl)
        assertSafeForStorage({ url: args.targetUrl })
        definition.target.url = args.targetUrl
      }
      if (args.desktopApp !== undefined) {
        if (definition.target.type !== 'desktop') throw new Error('desktopApp can only update a desktop-target inspection')
        assertSafePersistentText(args.desktopApp, 'inspection.target.app')
        definition.target.app = args.desktopApp
      }
      if (args.desktopProcessName !== undefined && args.clearDesktopProcessName === true) {
        throw new Error('desktopProcessName and clearDesktopProcessName cannot both be supplied')
      }
      if (args.desktopTitleContains !== undefined && args.clearDesktopTitleContains === true) {
        throw new Error('desktopTitleContains and clearDesktopTitleContains cannot both be supplied')
      }
      if (args.desktopProcessName !== undefined || args.clearDesktopProcessName === true
        || args.desktopTitleContains !== undefined || args.clearDesktopTitleContains === true) {
        if (definition.target.type !== 'desktop') throw new Error('desktop target hints can only update a desktop-target inspection')
        if (args.clearDesktopProcessName === true) delete definition.target.processName
        else if (args.desktopProcessName !== undefined) {
          assertSafePersistentText(args.desktopProcessName, 'inspection.target.processName')
          definition.target.processName = args.desktopProcessName
        }
        if (args.clearDesktopTitleContains === true) delete definition.target.titleContains
        else if (args.desktopTitleContains !== undefined) {
          assertSafePersistentText(args.desktopTitleContains, 'inspection.target.titleContains')
          definition.target.titleContains = args.desktopTitleContains
        }
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
      await persistRunbookEdit(store, definition)
      return `Updated inspection ${definition.id}. It is DRAFT and must be end-to-end validated before confirmation.${args.targetUrl === undefined ? '' : ' If a stored browser_navigate step should use the same new URL, update that step structurally with patrol_update_navigate_step; only re-teach when live navigation semantics actually changed.'}${definition.target.type === 'desktop' ? ' Desktop target metadata is human/stable app identity; live window state should still be resolved with desktop_list_windows/desktop_snapshot.' : ''}`
    },
  })

  const insertWaitStep = defineTool({
    name: 'patrol_insert_wait_step',
    description: 'Structurally insert a browser wait into an existing DRAFT Runbook with flat parameters, WITHOUT executing the CURRENT browser page. Prefer this over patrol_insert_browser_step for requests such as "after step X wait 5 seconds".',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      timeoutMs: { type: 'integer', required: true },
      selector: { type: 'string' },
      condition: { type: 'string', enum: ['visible', 'gone'] },
      tabId: { type: 'integer' },
      beforeStepId: { type: 'string' },
      afterStepId: { type: 'string' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 0) throw new Error('timeoutMs must be a non-negative integer')
      if (args.condition !== undefined && args.selector === undefined) throw new Error('condition requires selector')
      const browserArgs: JsonObject = { timeoutMs: args.timeoutMs }
      if (args.selector !== undefined) browserArgs.selector = args.selector
      if (args.condition !== undefined) browserArgs.condition = args.condition
      if (args.tabId !== undefined) browserArgs.tabId = args.tabId
      return await insertStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        beforeStepId: args.beforeStepId,
        afterStepId: args.afterStepId,
        step: {
          kind: 'tool',
          name: args.stepName,
          tool: 'browser_wait',
          arguments: browserArgs,
          ...(args.notes === undefined ? {} : { notes: args.notes }),
        },
      })
    },
  })

  const insertScreenshotStep = defineTool({
    name: 'patrol_insert_screenshot_step',
    description: 'Structurally insert a screenshot artifact step into an existing DRAFT Runbook with flat parameters, WITHOUT executing the CURRENT browser page.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      format: { type: 'string', enum: ['png', 'jpeg'] },
      tabId: { type: 'integer' },
      beforeStepId: { type: 'string' },
      afterStepId: { type: 'string' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      const browserArgs: JsonObject = {}
      if (args.format !== undefined) browserArgs.format = args.format
      if (args.tabId !== undefined) browserArgs.tabId = args.tabId
      return await insertStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        beforeStepId: args.beforeStepId,
        afterStepId: args.afterStepId,
        step: {
          kind: 'tool',
          name: args.stepName,
          tool: 'browser_screenshot',
          arguments: browserArgs,
          artifact: 'screenshot',
          ...(args.notes === undefined ? {} : { notes: args.notes }),
        },
      })
    },
  })

  const insertReadPageStep = defineTool({
    name: 'patrol_insert_read_page_step',
    description: 'Structurally insert a page-read step into an existing DRAFT Runbook with flat parameters, WITHOUT executing the CURRENT browser page. capturePageText defaults to true.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string' },
      maxChars: { type: 'integer' },
      tabId: { type: 'integer' },
      capturePageText: { type: 'boolean' },
      beforeStepId: { type: 'string' },
      afterStepId: { type: 'string' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.maxChars !== undefined && (!Number.isInteger(args.maxChars) || args.maxChars <= 0)) {
        throw new Error('maxChars must be a positive integer')
      }
      const browserArgs: JsonObject = {}
      if (args.selector !== undefined) browserArgs.selector = args.selector
      if (args.maxChars !== undefined) browserArgs.maxChars = args.maxChars
      if (args.tabId !== undefined) browserArgs.tabId = args.tabId
      return await insertStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        beforeStepId: args.beforeStepId,
        afterStepId: args.afterStepId,
        step: {
          kind: 'tool',
          name: args.stepName,
          tool: 'browser_read_page',
          arguments: browserArgs,
          ...(args.capturePageText === false ? {} : { artifact: 'page-text' as const }),
          ...(args.notes === undefined ? {} : { notes: args.notes }),
        },
      })
    },
  })

  const insertNavigateStep = defineTool({
    name: 'patrol_insert_navigate_step',
    description: 'Structurally insert a known navigation step into an existing DRAFT Runbook with flat parameters, WITHOUT navigating the CURRENT browser page.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      url: { type: 'string', required: true },
      tabId: { type: 'integer' },
      newTab: { type: 'boolean' },
      beforeStepId: { type: 'string' },
      afterStepId: { type: 'string' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      assertHttpUrl(args.url)
      if (args.newTab === true) throw new Error('stored browser_navigate steps must reuse the active tab; newTab=true is not replay-stable')
      const browserArgs: JsonObject = { url: args.url, action: 'navigate' }
      if (args.tabId !== undefined) browserArgs.tabId = args.tabId
      if (args.newTab !== undefined) browserArgs.newTab = args.newTab
      return await insertStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        beforeStepId: args.beforeStepId,
        afterStepId: args.afterStepId,
        step: {
          kind: 'tool',
          name: args.stepName,
          tool: 'browser_navigate',
          arguments: browserArgs,
          ...(args.notes === undefined ? {} : { notes: args.notes }),
        },
      })
    },
  })

  const insertClickStep = defineTool({
    name: 'patrol_insert_click_step',
    description: 'Structurally insert a click step into an existing DRAFT Runbook WITHOUT executing the CURRENT browser page. Use only when the selector/semantic locator is already known from the saved Runbook or fresh CURRENT evidence; never guess a selector. Otherwise use patrol_reteach_browser_step or live teaching.',
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
      beforeStepId: { type: 'string' },
      afterStepId: { type: 'string' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!String(args.selector ?? '').trim()) throw new Error('selector is required')
      if (args.expectedText !== undefined) assertSafePersistentText(args.expectedText, 'expectedText')
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      if (args.locatorText !== undefined) assertSafePersistentText(args.locatorText, 'locatorText')
      const browserArgs: JsonObject = { selector: args.selector }
      if (args.tabId !== undefined) browserArgs.tabId = args.tabId
      return await insertStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        beforeStepId: args.beforeStepId,
        afterStepId: args.afterStepId,
        step: {
          kind: 'tool',
          name: args.stepName,
          tool: 'browser_click',
          arguments: browserArgs,
          ...updatedExpectation(undefined, args),
          ...updatedCondition(undefined, args),
          ...updatedLocator(undefined, args),
          ...(args.notes === undefined ? {} : { notes: args.notes }),
        },
      })
    },
  })

  const insertBrowserStep = defineTool({
    name: 'patrol_insert_browser_step',
    description: 'Advanced structural-edit fallback for a non-typing browser step. This API requires a nested JSON arguments object; prefer patrol_insert_wait_step, patrol_insert_screenshot_step, patrol_insert_read_page_step, patrol_insert_navigate_step, or patrol_insert_click_step whenever one matches the requested change. It never executes the CURRENT browser page.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      action: { type: 'string', required: true, enum: [...BROWSER_ACTIONS] },
      arguments: { type: 'json', required: true },
      beforeStepId: { type: 'string' },
      afterStepId: { type: 'string' },
      expectedText: { type: 'string' },
      expectationMode: { type: 'string', enum: ['contains', 'not-contains'] },
      caseSensitive: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      locatorText: { type: 'string' },
      locatorRole: { type: 'string' },
      locatorTag: { type: 'string' },
      capturePageText: { type: 'boolean' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.expectedText !== undefined) assertSafePersistentText(args.expectedText, 'expectedText')
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      if (args.locatorText !== undefined) assertSafePersistentText(args.locatorText, 'locatorText')
      const action = args.action as BrowserAction
      const tool = browserToolForAction(action)
      const jsonArguments = asJsonObject(args.arguments as JsonValue)
      const artifact = tool === 'browser_screenshot'
        ? 'screenshot' as const
        : tool === 'browser_read_page' && args.capturePageText !== false
          ? 'page-text' as const
          : undefined
      return await insertStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        beforeStepId: args.beforeStepId,
        afterStepId: args.afterStepId,
        step: {
          kind: 'tool',
          name: args.stepName,
          tool,
          arguments: jsonArguments,
          ...updatedExpectation(undefined, args),
          ...updatedCondition(undefined, args),
          ...updatedLocator(undefined, args),
          ...(artifact === undefined ? {} : { artifact }),
          ...(args.notes === undefined ? {} : { notes: args.notes }),
        },
      })
    },
  })

  const updateWaitStep = defineTool({
    name: 'patrol_update_wait_step',
    description: 'Structurally update an existing browser_wait step in a DRAFT Runbook with flat parameters while preserving its stable step id and position. This does NOT execute the CURRENT browser page.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      timeoutMs: { type: 'integer' },
      selector: { type: 'string' },
      clearSelector: { type: 'boolean' },
      condition: { type: 'string', enum: ['visible', 'gone'] },
      clearCondition: { type: 'boolean' },
      tabId: { type: 'integer' },
      clearTabId: { type: 'boolean' },
      stepName: { type: 'string' },
      notes: { type: 'string' },
      clearNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.timeoutMs !== undefined && (!Number.isInteger(args.timeoutMs) || args.timeoutMs < 0)) throw new Error('timeoutMs must be a non-negative integer')
      if (args.selector !== undefined && args.clearSelector === true) throw new Error('selector and clearSelector cannot both be supplied')
      if (args.condition !== undefined && args.clearCondition === true) throw new Error('condition and clearCondition cannot both be supplied')
      if (args.tabId !== undefined && args.clearTabId === true) throw new Error('tabId and clearTabId cannot both be supplied')
      if (args.notes !== undefined && args.clearNotes === true) throw new Error('notes and clearNotes cannot both be supplied')
      if (args.clearSelector === true && args.condition !== undefined) throw new Error('condition cannot be supplied while clearing selector')
      if (args.timeoutMs === undefined && args.selector === undefined && args.clearSelector !== true
        && args.condition === undefined && args.clearCondition !== true
        && args.tabId === undefined && args.clearTabId !== true
        && args.stepName === undefined && args.notes === undefined && args.clearNotes !== true) {
        throw new Error('at least one wait-step field must be changed')
      }
      const argumentPatch: JsonObject = {}
      if (args.timeoutMs !== undefined) argumentPatch.timeoutMs = args.timeoutMs
      if (args.selector !== undefined) argumentPatch.selector = args.selector
      if (args.condition !== undefined) argumentPatch.condition = args.condition
      if (args.tabId !== undefined) argumentPatch.tabId = args.tabId
      const clearArgumentKeys: string[] = []
      if (args.clearSelector === true) clearArgumentKeys.push('selector', 'condition')
      else if (args.clearCondition === true) clearArgumentKeys.push('condition')
      if (args.clearTabId === true) clearArgumentKeys.push('tabId')
      return await updateStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        stepId: args.stepId,
        expectedTool: 'browser_wait',
        argumentPatch,
        clearArgumentKeys,
        ...(args.stepName === undefined ? {} : { stepName: args.stepName }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.clearNotes === true ? { clearNotes: true } : {}),
      })
    },
  })

  const updateScreenshotStep = defineTool({
    name: 'patrol_update_screenshot_step',
    description: 'Structurally update an existing browser_screenshot step in a DRAFT Runbook without taking a screenshot now. The step id and position are preserved.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      format: { type: 'string', enum: ['png', 'jpeg'] },
      clearFormat: { type: 'boolean' },
      tabId: { type: 'integer' },
      clearTabId: { type: 'boolean' },
      stepName: { type: 'string' },
      notes: { type: 'string' },
      clearNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.format !== undefined && args.clearFormat === true) throw new Error('format and clearFormat cannot both be supplied')
      if (args.tabId !== undefined && args.clearTabId === true) throw new Error('tabId and clearTabId cannot both be supplied')
      if (args.notes !== undefined && args.clearNotes === true) throw new Error('notes and clearNotes cannot both be supplied')
      if (args.format === undefined && args.clearFormat !== true
        && args.tabId === undefined && args.clearTabId !== true
        && args.stepName === undefined && args.notes === undefined && args.clearNotes !== true) {
        throw new Error('at least one screenshot-step field must be changed')
      }
      const argumentPatch: JsonObject = {}
      if (args.format !== undefined) argumentPatch.format = args.format
      if (args.tabId !== undefined) argumentPatch.tabId = args.tabId
      const clearArgumentKeys: string[] = []
      if (args.clearFormat === true) clearArgumentKeys.push('format')
      if (args.clearTabId === true) clearArgumentKeys.push('tabId')
      return await updateStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        stepId: args.stepId,
        expectedTool: 'browser_screenshot',
        argumentPatch,
        clearArgumentKeys,
        artifact: 'screenshot',
        ...(args.stepName === undefined ? {} : { stepName: args.stepName }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.clearNotes === true ? { clearNotes: true } : {}),
      })
    },
  })

  const updateReadPageStep = defineTool({
    name: 'patrol_update_read_page_step',
    description: 'Structurally update an existing browser_read_page step in a DRAFT Runbook without reading the CURRENT page. Unspecified browser arguments are preserved.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      selector: { type: 'string' },
      clearSelector: { type: 'boolean' },
      maxChars: { type: 'integer' },
      clearMaxChars: { type: 'boolean' },
      tabId: { type: 'integer' },
      clearTabId: { type: 'boolean' },
      capturePageText: { type: 'boolean' },
      stepName: { type: 'string' },
      notes: { type: 'string' },
      clearNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.maxChars !== undefined && (!Number.isInteger(args.maxChars) || args.maxChars <= 0)) throw new Error('maxChars must be a positive integer')
      if (args.selector !== undefined && args.clearSelector === true) throw new Error('selector and clearSelector cannot both be supplied')
      if (args.maxChars !== undefined && args.clearMaxChars === true) throw new Error('maxChars and clearMaxChars cannot both be supplied')
      if (args.tabId !== undefined && args.clearTabId === true) throw new Error('tabId and clearTabId cannot both be supplied')
      if (args.notes !== undefined && args.clearNotes === true) throw new Error('notes and clearNotes cannot both be supplied')
      if (args.selector === undefined && args.clearSelector !== true
        && args.maxChars === undefined && args.clearMaxChars !== true
        && args.tabId === undefined && args.clearTabId !== true
        && args.capturePageText === undefined
        && args.stepName === undefined && args.notes === undefined && args.clearNotes !== true) {
        throw new Error('at least one read-page field must be changed')
      }
      const argumentPatch: JsonObject = {}
      if (args.selector !== undefined) argumentPatch.selector = args.selector
      if (args.maxChars !== undefined) argumentPatch.maxChars = args.maxChars
      if (args.tabId !== undefined) argumentPatch.tabId = args.tabId
      const clearArgumentKeys: string[] = []
      if (args.clearSelector === true) clearArgumentKeys.push('selector')
      if (args.clearMaxChars === true) clearArgumentKeys.push('maxChars')
      if (args.clearTabId === true) clearArgumentKeys.push('tabId')
      return await updateStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        stepId: args.stepId,
        expectedTool: 'browser_read_page',
        argumentPatch,
        clearArgumentKeys,
        ...(args.capturePageText === undefined ? {} : { artifact: args.capturePageText ? 'page-text' : null }),
        ...(args.stepName === undefined ? {} : { stepName: args.stepName }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.clearNotes === true ? { clearNotes: true } : {}),
      })
    },
  })

  const updateNavigateStep = defineTool({
    name: 'patrol_update_navigate_step',
    description: 'Structurally update an existing browser_navigate step in a DRAFT Runbook without navigating the CURRENT browser. Use this for known URL/tab/new-tab parameter changes; re-teach only when live navigation semantics must be rediscovered.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      url: { type: 'string' },
      tabId: { type: 'integer' },
      clearTabId: { type: 'boolean' },
      newTab: { type: 'boolean' },
      clearNewTab: { type: 'boolean' },
      stepName: { type: 'string' },
      notes: { type: 'string' },
      clearNotes: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (args.url !== undefined) assertHttpUrl(args.url)
      if (args.newTab === true) throw new Error('stored browser_navigate steps must reuse the active tab; newTab=true is not replay-stable')
      if (args.tabId !== undefined && args.clearTabId === true) throw new Error('tabId and clearTabId cannot both be supplied')
      if (args.newTab !== undefined && args.clearNewTab === true) throw new Error('newTab and clearNewTab cannot both be supplied')
      if (args.notes !== undefined && args.clearNotes === true) throw new Error('notes and clearNotes cannot both be supplied')
      if (args.url === undefined
        && args.tabId === undefined && args.clearTabId !== true
        && args.newTab === undefined && args.clearNewTab !== true
        && args.stepName === undefined && args.notes === undefined && args.clearNotes !== true) {
        throw new Error('at least one navigate-step field must be changed')
      }
      const argumentPatch: JsonObject = {}
      if (args.url !== undefined) argumentPatch.url = args.url
      if (args.tabId !== undefined) argumentPatch.tabId = args.tabId
      if (args.newTab !== undefined) argumentPatch.newTab = args.newTab
      const clearArgumentKeys: string[] = []
      if (args.clearTabId === true) clearArgumentKeys.push('tabId')
      if (args.clearNewTab === true) clearArgumentKeys.push('newTab')
      return await updateStructuralToolStep(store, {
        inspectionId: args.inspectionId,
        stepId: args.stepId,
        expectedTool: 'browser_navigate',
        argumentPatch,
        clearArgumentKeys,
        ...(args.stepName === undefined ? {} : { stepName: args.stepName }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        ...(args.clearNotes === true ? { clearNotes: true } : {}),
      })
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
      await persistRunbookEdit(store, definition)
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
      await persistRunbookEdit(store, definition)
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
      await persistRunbookEdit(store, definition)
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
      await persistRunbookEdit(store, definition)
      return `Updated checkpoint ${current.id}. Full DRAFT validation is required before the runbook can return to READY.`
    },
  })

  const removeSteps = defineTool({
    name: 'patrol_remove_steps',
    description: 'Remove explicitly identified obsolete steps from a DRAFT runbook without renumbering surviving step ids. The edit is rejected when a surviving conditional step still depends on a removed step, so related steps must be deliberately repaired instead of silently broken.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepIds: { type: 'array', required: true, items: { type: 'string' } },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await loadDraft(store, args.inspectionId)
      const stepIds = [...new Set((args.stepIds as string[]).map(value => String(value).trim()).filter(Boolean))]
      if (stepIds.length === 0) throw new Error('stepIds must contain at least one step id')

      const known = new Set(definition.steps.map(step => step.id))
      const missing = stepIds.filter(stepId => !known.has(stepId))
      if (missing.length > 0) throw new Error(`cannot remove unknown step(s): ${missing.join(', ')}`)

      const removing = new Set(stepIds)
      const dependents = definition.steps.filter(step => !removing.has(step.id)
        && step.when !== undefined
        && removing.has(step.when.sourceStepId))
      if (dependents.length > 0) {
        throw new Error(
          `cannot remove ${stepIds.join(', ')} while surviving conditional step(s) still depend on them: `
          + `${dependents.map(step => `${step.id}<-${step.when!.sourceStepId}`).join(', ')}. `
          + 'Re-teach/remove those related steps explicitly first so the correction cannot silently corrupt the flow.',
        )
      }

      definition.steps = definition.steps.filter(step => !removing.has(step.id))
      assertConditionOrder(definition)
      markEdited(definition)
      await persistRunbookEdit(store, definition)
      return `Removed obsolete step(s) ${stepIds.join(', ')} in place. Surviving step ids were preserved; ${definition.steps.length} step(s) remain. Full patrol_validate is required.`
    },
  })

  const moveStep = defineTool({
    name: 'patrol_move_step',
    description: 'Move one existing DRAFT step to an exact position before or after another step. Use this immediately when a genuinely new correction step was taught at the tail but logically belongs in the middle of the flow. Conditional source ordering is validated before saving.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      beforeStepId: { type: 'string' },
      afterStepId: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      await assertNoPendingRun(store, args.inspectionId)
      const definition = await loadDraft(store, args.inspectionId)
      const before = typeof args.beforeStepId === 'string' && args.beforeStepId.trim() !== '' ? args.beforeStepId.trim() : undefined
      const after = typeof args.afterStepId === 'string' && args.afterStepId.trim() !== '' ? args.afterStepId.trim() : undefined
      if ((before === undefined) === (after === undefined)) {
        throw new Error('patrol_move_step requires exactly one of beforeStepId or afterStepId')
      }
      const stepId = String(args.stepId).trim()
      const anchorId = before ?? after!
      if (stepId === anchorId) throw new Error('stepId and anchor step id must be different')

      const movingIndex = definition.steps.findIndex(step => step.id === stepId)
      if (movingIndex < 0) throw new Error(`step ${stepId} not found`)
      if (!definition.steps.some(step => step.id === anchorId)) throw new Error(`anchor step ${anchorId} not found`)

      const [moving] = definition.steps.splice(movingIndex, 1)
      if (moving === undefined) throw new Error(`step ${stepId} not found`)
      const anchorIndex = definition.steps.findIndex(step => step.id === anchorId)
      const insertIndex = before !== undefined ? anchorIndex : anchorIndex + 1
      definition.steps.splice(insertIndex, 0, moving)
      assertConditionOrder(definition)
      markEdited(definition)
      await persistRunbookEdit(store, definition)
      return `Moved ${stepId} ${before !== undefined ? `before ${before}` : `after ${after}`}. The correction is now located inside the intended flow instead of being left at the tail. Full patrol_validate is required.`
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
      const { report, paths } = await runner.run(definition, exec, { purpose: 'validation' })
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
      const { report, paths } = await runner.resume(definition, exec, { purpose: 'validation' })
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
      await persistRunbookEdit(store, definition)
      return `Edited runbook ${definition.id} is READY again with ${definition.steps.length} steps. Stored schedule resumes automatically if it is enabled: ${scheduleText(definition)}.`
    },
  })

  return [
    beginEdit,
    updateInspection,
    insertWaitStep,
    insertScreenshotStep,
    insertReadPageStep,
    insertNavigateStep,
    insertClickStep,
    insertBrowserStep,
    updateWaitStep,
    updateScreenshotStep,
    updateReadPageStep,
    updateNavigateStep,
    reteachBrowserStep,
    reteachText,
    reteachCredential,
    reteachCheckpoint,
    removeSteps,
    moveStep,
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

function nextStepId(definition: InspectionDefinition): string {
  let max = 0
  for (const step of definition.steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match !== null) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}

function assertConditionOrder(definition: InspectionDefinition): void {
  const positions = new Map(definition.steps.map((step, index) => [step.id, index]))
  for (let index = 0; index < definition.steps.length; index += 1) {
    const step = definition.steps[index]
    if (step?.when === undefined) continue
    const sourceIndex = positions.get(step.when.sourceStepId)
    if (sourceIndex === undefined) {
      throw new Error(`step ${step.id} depends on missing source step ${step.when.sourceStepId}`)
    }
    if (sourceIndex >= index) {
      throw new Error(`step ${step.id} depends on ${step.when.sourceStepId}, which must remain earlier in the flow`)
    }
  }
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
  await persistRunbookEdit(store, latest)
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

interface StructuralToolInsertInput {
  inspectionId: string
  beforeStepId?: string | undefined
  afterStepId?: string | undefined
  step: Omit<ToolStep, 'id' | 'recordedAt'>
}

async function insertStructuralToolStep(store: PatrolStore, input: StructuralToolInsertInput): Promise<string> {
  await assertNoPendingRun(store, input.inspectionId)
  const definition = await loadDraft(store, input.inspectionId)
  assertSafePersistentText(input.step.name, 'stepName')
  if (input.step.notes !== undefined) assertSafePersistentText(input.step.notes, 'step notes')
  assertSafeForStorage(input.step.arguments)

  const before = typeof input.beforeStepId === 'string' && input.beforeStepId.trim() !== '' ? input.beforeStepId.trim() : undefined
  const after = typeof input.afterStepId === 'string' && input.afterStepId.trim() !== '' ? input.afterStepId.trim() : undefined
  if ((before === undefined) === (after === undefined)) {
    throw new Error('structural insert requires exactly one of beforeStepId or afterStepId')
  }
  const anchorId = before ?? after!
  const anchorIndex = definition.steps.findIndex(step => step.id === anchorId)
  if (anchorIndex < 0) throw new Error(`anchor step ${anchorId} not found`)

  const inserted: ToolStep = {
    id: nextStepId(definition),
    ...input.step,
    recordedAt: new Date().toISOString(),
  }
  const insertIndex = before !== undefined ? anchorIndex : anchorIndex + 1
  definition.steps.splice(insertIndex, 0, inserted)
  assertConditionOrder(definition)
  markEdited(definition)
  await persistRunbookEdit(store, definition)

  // Never trust an in-memory mutation as proof that the Runbook changed. Reload
  // from storage and verify both the step payload and its requested adjacency.
  const persisted = await recoverStructuralInsertPersistence(store, definition.id, inserted, before, after)
  const persistedIndex = persisted.steps.findIndex(step => step.id === inserted.id)
  if (persistedIndex < 0) {
    throw new Error(`structural edit persistence recovery failed: inserted step ${inserted.id} is still absent; storage=${store.root}`)
  }
  const persistedStep = persisted.steps[persistedIndex]

  const previous = structuralStepLabel(persisted.steps[persistedIndex - 1])
  const current = structuralStepLabel(persistedStep)
  const next = structuralStepLabel(persisted.steps[persistedIndex + 1])
  return [
    `Structural edit persisted: ${inserted.id} (${inserted.tool}) ${before !== undefined ? `before ${before}` : `after ${after}`}.`,
    `Saved order: ${previous} -> ${current} -> ${next}`,
    'Persistence check: PASSED (Runbook reloaded from storage).',
    'Make all requested structural edits first; then call patrol_show once to verify the complete saved graph before patrol_validate.',
  ].join('\n')
}

async function recoverStructuralInsertPersistence(
  store: PatrolStore,
  inspectionId: string,
  inserted: ToolStep,
  before: string | undefined,
  after: string | undefined,
): Promise<InspectionDefinition> {
  const anchorId = before ?? after!
  let persisted = await store.load(inspectionId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const persistedIndex = persisted.steps.findIndex(step => step.id === inserted.id)
    const persistedStep = persisted.steps[persistedIndex]
    const payloadMatches = persistedStep?.kind === 'tool'
      && persistedStep.tool === inserted.tool
      && persistedStep.name === inserted.name
      && persistedStep.artifact === inserted.artifact
      && JSON.stringify(persistedStep.arguments) === JSON.stringify(inserted.arguments)
    const adjacencyMatches = persistedIndex >= 0
      && (after === undefined || persisted.steps[persistedIndex - 1]?.id === after)
      && (before === undefined || persisted.steps[persistedIndex + 1]?.id === before)
    if (payloadMatches && adjacencyMatches) return persisted
    if (attempt === 2) break

    if (persisted.status !== 'draft') {
      throw new Error(`structural edit lost a write and ${persisted.id} is no longer DRAFT; refusing automatic recovery`)
    }
    const anchorIndex = persisted.steps.findIndex(step => step.id === anchorId)
    if (anchorIndex < 0) {
      throw new Error(`structural edit lost a write and anchor step ${anchorId} no longer exists`)
    }

    // Remove a partial/colliding copy before reapplying. If the same id now
    // belongs to another payload, allocate a fresh stable id from the latest
    // graph rather than overwriting that step.
    if (persistedIndex >= 0) {
      if (payloadMatches) persisted.steps.splice(persistedIndex, 1)
      else inserted.id = nextStepId(persisted)
    }
    inserted.recordedAt = new Date().toISOString()
    const refreshedAnchorIndex = persisted.steps.findIndex(step => step.id === anchorId)
    const insertIndex = before !== undefined ? refreshedAnchorIndex : refreshedAnchorIndex + 1
    persisted.steps.splice(insertIndex, 0, { ...inserted })
    assertConditionOrder(persisted)
    markEdited(persisted)
    await persistRunbookEdit(store, persisted)
    persisted = await store.load(persisted.id)
  }

  const ids = persisted.steps.map(step => step.id).join(',')
  throw new Error(`structural edit persistence check failed after 3 verified writes: inserted step ${inserted.id} was not stable after reload; storage=${store.root}; savedIds=[${ids}]`)
}

function structuralStepLabel(step: InspectionDefinition['steps'][number] | undefined): string {
  if (step === undefined) return '(boundary)'
  if (step.kind === 'checkpoint') return `${step.id}:${step.name}[checkpoint]`
  const waitMs = step.tool === 'browser_wait' && typeof step.arguments.timeoutMs === 'number'
    ? ` ${step.arguments.timeoutMs}ms`
    : ''
  return `${step.id}:${step.name}[${step.tool}${waitMs}]`
}

interface StructuralToolUpdateInput {
  inspectionId: string
  stepId: string
  expectedTool: string
  argumentPatch?: JsonObject | undefined
  clearArgumentKeys?: string[] | undefined
  stepName?: string | undefined
  artifact?: ToolStep['artifact'] | null | undefined
  notes?: string | undefined
  clearNotes?: boolean | undefined
}

async function updateStructuralToolStep(store: PatrolStore, input: StructuralToolUpdateInput): Promise<string> {
  await assertNoPendingRun(store, input.inspectionId)
  const definition = await loadDraft(store, input.inspectionId)
  const current = requireToolStep(definition, input.stepId)
  if (current.tool !== input.expectedTool) {
    throw new Error(`${input.stepId} is ${current.tool}; ${input.expectedTool} is required for this structural update`)
  }
  const originalIndex = definition.steps.findIndex(step => step.id === current.id)
  if (originalIndex < 0) throw new Error(`step ${current.id} not found`)

  const name = input.stepName ?? current.name
  assertSafePersistentText(name, 'stepName')
  if (input.notes !== undefined) assertSafePersistentText(input.notes, 'step notes')
  const arguments_1: JsonObject = { ...current.arguments, ...(input.argumentPatch ?? {}) }
  for (const key of input.clearArgumentKeys ?? []) delete arguments_1[key]
  assertSafeForStorage(arguments_1)

  const replacement: ToolStep = {
    ...current,
    name,
    arguments: arguments_1,
    ...updatedNotes(current.notes, input.notes, input.clearNotes),
    recordedAt: new Date().toISOString(),
  }
  if (input.artifact === null) delete replacement.artifact
  else if (input.artifact !== undefined) replacement.artifact = input.artifact

  replaceStep(definition, current.id, replacement)
  assertConditionOrder(definition)
  markEdited(definition)
  await persistRunbookEdit(store, definition)

  const persisted = await store.load(definition.id)
  const persistedIndex = persisted.steps.findIndex(step => step.id === replacement.id)
  if (persistedIndex !== originalIndex) {
    throw new Error(`structural update persistence check failed: ${replacement.id} moved from index ${originalIndex} to ${persistedIndex}`)
  }
  const persistedStep = persisted.steps[persistedIndex]
  if (persistedStep?.kind !== 'tool'
    || persistedStep.tool !== replacement.tool
    || persistedStep.name !== replacement.name
    || persistedStep.artifact !== replacement.artifact
    || JSON.stringify(persistedStep.arguments) !== JSON.stringify(replacement.arguments)) {
    throw new Error(`structural update persistence check failed: ${replacement.id} did not reload with the requested saved payload`)
  }

  const previous = structuralStepLabel(persisted.steps[persistedIndex - 1])
  const currentLabel = structuralStepLabel(persistedStep)
  const next = structuralStepLabel(persisted.steps[persistedIndex + 1])
  return [
    `Structural step update persisted: ${replacement.id} (${replacement.tool}); stable id and position preserved.`,
    `Saved order: ${previous} -> ${currentLabel} -> ${next}`,
    `Saved arguments: ${JSON.stringify(replacement.arguments)}`,
    'Persistence check: PASSED (Runbook reloaded from storage).',
    'Make all requested structural edits first; then call patrol_show once to verify the complete saved graph before patrol_validate.',
  ].join('\n')
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
  if (requested.has('screenshot') && !definition.steps.some(step => step.kind === 'tool' && (step.tool === 'browser_screenshot' || step.tool === 'desktop_screenshot'))) {
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
    `DRAFT validation (internal edit check; excluded from formal patrol records): ${summarizeReport(report)}`,
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

async function persistRunbookEdit(store: PatrolStore, definition: InspectionDefinition): Promise<void> {
  const candidate = store as PatrolStore & {
    saveRunbookEdit?: (definition: InspectionDefinition) => Promise<void>
  }
  if (typeof candidate.saveRunbookEdit === 'function') {
    await candidate.saveRunbookEdit(definition)
    return
  }
  await store.save(definition)
}
