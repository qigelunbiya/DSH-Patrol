import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { assertSafePersistentText } from './security.js'
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

export interface PatrolClickTargetOptions {
  maxSteps: number
}

/**
 * New teaching-time click path. The low-level browser_click tool is kept for
 * Runbook compatibility, but model-facing teaching should resolve a concrete
 * visible target before browser_click is allowed to mutate the page.
 */
export function registerPatrolClickTargetTool(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolClickTargetOptions,
): () => void {
  const tool = defineTool({
    name: 'patrol_click_target',
    description: 'Reliably click a CURRENT visible page target. Start with locatorText. locatorRole/locatorTag are optional ranking hints and must not be guessed as hard DOM requirements. selector is optional. Broad CSS such as button or a is never allowed to silently click the first match: Patrol resolves one concrete visible stable selector first, refuses ambiguity, then clicks and records the resolved selector plus semantic locator for replay.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', description: 'Optional CSS hint. Stable selectors from patrol_snapshot are ideal. Broad selectors are accepted only when exactly one visible element matches or semantic fields uniquely identify the target.' },
      locatorText: { type: 'string', description: 'Visible/accessible target text, for example 登录、短信登录、获取验证码、立即登录.' },
      locatorRole: { type: 'string', description: 'Optional ranking hint such as button, link, tab. Supply only when CURRENT observation actually exposes the role.' },
      locatorTag: { type: 'string', description: 'Optional ranking hint such as button, a, div. Supply only when CURRENT observation actually exposes the tag.' },
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

      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)
      let resolved = await resolveCurrentTarget(runner, exec, selector, locator, args.tabId)
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

      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: 'browser_click',
        arguments: compactObject({ selector: resolved.selector, tabId: args.tabId }),
        ...optionalExpectation(args.expectedText, args.expectationMode, args.caseSensitive),
        ...optionalCondition(args.conditionSourceStepId, args.conditionExpectedText, args.conditionMode),
        ...(locator === undefined ? {} : { locator }),
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        recordedAt: new Date().toISOString(),
      }
      await appendStep(store, definition, step)

      return [
        `Executed and recorded ${step.id} (browser_click) after CURRENT target resolution.`,
        `Resolved target: ${describeTarget(resolved)}`,
        clicked.text,
        'For an important state-changing click, observe/read the CURRENT page next instead of repeating the same broad click when the expected UI does not change.',
      ].filter(Boolean).join('\n')
    },
  })

  return ctx.tools.register(tool)
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

  const snapshot = await runner.dispatch('browser_snapshot', compactObject({ maxElements: 500, tabId }), exec)
  if (!snapshot.ok) throw new Error(snapshot.error ?? 'Could not snapshot current interactive elements for click resolution')
  const elements = snapshotElements(snapshot.value)
  if (elements.length === 0) throw new Error('current page snapshot contains no visible interactive elements')

  const exactSelector = selector === undefined ? [] : elements.filter(item => item.selector === selector)
  const semantic = scoreSemanticCandidates(elements, locator, selector)
  if (semantic.length === 0 && exactSelector.length === 1 && semanticLocatorMatches(exactSelector[0]!, locator, false)) {
    return targetFromSnapshot(exactSelector[0]!, 'semantic-contains')
  }
  if (semantic.length === 0) {
    throw new Error(`no visible interactive element matched ${describeLocator(locator)}${selector ? ` with selector hint ${JSON.stringify(selector)}` : ''}. Call patrol_observe, use CURRENT visible text, and retry locatorText without guessing role/tag; do not fall back to button/a or text= selectors.`)
  }

  const bestScore = semantic[0]!.score
  const best = semantic.filter(item => item.score === bestScore)
  if (best.length !== 1) {
    const examples = best.slice(0, 5).map(item => describeSnapshot(item.element)).join('; ')
    throw new Error(`ambiguous semantic click target ${describeLocator(locator)} matched ${best.length} equally good visible elements: ${examples}. Add a role/tag only if CURRENT observation confirms it, or provide a stable selector.`)
  }

  return targetFromSnapshot(best[0]!.element, best[0]!.exactText ? 'semantic-exact' : 'semantic-contains')
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

    // Without text, role/tag are the locator and therefore remain strict.
    // With visible text, they are only ranking hints. Real-world React/Vue
    // pages frequently implement a button as a clickable div/span, and a model
    // should not lose an exact text target merely because it guessed role=button.
    if (wantedText === undefined) {
      if (wantedRole !== undefined && role !== wantedRole) continue
      if (wantedTag !== undefined && tag !== wantedTag) continue
    }

    let score = 0
    let exactText = false
    if (wantedText !== undefined) {
      if (text === wantedText) {
        score += 100
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

/**
 * Prefer the smallest/deepest semantic leaf when both a real action and one or
 * more layout ancestors merely CONTAIN the requested text. React/Ant pages
 * often make a whole table/root div look clickable to heuristic snapshots
 * because its descendant text contains an action word such as RDP or 登录.
 * Clicking the leaf is safe because DOM click bubbles to a parent handler, while
 * choosing the page-sized ancestor is both ambiguous and usually wrong.
 *
 * Exact-text ties remain ties: two rows that both literally say "RDP" still
 * require a row-specific selector rather than silently choosing one.
 */
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
  const selector = cleanString(element.selector)
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
    out.push({
      selector: object.selector,
      text: object.text,
      role: object.role,
      tag: object.tag,
    })
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

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

function objectNumber(value: JsonValue | undefined, key: string): number | undefined {
  if (value === null || value === undefined || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as JsonObject)[key]
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