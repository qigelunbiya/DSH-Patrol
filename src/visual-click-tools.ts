import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createPatrolClickOutcomeTracker, type PatrolClickOutcomeTracker } from './click-retry-state.js'
import { verifyPostClickExpectation } from './post-click-verification.js'
import { assertSafePersistentText } from './security.js'
import { stepExecutionNotes } from './step-notes.js'
import { installTeachingRunbookFilter } from './teaching-runbook-filter.js'
import type { PatrolRunner } from './runner.js'
import { assertPersistedTaskChecklist, type PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep, JsonObject, StepCondition, TextExpectation, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}
const AUTO_VERIFY_DELAYS_MS = [0, 200, 500, 1000, 2000] as const
const IMAGE_CODE_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|验证码|校验码|图形码|图片码)/i

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
export interface PatrolVisualClickOptions {
  maxSteps: number
  clickOutcomes?: PatrolClickOutcomeTracker
  browserControlMode?: 'visual-grounding' | 'hybrid'
}

export function registerPatrolVisualClickTool(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolVisualClickOptions,
): () => void {
  installTeachingRunbookFilter(store)
  const outcomes = options.clickOutcomes ?? createPatrolClickOutcomeTracker()
  const tool = defineTool({
    name: 'patrol_visual_click_target',
    description: 'Vision-first browser teaching click. After patrol_observe(includeImage=true), click the exact CURRENT screenshot point like a human: xRatio=centerX/imageWidth and yRatio=centerY/imageHeight. targetHint labels the intended business action, but CURRENT DOM is NOT a pre-click permission gate and must not relocate a live visual point. After the physical click, Patrol verifies the business result, reverse-binds the hit DOM/Shadow-DOM/Accessibility identity when trustworthy, and stores semantic/selector replay first with guarded visual geometry as fallback. Never use for image-code/CAPTCHA.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      frameId: { type: 'string', required: true },
      xRatio: { type: 'number', required: true },
      yRatio: { type: 'number', required: true },
      targetHint: { type: 'string', required: true, description: 'Concrete CURRENT business intent, e.g. 评论输入框/发布按钮/点赞按钮/完整视频标题. It labels post-click verification and learned DOM/semantic binding; it does not authorize or relocate the live screenshot coordinate.' },
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
      if (!Number.isFinite(args.xRatio) || !Number.isFinite(args.yRatio)
        || args.xRatio < 0 || args.xRatio > 1 || args.yRatio < 0 || args.yRatio > 1) {
        throw new Error('xRatio/yRatio must be finite numbers between 0 and 1')
      }
      if (!/^browser-visual-[a-z0-9-]+$/i.test(String(args.frameId ?? '').trim())) {
        throw new Error('frameId must be the visualFrameId returned by the immediately preceding patrol_observe(includeImage=true), not the screenshot file name/path. If patrol_observe has no visualFrameId, check browser_status: visualClick must be yes.')
      }
      assertSafePersistentText(args.stepName, 'stepName')
      if (typeof args.targetHint !== 'string' || args.targetHint.trim().length < 2) {
        throw new Error('targetHint is required for visual clicks as the business-intent label used for post-click verification and learned DOM/semantic binding')
      }
      assertSafePersistentText(args.targetHint, 'targetHint')
      if (args.expectedText !== undefined) assertSafePersistentText(args.expectedText, 'expectedText')
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')

      if (IMAGE_CODE_HINT.test([args.stepName, args.targetHint ?? ''].join(' '))) {
        throw new Error('browser visual click is forbidden for image-code/CAPTCHA. Keep the existing Patrol Windows/local OCR image-code solver path.')
      }

      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)
      const expectation = optionalExpectation(args.expectedText, args.expectationMode, args.caseSensitive)
      const beforeState = expectation.expectation === undefined ? await capturePageState(runner, exec, args.tabId) : undefined
      const visualAuthority = options.browserControlMode === 'visual-grounding'
      const clicked = await runner.dispatch('browser_visual_click', compactObject({
        frameId: args.frameId,
        xRatio: args.xRatio,
        yRatio: args.yRatio,
        targetHint: args.targetHint,
        visualAuthority,
        tabId: args.tabId,
      }), exec)
      if (!clicked.ok) {
        return [
          'Visual fallback failed before Patrol could confirm a physical click, so this attempt does NOT consume the visual physical-click budget.',
          clicked.error ?? clicked.text ?? 'Unknown browser visual click error',
          'Capture a fresh patrol_observe(includeImage=true) and retry with its new visualFrameId if useful. There is no fixed visual-screenshot count ceiling; older model-visible image blocks are offloaded and oversized text tool results are pruned before new visual attachments.',
        ].filter(Boolean).join('\n')
      }
      outcomes.recordVisualPhysicalClick(args)

      if (objectBoolean(clicked.value, 'physicalClickUncertain') === true) {
        outcomes.recordUnverifiedPhysicalClick(args)
        return [
          'A trusted physical click may already have been dispatched, but its final outcome is uncertain, so Patrol deliberately did NOT issue a synthetic duplicate and did NOT record the step.',
          objectString(clicked.value, 'stateEvidence') ?? clicked.text,
          'Observe the CURRENT page state before deciding whether another click is necessary. Never blindly retry the same visual frame after an uncertain physical click.',
        ].filter(Boolean).join('\n')
      }

      const mismatch = visualTargetMismatch(args.targetHint, clicked.value)
      if (objectBoolean(clicked.value, 'unexpectedNavigation') === true) {
        outcomes.recordUnverifiedPhysicalClick(args)
        return [
          'Visual physical click executed at the model-selected screenshot point but was NOT recorded because an in-page business control unexpectedly navigated away.',
          mismatch ?? objectString(clicked.value, 'stateEvidence') ?? 'unexpected navigation',
          clicked.text,
          'The live visual coordinate was not DOM-relocated. Capture a fresh CURRENT frame after returning to the intended page and choose the visible control itself.',
        ].filter(Boolean).join('\n')
      }

      let verificationMethod: NonNullable<ToolStep['teaching']>['method']
      let verificationEvidence = ''
      let verificationAttempts = 1
      if (expectation.expectation !== undefined) {
        const verified = await verifyPostClickExpectation(
          (toolName, toolArgs, toolExec) => runner.dispatch(toolName, toolArgs, toolExec),
          exec,
          expectation.expectation,
          args.tabId,
        )
        verificationAttempts = verified.attempts
        if (!verified.ok) {
          outcomes.recordUnverifiedPhysicalClick(args)
          return [
            'Visual click executed but was NOT recorded because the requested business expectation was not reached.',
            verified.error ?? 'unknown expected-text verification error',
            clicked.text,
          ].filter(Boolean).join('\n')
        }
        verificationMethod = 'expected-text'
        verificationEvidence = `${expectation.expectation.mode} ${JSON.stringify(expectation.expectation.value)}`
      } else if (objectBoolean(clicked.value, 'targetStateChanged') === true) {
        verificationMethod = 'state-change'
        verificationEvidence = objectString(clicked.value, 'stateEvidence') ?? 'clicked visual target changed its own CURRENT DOM state'
      } else if (objectBoolean(clicked.value, 'targetFocusedEditable') === true) {
        verificationMethod = 'state-change'
        verificationEvidence = objectString(clicked.value, 'stateEvidence') ?? 'clicked visual target focused an editable control'
      } else {
        const verified = await verifyAutomaticStateChange(runner, exec, beforeState, args.tabId, args.targetHint)
        verificationAttempts = verified.attempts
        if (!verified.ok) {
          outcomes.recordUnverifiedPhysicalClick(args)
          return [
            'Visual click executed but was NOT recorded because no meaningful CURRENT target/page/DOM state change could be verified.',
            verified.evidence,
            clicked.text,
            'Do not report this target as completed. If this was an in-page control and navigation occurred, return to the original page before any retry; never count the navigation itself as success.',
          ].filter(Boolean).join('\n')
        }
        verificationMethod = 'state-change'
        verificationEvidence = verified.evidence ?? 'CURRENT page/DOM changed after visual click'
      }

      if (mismatch !== undefined) {
        outcomes.recordUnverifiedPhysicalClick(args)
        return [
          'Visual click was physically executed, but the post-click hit binding contradicts the requested business control, so this teaching step was NOT recorded.',
          mismatch,
          'DOM evidence was used only after the visual click; it did not move or block the model-selected point.',
          clicked.text,
        ].filter(Boolean).join('\n')
      }

      const selectorHint = objectString(clicked.value, 'selectorHint')
      const urlIdentity = objectString(clicked.value, 'urlIdentity')
      const viewportWidth = objectNumber(clicked.value, 'viewportWidth')
      const viewportHeight = objectNumber(clicked.value, 'viewportHeight')
      const captureClientLeft = objectNumber(clicked.value, 'captureClientLeft')
      const captureClientTop = objectNumber(clicked.value, 'captureClientTop')
      const captureWidth = objectNumber(clicked.value, 'captureWidth')
      const captureHeight = objectNumber(clicked.value, 'captureHeight')
      const captureMode = objectString(clicked.value, 'captureMode')
      const scrollX = objectNumber(clicked.value, 'scrollX')
      const scrollY = objectNumber(clicked.value, 'scrollY')
      if (urlIdentity === undefined || viewportWidth === undefined || viewportHeight === undefined || scrollX === undefined || scrollY === undefined) {
        outcomes.recordUnverifiedPhysicalClick(args)
        return 'Visual click reached a verified state but returned incomplete replay geometry, so it was NOT persisted. Capture a fresh visual observation and reteach the target.'
      }

      const effectiveXRatio = objectNumber(clicked.value, 'xRatio') ?? args.xRatio
      const effectiveYRatio = objectNumber(clicked.value, 'yRatio') ?? args.yRatio
      const bindingActionable = objectBoolean(clicked.value, 'bindingActionable') === true
      const selectorReplaySafe = objectBoolean(clicked.value, 'selectorReplaySafe') !== false
      const learnedLocatorText = bindingActionable
        ? learnedVisualLocatorText(clicked.value)
        : undefined
      const learnedLocatorRole = learnedLocatorText === undefined ? undefined : objectString(clicked.value, 'targetRole')
      const learnedLocatorTag = learnedLocatorText === undefined ? undefined : objectString(clicked.value, 'targetTag')
      const stepArguments = compactObject({
        // Live teaching persists the exact screenshot point selected by vision.
        // DOM/semantic identity is learned from that hit afterwards and is tried
        // first on replay; guarded geometry remains the final fallback.
        xRatio: effectiveXRatio,
        yRatio: effectiveYRatio,
        selectorHint: selectorReplaySafe ? selectorHint : undefined,
        learnedLocatorText,
        learnedLocatorRole,
        learnedLocatorTag,
        learnedSelectorQuality: objectString(clicked.value, 'selectorQuality'),
        learnedBindingSource: objectString(clicked.value, 'bindingSource'),
        teachingControlMode: options.browserControlMode,
        urlIdentity,
        viewportWidth,
        viewportHeight,
        viewportScale: objectNumber(clicked.value, 'viewportScale'),
        captureClientLeft,
        captureClientTop,
        captureWidth,
        captureHeight,
        captureMode,
        scrollX,
        scrollY,
        expectedTag: objectString(clicked.value, 'targetTag'),
        expectedRole: objectString(clicked.value, 'targetRole'),
        expectedTitle: objectString(clicked.value, 'targetTitle'),
        expectedAriaLabel: objectString(clicked.value, 'targetAriaLabel'),
        targetHint: args.targetHint.trim(),
        targetTextHint: objectString(clicked.value, 'targetText'),
        targetIdHint: objectString(clicked.value, 'targetId'),
        targetClassHint: objectString(clicked.value, 'targetClassName'),
      })
      const condition = optionalCondition(args.conditionSourceStepId, args.conditionExpectedText, args.conditionMode)
      const targetNote = `视觉目标：${args.targetHint.trim()}`
      const providedNotes = [targetNote, args.notes?.trim()].filter(Boolean).join('\n')
      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: 'browser_visual_click',
        arguments: stepArguments,
        ...expectation,
        ...condition,
        teaching: { status: 'verified', method: verificationMethod, evidence: verificationEvidence },
        taskHint: args.targetHint.trim(),
        notes: stepExecutionNotes({
          tool: 'browser_visual_click',
          args: stepArguments,
          ...expectation,
          ...condition,
          providedNotes,
        }),
        recordedAt: new Date().toISOString(),
      }
      definition.steps.push(step)
      definition.schemaVersion = '0.2'
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.flowHealth
      await store.save(definition)
      outcomes.recordVerified(args)

      return [
        `Executed and recorded ${step.id} (browser_visual_click) after CURRENT visual-state verification.`,
        `Visual point saved for replay: xRatio=${effectiveXRatio.toFixed(4)}, yRatio=${effectiveYRatio.toFixed(4)}; model-requested=(${args.xRatio.toFixed(4)}, ${args.yRatio.toFixed(4)}); capture=${captureWidth ?? viewportWidth}x${captureHeight ?? viewportHeight} CSS px at (${captureClientLeft ?? 0}, ${captureClientTop ?? 0}).`,
        objectBoolean(clicked.value, 'visualAuthority') === true
          ? 'TEST visual-grounding used the exact model-selected screenshot point; DOM/Shadow-DOM did not relocate it before physical input.'
          : objectBoolean(clicked.value, 'visualSnapped') === true
            ? `Replay coordinate was corrected against CURRENT learned evidence by ${objectNumber(clicked.value, 'snapDistance')?.toFixed(1) ?? '?'} CSS px.`
            : 'Replay used the recorded visual geometry without correction.',
        learnedLocatorText
          ? `Learned reusable DOM/semantic binding from the successful visual hit: text=${JSON.stringify(learnedLocatorText)}${learnedLocatorRole ? `, role=${learnedLocatorRole}` : ''}${learnedLocatorTag ? `, tag=${learnedLocatorTag}` : ''}. Replay tries this semantic identity first, then the learned selector, then guarded visual geometry.`
          : selectorHint
            ? `No trustworthy semantic label was learned; replay tries discovered selector ${JSON.stringify(selectorHint)} before guarded visual geometry.`
            : 'No trustworthy DOM binding was available; replay keeps guarded normalized visual geometry as fallback.',
        `Verification: ${verificationMethod}, ${verificationEvidence}, attempts=${verificationAttempts}.`,
        clicked.text,
      ].filter(Boolean).join('\n')
    },
  })
  return ctx.tools.register(tool)
}

async function capturePageState(runner: PatrolRunner, exec: ToolRunContext, tabId: number | undefined): Promise<PageState | undefined> {
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
async function verifyAutomaticStateChange(runner: PatrolRunner, exec: ToolRunContext, before: PageState | undefined, tabId: number | undefined, targetHint?: string): Promise<StateChangeVerification> {
  if (before === undefined) return { ok: false, attempts: 0 }
  for (let index = 0; index < AUTO_VERIFY_DELAYS_MS.length; index += 1) {
    const delayMs = AUTO_VERIFY_DELAYS_MS[index]!
    if (delayMs > 0) await sleep(delayMs)
    const after = await capturePageState(runner, exec, tabId)
    if (after === undefined) continue
    if (before.url && after.url && before.url !== after.url && inPageControlHint(targetHint)) {
      return {
        ok: false,
        attempts: index + 1,
        evidence: `unexpected navigation for in-page control ${JSON.stringify(targetHint ?? '')}: ${safeStateUrl(before.url)} -> ${safeStateUrl(after.url)}`,
      }
    }
    const evidence = stateChangeEvidence(before, after)
    if (evidence !== undefined) return { ok: true, attempts: index + 1, evidence }
  }
  return { ok: false, attempts: AUTO_VERIFY_DELAYS_MS.length }
}
function inPageControlHint(targetHint: string | undefined): boolean {
  const hint = normalizePageText(targetHint ?? '')
  return /点赞|投币|收藏|评论|回复|输入框|编辑框|发布|发表|发送|提交|like|favorite|comment|reply|post|send|submit/.test(hint)
}

function stateChangeEvidence(before: PageState, after: PageState): string | undefined {
  if (before.url && after.url && before.url !== after.url) return `URL changed from ${safeStateUrl(before.url)} to ${safeStateUrl(after.url)}`
  // Global dynamic DOM/text churn is not evidence that a visual business target
  // was hit. The provider reports target-local state/focus above; this fallback
  // accepts navigation only.
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
function visualTargetMismatch(targetHint: string | undefined, value: unknown): string | undefined {
  const hint = normalizePageText(targetHint ?? '')
  if (!hint) return undefined
  if (objectBoolean(value, 'unexpectedNavigation') === true) {
    return `targetHint expects an in-page business control, but CURRENT click unexpectedly navigated away instead of activating ${JSON.stringify(targetHint ?? '')}`
  }
  const haystack = normalizePageText([
    objectString(value, 'selectorHint') ?? '',
    objectString(value, 'targetText') ?? '',
    objectString(value, 'targetTitle') ?? '',
    objectString(value, 'targetAriaLabel') ?? '',
    objectString(value, 'targetId') ?? '',
    objectString(value, 'targetClassName') ?? '',
  ].join(' '))

  const wantsCommentEditor = /评论.*(?:输入|编辑)|回复.*(?:输入|编辑)|输入框|编辑框|comment.*(?:input|editor)|reply.*(?:input|editor)/i.test(hint)
  if (wantsCommentEditor) {
    const focused = objectBoolean(value, 'targetFocusedEditable') === true
    const explicitEditorEvidence = /textbox|textarea|contenteditable|bili-comment-editor|comment-editor|reply-editor/.test(haystack)
    const broadCommentsShell = /(?:^|[^a-z])bili-comments(?:[^a-z]|$)/.test(haystack)
    if (broadCommentsShell && !focused) {
      return 'targetHint expects the actual comment editor, but CURRENT click only resolved the whole bili-comments container and did not focus an editable control'
    }
    if (!focused && !explicitEditorEvidence) {
      return `targetHint expects a focused comment editor, but CURRENT clicked DOM evidence was ${JSON.stringify(haystack.slice(0, 320) || '(empty)')}`
    }
  }

  const groups: Array<{ hint: RegExp; evidence: RegExp; label: string }> = [
    { hint: /点赞|大拇指|\blike\b|thumb/, evidence: /点赞|\blike\b|thumb|video-like|aria-pressed/, label: '点赞/like' },
    { hint: /评论|回复|\bcomment\b|\breply\b/, evidence: /评论|回复|comment|reply|editor|textarea|placeholder/, label: '评论/comment' },
    { hint: /搜索|\bsearch\b/, evidence: /搜索|search/, label: '搜索/search' },
    { hint: /发布|发表|发送|提交|\bpost\b|\bsend\b|\bsubmit\b/, evidence: /发布|发表|发送|提交|post|send|submit/, label: '发布/发送/post' },
  ]
  const expected = groups.find(group => group.hint.test(hint))
  if (expected === undefined || expected.evidence.test(haystack)) return undefined
  return `targetHint expects ${expected.label}, but CURRENT clicked DOM evidence was ${JSON.stringify(haystack.slice(0, 320) || '(empty)')}`
}

function learnedVisualLocatorText(value: unknown): string | undefined {
  const candidates = [
    objectString(value, 'targetAriaLabel'),
    objectString(value, 'targetTitle'),
    objectString(value, 'targetText'),
  ]
  for (const candidate of candidates) {
    const text = candidate?.replace(/\s+/g, ' ').trim()
    if (!text || text.length < 2 || text.length > 180 || /^\d[\d,.万亿kKmM+\s]*$/.test(text)) continue
    return text
  }
  return undefined
}

async function loadEditable(store: PatrolStore, inspectionId: string, maxSteps: number): Promise<InspectionDefinition> {
  const definition = await store.load(inspectionId)
  if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}, not draft; call patrol_begin_edit before teaching a visual click`)
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
  return { expectation: { mode: mode === 'not-contains' ? 'not-contains' : 'contains', value: expectedText, caseSensitive: caseSensitive ?? false } }
}
function optionalCondition(sourceStepId: string | undefined, expectedText: string | undefined, mode: string | undefined): { when?: StepCondition } {
  if (sourceStepId === undefined && expectedText === undefined) return {}
  if (sourceStepId === undefined || expectedText === undefined) throw new Error('conditional steps require both conditionSourceStepId and conditionExpectedText')
  return { when: { sourceStepId, mode: mode === 'not-contains' ? 'not-contains' : 'contains', value: expectedText, caseSensitive: false } }
}
function compactObject(value: Record<string, string | number | boolean | undefined>): JsonObject {
  const out: JsonObject = {}
  for (const [key, child] of Object.entries(value)) if (child !== undefined) out[key] = child
  return out
}
function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'string' && child.trim() !== '' ? child : undefined
}
function objectNumber(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'number' && Number.isFinite(child) ? child : undefined
}
function objectBoolean(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'boolean' ? child : undefined
}
function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
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
