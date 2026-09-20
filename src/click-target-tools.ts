import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { verifyPostClickExpectation } from './post-click-verification.js'
import { isSelectorBoundToCurrentSnapshot } from './browser.js'
import { assertSafePersistentText } from './security.js'
import { stepExecutionNotes } from './step-notes.js'
import { installTeachingRunbookFilter } from './teaching-runbook-filter.js'
import type { PatrolRunner } from './runner.js'
import { assertPersistedTaskChecklist, type PatrolStore } from './store.js'
import type { PatrolClickOutcomeTracker } from './click-retry-state.js'
import type {
  InspectionDefinition,
  InspectionStep,
  JsonObject,
  SemanticLocator,
  StepCondition,
  TextExpectation,
  ToolStep,
} from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const AUTO_VERIFY_DELAYS_MS = [0, 200, 500, 1000, 2000] as const

interface PageState {
  url: string
  text: string
  elementSignatures: Set<string>
}

interface StateChangeVerification {
  ok: boolean
  attempts: number
  evidence?: string
}

export interface PatrolClickTargetOptions {
  maxSteps: number
  clickOutcomes?: PatrolClickOutcomeTracker
}

/**
 * Teaching-time click entrypoint.
 *
 * Semantic clicks are resolved and executed atomically by the browser extension
 * in the page MAIN world. This is intentionally different from the old
 * snapshot -> return selector -> later click sequence: framework re-renders,
 * iframe registration churn, and content-script reconnects can no longer make
 * a CURRENT semantic target stale between discovery and execution.
 *
 * Only a click whose business result is verified is persisted when semantic
 * information is available. The persisted Runbook remains a normal
 * browser_click step using the selector actually clicked by the extension, so
 * existing replay/self-healing behavior stays compatible.
 */
export function registerPatrolClickTargetTool(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolClickTargetOptions,
): () => void {
  // Install once while the Patrol plugin is being applied. This is early enough
  // to cover every teaching action, but avoids import-time PatrolStore cycles.
  installTeachingRunbookFilter(store)

  const tool = defineTool({
    name: 'patrol_click_target',
    description: 'Reliably click one CURRENT visible page target. Prefer locatorText and optional CURRENT-observed role/tag. Patrol resolves the target across top document/iframes and clicks it atomically in the page MAIN world, then records only after the required business state is verified. selector is only a hint when semantic fields are present; do not guess internal URLs or brittle nth-of-type selectors.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', description: 'Optional CURRENT selector hint. With semantic fields this is a hint, not the source of truth.' },
      locatorText: { type: 'string', description: 'CURRENT visible/accessible target text, for example 登录、我的工作台、待办待阅工单.' },
      locatorRole: { type: 'string', description: 'Optional CURRENT-observed role such as button/link/tab. Do not guess it.' },
      locatorTag: { type: 'string', description: 'Optional CURRENT-observed tag such as button/a/div. Do not guess it.' },
      tabId: { type: 'integer' },
      expectedText: { type: 'string', description: 'Optional concrete text that must appear/disappear after the click. Omit rather than invent when unknown; Patrol then verifies a meaningful CURRENT state change.' },
      expectationMode: { type: 'string', enum: ['contains', 'not-contains'] },
      caseSensitive: { type: 'boolean' },
      conditionSourceStepId: { type: 'string' },
      conditionExpectedText: { type: 'string' },
      conditionMode: { type: 'string', enum: ['contains', 'not-contains'] },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec: ToolRunContext) {
      assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      if (args.expectedText !== undefined) assertSafePersistentText(args.expectedText, 'expectedText')
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      if (args.locatorText !== undefined) assertSafePersistentText(args.locatorText, 'locatorText')

      const rawSelector = cleanString(args.selector)
      const locator = normalizeLocator(args.locatorText, args.locatorRole, args.locatorTag)
      // selector is only an optional hint when a semantic locator is present.
      // Do not let a model-invented Playwright/jQuery/XPath dialect suppress a
      // valid locatorText path; the always-on planning guard still rejects such
      // selectors when no semantic locator is available.
      const selector = locator !== undefined && rawSelector !== undefined && unsupportedSelectorHint(rawSelector)
        ? undefined
        : rawSelector
      if (selector === undefined && locator === undefined) {
        throw new Error('patrol_click_target requires selector or at least one semantic locator field')
      }

      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)
      const expectation = optionalExpectation(args.expectedText, args.expectationMode, args.caseSensitive)
      const beforeState = expectation.expectation === undefined && locator !== undefined
        ? await capturePageState(runner, exec, args.tabId)
        : undefined

      let resolvedSelector = selector
      let clickedText = ''
      let resolutionSummary = ''
      let physicalClickExecuted = false
      let targetStateChanged = false
      let targetStateEvidence: string | undefined
      let openedTabId: number | undefined
      let openedTabUrl: string | undefined
      let semanticReplayRequired = false

      if (locator !== undefined) {
        let atomic = await runner.dispatch('browser_semantic_click', compactObject({
          locatorText: locator.text,
          locatorRole: locator.role,
          locatorTag: locator.tag,
          selectorHint: selector,
          task: args.stepName,
          tabId: args.tabId,
        }), exec)

        // UI libraries frequently expose a clickable div/span with a useful
        // title/placeholder but no literal role=button. If the model guessed a
        // role/tag that made semantic resolution fail, retry once with text
        // only. The atomic resolver still requires one globally best CURRENT
        // target, so this is stricter than switching to coordinates.
        if (!atomic.ok && locator.text && (locator.role || locator.tag)) {
          const relaxed = await runner.dispatch('browser_semantic_click', compactObject({
            locatorText: locator.text,
            selectorHint: selector,
            task: args.stepName,
            tabId: args.tabId,
          }), exec)
          if (relaxed.ok) atomic = relaxed
        }
        if (!atomic.ok) {
          // F12 evidence from Ant Design enterprise trees shows a common shape:
          // one exact [title] business leaf is wrapped by many same-text DOM
          // ancestors, with the real click listener on its tree content wrapper.
          // If semantic MAIN-world resolution misses and the model supplied no
          // trustworthy selector hint, probe the exact title directly. The
          // browser_click content layer promotes the titled leaf to its own
          // clickable Ant-tree wrapper.
          const atomicFailure = String(atomic.error ?? atomic.text ?? '').toLocaleLowerCase()
          const atomicWasAmbiguous = atomicFailure.includes('ambiguous')
          if (selector === undefined && locator.text && !atomicWasAmbiguous) {
            const titleSelector = exactTitleSelector(locator.text)
            const countedTitle = await runner.dispatch('browser_count', compactObject({
              selector: titleSelector,
              visibleOnly: true,
              tabId: args.tabId,
            }), exec)
            const titleCount = objectNumber(countedTitle.value, 'count')
            if (countedTitle.ok && titleCount === 1) {
              const clickedTitle = await runner.dispatch('browser_click', compactObject({
                selector: titleSelector,
                tabId: args.tabId,
              }), exec)
              if (clickedTitle.ok) {
                physicalClickExecuted = true
                resolvedSelector = titleSelector
                clickedText = clickedTitle.text
                targetStateChanged = objectBoolean(clickedTitle.value, 'targetStateChanged') === true
                targetStateEvidence = objectString(clickedTitle.value, 'stateEvidence')
                openedTabId = objectNumber(clickedTitle.value, 'openedTabId')
                openedTabUrl = objectString(clickedTitle.value, 'openedTabUrl')
                resolutionSummary = `selector=${JSON.stringify(titleSelector)}, transport=unique-exact-title-direct`
              }
            }
          }

          // The planner may already have supplied a selector from the same
          // CURRENT snapshot (for example a lone logo anchor). If the atomic
          // MAIN-world transport is unavailable, use that selector only after
          // re-counting visible matches. This keeps the fallback safe and
          // avoids forcing the model into a second business-click attempt.
          if (!physicalClickExecuted && selector === undefined) {
            return [
              'Reliable semantic click failed and was NOT recorded.',
              atomic.error ?? atomic.text ?? 'Unknown atomic semantic click error',
              'No unique CURRENT exact-title fallback was available. Observe/analyze once for new evidence instead of looping guessed selectors.',
            ].join('\n')
          }
          if (!physicalClickExecuted) {
          const currentSnapshot = await runner.dispatch('browser_snapshot', compactObject({
            maxElements: 180,
            includeHidden: false,
            tabId: args.tabId,
          }), exec)
          const fallbackSelector = selector
          if (fallbackSelector === undefined) throw new Error('selector fallback invariant violated')
          const selectorBound = currentSnapshot.ok && locator !== undefined
            && isSelectorBoundToCurrentSnapshot(currentSnapshot.value, fallbackSelector, locator)
          if (!selectorBound) {
            return [
              'Reliable semantic click failed and selector fallback was NOT recorded.',
              atomic.error ?? atomic.text ?? 'Unknown atomic semantic click error',
              `The selector hint was not uniquely bound to the CURRENT snapshot for locator ${JSON.stringify(locator)}.`,
            ].join('\n')
          }
          const counted = await runner.dispatch('browser_count', compactObject({ selector: fallbackSelector, visibleOnly: true, tabId: args.tabId }), exec)
          const count = objectNumber(counted.value, 'count')
          if (!counted.ok || count !== 1) {
            return [
              'Reliable semantic click failed and selector fallback was NOT recorded.',
              atomic.error ?? atomic.text ?? 'Unknown atomic semantic click error',
              counted.error ?? `CURRENT selector ${JSON.stringify(fallbackSelector)} is not unique (${count ?? 'unknown'} visible matches).`,
            ].join('\n')
          }
          const fallback = await runner.dispatch('browser_click', compactObject({ selector: fallbackSelector, tabId: args.tabId }), exec)
          if (!fallback.ok) {
            return [
              'Reliable semantic click failed and selector fallback was NOT recorded.',
              atomic.error ?? atomic.text ?? 'Unknown atomic semantic click error',
              fallback.error ?? fallback.text ?? 'Selector-compatible fallback click failed.',
            ].join('\n')
          }
          physicalClickExecuted = true
          resolvedSelector = fallbackSelector
          clickedText = fallback.text
          targetStateChanged = objectBoolean(fallback.value, 'targetStateChanged') === true
          targetStateEvidence = objectString(fallback.value, 'stateEvidence')
          openedTabId = objectNumber(fallback.value, 'openedTabId')
          openedTabUrl = objectString(fallback.value, 'openedTabUrl')
          resolutionSummary = `selector=${JSON.stringify(fallbackSelector)}, transport=selector-compatible fallback`
          }
        } else {
          physicalClickExecuted = true
          resolvedSelector = objectString(atomic.value, 'selector')
          if (resolvedSelector === undefined) {
            options.clickOutcomes?.recordUnverifiedPhysicalClick(args)
            return 'Atomic semantic click executed but returned no reusable selector, so it was NOT recorded.'
          }
          clickedText = objectString(atomic.value, 'text') ?? atomic.text ?? ''
          targetStateChanged = objectBoolean(atomic.value, 'targetStateChanged') === true
          targetStateEvidence = objectString(atomic.value, 'stateEvidence')
          openedTabId = objectNumber(atomic.value, 'openedTabId')
          openedTabUrl = objectString(atomic.value, 'openedTabUrl')
          semanticReplayRequired = objectBoolean(atomic.value, 'replaySelectorSafe') === false
          resolutionSummary = [
            `selector=${JSON.stringify(resolvedSelector)}`,
            objectString(atomic.value, 'text') ? `text=${JSON.stringify(objectString(atomic.value, 'text'))}` : undefined,
            objectString(atomic.value, 'role') ? `role=${objectString(atomic.value, 'role')}` : undefined,
            objectString(atomic.value, 'tag') ? `tag=${objectString(atomic.value, 'tag')}` : undefined,
            objectString(atomic.value, 'transport') ? `transport=${objectString(atomic.value, 'transport')}` : 'transport=atomic-semantic',
          ].filter(Boolean).join(', ')
        }
      } else {
        const counted = await runner.dispatch('browser_count', compactObject({ selector, visibleOnly: true, tabId: args.tabId }), exec)
        if (!counted.ok) throw new Error(counted.error ?? 'Could not count click target')
        const count = objectNumber(counted.value, 'count')
        if (count === undefined) throw new Error('browser_count returned no visible target count')
        if (count === 0) throw new Error(`click target not found or not visible: ${selector}`)
        if (count > 1) {
          throw new Error(`ambiguous click selector ${JSON.stringify(selector)} matched ${count} visible elements. Use locatorText/locatorRole/locatorTag from CURRENT evidence; Patrol will not silently click the first match.`)
        }
        const clicked = await runner.dispatch('browser_click', compactObject({ selector, tabId: args.tabId }), exec)
        if (!clicked.ok) {
          return `Reliable selector click failed and was NOT recorded. ${clicked.error ?? 'Unknown browser click error'}\n${clicked.text}`
        }
        physicalClickExecuted = true
        clickedText = clicked.text
        targetStateChanged = objectBoolean(clicked.value, 'targetStateChanged') === true
        targetStateEvidence = objectString(clicked.value, 'stateEvidence')
        openedTabId = objectNumber(clicked.value, 'openedTabId')
        openedTabUrl = objectString(clicked.value, 'openedTabUrl')
        resolutionSummary = `selector=${JSON.stringify(selector)}, transport=selector-compatible`
      }

      let verificationAttempts: number | undefined
      let verificationMethod: NonNullable<ToolStep['teaching']>['method'] | undefined
      let verificationEvidence: string | undefined

      const verificationTabId = openedTabId ?? args.tabId
      if (expectation.expectation !== undefined) {
        const verified = await verifyPostClickExpectation(
          (toolName, toolArgs, toolExec) => runner.dispatch(toolName, toolArgs, toolExec),
          exec,
          expectation.expectation,
          verificationTabId,
        )
        verificationAttempts = verified.attempts
        if (!verified.ok) {
          if (physicalClickExecuted) options.clickOutcomes?.recordUnverifiedPhysicalClick(args)
          return [
            'Click executed but was NOT recorded because the requested business expectation was not reached.',
            `Resolved target: ${resolutionSummary}`,
            `Post-click expectation was not met: ${verified.error ?? 'unknown verification error'}`,
            clickedText,
          ].filter(Boolean).join('\n')
        }
        verificationMethod = 'expected-text'
        verificationEvidence = `${expectation.expectation.mode} ${JSON.stringify(expectation.expectation.value)}`
      } else if (locator !== undefined) {
        if (openedTabId !== undefined) {
          verificationAttempts = 1
          verificationMethod = 'state-change'
          verificationEvidence = `click opened and activated child tab ${openedTabId}${openedTabUrl ? ` (${safeStateUrl(openedTabUrl)})` : ''}`
        } else if (targetStateChanged) {
          verificationAttempts = 1
          verificationMethod = 'state-change'
          verificationEvidence = targetStateEvidence ?? 'semantic target changed its own CURRENT DOM state'
        } else {
          const verified = await verifyAutomaticStateChange(runner, exec, beforeState, args.tabId)
          verificationAttempts = verified.attempts
          if (!verified.ok) {
            if (physicalClickExecuted) options.clickOutcomes?.recordUnverifiedPhysicalClick(args)
            return [
              'Semantic click executed but was NOT recorded because neither the target itself nor the page URL changed.',
              `Resolved target: ${resolutionSummary}`,
              clickedText,
              'Dynamic text/DOM churn elsewhere on the page is deliberately ignored and cannot prove this business click succeeded.',
            ].filter(Boolean).join('\n')
          }
          verificationMethod = 'state-change'
          verificationEvidence = verified.evidence
        }
      }

      if (locator === undefined && expectation.expectation === undefined && openedTabId !== undefined) {
        verificationAttempts = 1
        verificationMethod = 'state-change'
        verificationEvidence = `click opened and activated child tab ${openedTabId}${openedTabUrl ? ` (${safeStateUrl(openedTabUrl)})` : ''}`
      }

      if (resolvedSelector === undefined) throw new Error('resolved click target has no reusable selector')
      const condition = optionalCondition(args.conditionSourceStepId, args.conditionExpectedText, args.conditionMode)

      // tabId is execution-local browser state and must never be persisted into
      // a reusable Runbook. Ordinary semantic targets keep a selector replay for
      // compatibility. Targets inside open Shadow DOM cannot be addressed by a
      // document-level CSS selector, so preserve the semantic resolver itself.
      const replayTool = semanticReplayRequired && locator !== undefined
        ? 'browser_semantic_click'
        : 'browser_click'
      const stepArguments = replayTool === 'browser_semantic_click'
        ? compactObject({
            locatorText: locator?.text,
            locatorRole: locator?.role,
            locatorTag: locator?.tag,
            selectorHint: resolvedSelector,
            task: args.stepName,
          })
        : compactObject({ selector: resolvedSelector })
      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: replayTool,
        arguments: stepArguments,
        ...expectation,
        ...condition,
        ...(locator === undefined ? {} : { locator }),
        ...(verificationMethod === undefined ? {} : {
          teaching: {
            status: 'verified',
            method: verificationMethod,
            ...(verificationEvidence === undefined ? {} : { evidence: verificationEvidence }),
          },
        }),
        notes: stepExecutionNotes({
          tool: replayTool,
          args: stepArguments,
          ...expectation,
          ...condition,
          ...(locator === undefined ? {} : { locator }),
          providedNotes: args.notes,
        }),
        recordedAt: new Date().toISOString(),
      }

      definition.steps.push(step)
      definition.schemaVersion = '0.2'
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.flowHealth
      await store.save(definition)
      options.clickOutcomes?.recordVerified(args)

      return [
        `Executed and recorded ${step.id} (${replayTool}) only after CURRENT business-state verification.`,
        `Resolved target: ${resolutionSummary}`,
        verificationAttempts === undefined
          ? undefined
          : `Post-click business state verified in ${verificationAttempts} attempt(s) by ${verificationMethod === 'state-change' ? 'automatic CURRENT-state change' : 'expected text'}.`,
        verificationEvidence === undefined ? undefined : `Verification evidence: ${verificationEvidence}`,
        clickedText,
        semanticReplayRequired
          ? 'The target lives inside open Shadow DOM; replay keeps the semantic resolver instead of persisting an unreachable document CSS selector.'
          : 'Semantic discovery and the physical click were one browser-extension command; the content-script/frame bridge was not used for the last-mile click.',
      ].filter(Boolean).join('\n')
    },
  })

  return ctx.tools.register(tool)
}

async function capturePageState(
  runner: PatrolRunner,
  exec: ToolRunContext,
  tabId: number | undefined,
): Promise<PageState | undefined> {
  const [page, snapshot] = await Promise.all([
    runner.dispatch('browser_read_page', compactObject({ maxChars: 12000, tabId }), exec),
    runner.dispatch('browser_snapshot', compactObject({ maxElements: 180, includeHidden: false, tabId }), exec),
  ])
  if (!page.ok && !snapshot.ok) return undefined
  return {
    url: objectString(page.value, 'url') ?? objectString(snapshot.value, 'url') ?? '',
    text: normalizePageText(objectString(page.value, 'text') ?? page.text ?? ''),
    elementSignatures: snapshotElementSignatures(snapshot.value),
  }
}

async function verifyAutomaticStateChange(
  runner: PatrolRunner,
  exec: ToolRunContext,
  before: PageState | undefined,
  tabId: number | undefined,
): Promise<StateChangeVerification> {
  if (before === undefined) return { ok: false, attempts: 0 }
  for (let index = 0; index < AUTO_VERIFY_DELAYS_MS.length; index += 1) {
    const delayMs = AUTO_VERIFY_DELAYS_MS[index]!
    if (delayMs > 0) await sleep(delayMs)
    const after = await capturePageState(runner, exec, tabId)
    if (after === undefined) continue
    const evidence = stateChangeEvidence(before, after)
    if (evidence !== undefined) return { ok: true, attempts: index + 1, evidence }
  }
  return { ok: false, attempts: AUTO_VERIFY_DELAYS_MS.length }
}

function stateChangeEvidence(before: PageState, after: PageState): string | undefined {
  if (before.url && after.url && before.url !== after.url) {
    return `URL changed from ${safeStateUrl(before.url)} to ${safeStateUrl(after.url)}`
  }
  // Dynamic pages (video players, feeds, clocks, comment counters) mutate DOM
  // continuously. Those unrelated changes must never certify a business click.
  // Target-local state is reported by browser_semantic_click above; this
  // fallback accepts navigation only.
  return undefined
}

function snapshotElementSignatures(value: unknown): Set<string> {
  const out = new Set<string>()
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return out
  const elements = (value as Record<string, unknown>).elements
  if (!Array.isArray(elements)) return out
  for (const raw of elements) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const element = raw as Record<string, unknown>
    const selector = cleanString(element.selector) ?? ''
    const text = cleanString(element.text) ?? ''
    const tag = cleanString(element.tag) ?? ''
    const role = cleanString(element.role) ?? ''
    if (!selector && !text) continue
    out.add(`selector=${selector}|tag=${tag}|role=${role}|text=${normalizePageText(text)}`)
  }
  return out
}

function normalizeLocator(text: unknown, role: unknown, tag: unknown): SemanticLocator | undefined {
  const locator: SemanticLocator = {}
  const cleanText = cleanString(text)
  const cleanRole = cleanString(role)
  const cleanTag = cleanString(tag)
  if (cleanText !== undefined) locator.text = cleanText
  if (cleanRole !== undefined) locator.role = cleanRole.toLowerCase()
  if (cleanTag !== undefined) locator.tag = cleanTag.toLowerCase()
  return Object.keys(locator).length === 0 ? undefined : locator
}

function unsupportedSelectorHint(selector: string): boolean {
  return /:(?:contains|has-text)\s*\(/i.test(selector)
    || /^text\s*=/i.test(selector)
    || /^(?:xpath\s*=|\/\/|\.\/\/)/i.test(selector)
}

function exactTitleSelector(text: string): string {
  const escaped = text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ')
  return `top-frame::[title="${escaped}"]`
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'string' && child.trim() !== '' ? child : undefined
}

function objectBoolean(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'boolean' ? child : undefined
}

function objectNumber(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'number' && Number.isFinite(child) ? child : undefined
}

function compactObject(value: Record<string, string | number | boolean | undefined>): JsonObject {
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) if (child !== undefined) out[key] = child
  return out
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; call patrol_begin_edit before teaching a click`)
  assertPersistedTaskChecklist(definition)
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

function normalizePageText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLocaleLowerCase() : ''
}

function safeStateUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return value.split(/[?#]/, 1)[0] ?? value
  }
}


function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}
