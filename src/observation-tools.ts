import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PatrolBootstrapObservationKind, PatrolObservationGate } from './observation-guard.js'
import { PatrolRunner } from './runner.js'

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
const SNAPSHOT_EVIDENCE_MAX_ELEMENTS = 40
const SNAPSHOT_EVIDENCE_MAX_CHARS = 5000
const OBSERVATION_ERROR_MAX_CHARS = 1000

type ObservationImageStatus = 'attached' | 'tool-unavailable' | 'read-failed'

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

export function registerPatrolObservationTools(
  ctx: Context,
  runner: PatrolRunner,
  gate: PatrolObservationGate,
): () => void {
  const observe = defineTool({
    name: 'patrol_observe',
    description: 'Read-only first action for each browser turn. Always capture the CURRENT tab first. When the current Harness route can accept images, attach that exact screenshot as an image; otherwise automatically degrade to fresh screenshot OCR plus a safe DOM snapshot without blocking Patrol progress. On an unobservable initial blank/new tab, return a bootstrap state that authorizes only one initial patrol_navigate. Does not record a Runbook step.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      tabId: { type: 'integer' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          observationKind: { type: 'string', required: true, enum: ['visual', 'bootstrap-unobservable-tab', 'bootstrap-no-tab'] },
          evidenceMode: { type: 'string', enum: ['image', 'screenshot-ocr-snapshot'] },
          imageStatus: { type: 'string', enum: ['attached', 'tool-unavailable', 'read-failed'] },
          imageError: { type: 'string' },
          path: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          ocrStatus: { type: 'string' },
          ocrText: { type: 'string' },
          ocrTextWithheld: { type: 'boolean' },
          snapshotText: { type: 'string' },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => {
        if (value.observationKind !== 'visual') {
          const noTab = value.observationKind === 'bootstrap-no-tab'
          return [{
            type: 'text',
            text: [
              noTab
                ? 'Current-browser bootstrap observation: no tabs exist yet.'
                : `Current-browser bootstrap observation: the active tab is an unobservable Chromium blank/new-tab page${value.url ? ` (${value.url})` : ''}.`,
              'There is no meaningful page image to inspect yet, so Chromium cannot provide screenshot pixels for this bootstrap state.',
              noTab
                ? 'Exactly one patrol_navigate with a concrete URL and newTab=true is authorized. Immediately call patrol_observe after navigation.'
                : 'Exactly one patrol_navigate with a concrete user-requested URL is authorized. Immediately call patrol_observe after navigation.',
              'Do not use this bootstrap authorization for reload/back/forward, clicks, typing, run, validate, or resume.',
            ].join('\n'),
          }]
        }

        const hasImage = value.evidenceMode === 'image' && value.image !== undefined
        const lines = [
          `Current-page observation: ${value.title || '(untitled)'}${value.url ? ` - ${value.url}` : ''}`,
          `Fresh screenshot: ${value.path}`,
          `Evidence mode: ${hasImage ? 'attached screenshot image + current OCR/DOM evidence' : 'fresh screenshot OCR + current DOM snapshot fallback'}`,
          `Secondary Windows OCR status: ${value.ocrStatus || 'unknown'}`,
        ]

        if (hasImage) {
          lines.push('The attached screenshot image is the authoritative CURRENT browser state. Ignore stale CAPTCHA strings and stale page assumptions from earlier turns.')
        } else {
          lines.push('The browser screenshot itself succeeded, but this Harness route could not attach its pixels as an image. This is NOT a Patrol blocker: the current-state observation is complete and browser actions may continue in this Harness turn using the fresh OCR/DOM evidence below.')
          lines.push('Do NOT retry patrol_observe, patrol_screenshot, patrol_snapshot, or patrol_read_page merely to obtain an image attachment. For a CAPTCHA, use patrol_detect_auth_challenge; never reuse a CAPTCHA string from history or from text already typed into the CAPTCHA input.')
          if (value.imageError) lines.push(`Image attachment note: ${value.imageError}`)
        }

        if (value.ocrTextWithheld === true) {
          lines.push('Whole-page OCR text is intentionally withheld because the current DOM contains a CAPTCHA/image-code input. This prevents a previously typed CAPTCHA value from contaminating the next decision; use the dedicated current CAPTCHA detector instead.')
        } else if (value.ocrText) {
          lines.push(`Fresh screenshot OCR (secondary evidence):\n${value.ocrText}`)
        }
        if (value.snapshotText) lines.push(`Fresh DOM snapshot (current page; input values omitted):\n${value.snapshotText}`)

        const blocks: any[] = [{ type: 'text', text: lines.join('\n') }]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Observe current browser state',
      kind: 'other',
      rawInput: { inspectionId: args.inspectionId, tabId: args.tabId },
    }),
    async execute(args, exec: ToolRunContext) {
      // Screenshot capture is the required observation primitive. Image attachment
      // is only a best-effort enhancement and must never make Patrol unusable.
      const shot = await runner.dispatch('browser_screenshot', compactObject({
        tabId: args.tabId,
        format: 'png',
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

      const path = objectString(shot.value, 'path')
      if (path === undefined) throw new Error('current-page screenshot did not return a workspace path')

      let url = ''
      let title = ''
      let snapshotText = ''
      let captchaInputPresent = false
      const snapshot = await runner.dispatch('browser_snapshot', compactObject({
        tabId: args.tabId,
        maxElements: 120,
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

      const imageAttempt = await tryReadScreenshotAsImage(ctx, exec, path)
      const rawOcrText = objectRawString(shot.value, 'ocrText') ?? ''
      const ocrText = captchaInputPresent ? '' : rawOcrText

      // A successful screenshot is enough to establish current-state freshness.
      // read_image/model image capability only changes evidence quality.
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
    const label = text ? ` ${JSON.stringify(shortEvidence(text, 160))}` : ''
    const target = selector ? ` -> ${selector}` : ''
    return `${index + 1}. <${tag}>${attributes ? ` ${attributes}` : ''}${label}${target}`
  })

  if (elements.length > SNAPSHOT_EVIDENCE_MAX_ELEMENTS || objectBoolean(value, 'truncated') === true) {
    lines.push('(snapshot truncated)')
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

async function tryReadScreenshotAsImage(ctx: Context, exec: ToolRunContext, path: string): Promise<ImageAttachmentAttempt> {
  if (ctx.tools.get('read_image', exec.agent) === undefined) {
    return {
      status: 'tool-unavailable',
      error: 'Harness read_image is not registered for this Patrol agent route; continuing with the screenshot OCR/DOM fallback.',
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
        error: `${safeObservationError(result.error?.message ?? 'read_image failed')}; continuing with the screenshot OCR/DOM fallback.`,
      }
    }
    const value = result.value
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return {
        status: 'read-failed',
        error: 'read_image returned no structured image attachment; continuing with the screenshot OCR/DOM fallback.',
      }
    }
    const image = (value as Record<string, unknown>).image
    if (image === null || typeof image !== 'object' || Array.isArray(image)) {
      return {
        status: 'read-failed',
        error: 'read_image returned no image attachment; continuing with the screenshot OCR/DOM fallback.',
      }
    }
    return { status: 'attached', image }
  } catch (error: unknown) {
    return {
      status: 'read-failed',
      error: `${safeObservationError(error)}; continuing with the screenshot OCR/DOM fallback.`,
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
