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

interface BootstrapObservation {
  kind: PatrolBootstrapObservationKind
  url?: string
  title?: string
}

export function registerPatrolObservationTools(
  ctx: Context,
  runner: PatrolRunner,
  gate: PatrolObservationGate,
): () => void {
  const observe = defineTool({
    name: 'patrol_observe',
    description: 'Read-only first action for each browser turn. Capture the CURRENT tab, then attach that exact screenshot as an image so the model sees pixels instead of relying on page OCR. On an unobservable initial blank/new tab, it returns a bootstrap state that authorizes only one initial patrol_navigate. Does not record a Runbook step.',
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
          path: { type: 'string' },
          url: { type: 'string' },
          title: { type: 'string' },
          ocrStatus: { type: 'string' },
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

        const lines = [
          `Current-page observation: ${value.title || '(untitled)'}${value.url ? ` - ${value.url}` : ''}`,
          `Fresh screenshot: ${value.path}`,
          `Secondary Windows OCR status: ${value.ocrStatus || 'unknown'}`,
          'The attached image is the authoritative CURRENT browser state. Ignore stale CAPTCHA strings and stale page assumptions from earlier turns.',
        ]
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
      const shot = await runner.dispatch('browser_screenshot', compactObject({
        tabId: args.tabId,
        format: 'png',
      }), exec)
      if (!shot.ok) {
        const bootstrap = await detectBootstrapObservation(runner, exec, args.tabId)
        if (bootstrap !== undefined) {
          gate.markBootstrap(args.inspectionId, exec.rootCallId, bootstrap.kind)
          return {
            ok: true,
            observationKind: bootstrap.kind === 'no-tab' ? 'bootstrap-no-tab' : 'bootstrap-unobservable-tab',
            ...(bootstrap.url === undefined ? {} : { url: bootstrap.url }),
            ...(bootstrap.title === undefined ? {} : { title: bootstrap.title }),
            ocrStatus: 'not-captured-bootstrap',
          }
        }
        throw new Error(`current-page screenshot failed: ${shot.error ?? shot.text}`)
      }

      const path = objectString(shot.value, 'path')
      if (path === undefined) throw new Error('current-page screenshot did not return a workspace path')

      const image = await readScreenshotAsImage(ctx, exec, path)
      if (image === undefined) {
        throw new Error('patrol_observe could not attach the screenshot pixels. The Patrol route requires the Harness read_image tool and an image-capable current model; no browser-changing action was authorized.')
      }

      let url = ''
      let title = ''
      const snapshot = await runner.dispatch('browser_snapshot', compactObject({
        tabId: args.tabId,
        maxElements: 120,
        includeHidden: false,
      }), exec)
      if (snapshot.ok) {
        url = objectString(snapshot.value, 'url') ?? ''
        title = objectString(snapshot.value, 'title') ?? ''
      } else {
        const tab = await currentTabMetadata(runner, exec, args.tabId)
        url = tab?.url ?? ''
        title = tab?.title ?? ''
      }

      gate.markObserved(args.inspectionId, exec.rootCallId)
      return {
        ok: true,
        observationKind: 'visual',
        path,
        ...(url ? { url } : {}),
        ...(title ? { title } : {}),
        ocrStatus: objectString(shot.value, 'ocrStatus') ?? 'unknown',
        image,
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

async function readScreenshotAsImage(ctx: Context, exec: ToolRunContext, path: string): Promise<any | undefined> {
  if (ctx.tools.get('read_image', exec.agent) === undefined) return undefined
  const result = await ctx.tools.execute({
    callId: CallId(`patrol-observe-${randomUUID()}`),
    rootCallId: exec.rootCallId,
    name: 'read_image',
    arguments: { file_path: path },
    signal: exec.signal,
    ...(exec.agent === undefined ? {} : { agent: exec.agent }),
    parent: exec.token,
  })
  if (result.isError) throw new Error(`reading current screenshot as image failed: ${result.error.message}`)
  const value = result.value
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const image = (value as Record<string, unknown>).image
  return image !== null && typeof image === 'object' && !Array.isArray(image) ? image : undefined
}

function compactObject(value: Record<string, string | number | boolean | undefined>): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, child] of Object.entries(value)) if (child !== undefined) out[key] = child
  return out
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
