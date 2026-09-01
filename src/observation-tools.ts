import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { PatrolObservationGate } from './observation-guard.js'
import { PatrolRunner } from './runner.js'

const IMAGE_SCHEMA = {
  type: 'object' as const,
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string' as const, required: true },
    mediaType: { type: 'string' as const, required: true, enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] },
    bytes: { type: 'integer' as const, required: true },
    width: { type: 'integer' as const, required: true },
    height: { type: 'integer' as const, required: true },
    name: { type: 'string' as const },
    originalDimensions: {
      type: 'object' as const,
      additionalProperties: false,
      properties: {
        width: { type: 'integer' as const, required: true },
        height: { type: 'integer' as const, required: true },
      },
    },
  },
}

export function registerPatrolObservationTools(
  ctx: Context,
  runner: PatrolRunner,
  gate: PatrolObservationGate,
): () => void {
  const observe = defineTool({
    name: 'patrol_observe',
    description: 'Read-only first action for each browser turn. Capture the CURRENT tab, then attach that exact screenshot as an image so the model sees pixels instead of relying on page OCR. Does not record a Runbook step.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      tabId: { type: 'integer' },
    },
    output: {
      schema: {
        type: 'object' as const,
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' as const, required: true },
          path: { type: 'string' as const, required: true },
          url: { type: 'string' as const },
          title: { type: 'string' as const },
          ocrStatus: { type: 'string' as const },
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => {
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
      if (!shot.ok) throw new Error(`current-page screenshot failed: ${shot.error ?? shot.text}`)
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
      }

      gate.markObserved(args.inspectionId, exec.rootCallId)
      return {
        ok: true,
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

function objectString(value: unknown, key: string): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const child = (value as Record<string, unknown>)[key]
  return typeof child === 'string' && child.length > 0 ? child : undefined
}
