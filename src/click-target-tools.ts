import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { verifyPostClickExpectation } from './post-click-verification.js'
import { assertSafePersistentText } from './security.js'
import { stepExecutionNotes } from './step-notes.js'
import type { PatrolRunner } from './runner.js'
import type { PatrolStore } from './store.js'
import type {
  InspectionDefinition,
  InspectionStep,
  JsonObject,
  JsonValue,
  SemanticLocator,
  StepCondition,
  TextExpectation,
  ToolStep,
} from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const AUTO_VERIFY_DELAYS_MS = [0, 140, 320, 700] as const

interface ClickTarget {
  selector: string
  text?: string
  role?: string
  tag?: string
  match: 'selector-unique' | 'semantic-exact' | 'semantic-contains'
}

interface SnapshotElement {
  selector?: unknown
  text?: unknown
  role?: unknown
  tag?: unknown
}

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
}

/**
 * Teaching-time semantic click path.
 *
 * The model supplies what it can actually observe: normally locatorText and,
 * when the next business state is already known, expectedText. expectedText is
 * intentionally optional. If it is absent Patrol takes a compact pre-click
 * state, performs the unique visible click, then verifies that the CURRENT page
 * changed in a meaningful way. This avoids the previous failure mode where a
 * model had to invent a post-click label before it was allowed to click a logo,
 * menu entry, or framework control.
 */
export function registerPatrolClickTargetTool(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolClickTargetOptions,
): () => void {
  const tool = defineTool({
    name: 'patrol_click_target',
    description: 'Reliably click one CURRENT visible page target. Prefer locatorText. expectedText is optional: provide it only when the next business state is concretely known; otherwise Patrol verifies a meaningful DOM/page state change automatically. locatorRole/locatorTag are optional ranking hints and must not be guessed. Broad CSS never silently clicks the first match. Native actionable elements are preferred over layout ancestors with the same text.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', description: 'Optional CSS hint. Stable selectors from CURRENT Patrol snapshot evidence are ideal.' },
      locatorText: { type: 'string', description: 'Visible/accessible target text, for example 登录、我的工作台、待办待阅工单.' },
      locatorRole: { type: 'string', description: 'Optional CURRENT-observed role such as button/link/tab. Do not guess it.' },
      locatorTag: { type: 'string', description: 'Optional CURRENT-observed tag such as button/a/div. Do not guess it.' },
      tabId: { type: 'integer' },
      expectedText: { type: 'string', description: 'Optional concrete text that must appear/disappear after the click. Omit rather than invent when the post-click label is not yet known.' },
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

      const selector = cleanString(args.selector)
      const locator = normalizeLocator(args.locatorText, args.locatorRole, args.locatorTag)
      if (selector === undefined && locator === undefined) {
        throw new Error('patrol_click_target requires selector or at least one semantic locator field')
      }
      const expectation = optionalExpectation(args.expectedText, args.expectationMode, args.caseSensitive)
      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)

      let resolved = await resolveCurrentTarget(runner, exec, selector, locator, args.tabId)
      const beforeState = expectation.expectation === undefined && locator !== undefined
        ? await capturePageState(runner, exec, args.tabId)
        : undefined

      let clicked = await runner.dispatch('browser_click', compactObject({ selector: resolved.selector, tabId: args.tabId }), exec)

      // Dynamic React/Vue/portal UIs can replace the node between snapshot and
      // click. Resolve one fresh target and retry once; never enter a click loop.
      if (!clicked.ok && locator !== undefined) {
        const refreshed = await resolveCurrentTarget(runner, exec, selector, locator, args.tabId)
        if (refreshed.selector !== resolved.selector || refreshed.match !== resolved.match) resolved = refreshed
        clicked = await runner.dispatch('browser_click', compactObject({ selector: resolved.selector, tabId: args.tabId }), exec)
      }

      if (!clicked.ok) {
        return [
          'Reliable click failed and was NOT recorded.',
          `Resolved target: ${describeTarget(resolved)}`,
          clicked.error ?? clicked.text ?? 'Unknown browser click error',
        ].join('\n')
      }

      let verificationAttempts: number | undefined
      let verificationMethod: NonNullable<ToolStep['teaching']>['method'] | undefined = undefined
      let verificationEvidence: string | undefined

      if (expectation.expectation !== undefined) {
        const verified = await verifyPostClickExpectation(
          (toolName, toolArgs, toolExec) => runner.dispatch(toolName, toolArgs, toolExec),
          exec,
          expectation.expectation,
          args.tabId,
        )
        verificationAttempts = verified.attempts
        if (!verified.ok) {
          return [
            'Semantic click executed but was NOT recorded because the requested business expectation was not reached.',
            `Resolved target: ${describeTarget(resolved)}`,
            `Post-click expectation was not met: ${verified.error ?? 'unknown verification error'}`,
            clicked.text,
            'Observe the CURRENT page and retry only with new evidence; do not guess a URL or repeat the same click blindly.',
          ].filter(Boolean).join('\n')
        }
        verificationMethod = 'expected-text'
        verificationEvidence = `${expectation.expectation.mode} ${JSON.stringify(expectation.expectation.value)}`
      } else if (locator !== undefined) {
        const verified = await verifyAutomaticStateChange(runner, exec, beforeState, args.tabId)
        verificationAttempts = verified.attempts
        if (!verified.ok) {
          return [
            'Semantic click executed but was NOT recorded because no meaningful post-click page/DOM state change could be verified.',
            `Resolved target: ${describeTarget(resolved)}`,
            clicked.text,
            'Use patrol_observe once to inspect the CURRENT state. If the user-required result is visible, retry with a concrete expectedText; otherwise treat this click as failed instead of bypassing it with navigation.',
          ].filter(Boolean).join('\n')
        }
        verificationMethod = 'state-change'
        verificationEvidence = verified.evidence
      }

      const condition = optionalCondition(args.conditionSourceStepId, args.conditionExpectedText, args.conditionMode)
      const stepArguments = compactObject({ selector: resolved.selector, tabId: args.tabId })
      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: 'browser_click',
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
          tool: 'browser_click',
          args: stepArguments,
          ...expectation,
          ...condition,
          ...(locator === undefined ? {} : { locator }),
          providedNotes: args.notes,
        }),
        recordedAt: new Date().toISOString(),
      }
      await appendStep(store, definition, step)

      return [
        `Executed and recorded ${step.id} (browser_click) after CURRENT target resolution.`,
        `Resolved target: ${describeTarget(resolved)}`,
        verificationAttempts === undefined
          ? undefined
          : `Post-click business state verified in ${verificationAttempts} attempt(s) by ${verificationMethod === 'state-change' ? 'automatic CURRENT-state change' : 'expected text'}.`,
        verificationEvidence === undefined ? undefined : `Verification evidence: ${verificationEvidence}`,
        clicked.text,
        'The low-level browser_click was dispatched inside Patrol so the action remains auditable and reusable.',
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
    runner.dispatch('browser_snapshot', compactObject({ maxElements: 160, includeHidden: false, tabId }), exec),
  ])
  if (!page.ok && !snapshot.ok) return undefined
  const url = objectString(page.value, 'url') ?? objectString(snapshot.value, 'url') ?? ''
  const text = objectString(page.value, 'text') ?? page.text ?? ''
  return {
    url,
    text: normalizePageText(text),
    elementSignatures: snapshotElementSignatures(snapshot.value),
  }
}

async function verifyAutomaticStateChange(
  runner: PatrolRunner,
  exec: ToolRunContext,
  before: PageState | undefined,
  tabId: number | undefined,
): Promise<StateChangeVerification> {
  if (before === undefined) {
    return { ok: false, attempts: 0 }
  }
  let last: PageState | undefined
  for (let index = 0; index < AUTO_VERIFY_DELAYS_MS.length; index += 1) {
    const delayMs = AUTO_VERIFY_DELAYS_MS[index]!
    if (delayMs > 0) await sleep(delayMs)
    last = await capturePageState(runner, exec, tabId)
    if (last === undefined) continue
    const evidence = stateChangeEvidence(before, last)
    if (evidence !== undefined) return { ok: true, attempts: index + 1, evidence }
  }
  return { ok: false, attempts: AUTO_VERIFY_DELAYS_MS.length }
}

function stateChangeEvidence(before: PageState, after: PageState): string | undefined {
  if (before.url && after.url && before.url !== after.url) {
    return `URL changed from ${safeStateUrl(before.url)} to ${safeStateUrl(after.url)}`
  }

  const added = [...after.elementSignatures].filter(signature => !before.elementSignatures.has(signature))
  if (added.length > 0) {
    const evidence = added.find(signature => signature.includes('|text=')) ?? added[0]
    return evidence === undefined ? 'interactive DOM changed' : `new interactive DOM: ${shortStateEvidence(evidence)}`
  }

  if (before.text !== after.text) {
    const lengthDelta = Math.abs(before.text.length - after.text.length)
    if (lengthDelta >= 12 || !before.text || !after.text) {
      return `visible page text changed (${before.text.length} -> ${after.text.length} chars)`
    }
  }
  return undefined
}

async function resolveCurrentTarget(
  runner: PatrolRunner,
  exec: ToolRunContext,
  selector: string | undefined,
  locator: SemanticLocator | undefined,
  tabId: number | undefined,
): Promise<ClickTarget> {
  if (locator === undefined) {
    if (selector === undefined) throw new Error('selector is required when no semantic locator is provided')
    const counted = await runner.dispatch('browser_count', compactObject({ selector, visibleOnly: true, tabId }), exec)
    if (!counted.ok) throw new Error(counted.error ?? 'Could not count click target')
    const count = objectNumber(counted.value, 'count')
    if (count === undefined) throw new Error('browser_count returned no visible target count')
    if (count === 0) throw new Error(`click target not found or not visible: ${selector}`)
    if (count > 1) {
      throw new Error(`ambiguous click selector ${JSON.stringify(selector)} matched ${count} visible elements. Use patrol_snapshot stable selector or patrol_click_target locatorText/locatorRole/locatorTag; Patrol will not silently click the first match.`)
    }
    return { selector, match: 'selector-unique' }
  }

  const snapshot = await runner.dispatch('browser_snapshot', compactObject({ maxElements: 500, includeHidden: false, tabId }), exec)
  if (!snapshot.ok) throw new Error(snapshot.error ?? 'Could not snapshot current interactive elements for click resolution')
  const elements = snapshotElements(snapshot.value)
  if (elements.length === 0) throw new Error('current page snapshot contains no visible interactive elements')

  const exactSelector = selector === undefined ? [] : elements.filter(item => item.selector === selector)
  const semantic = scoreSemanticCandidates(elements, locator, selector)
  if (semantic.length === 0 && exactSelector.length === 1 && semanticLocatorMatches(exactSelector[0]!, locator, false)) {
    return targetFromSnapshot(exactSelector[0]!, 'semantic-contains')
  }
  if (semantic.length === 0) {
    throw new Error(`no visible interactive element matched ${describeLocator(locator)}${selector ? ` with selector hint ${JSON.stringify(selector)}` : ''}. Call patrol_observe once, use CURRENT visible text, and retry without guessing role/tag or internal URLs.`)
  }

  const bestScore = semantic[0]!.score
  const best = semantic.filter(item => item.score === bestScore)
  if (best.length !== 1) {
    const nestedAncestor = uniqueNestedAncestor(best)
    if (nestedAncestor !== undefined) {
      return targetFromSnapshot(nestedAncestor.element, nestedAncestor.exactText ? 'semantic-exact' : 'semantic-contains')
    }
    const contentFrame = uniqueContentFrameCandidate(best)
    if (contentFrame !== undefined) {
      return targetFromSnapshot(contentFrame.element, contentFrame.exactText ? 'semantic-exact' : 'semantic-contains')
    }
    const examples = best.slice(0, 5).map(item => describeSnapshot(item.element)).join('; ')
    throw new Error(`ambiguous semantic click target ${describeLocator(locator)} matched ${best.length} equally good visible elements: ${examples}. Add a role/tag only if CURRENT observation confirms it, or provide a stable selector.`)
  }

  return targetFromSnapshot(best[0]!.element, best[0]!.exactText ? 'semantic-exact' : 'semantic-contains')
}

function uniqueContentFrameCandidate(
  candidates: readonly { element: SnapshotElement; score: number; exactText: boolean }[],
): { element: SnapshotElement; score: number; exactText: boolean } | undefined {
  const framed = candidates.filter(item => cleanString(item.element.selector)?.startsWith('frame-url(') === true)
  if (framed.length !== 1) return undefined
  const topOrUnframed = candidates.some(item => cleanString(item.element.selector)?.startsWith('frame-url(') !== true)
  return topOrUnframed ? framed[0] : undefined
}

function scoreSemanticCandidates(elements: SnapshotElement[], locator: SemanticLocator, selectorHint?: string) {
  const wantedText = normalizeText(locator.text)
  const wantedRole = normalizeToken(locator.role)
  const wantedTag = normalizeToken(locator.tag)
  const ranked: Array<{ element: SnapshotElement; score: number; exactText: boolean }> = []

  for (const element of elements) {
    const selector = cleanString(element.selector)
    if (selector === undefined) continue
    const text = normalizeText(element.text)
    const role = normalizeToken(element.role)
    const tag = normalizeToken(element.tag)

    if (wantedText === undefined) {
      if (wantedRole !== undefined && role !== wantedRole) continue
      if (wantedTag !== undefined && tag !== wantedTag) continue
    }

    let score = semanticActionabilityScore(role, tag)
    let exactText = false
    if (wantedText !== undefined) {
      if (text === wantedText) {
        score += 200
        exactText = true
      } else if (text !== undefined && (text.includes(wantedText) || wantedText.includes(text))) {
        score += 55
        score += semanticContainmentSpecificity(text, wantedText, selector)
      } else {
        continue
      }
    }
    if (wantedRole !== undefined && role === wantedRole) score += 20
    if (wantedTag !== undefined && tag === wantedTag) score += 10
    if (selectorHint !== undefined && selector === selectorHint) score += 35
    ranked.push({ element, score, exactText })
  }

  ranked.sort((a, b) => b.score - a.score)
  return ranked
}

/** Prefer the actual action control over a layout ancestor exposing same text. */
function semanticActionabilityScore(role: string | undefined, tag: string | undefined): number {
  let score = 0
  if (role !== undefined && ['button', 'link', 'tab', 'menuitem'].includes(role)) score += 22
  if (tag !== undefined && ['a', 'button', 'input', 'select', 'textarea', 'summary'].includes(tag)) score += 28
  if (tag !== undefined && ['li', 'div', 'span', 'p'].includes(tag) && role === undefined) score -= 4
  return score
}

function uniqueNestedAncestor(
  candidates: readonly { element: SnapshotElement; score: number; exactText: boolean }[],
): { element: SnapshotElement; score: number; exactText: boolean } | undefined {
  const withSelectors = candidates
    .map(candidate => ({ candidate, selector: cleanString(candidate.element.selector) }))
    .filter((item): item is { candidate: (typeof candidates)[number]; selector: string } => item.selector !== undefined)
  const ancestors = withSelectors.filter(item => withSelectors.every(other =>
    other === item || isDescendantSelector(other.selector, item.selector),
  ))
  return ancestors.length === 1 ? ancestors[0]!.candidate : undefined
}
function isDescendantSelector(candidate: string, ancestor: string): boolean {
  return candidate.startsWith(`${ancestor} > `)
}

function semanticContainmentSpecificity(text: string, wantedText: string, selector: string): number {
  const extraText = Math.max(0, text.length - wantedText.length)
  const compactTextBonus = Math.max(0, 30 - Math.min(extraText, 30))
  const selectorDepth = Math.max(0, selector.split('>').length - 1)
  const depthBonus = Math.min(selectorDepth, 12)
  const bracketedActionBonus = text.includes(`[${wantedText}]`) ? 12 : 0
  return compactTextBonus + depthBonus + bracketedActionBonus
}

function semanticLocatorMatches(element: SnapshotElement, locator: SemanticLocator, exactOnly: boolean): boolean {
  const wantedText = normalizeText(locator.text)
  const wantedRole = normalizeToken(locator.role)
  const wantedTag = normalizeToken(locator.tag)
  const text = normalizeText(element.text)
  if (wantedText === undefined) {
    if (wantedRole !== undefined && normalizeToken(element.role) !== wantedRole) return false
    if (wantedTag !== undefined && normalizeToken(element.tag) !== wantedTag) return false
    return true
  }
  if (text === wantedText) return true
  return !exactOnly && text !== undefined && (text.includes(wantedText) || wantedText.includes(text))
}

function targetFromSnapshot(element: SnapshotElement, match: ClickTarget['match']): ClickTarget {
  const rawSelector = cleanString(element.selector)
  const selector = qualifyTopDocumentSelector(rawSelector)
  if (selector === undefined) throw new Error('resolved click target has no stable selector')
  const text = cleanString(element.text)
  const role = cleanString(element.role)
  const tag = cleanString(element.tag)
  return {
    selector,
    ...(text === undefined ? {} : { text }),
    ...(role === undefined ? {} : { role }),
    ...(tag === undefined ? {} : { tag }),
    match,
  }
}

function snapshotElements(value: JsonValue | undefined): SnapshotElement[] {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return []
  const children = (value as JsonObject).elements
  if (!Array.isArray(children)) return []
  const out: SnapshotElement[] = []
  for (const child of children) {
    if (child === null || typeof child !== 'object' || Array.isArray(child)) continue
    const object = child as JsonObject
    out.push({ selector: object.selector, text: object.text, role: object.role, tag: object.tag })
  }
  return out
}

function snapshotElementSignatures(value: JsonValue | undefined): Set<string> {
  const out = new Set<string>()
  for (const element of snapshotElements(value)) {
    const selector = cleanString(element.selector) ?? ''
    const text = cleanString(element.text) ?? ''
    const role = cleanString(element.role) ?? ''
    const tag = cleanString(element.tag) ?? ''
    if (!selector && !text) continue
    out.add(`selector=${selector}|tag=${tag}|role=${role}|text=${normalizePageText(text)}`)
  }
  return out
}

function describeTarget(target: ClickTarget): string {
  return [
    `selector=${JSON.stringify(target.selector)}`,
    target.text ? `text=${JSON.stringify(target.text)}` : undefined,
    target.role ? `role=${target.role}` : undefined,
    target.tag ? `tag=${target.tag}` : undefined,
    `match=${target.match}`,
  ].filter(Boolean).join(', ')
}

function describeSnapshot(element: SnapshotElement): string {
  return [
    cleanString(element.tag) ? `<${cleanString(element.tag)}>` : '<element>',
    cleanString(element.role) ? `role=${cleanString(element.role)}` : '',
    cleanString(element.text) ? JSON.stringify(cleanString(element.text)) : '',
    cleanString(element.selector) ? `-> ${cleanString(element.selector)}` : '',
  ].filter(Boolean).join(' ')
}

function describeLocator(locator: SemanticLocator): string {
  return [
    locator.text ? `text=${JSON.stringify(locator.text)}` : undefined,
    locator.role ? `role=${locator.role}` : undefined,
    locator.tag ? `tag=${locator.tag}` : undefined,
  ].filter(Boolean).join(', ') || '(empty locator)'
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

function normalizeText(value: unknown): string | undefined {
  const text = cleanString(value)
  return text === undefined ? undefined : text.replace(/\s+/g, ' ').trim().toLocaleLowerCase()
}

function normalizeToken(value: unknown): string | undefined {
  const text = cleanString(value)
  return text === undefined ? undefined : text.toLowerCase()
}

function normalizePageText(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().toLocaleLowerCase() : ''
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function objectNumber(value: JsonValue | undefined, key: string): number | undefined {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as JsonObject)[key]
  return typeof child === 'number' && Number.isFinite(child) ? child : undefined
}

function objectString(value: JsonValue | undefined, key: string): string | undefined {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as JsonObject)[key]
  return typeof child === 'string' ? child : undefined
}

function compactObject(value: Record<string, string | number | boolean | undefined>): JsonObject {
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) if (child !== undefined) out[key] = child
  return out
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; call patrol_begin_edit before teaching a click`)
  if (definition.steps.length >= maxSteps) throw new Error(`runbook reached maxSteps=${maxSteps}`)
  return definition
}

async function appendStep(store: PatrolStore, definition: InspectionDefinition, step: InspectionStep): Promise<void> {
  definition.steps.push(step)
  definition.schemaVersion = '0.2'
  definition.metadata.updatedAt = new Date().toISOString()
  delete definition.metadata.flowHealth
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

function qualifyTopDocumentSelector(selector: string | undefined): string | undefined {
  if (selector === undefined) return undefined
  if (selector.startsWith('frame-url(') || selector.startsWith('top-frame::')) return selector
  return `top-frame::${selector}`
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

function shortStateEvidence(value: string): string {
  const text = value.replace(/\s+/g, ' ').trim()
  return text.length <= 220 ? text : `${text.slice(0, 220)}…`
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}