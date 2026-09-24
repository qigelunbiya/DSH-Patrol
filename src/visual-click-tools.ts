import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { createPatrolClickOutcomeTracker, type PatrolClickOutcomeTracker } from './click-retry-state.js'
import { captureBrowserTabBaseline, formatFreshBrowserTabs, reconcileFreshBrowserTabs } from './browser-tab-reconciliation.js'
import { verifyPostClickExpectation } from './post-click-verification.js'
import { assertSafePersistentText } from './security.js'
import { stepExecutionNotes } from './step-notes.js'
import { installTeachingRunbookFilter } from './teaching-runbook-filter.js'
import type { PatrolRunner } from './runner.js'
import { assertPersistedTaskChecklist, type PatrolStore } from './store.js'
import type { InspectionDefinition, InspectionStep, JsonObject, JsonValue, StepCondition, TextExpectation, ToolStep } from './types.js'
import type { PatrolVisualEvidenceRegistry } from './visual-evidence-registry.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}
const AUTO_VERIFY_DELAYS_MS = [0, 200, 500, 1000, 2000] as const
const IMAGE_CODE_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|验证码|校验码|图形码|图片码)/i

interface PageState {
  url: string
  title: string
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
  visualEvidence?: PatrolVisualEvidenceRegistry
  requirePreview?: boolean
}

export function registerPatrolVisualClickTool(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  options: PatrolVisualClickOptions,
): () => void {
  installTeachingRunbookFilter(store)
  const outcomes = options.clickOutcomes ?? createPatrolClickOutcomeTracker()
  const visualPreviews = new Map<string, {
    previewId: string
    inspectionId: string
    targetHint: string
    frameId: string
    xRatio: number
    yRatio: number
    createdAt: number
  }>()
  let visualPreviewSequence = 0
  const tool = defineTool({
    name: 'patrol_visual_click_target',
    description: 'Primary browser visual click. Preferred live path is CURRENT screenshot raster -> model picks the target center -> pass imageX/imageY from that exact attached raster -> Patrol converts those pixels through the frame\'s stored raster/capture geometry exactly once -> Chrome debugger dispatches a trusted mouse click at that viewport point. Do not manually convert pixels to xRatio when imageX/imageY are available. candidateId remains an optional compatibility path for explicit Action Maps; xRatio/yRatio remain a legacy normalized fallback. frameId is normally omitted because Patrol auto-binds the latest model-visible patrol_observe(includeImage=true) frame. Live visual clicks fail closed if trusted debugger mouse input is unavailable; they never silently substitute element.click() or synthetic MouseEvents. Never use for image-code/CAPTCHA.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      frameId: { type: 'string', description: 'Optional explicit browser visualFrameId. Normally omit it: Patrol automatically uses the latest model-visible patrol_observe(includeImage=true) frame for this inspection. Screenshot file names/paths are never valid frame IDs.' },
      previewId: { type: 'string', description: 'Optional diagnostic token returned by pointerAction=mark. Normal visual clicks do not require it.' },
      imageX: { type: 'number', description: 'Preferred CURRENT screenshot pixel X of the target center, measured on the exact model-visible raster returned by patrol_observe(includeImage=true). Patrol uses the frame\'s stored raster width; do not convert this to CSS pixels.' },
      imageY: { type: 'number', description: 'Preferred CURRENT screenshot pixel Y of the target center, measured on the exact model-visible raster returned by patrol_observe(includeImage=true). Patrol uses the frame\'s stored raster height; do not convert this to CSS pixels.' },
      imageWidth: { type: 'number', description: 'Optional validation copy of modelRasterWidth from CURRENT patrol_observe. If supplied and it does not match the bound frame, Patrol refuses the click.' },
      imageHeight: { type: 'number', description: 'Optional validation copy of modelRasterHeight from CURRENT patrol_observe. If supplied and it does not match the bound frame, Patrol refuses the click.' },
      xRatio: { type: 'number', description: 'Legacy normalized screenshot X fallback. Prefer imageX/imageY because manual ratio conversion adds avoidable error for small controls.' },
      yRatio: { type: 'number', description: 'Legacy normalized screenshot Y fallback. Prefer imageX/imageY because manual ratio conversion adds avoidable error for small controls.' },
      candidateId: { type: 'string', description: 'A visual A1/A2/... label chosen by the model from patrol_observe(includeImage=true, actionMap=true). When the candidate is visually clear, click it directly; Patrol binds the click to that candidate safe-point and fingerprint. Use mark only when the model itself is uncertain.' },
      targetHint: { type: 'string', required: true, description: 'Concrete CURRENT business intent, e.g. 评论输入框/发布按钮/点赞按钮/完整视频标题. It labels post-click verification and learned DOM/semantic binding; it does not authorize or relocate the live screenshot coordinate.' },
      expectedVisualText: { type: 'string', description: 'Optional extra exact visible label/title from the attached CURRENT screenshot. Action Map candidate clicks automatically carry candidate-visible text/title/aria evidence; free-XY navigation/card/video clicks still require expectedVisualText so Patrol can verify the raw point and destination.' },
      visualAuthority: { type: 'boolean', description: 'Backward-compatible flag. Live patrol_visual_click_target teaching is coordinate-authoritative regardless of this value; replay may still use learned semantic/selector recovery.' },
      pointerAction: {
        type: 'string',
        enum: ['left-click', 'right-click', 'hover', 'mark'],
        description: 'Default left-click records a verified business action. right-click/hover/mark are visual-coordinate diagnostics only: they never record a Runbook step. mark draws a temporary red crosshair at the exact screenshot point; hover dispatches a browser mouseMoved event plus the marker; right-click dispatches a trusted right-button click at that exact point.',
      },
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
      const requestedPreviewId = typeof args.previewId === 'string' ? args.previewId.trim() : ''
      const boundPreview = requestedPreviewId ? visualPreviews.get(requestedPreviewId) : undefined
      if (requestedPreviewId && !boundPreview) {
        throw new Error(`browser visual preview ${JSON.stringify(requestedPreviewId)} is unavailable or stale; mark the CURRENT target again before clicking`)
      }
      if (boundPreview && Date.now() - boundPreview.createdAt > 45000) {
        visualPreviews.delete(requestedPreviewId)
        throw new Error('browser visual preview is stale; mark the CURRENT target again before clicking')
      }
      if (boundPreview && boundPreview.inspectionId !== args.inspectionId) {
        throw new Error('browser visual preview belongs to a different inspection')
      }
      const requestedTargetHint = typeof args.targetHint === 'string' ? args.targetHint.trim() : ''
      if (boundPreview && normalizePageText(boundPreview.targetHint) !== normalizePageText(requestedTargetHint)) {
        throw new Error('browser visual preview is bound to a different business target; mark this target again instead of reusing another control preview')
      }

      const candidateId = boundPreview ? '' : (typeof args.candidateId === 'string' ? args.candidateId.trim().toUpperCase() : '')
      const hasCandidate = /^A[1-9]\d*$/i.test(candidateId)
      const imageX = boundPreview ? Number.NaN : (typeof args.imageX === 'number' ? args.imageX : Number.NaN)
      const imageY = boundPreview ? Number.NaN : (typeof args.imageY === 'number' ? args.imageY : Number.NaN)
      const hasImagePoint = Number.isFinite(imageX) && Number.isFinite(imageY) && imageX >= 0 && imageY >= 0
      const pointX = boundPreview ? boundPreview.xRatio : (typeof args.xRatio === 'number' ? args.xRatio : Number.NaN)
      const pointY = boundPreview ? boundPreview.yRatio : (typeof args.yRatio === 'number' ? args.yRatio : Number.NaN)
      const hasRatioPoint = Number.isFinite(pointX) && Number.isFinite(pointY)
        && pointX >= 0 && pointX <= 1 && pointY >= 0 && pointY <= 1
      if ([hasCandidate, hasImagePoint, hasRatioPoint || Boolean(boundPreview)].filter(Boolean).length > 1) {
        throw new Error('visual click requires exactly one coordinate source: imageX/imageY (preferred), candidateId, xRatio/yRatio, or previewId')
      }
      if (!hasCandidate && !hasImagePoint && !hasRatioPoint && !boundPreview) {
        throw new Error('visual click requires imageX/imageY from the CURRENT model-visible raster (preferred), candidateId=A#, previewId, or legacy xRatio/yRatio')
      }
      const explicitFrameId = String(args.frameId ?? '').trim()
      const frameId = boundPreview?.frameId
        || explicitFrameId
        || options.visualEvidence?.latest(args.inspectionId)
        || ''
      if (!/^browser-visual-[a-z0-9-]+$/i.test(frameId)) {
        throw new Error('no CURRENT model-visible browser visual frame is available. Run patrol_observe(includeImage=true,targetHint=...) first. Do not copy screenshot file names/paths into frameId.')
      }
      assertSafePersistentText(args.stepName, 'stepName')
      if (typeof args.targetHint !== 'string' || args.targetHint.trim().length < 2) {
        throw new Error('targetHint is required for visual clicks as the business-intent label used for post-click verification and learned DOM/semantic binding')
      }
      assertSafePersistentText(args.targetHint, 'targetHint')
      if (args.expectedVisualText !== undefined) assertSafePersistentText(args.expectedVisualText, 'expectedVisualText')
      const pointerAction = args.pointerAction ?? 'left-click'
      const diagnosticPointerAction = pointerAction !== 'left-click'
      if (!diagnosticPointerAction && !hasCandidate && navigationLikeBusinessAction(args.stepName, args.targetHint)
        && (typeof args.expectedVisualText !== 'string' || args.expectedVisualText.trim().length < 4)) {
        throw new Error('direct screenshot-coordinate navigation/card clicks require expectedVisualText copied from the CURRENT model-visible screenshot so Patrol can verify the destination')
      }
      if (args.expectedText !== undefined) assertSafePersistentText(args.expectedText, 'expectedText')
      if (args.conditionExpectedText !== undefined) assertSafePersistentText(args.conditionExpectedText, 'conditionExpectedText')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')

      if (IMAGE_CODE_HINT.test([args.stepName, args.targetHint ?? ''].join(' '))) {
        throw new Error('browser visual click is forbidden for image-code/CAPTCHA. Keep the existing Patrol Windows/local OCR image-code solver path.')
      }

      const evidence = options.visualEvidence?.consume(frameId, args.inspectionId)
      if (evidence?.ok === false) {
        throw new Error(`visual click refused: ${evidence.reason}. A visualFrameId is usable only after patrol_observe(includeImage=true) actually attached that screenshot to the model; after that it remains reusable while the browser still matches it.`)
      }

      if (diagnosticPointerAction) {
        await store.load(args.inspectionId)
        const probed = await runner.dispatch('browser_visual_click', compactObject({
          frameId,
          candidateId: hasCandidate ? candidateId : undefined,
          imageX: hasImagePoint ? imageX : undefined,
          imageY: hasImagePoint ? imageY : undefined,
          imageWidth: hasImagePoint && typeof args.imageWidth === 'number' ? args.imageWidth : undefined,
          imageHeight: hasImagePoint && typeof args.imageHeight === 'number' ? args.imageHeight : undefined,
          xRatio: hasRatioPoint || boundPreview ? pointX : undefined,
          yRatio: hasRatioPoint || boundPreview ? pointY : undefined,
          targetHint: args.targetHint,
          expectedVisualText: args.expectedVisualText,
          visualAuthority: true,
          pointerAction,
          tabId: args.tabId,
        }), exec)
        if (!probed.ok) {
          return [
            `Visual pointer diagnostic ${pointerAction} failed at the requested screenshot coordinate.`,
            probed.error ?? probed.text ?? 'Unknown browser visual pointer error',
          ].filter(Boolean).join('\n')
        }
        const hit = [
          objectString(probed.value, 'targetTag') ? `tag=${objectString(probed.value, 'targetTag')}` : '',
          objectString(probed.value, 'targetRole') ? `role=${objectString(probed.value, 'targetRole')}` : '',
          objectString(probed.value, 'targetText') ? `text=${JSON.stringify(objectString(probed.value, 'targetText'))}` : '',
          objectString(probed.value, 'targetTitle') ? `title=${JSON.stringify(objectString(probed.value, 'targetTitle'))}` : '',
          objectString(probed.value, 'targetAriaLabel') ? `aria=${JSON.stringify(objectString(probed.value, 'targetAriaLabel'))}` : '',
        ].filter(Boolean).join(', ')
        let previewLine = ''
        if (pointerAction === 'mark') {
          const previewX = objectNumber(probed.value, 'xRatio') ?? pointX
          const previewY = objectNumber(probed.value, 'yRatio') ?? pointY
          if (Number.isFinite(previewX) && Number.isFinite(previewY)) {
            visualPreviewSequence += 1
            const previewId = `browser-preview-${Date.now().toString(36)}-${visualPreviewSequence.toString(36)}`
            visualPreviews.set(previewId, {
              previewId,
              inspectionId: args.inspectionId,
              targetHint: args.targetHint.trim(),
              frameId,
              xRatio: previewX,
              yRatio: previewY,
              createdAt: Date.now(),
            })
            while (visualPreviews.size > 24) {
              const oldest = visualPreviews.keys().next().value
              if (!oldest) break
              visualPreviews.delete(oldest)
            }
            const resolvedClickX = objectNumber(probed.value, 'resolvedClickX')
            const resolvedClickY = objectNumber(probed.value, 'resolvedClickY')
            const viewportWidth = objectNumber(probed.value, 'viewportWidth')
            const viewportHeight = objectNumber(probed.value, 'viewportHeight')
            const focusXRatio = resolvedClickX !== undefined && viewportWidth !== undefined && viewportWidth > 0
              ? Math.max(0, Math.min(1, resolvedClickX / viewportWidth))
              : undefined
            const focusYRatio = resolvedClickY !== undefined && viewportHeight !== undefined && viewportHeight > 0
              ? Math.max(0, Math.min(1, resolvedClickY / viewportHeight))
              : undefined
            const focusInstruction = focusXRatio !== undefined && focusYRatio !== undefined
              ? ` For precise verification, call patrol_observe(includeImage=true, focusXRatio=${focusXRatio.toFixed(4)}, focusYRatio=${focusYRatio.toFixed(4)}, focusWidthRatio=0.22, focusHeightRatio=0.24) so the same red crosshair is inspected in a magnified CURRENT crop.`
              : ' After patrol_observe(includeImage=true) confirms the red crosshair is exactly on the intended control, continue.'
            previewLine = `Visual preview token: ${previewId}.${focusInstruction} Then call patrol_visual_click_target with this previewId and the same targetHint. Do not recompute or restate coordinates.`
          }
        }
        return [
          hasCandidate
            ? `Visual pointer diagnostic ${pointerAction} executed on vision-selected action-map candidate ${candidateId}; browser geometry supplied the exact control center.`
            : hasImagePoint
              ? `Visual pointer diagnostic ${pointerAction} executed from CURRENT model-raster pixel imageX=${imageX.toFixed(1)}, imageY=${imageY.toFixed(1)}; Patrol performed the raster-to-viewport mapping.`
              : `Visual pointer diagnostic ${pointerAction} executed at legacy normalized frame coordinate xRatio=${pointX.toFixed(4)}, yRatio=${pointY.toFixed(4)}.`,
          pointerAction === 'mark'
            ? 'A temporary red crosshair was drawn on the page for visual calibration; no click was issued.'
            : pointerAction === 'hover'
              ? 'A trusted browser mouseMoved event was issued and the red calibration marker was drawn. CDP hover does not guarantee that the operating-system hardware cursor itself visibly moves.'
              : 'A trusted right-button browser click was issued at that coordinate and a red calibration marker was drawn. This is diagnostic only and was NOT written to the Runbook.',
          previewLine,
          hit ? `CURRENT hit under that exact point: ${hit}.` : 'No stable DOM identity was required for this diagnostic point.',
          'Diagnostic pointer actions never consume visual retry budget and never become replay steps.',
        ].filter(Boolean).join('\n')
      }

      const definition = await loadEditable(store, args.inspectionId, options.maxSteps)
      const expectation = optionalExpectation(args.expectedText, args.expectationMode, args.caseSensitive)
      const navigationAction = navigationLikeBusinessAction(args.stepName, args.targetHint)
      const isVisualNavigation = navigationAction && (hasCandidate
        || (typeof args.expectedVisualText === 'string' && args.expectedVisualText.trim().length >= 4))
      const tabBaseline = isVisualNavigation
        ? await captureBrowserTabBaseline(runner, exec)
        : undefined
      const beforeState = expectation.expectation === undefined || isVisualNavigation
        ? await capturePageState(runner, exec, args.tabId)
        : undefined
      // A live patrol_visual_click_target is a visual action by definition.
      // Keep the screenshot coordinate authoritative even if the model forgets
      // to pass visualAuthority=true; AUTO/HYBRID decides which tool to choose,
      // not whether this visual tool may silently relocate its live point.
      const visualAuthority = true
      const clicked = await runner.dispatch('browser_visual_click', compactObject({
        frameId,
        candidateId: hasCandidate ? candidateId : undefined,
        imageX: hasImagePoint ? imageX : undefined,
        imageY: hasImagePoint ? imageY : undefined,
        imageWidth: hasImagePoint && typeof args.imageWidth === 'number' ? args.imageWidth : undefined,
        imageHeight: hasImagePoint && typeof args.imageHeight === 'number' ? args.imageHeight : undefined,
        xRatio: hasRatioPoint || boundPreview ? pointX : undefined,
        yRatio: hasRatioPoint || boundPreview ? pointY : undefined,
        targetHint: args.targetHint,
        expectedVisualText: args.expectedVisualText,
        visualAuthority,
        pointerAction: 'left-click',
        tabId: args.tabId,
      }), exec)
      if (!clicked.ok) {
        return [
          'Visual click failed before Patrol could confirm a physical click, so this attempt does NOT consume the visual physical-click budget. The same frameId may be retried if CURRENT URL/scroll/zoom/viewport are still unchanged.',
          clicked.error ?? clicked.text ?? 'Unknown browser visual click error',
          'Reuse this frameId freely while the CURRENT page geometry still matches it; capture a new patrol_observe(includeImage=true) only after navigation, scroll, zoom, viewport/layout changes, or when a new screenshot is actually useful.',
          boundPreview
            ? 'The click reused the exact visually marked point; capture a fresh CURRENT frame and mark a different point instead of nudging this preview token.'
            : hasCandidate
              ? 'If this Action Map candidate is wrong, capture a fresh CURRENT screenshot and use the direct imageX/imageY path instead of repeatedly guessing A# labels.'
              : hasImagePoint
                ? 'If this raster pixel is wrong, capture a fresh CURRENT screenshot (or a focused crop for a tiny control) and choose the target center again in image pixels; do not nudge CSS/viewport coordinates manually.'
                : 'If this legacy ratio is wrong, capture a fresh CURRENT screenshot and switch to imageX/imageY so Patrol owns the only coordinate conversion.',
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

      const explicitExpectedVisualText = typeof args.expectedVisualText === 'string' ? args.expectedVisualText.trim() : ''
      const effectiveExpectedVisualText = explicitExpectedVisualText
        || (hasCandidate ? objectString(clicked.value, 'actionCandidateExpectedText') : undefined)
        || (hasCandidate ? objectString(clicked.value, 'targetText') : undefined)
        || (hasCandidate ? objectString(clicked.value, 'targetAriaLabel') : undefined)
        || (hasCandidate ? objectString(clicked.value, 'targetTitle') : undefined)
      let navigationTabId = args.tabId
      let tabReconciliationEvidence = ''
      if (isVisualNavigation) {
        const reconciled = await reconcileFreshBrowserTabs(
          runner,
          exec,
          tabBaseline,
          effectiveExpectedVisualText,
        )
        if (reconciled?.ambiguous) {
          outcomes.recordUnverifiedPhysicalClick(args)
          return [
            'Visual navigation opened multiple fresh tabs, but Patrol could not uniquely identify the screenshot-selected destination. No tabs were closed.',
            `Fresh tabs: ${formatFreshBrowserTabs(reconciled.freshTabs)}`,
            'Inspect the fresh tab titles and retry from the correct CURRENT tab; do not continue clicking on the old source tab.',
          ].join('\n')
        }
        if (reconciled?.selected) {
          navigationTabId = reconciled.selected.id
          tabReconciliationEvidence = reconciled.closedTabIds.length > 0
            ? `Selected fresh tab ${reconciled.selected.id} for ${JSON.stringify(effectiveExpectedVisualText ?? args.targetHint)} and closed wrong fresh sibling tab(s): ${reconciled.closedTabIds.join(', ')}.`
            : `Selected fresh tab ${reconciled.selected.id} for ${JSON.stringify(effectiveExpectedVisualText ?? args.targetHint)}.`
        }
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
      if (isVisualNavigation) {
        const verified = await verifyAutomaticStateChange(
          runner,
          exec,
          beforeState,
          navigationTabId,
          args.targetHint,
          effectiveExpectedVisualText,
        )
        verificationAttempts = verified.attempts
        if (!verified.ok) {
          outcomes.recordUnverifiedPhysicalClick(args)
          return [
            'Visual navigation was physically executed but was NOT recorded because the destination does not match the exact item selected from the model-visible screenshot.',
            verified.evidence,
            clicked.text,
          ].filter(Boolean).join('\n')
        }
        verificationMethod = 'state-change'
        verificationEvidence = [
          verified.evidence ?? `navigation reached the screenshot-selected item ${JSON.stringify(effectiveExpectedVisualText ?? args.targetHint)}`,
          tabReconciliationEvidence,
        ].filter(Boolean).join(' ')
      } else if (expectation.expectation !== undefined) {
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
        const verified = await verifyAutomaticStateChange(runner, exec, beforeState, args.tabId, args.targetHint, args.expectedVisualText)
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

      const effectiveXRatio = objectNumber(clicked.value, 'xRatio') ?? ((hasRatioPoint || boundPreview) ? pointX : undefined)
      const effectiveYRatio = objectNumber(clicked.value, 'yRatio') ?? ((hasRatioPoint || boundPreview) ? pointY : undefined)
      if (effectiveXRatio === undefined || effectiveYRatio === undefined
        || !Number.isFinite(effectiveXRatio) || !Number.isFinite(effectiveYRatio)) {
        outcomes.recordUnverifiedPhysicalClick(args)
        return 'Visual click reached a verified state but did not return effective normalized geometry, so it was NOT persisted.'
      }
      const bindingActionable = objectBoolean(clicked.value, 'bindingActionable') === true
      const selectorReplaySafe = objectBoolean(clicked.value, 'selectorReplaySafe') !== false
      const learnedLocatorText = bindingActionable
        ? learnedVisualLocatorText(clicked.value)
        : undefined
      const learnedLocatorRole = learnedLocatorText === undefined ? undefined : objectString(clicked.value, 'targetRole')
      const learnedLocatorTag = learnedLocatorText === undefined ? undefined : objectString(clicked.value, 'targetTag')
      const replayPlan = visualReplayPlan(compactObject({
        learnedLocatorText,
        learnedLocatorRole,
        learnedLocatorTag,
        selectorHint: selectorReplaySafe ? selectorHint : undefined,
        xRatio: effectiveXRatio,
        yRatio: effectiveYRatio,
      }) as {
        learnedLocatorText?: string
        learnedLocatorRole?: string
        learnedLocatorTag?: string
        selectorHint?: string
        xRatio: number
        yRatio: number
      })
      const stepArguments = compactObject({
        // Live teaching persists the exact screenshot point selected by vision.
        // DOM/semantic identity is learned from that hit afterwards and is tried
        // first on replay; guarded geometry remains the final fallback.
        xRatio: effectiveXRatio,
        yRatio: effectiveYRatio,
        selectorHint: selectorReplaySafe && bindingActionable ? selectorHint : undefined,
        learnedLocatorText,
        learnedLocatorRole,
        learnedLocatorTag,
        learnedSelectorQuality: objectString(clicked.value, 'selectorQuality'),
        learnedBindingSource: objectString(clicked.value, 'bindingSource'),
        replayPlan,
        teachingControlMode: visualAuthority ? 'visual-grounding' : 'hybrid',
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
        expectedVisualText: args.expectedVisualText?.trim(),
        targetTextHint: objectString(clicked.value, 'targetText'),
        targetIdHint: objectString(clicked.value, 'targetId'),
        targetClassHint: objectString(clicked.value, 'targetClassName'),
      })
      const condition = optionalCondition(args.conditionSourceStepId, args.conditionExpectedText, args.conditionMode)
      const targetNote = `视觉目标：${args.targetHint.trim()}${hasCandidate ? `；视觉编号：${candidateId}` : ''}`
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
        `Executed and recorded ${step.id} (browser_visual_click) after CURRENT model-visible visual-state verification.`,
        hasCandidate
          ? `Visual action-map candidate ${candidateId} resolved by CURRENT browser geometry to xRatio=${effectiveXRatio.toFixed(4)}, yRatio=${effectiveYRatio.toFixed(4)}; this exact center was saved for replay. The model selected the labeled box, not a free pixel coordinate.`
          : `Visual point saved for replay: xRatio=${effectiveXRatio.toFixed(4)}, yRatio=${effectiveYRatio.toFixed(4)}; model-requested=(${pointX.toFixed(4)}, ${pointY.toFixed(4)}); capture=${captureWidth ?? viewportWidth}x${captureHeight ?? viewportHeight} CSS px at (${captureClientLeft ?? 0}, ${captureClientTop ?? 0}).`,
        objectBoolean(clicked.value, 'visualAuthority') === true
          ? (hasCandidate
              ? 'Visual grounding used the model-selected action-map label; DOM/CDP contributed only the CURRENT interactive rectangle geometry and did not choose the business target.'
              : 'TEST visual-grounding used the exact model-selected screenshot point; DOM/Shadow-DOM did not relocate it before physical input.')
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
    title: objectString(page.value, 'title') ?? objectString(snapshot.value, 'title') ?? '',
    text: normalizePageText(objectString(page.value, 'text') ?? page.text ?? ''),
    elementSignatures: snapshotElementSignatures(snapshot.value),
  }
}
async function verifyAutomaticStateChange(runner: PatrolRunner, exec: ToolRunContext, before: PageState | undefined, tabId: number | undefined, targetHint?: string, expectedVisualText?: string): Promise<StateChangeVerification> {
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
    if (before.url && after.url && before.url !== after.url && expectedVisualText) {
      const destinationEvidence = normalizePageText(`${after.title} ${after.text}`)
      const wanted = normalizePageText(expectedVisualText)
      if (!visualTextContains(destinationEvidence, wanted)) {
        return {
          ok: false,
          attempts: index + 1,
          evidence: `navigation reached a different destination than the visually selected item: expected ${JSON.stringify(expectedVisualText)}, CURRENT destination title=${JSON.stringify(after.title || '(untitled)')}`,
        }
      }
    }
    const evidence = stateChangeEvidence(before, after)
    if (evidence !== undefined) return { ok: true, attempts: index + 1, evidence }
  }
  return { ok: false, attempts: AUTO_VERIFY_DELAYS_MS.length }
}
function navigationLikeBusinessAction(stepName: string | undefined, targetHint: string | undefined): boolean {
  const text = normalizePageText([stepName, targetHint].filter(Boolean).join(' '))
  if (!text || inPageControlHint(text)) return false
  return /(?:点击|打开|进入|选择|访问|跳转).*(?:视频|卡片|封面|详情|文章|结果|链接|百科|官网|标题|条目)|(?:视频|卡片|封面|详情|结果|链接|百科|官网|标题|条目).*(?:打开|进入|跳转|点击)/i.test(text)
}

function visualTextContains(haystack: string, needle: string): boolean {
  const compact = (value: string) => value.replace(/[^\p{L}\p{N}]+/gu, '')
  const left = compact(haystack)
  const right = compact(needle)
  return right.length >= 4 && (left.includes(right) || (left.length >= 8 && right.includes(left)))
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
    { hint: /搜索(?:框|栏|按钮|输入)|(?:输入|点击).*(?:搜索|search)|\bsearch\s*(?:box|bar|button|input)\b/i, evidence: /搜索|search|textbox|input/, label: '搜索/search' },
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

function visualReplayPlan(input: {
  learnedLocatorText?: string
  learnedLocatorRole?: string
  learnedLocatorTag?: string
  selectorHint?: string
  xRatio: number
  yRatio: number
}): JsonObject {
  const fallback = {
    tool: 'browser_visual_click',
    mode: 'guarded-visual-coordinate',
    xRatio: input.xRatio,
    yRatio: input.yRatio,
  }
  const secondary = input.selectorHint === undefined
    ? undefined
    : { tool: 'browser_click', selector: input.selectorHint }
  const primary = input.learnedLocatorText === undefined
    ? secondary ?? fallback
    : compactObject({
        tool: 'browser_visual_click',
        mode: 'learned-semantic',
        learnedLocatorText: input.learnedLocatorText,
        learnedLocatorRole: input.learnedLocatorRole,
        learnedLocatorTag: input.learnedLocatorTag,
      })
  return compactObject({ primary, secondary, fallback })
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
function compactObject(value: Record<string, JsonValue | undefined>): JsonObject {
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
