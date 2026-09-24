import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PatrolBootstrapObservationKind, PatrolObservationGate } from './observation-guard.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import { countRetainedToolResultImages, offloadHistoricalToolResultImages } from './image-context-hardening.js'
import type { PatrolVisualEvidenceRegistry } from './visual-evidence-registry.js'

const IMAGE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
    originalDimensions: {
      type: 'object',
      additionalProperties: false,
      properties: {
        width: { type: 'integer', required: true },
        height: { type: 'integer', required: true },
      },
    },
  },
} as const

const BOOTSTRAP_URLS = new Set([
  '',
  'about:blank',
  'chrome://newtab/',
  'chrome://newtab',
  'chrome://new-tab-page/',
  'chrome://new-tab-page',
  'edge://newtab/',
  'edge://newtab',
  'brave://newtab/',
  'brave://newtab',
  'chrome-search://local-ntp/local-ntp.html',
])

const CAPTCHA_HINT = /(captcha|verify|verification|image[-_ ]?code|验证码|校验码|图形码)/i
// Observations are sent to the model repeatedly during long patrols. Keep the
// default state packet deliberately small; the full screenshot remains on disk
// and can be attached explicitly with includeImage=true only when vision is
// actually needed.
const SNAPSHOT_CAPTURE_MAX_ELEMENTS = 80
const SNAPSHOT_EVIDENCE_MAX_ELEMENTS = 24
const SNAPSHOT_EVIDENCE_MAX_CHARS = 3000
const OCR_EVIDENCE_MAX_CHARS = 2000
const OBSERVATION_ERROR_MAX_CHARS = 800
const VISUAL_SCREENSHOT_MAX_WIDTH = 1024
const VISUAL_SCREENSHOT_JPEG_QUALITY = 68

type ObservationImageStatus = 'attached' | 'not-requested' | 'tool-unavailable' | 'read-failed'

interface BootstrapObservation {
  kind: PatrolBootstrapObservationKind
  url?: string
  title?: string
}

interface ImageAttachmentAttempt {
  status: ObservationImageStatus
  image?: any
  error?: string
}

interface ToolResultPrunerLike {
  pruneSession(session: unknown): { pruned?: unknown[]; charsRemoved?: number }
}

export function registerPatrolObservationTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
  gate: PatrolObservationGate,
  visualEvidence?: PatrolVisualEvidenceRegistry,
): () => void {
  const observe = defineTool({
    name: 'patrol_observe',
    description: 'Read-only CURRENT-page observation for browser vision. New TEST visual teaching is OCR-first: visible text targets should go directly to patrol_visual_click_target(ocrText=...) so Patrol captures a fresh screenshot internally and clicks Windows-OCR bbox geometry without read_image/focused B#/A#. Use includeImage=true mainly for large unlabeled controls or genuinely visual context, then imageX/imageY on that exact raster. pixelActionMap/actionMap remain legacy compatibility diagnostics only. Does not record a Runbook step.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      tabId: { type: 'integer' },
      includeImage: { type: 'boolean', description: 'Attach the CURRENT screenshot image to model context. For visible text clicks, normally skip this and call patrol_visual_click_target(ocrText=...) directly; use includeImage=true for large unlabeled controls or genuinely visual layout inspection.' },
      pixelActionMap: { type: 'boolean', description: 'LEGACY compatibility diagnostic only. Do not use B# for new TEST teaching; visible text uses patrol_visual_click_target(ocrText=...), adjacent close/remove uses ocrRelation=close-right.' },
      actionMap: { type: 'boolean', description: 'LEGACY DOM A# compatibility diagnostic only. Do not use for new TEST visual teaching.' },
      targetHint: { type: 'string', description: 'Concrete CURRENT business target. It is context only. Visible text targets should be executed via patrol_visual_click_target(ocrText=<visible text>) rather than focused B#/A#.' },
      focusXRatio: { type: 'number', description: 'Optional coarse X center (0..1) for a focused visual crop. Use after a full-frame visual estimate when the target is small or a calibration mark missed.' },
      focusYRatio: { type: 'number', description: 'Optional coarse Y center (0..1) for a focused visual crop. Requires includeImage=true and focusXRatio.' },
      focusWidthRatio: { type: 'number', description: 'Legacy/manual focused crop width. New TEST text clicking should use OCR geometry instead of focused crops.' },
      focusHeightRatio: { type: 'number', description: 'Legacy/manual focused crop height. New TEST text clicking should use OCR geometry instead of focused crops.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          observationKind: { type: 'string', required: true, enum: ['visual', 'bootstrap-unobservable-tab', 'bootstrap-no-tab'] },
          evidenceMode: { type: 'string', enum: ['image', 'screenshot-ocr-snapshot'] },
          imageStatus: { type: 'string', enum: ['attached', 'not-requested', 'tool-unavailable', 'read-failed'] },
          imageError: { type: 'string' },
          path: { type: 'string' },
          visualFrameId: { type: 'string' },
          visualClickReady: { type: 'boolean' },
          urlIdentity: { type: 'string' },
          viewportWidth: { type: 'number' },
          viewportHeight: { type: 'number' },
          viewportScale: { type: 'number' },
          captureClientLeft: { type: 'number' },
          captureClientTop: { type: 'number' },
          captureWidth: { type: 'number' },
          captureHeight: { type: 'number' },
          captureMode: { type: 'string' },
          coordinateGuide: { type: 'boolean' },
          pixelActionMap: { type: 'boolean' },
          pixelCandidateCount: { type: 'integer' },
          pixelCandidateSummary: { type: 'string' },
          actionMap: { type: 'boolean' },
          actionMapTargeted: { type: 'boolean' },
          actionMapTargetHint: { type: 'string' },
          actionMapTargetMiss: { type: 'boolean' },
          actionMapStrictTargetMiss: { type: 'boolean' },
          actionCandidateCount: { type: 'integer' },
          actionCandidateSummary: { type: 'string' },
          actionMapZoom: { type: 'boolean' },
          actionMapZoomCount: { type: 'integer' },
          actionMapZoomPath: { type: 'string' },
          actionMapZoomImage: IMAGE_SCHEMA,
          coordinateGridUnits: { type: 'number' },
          modelRasterWidth: { type: 'number' },
          modelRasterHeight: { type: 'number' },
          focusedVisual: { type: 'boolean' },
          focusCenterXRatio: { type: 'number' },
          focusCenterYRatio: { type: 'number' },
          focusWidthRatio: { type: 'number' },
          focusHeightRatio: { type: 'number' },
          scrollX: { type: 'number' },
          scrollY: { type: 'number' },
          url: { type: 'string' },
          title: { type: 'string' },
          ocrStatus: { type: 'string' },
          ocrText: { type: 'string' },
          ocrTextWithheld: { type: 'boolean' },
          snapshotText: { type: 'string' },
          image: IMAGE_SCHEMA,
        },
      },
      render: (args, value) => {
        if (value.observationKind !== 'visual') {
          const noTab = value.observationKind === 'bootstrap-no-tab'
          return [{
            type: 'text',
            text: [
              noTab
                ? 'Current-browser bootstrap observation: no tabs exist yet.'
                : `Current-browser bootstrap observation: the active tab is an unobservable Chromium blank/new-tab page${value.url ? ` (${value.url})` : ''}.`,
              noTab
                ? 'Exactly one patrol_navigate with a concrete URL and newTab=true is authorized. Observe immediately after navigation.'
                : 'Exactly one patrol_navigate with the concrete user-requested URL is authorized. Observe immediately after navigation.',
            ].join('\n'),
          }]
        }

        const hasImage = value.evidenceMode === 'image' && value.image !== undefined
        const hasActionMapZoom = value.actionMapZoom === true && value.actionMapZoomImage !== undefined
        const lines = [
          `CURRENT page: ${value.title || '(untitled)'}${value.url ? ` - ${value.url}` : ''}`,
          `Fresh screenshot saved: ${value.path}`,
          ...(value.visualFrameId ? [`Visual click frame READY: ${value.visualFrameId}; viewport=${value.viewportWidth ?? '?'}x${value.viewportHeight ?? '?'}; capture=${value.captureWidth ?? value.viewportWidth ?? '?'}x${value.captureHeight ?? value.viewportHeight ?? '?'} at (${value.captureClientLeft ?? 0}, ${value.captureClientTop ?? 0}); scroll=(${value.scrollX ?? '?'}, ${value.scrollY ?? '?'})`] : []),
          `Evidence: ${hasImage ? 'MODEL-VISIBLE image attached + compact OCR/DOM' : 'compact OCR/DOM only'}`,
          ...(hasImage && value.pixelActionMap === true ? [
            `LEGACY BROWSER PIXEL ACTION MAP: ${value.pixelCandidateCount ?? 0} B# candidate(s) are present. New TEST teaching must not use B#; visible text uses patrol_visual_click_target(ocrText=...), and adjacent x/× uses ocrRelation="close-right". Use this map only for historical compatibility diagnostics.`,
            ...(value.pixelCandidateSummary ? [`CURRENT B# pixel geometry (for diagnostics only; choose by image):\n${value.pixelCandidateSummary}`] : []),
          ] : []),
          ...(hasImage && value.coordinateGuide === true ? [
            value.focusedVisual === true
              ? `FOCUSED RAW VISUAL FRAME: this attached crop is exactly ${value.modelRasterWidth ?? value.image?.width ?? '?'}x${value.modelRasterHeight ?? value.image?.height ?? '?'} model pixels and covers only the indicated CURRENT-page region. Identify the target center on THIS crop and call patrol_visual_click_target(imageX=<pixel>, imageY=<pixel>, imageWidth=${value.modelRasterWidth ?? value.image?.width ?? '?'}, imageHeight=${value.modelRasterHeight ?? value.image?.height ?? '?'}). Patrol maps crop pixels -> capture geometry -> viewport exactly once. The XY/1000 overlay is only a visual aid; do not manually convert to CSS coordinates.`
              : `RAW VISUAL CLICK FRAME: the attached CURRENT raster is exactly ${value.modelRasterWidth ?? value.image?.width ?? '?'}x${value.modelRasterHeight ?? value.image?.height ?? '?'} model pixels. For patrol_visual_click_target, prefer the target center as imageX/imageY on this exact raster and copy imageWidth/imageHeight for frame validation. Patrol owns the only raster->viewport conversion. Do not infer coordinates from OS screen size, CSS viewport size, devicePixelRatio, or chat preview size. The XY/1000 overlay is only a coarse visual aid.`,
          ] : []),
          ...(hasImage && value.actionMapStrictTargetMiss === true ? [
            `LEGACY A# TARGET MISS for ${JSON.stringify(value.actionMapTargetHint || args.targetHint || '')}. Do not recover by guessing A#/XY in new TEST teaching; use screenshot OCR geometry (ocrText) when visible text exists.`,
          ] : []),
          ...(hasImage && value.actionMap === true ? [
            value.actionMapTargeted === true
              ? `LEGACY TARGETED A# MAP for ${JSON.stringify(value.actionMapTargetHint || args.targetHint || '')}: ${value.actionCandidateCount ?? 0} candidate(s). New TEST teaching should use ocrText for visible text instead.`
              : `LEGACY A# MAP: ${value.actionCandidateCount ?? 0} CURRENT interactive control(s). This is compatibility-only; do not use candidateId for new TEST teaching.`,
            ...(value.actionCandidateSummary ? [`CURRENT A# bindings from browser geometry:\n${value.actionCandidateSummary}`] : []),
            ...(hasActionMapZoom ? [
              `LEGACY A# zoom image attached (${value.actionMapZoomCount ?? value.actionCandidateCount ?? 0} candidates). Do not use it for new TEST teaching.`,
            ] : []),
          ] : []),
          ...(args.includeImage === true && !hasImage ? ['VISUAL CLICK DISABLED: includeImage=true did not produce a model-visible image; do not guess screenshot coordinates.'] : []),
        ]

        if (value.ocrTextWithheld === true) {
          lines.push('Whole-page OCR withheld because a CAPTCHA/image-code input is present; use the CURRENT tight CAPTCHA crop instead of historical text.')
        } else if (value.ocrText) {
          lines.push(`OCR:\n${value.ocrText}`)
        }
        if (value.snapshotText) lines.push(`DOM:\n${value.snapshotText}`)
        if (value.imageError) lines.push(`Image note: ${value.imageError}`)
        if (!hasImage && args.includeImage !== true) lines.push('Use patrol_observe(includeImage=true) when visual evidence is actually needed; visual clicking is unavailable from this DOM/OCR-only observation.')

        const blocks: any[] = [{ type: 'text', text: lines.join('\n') }]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
        if (value.actionMapZoomImage !== undefined) blocks.push({ type: 'image', attachment: value.actionMapZoomImage })
        return blocks
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Observe current browser state',
      kind: 'other',
      rawInput: {
        inspectionId: args.inspectionId,
        tabId: args.tabId,
        includeImage: args.includeImage === true,
        pixelActionMap: args.pixelActionMap === true,
        actionMap: args.actionMap === true,
        ...(args.targetHint === undefined ? {} : { targetHint: args.targetHint }),
        ...(args.focusXRatio === undefined ? {} : { focusXRatio: args.focusXRatio }),
        ...(args.focusYRatio === undefined ? {} : { focusYRatio: args.focusYRatio }),
      },
    }),
    async execute(args, exec: ToolRunContext) {
      const focusRequested = args.focusXRatio !== undefined || args.focusYRatio !== undefined
        || args.focusWidthRatio !== undefined || args.focusHeightRatio !== undefined
      const requestedActionMapTargetHint = typeof args.targetHint === 'string' ? args.targetHint.trim() : ''
      const actionMapRequested = args.actionMap === true
      const pixelActionMapRequested = args.pixelActionMap === true
        || (focusRequested && args.pixelActionMap !== false && !actionMapRequested)
      if (args.actionMap === true && args.includeImage !== true) {
        throw new Error('visual action-map observation requires includeImage=true')
      }
      if (args.actionMap === true) {
        if (typeof args.targetHint !== 'string' || args.targetHint.trim().length < 2) {
          throw new Error('visual action-map observation requires targetHint so Patrol can narrow labels to the intended CURRENT business target')
        }
      }
      if (focusRequested) {
        if (args.includeImage !== true) throw new Error('focused visual observation requires includeImage=true')
        if (!Number.isFinite(args.focusXRatio) || !Number.isFinite(args.focusYRatio)
          || Number(args.focusXRatio) < 0 || Number(args.focusXRatio) > 1
          || Number(args.focusYRatio) < 0 || Number(args.focusYRatio) > 1) {
          throw new Error('focused visual observation requires focusXRatio/focusYRatio between 0 and 1')
        }
      }

      // Visual capture is unlimited by count, but previous screenshot image
      // blocks must not accumulate in the next local-Qwen request. The generic
      // toolResultPruner only trims text, so Patrol explicitly offloads old
      // image occurrences first and runs the text pruner as a separate pass.
      const visualContextReady = args.includeImage !== true || pruneHistoricalVisualContext(ctx, exec)

      // Screenshot capture establishes freshness and supplies bounded OCR.
      const shot = await runner.dispatch('browser_screenshot', compactObject({
        tabId: args.tabId,
        format: args.includeImage === true ? 'jpeg' : 'png',
        // Keep enough native raster detail for precise visual pointing, but make
        // maxWidth a final physical-pixel budget inside the extension (DPR-aware).
        // This avoids the old DPR=2 bug where "1024" still produced a ~2048px
        // model image and simultaneously keeps browser vision closer to the
        // geometry-faithful Desktop Automation frame.
        ...(args.includeImage === true ? {
          maxWidth: VISUAL_SCREENSHOT_MAX_WIDTH,
          quality: VISUAL_SCREENSHOT_JPEG_QUALITY,
          coordinateGuide: !actionMapRequested && !pixelActionMapRequested,
          pixelActionMap: pixelActionMapRequested,
          actionMap: actionMapRequested,
          ...(actionMapRequested ? { actionMapTargetHint: requestedActionMapTargetHint } : {}),
          ...(focusRequested ? {
            focusXRatio: Number(args.focusXRatio),
            focusYRatio: Number(args.focusYRatio),
            ...(args.focusWidthRatio === undefined ? {} : { focusWidthRatio: Number(args.focusWidthRatio) }),
            ...(args.focusHeightRatio === undefined ? {} : { focusHeightRatio: Number(args.focusHeightRatio) }),
          } : {}),
        } : {}),
      }), exec)
      if (!shot.ok) {
        const bootstrap = await detectBootstrapObservation(runner, exec, args.tabId)
        if (bootstrap !== undefined) {
          gate.markBootstrap(args.inspectionId, exec.rootCallId, bootstrap.kind)
          const observationKind = bootstrap.kind === 'no-tab'
            ? 'bootstrap-no-tab' as const
            : 'bootstrap-unobservable-tab' as const
          return {
            ok: true,
            observationKind,
            ...(bootstrap.url === undefined ? {} : { url: bootstrap.url }),
            ...(bootstrap.title === undefined ? {} : { title: bootstrap.title }),
            ocrStatus: 'not-captured-bootstrap',
          }
        }
        throw new Error(`current-page screenshot failed: ${shot.error ?? shot.text}`)
      }

      const capturedPath = objectString(shot.value, 'path')
      if (capturedPath === undefined) throw new Error('current-page screenshot did not return a workspace path')
      const workspaceRoot = exec.agent?.session.header.cwd
      const path = workspaceRoot
        ? await store.organizeTeachingScreenshot(args.inspectionId, capturedPath, workspaceRoot)
        : capturedPath

      let url = ''
      let title = ''
      let snapshotText = ''
      let captchaInputPresent = false
      const snapshot = await runner.dispatch('browser_snapshot', compactObject({
        tabId: args.tabId,
        maxElements: SNAPSHOT_CAPTURE_MAX_ELEMENTS,
        includeHidden: false,
      }), exec)
      if (snapshot.ok) {
        url = objectString(snapshot.value, 'url') ?? ''
        title = objectString(snapshot.value, 'title') ?? ''
        snapshotText = summarizeSnapshotEvidence(snapshot.value)
        captchaInputPresent = snapshotContainsCaptchaInput(snapshot.value)
      } else {
        const tab = await currentTabMetadata(runner, exec, args.tabId)
        url = tab?.url ?? ''
        title = tab?.title ?? ''
      }

      const imageAttempt: ImageAttachmentAttempt = args.includeImage !== true
        ? { status: 'not-requested' }
        : !visualContextReady
          ? {
              status: 'read-failed',
              error: 'Previous model-visible Patrol image could not be offloaded safely, so CURRENT screenshot was kept on disk but not attached. Continuing with compact OCR/DOM evidence to avoid image accumulation/OOM.',
            }
          : await readBoundedScreenshotAsImage(ctx, exec, path)
      const actionMapZoomPath = objectString(shot.value, 'actionMapZoomPath')
      const zoomImageAttempt: ImageAttachmentAttempt = args.includeImage === true
        && actionMapZoomPath !== undefined
        && imageAttempt.image !== undefined
        ? await readBoundedScreenshotAsImage(ctx, exec, actionMapZoomPath)
        : { status: 'not-requested' }
      const rawOcrText = objectRawString(shot.value, 'ocrText') ?? ''
      const ocrText = captchaInputPresent ? '' : shortEvidence(rawOcrText, OCR_EVIDENCE_MAX_CHARS)

      const rawVisualFrameId = objectString(shot.value, 'visualFrameId')
      const visualFrameId = imageAttempt.image === undefined ? undefined : rawVisualFrameId
      const visualClickReady = imageAttempt.image !== undefined && visualFrameId !== undefined
      if (visualClickReady) visualEvidence?.mark(visualFrameId, args.inspectionId)
      const urlIdentity = objectString(shot.value, 'urlIdentity')
      const viewportWidth = objectNumber(shot.value, 'viewportWidth')
      const viewportHeight = objectNumber(shot.value, 'viewportHeight')
      const viewportScale = objectNumber(shot.value, 'viewportScale')
      const captureClientLeft = objectNumber(shot.value, 'captureClientLeft')
      const captureClientTop = objectNumber(shot.value, 'captureClientTop')
      const captureWidth = objectNumber(shot.value, 'captureWidth')
      const captureHeight = objectNumber(shot.value, 'captureHeight')
      const captureMode = objectString(shot.value, 'captureMode')
      const coordinateGuide = objectBoolean(shot.value, 'coordinateGuide') === true
      const pixelActionMap = objectBoolean(shot.value, 'pixelActionMap') === true
      const pixelCandidateCount = objectNumber(shot.value, 'pixelCandidateCount')
      const pixelCandidateSummary = objectString(shot.value, 'pixelCandidateSummary')
      const actionMap = objectBoolean(shot.value, 'actionMap') === true
      const actionMapTargeted = objectBoolean(shot.value, 'actionMapTargeted') === true
      const actionMapTargetHint = objectString(shot.value, 'actionMapTargetHint')
      const actionMapTargetMiss = objectBoolean(shot.value, 'actionMapTargetMiss') === true
      const actionMapStrictTargetMiss = objectBoolean(shot.value, 'actionMapStrictTargetMiss') === true
      const actionCandidateCount = objectNumber(shot.value, 'actionCandidateCount')
      const actionCandidateSummary = objectString(shot.value, 'actionCandidateSummary')
      const actionMapZoom = objectBoolean(shot.value, 'actionMapZoom') === true
      const actionMapZoomCount = objectNumber(shot.value, 'actionMapZoomCount')
      const coordinateGridUnits = objectNumber(shot.value, 'coordinateGridUnits')
      const modelRasterWidth = objectNumber(shot.value, 'modelRasterWidth')
      const modelRasterHeight = objectNumber(shot.value, 'modelRasterHeight')
      const focusedVisual = objectBoolean(shot.value, 'focusedVisual') === true
      const focusCenterXRatio = objectNumber(shot.value, 'focusCenterXRatio')
      const focusCenterYRatio = objectNumber(shot.value, 'focusCenterYRatio')
      const focusWidthRatio = objectNumber(shot.value, 'focusWidthRatio')
      const focusHeightRatio = objectNumber(shot.value, 'focusHeightRatio')
      const scrollX = objectNumber(shot.value, 'scrollX')
      const scrollY = objectNumber(shot.value, 'scrollY')

      gate.markObserved(args.inspectionId, exec.rootCallId)
      return {
        ok: true,
        observationKind: 'visual' as const,
        evidenceMode: imageAttempt.image === undefined
          ? 'screenshot-ocr-snapshot' as const
          : 'image' as const,
        imageStatus: imageAttempt.status,
        ...(imageAttempt.error === undefined ? {} : { imageError: imageAttempt.error }),
        path,
        ...(visualFrameId === undefined ? {} : { visualFrameId }),
        visualClickReady,
        ...(urlIdentity === undefined ? {} : { urlIdentity }),
        ...(viewportWidth === undefined ? {} : { viewportWidth }),
        ...(viewportHeight === undefined ? {} : { viewportHeight }),
        ...(viewportScale === undefined ? {} : { viewportScale }),
        ...(captureClientLeft === undefined ? {} : { captureClientLeft }),
        ...(captureClientTop === undefined ? {} : { captureClientTop }),
        ...(captureWidth === undefined ? {} : { captureWidth }),
        ...(captureHeight === undefined ? {} : { captureHeight }),
        ...(captureMode === undefined ? {} : { captureMode }),
        coordinateGuide,
        pixelActionMap,
        ...(pixelCandidateCount === undefined ? {} : { pixelCandidateCount }),
        ...(pixelCandidateSummary === undefined ? {} : { pixelCandidateSummary }),
        actionMap,
        actionMapTargeted,
        actionMapTargetMiss,
        actionMapStrictTargetMiss,
        ...(actionMapTargetHint === undefined ? {} : { actionMapTargetHint }),
        ...(actionCandidateCount === undefined ? {} : { actionCandidateCount }),
        ...(actionCandidateSummary === undefined ? {} : { actionCandidateSummary }),
        actionMapZoom,
        ...(actionMapZoomCount === undefined ? {} : { actionMapZoomCount }),
        ...(actionMapZoomPath === undefined ? {} : { actionMapZoomPath }),
        ...(zoomImageAttempt.image === undefined ? {} : { actionMapZoomImage: zoomImageAttempt.image }),
        ...(coordinateGridUnits === undefined ? {} : { coordinateGridUnits }),
        ...(modelRasterWidth === undefined ? {} : { modelRasterWidth }),
        ...(modelRasterHeight === undefined ? {} : { modelRasterHeight }),
        focusedVisual,
        ...(focusCenterXRatio === undefined ? {} : { focusCenterXRatio }),
        ...(focusCenterYRatio === undefined ? {} : { focusCenterYRatio }),
        ...(focusWidthRatio === undefined ? {} : { focusWidthRatio }),
        ...(focusHeightRatio === undefined ? {} : { focusHeightRatio }),
        ...(scrollX === undefined ? {} : { scrollX }),
        ...(scrollY === undefined ? {} : { scrollY }),
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
        ocrStatus: objectString(shot.value, 'ocrStatus') ?? 'unknown',
        ...(ocrText ? { ocrText } : {}),
        ocrTextWithheld: captchaInputPresent,
        ...(snapshotText ? { snapshotText } : {}),
        ...(imageAttempt.image === undefined ? {} : { image: imageAttempt.image }),
      }
    },
  })

  return ctx.tools.register(observe)
}

export function classifyBootstrapObservation(
  tabsValue: unknown,
  requestedTabId?: number,
): BootstrapObservation | undefined {
  const tabs = objectArray(tabsValue, 'tabs')
  if (tabs === undefined) return undefined
  if (tabs.length === 0) return { kind: 'no-tab' }

  const requested = requestedTabId === undefined
    ? undefined
    : tabs.find(tab => objectNumber(tab, 'id') === requestedTabId)
  const active = tabs.find(tab => objectBoolean(tab, 'active') === true)
  const tab = requested ?? active ?? tabs[0]
  if (tab === undefined) return { kind: 'no-tab' }

  const url = objectRawString(tab, 'url') ?? ''
  if (!isBootstrapUnobservableUrl(url)) return undefined
  const title = objectRawString(tab, 'title') ?? ''
  return {
    kind: 'unobservable-tab',
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
  }
}

export function isBootstrapUnobservableUrl(url: string): boolean {
  const normalized = String(url ?? '').trim().toLowerCase()
  return BOOTSTRAP_URLS.has(normalized)
}

export function snapshotContainsCaptchaInput(value: unknown): boolean {
  const elements = objectArray(value, 'elements') ?? []
  return elements.some(element => {
    const tag = (objectRawString(element, 'tag') ?? '').toLowerCase()
    if (tag !== 'input' && tag !== 'textarea') return false
    const combined = [
      objectRawString(element, 'selector'),
      objectRawString(element, 'name'),
      objectRawString(element, 'type'),
      objectRawString(element, 'text'),
    ].filter((part): part is string => typeof part === 'string' && part.length > 0).join(' ')
    return CAPTCHA_HINT.test(combined)
  })
}

export function summarizeSnapshotEvidence(value: unknown): string {
  const elements = objectArray(value, 'elements') ?? []
  const lines = elements.slice(0, SNAPSHOT_EVIDENCE_MAX_ELEMENTS).map((element, index) => {
    const tag = objectRawString(element, 'tag') ?? '?'
    const role = objectRawString(element, 'role')
    const type = objectRawString(element, 'type')
    const name = objectRawString(element, 'name')
    const text = objectRawString(element, 'text')
    const selector = objectRawString(element, 'selector')
    const attributes = [
      role ? `role=${role}` : '',
      type ? `type=${type}` : '',
      name ? `name=${name}` : '',
    ].filter(Boolean).join(' ')
    const label = text ? ` ${JSON.stringify(shortEvidence(text, 120))}` : ''
    const target = selector ? ` -> ${selector}` : ''
    return `${index + 1}. <${tag}>${attributes ? ` ${attributes}` : ''}${label}${target}`
  })

  if (elements.length > SNAPSHOT_EVIDENCE_MAX_ELEMENTS || objectBoolean(value, 'truncated') === true) {
    lines.push('(snapshot truncated; request a targeted snapshot only if the needed target is absent)')
  }
  const text = lines.join('\n')
  return text.length <= SNAPSHOT_EVIDENCE_MAX_CHARS
    ? text
    : `${text.slice(0, SNAPSHOT_EVIDENCE_MAX_CHARS)}…`
}

async function detectBootstrapObservation(
  runner: PatrolRunner,
  exec: ToolRunContext,
  requestedTabId?: number,
): Promise<BootstrapObservation | undefined> {
  const listed = await runner.dispatch('browser_list_tabs', {}, exec)
  if (!listed.ok) return undefined
  return classifyBootstrapObservation(listed.value, requestedTabId)
}

async function currentTabMetadata(
  runner: PatrolRunner,
  exec: ToolRunContext,
  requestedTabId?: number,
): Promise<{ url: string; title: string } | undefined> {
  const listed = await runner.dispatch('browser_list_tabs', {}, exec)
  if (!listed.ok) return undefined
  const tabs = objectArray(listed.value, 'tabs')
  if (tabs === undefined || tabs.length === 0) return undefined
  const requested = requestedTabId === undefined
    ? undefined
    : tabs.find(tab => objectNumber(tab, 'id') === requestedTabId)
  const active = tabs.find(tab => objectBoolean(tab, 'active') === true)
  const tab = requested ?? active ?? tabs[0]
  if (tab === undefined) return undefined
  return {
    url: objectRawString(tab, 'url') ?? '',
    title: objectRawString(tab, 'title') ?? '',
  }
}

function pruneHistoricalVisualContext(ctx: Context, exec: ToolRunContext): boolean {
  const agent = exec.agent as unknown as { session?: unknown } | undefined
  if (agent?.session === undefined) return false

  // We are about to add one fresh CURRENT screenshot. Offload every older
  // tool-result image so the new screenshot is the only retained Patrol visual
  // occurrence after read_image returns. This is a durable model-surface
  // projection, not a deletion from the append-only session log.
  const imagesBefore = countRetainedToolResultImages(agent.session)
  const imageResult = offloadHistoricalToolResultImages(agent.session, 0)
  if (imageResult.applied) {
    ctx.logger.info(
      `[dsh-patrol/vision] offloaded historical image payloads before CURRENT visual attachment; before=${imagesBefore}, after=${imageResult.retainedAfter}, offloaded=${imageResult.offloaded}`,
    )
  } else if (imageResult.error !== undefined) {
    ctx.logger.warn(`[dsh-patrol/vision] historical image offload unavailable: ${imageResult.error}`)
  }
  const imageSurfaceReady = imagesBefore === 0
    || (imageResult.applied && imageResult.retainedAfter === 0)

  let pruner: ToolResultPrunerLike | undefined
  try {
    pruner = ctx.get('toolResultPruner') as ToolResultPrunerLike | undefined
  } catch {
    pruner = undefined
  }
  if (pruner === undefined) return imageSurfaceReady
  try {
    const result = pruner.pruneSession(agent.session)
    const pruned = Array.isArray(result.pruned) ? result.pruned.length : 0
    const chars = typeof result.charsRemoved === 'number' ? result.charsRemoved : 0
    if (pruned > 0 || chars > 0) {
      ctx.logger.info(`[dsh-patrol/vision] trimmed historical TEXT tool payloads before CURRENT visual attachment; entries=${pruned}, chars=${chars}`)
    }
  } catch (error: unknown) {
    ctx.logger.warn(`[dsh-patrol/vision] proactive visual-history text prune failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  return imageSurfaceReady
}

async function readBoundedScreenshotAsImage(ctx: Context, exec: ToolRunContext, path: string): Promise<ImageAttachmentAttempt> {
  const attempt = await tryReadScreenshotAsImage(ctx, exec, path)
  if (attempt.image === undefined) return attempt
  const width = objectNumber(attempt.image, 'width')
  if (width !== undefined && width <= VISUAL_SCREENSHOT_MAX_WIDTH) return attempt

  const agent = exec.agent as unknown as { session?: unknown } | undefined
  if (agent?.session !== undefined) {
    const offloaded = offloadHistoricalToolResultImages(agent.session, 0)
    if (offloaded.error !== undefined) {
      ctx.logger.warn(`[dsh-patrol/vision] oversized CURRENT read_image could not be offloaded: ${offloaded.error}`)
    }
  }
  return {
    status: 'read-failed',
    error: width === undefined
      ? 'CURRENT read_image did not report attachment width, so Patrol cannot prove the model-visible screenshot is within its visual raster budget. Visual clicking is disabled for this frame.'
      : `CURRENT model-visible screenshot is ${width}px wide, above the ${VISUAL_SCREENSHOT_MAX_WIDTH}px Patrol budget. Visual clicking is disabled for this frame; update/restart the Patrol browser extension so maxWidth is honored.`,
  }
}

async function tryReadScreenshotAsImage(ctx: Context, exec: ToolRunContext, path: string): Promise<ImageAttachmentAttempt> {
  if (ctx.tools.get('read_image', exec.agent) === undefined) {
    return {
      status: 'tool-unavailable',
      error: 'Harness read_image is not registered for this Patrol agent route; continuing with compact OCR/DOM evidence.',
    }
  }

  try {
    const result = await ctx.tools.execute({
      callId: CallId(`patrol-observe-${randomUUID()}`),
      rootCallId: exec.rootCallId,
      name: 'read_image',
      arguments: { file_path: path },
      signal: exec.signal,
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      parent: exec.token,
    })
    if (result.isError) {
      return {
        status: 'read-failed',
        error: `${safeObservationError(result.error?.message ?? 'read_image failed')}; continuing with compact OCR/DOM evidence.`,
      }
    }
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return { status: 'read-failed', error: 'read_image returned no structured image attachment.' }
    }
    const image = (value as Record<string, unknown>).image
    if (image === null || typeof image !== 'object' || Array.isArray(image)) {
      return { status: 'read-failed', error: 'read_image returned no image attachment.' }
    }
    return { status: 'attached', image }
  } catch (error: unknown) {
    return {
      status: 'read-failed',
      error: `${safeObservationError(error)}; continuing with compact OCR/DOM evidence.`,
    }
  }
}

function compactObject(value: Record<string, string | number | boolean | undefined>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, child] of Object.entries(value)) if (child !== undefined) out[key] = child
  return out
}

function shortEvidence(value: string, maxChars: number): string {
  const normalized = value.replace(/[\t\r\n ]+/g, ' ').trim()
  return normalized.length <= maxChars ? normalized : `${normalized.slice(0, maxChars)}…`
}

function safeObservationError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? 'unknown image attachment error')
  const redacted = raw.replace(/(password|passwd|pwd|token|secret|authorization|cookie|otp|captcha)\s*[:=：]\s*\S+/gi, '$1=[REDACTED]')
  return redacted.length <= OBSERVATION_ERROR_MAX_CHARS
    ? redacted
    : `${redacted.slice(0, OBSERVATION_ERROR_MAX_CHARS)}…`
}

function objectArray(value: unknown, key: string): Record<string, unknown>[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  if (!Array.isArray(child)) return undefined
  return child.filter((item): item is Record<string, unknown> => item !== null && typeof item === 'object' && !Array.isArray(item))
}

function objectString(value: unknown, key: string): string | undefined {
  const child = objectRawString(value, key)
  return child !== undefined && child.length > 0 ? child : undefined
}

function objectRawString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'string' ? child : undefined
}

function objectNumber(value: unknown, key: string): number | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'number' ? child : undefined
}

function objectBoolean(value: unknown, key: string): boolean | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'boolean' ? child : undefined
}
