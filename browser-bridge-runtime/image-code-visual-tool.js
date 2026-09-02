import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

const reqBool = { type: 'boolean', required: true }
const str = { type: 'string' }
const optStr = { type: 'string' }
const optInt = { type: 'integer' }

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
}

export function registerImageCodeVisualTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'browser_capture_image_code_visual',
    description: 'Capture the CURRENT conventional image-code CAPTCHA as a tight image crop and attach that crop to the model through Harness read_image when available. This does not OCR or guess the answer. In Patrol TEST MODE, prefer this visual crop when ddddocr/Windows OCR is uncertain or failed, then type only the characters visible in this current crop.',
    parameters: {
      tabId: optInt,
      inputSelector: optStr,
      imageSelector: optStr,
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: reqBool,
          path: { type: 'string', required: true },
          captureMode: str,
          inputSelector: str,
          imageSelector: str,
          imageStatus: { type: 'string', required: true, enum: ['attached', 'tool-unavailable', 'read-failed'] },
          imageError: str,
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const lines = [
          `CURRENT image-code crop: ${value.path}`,
          `captureMode=${value.captureMode || 'unknown'}; inputSelector=${value.inputSelector || '(auto)'}; imageSelector=${value.imageSelector || '(auto)'}`,
        ]
        if (value.imageStatus === 'attached' && value.image !== undefined) {
          lines.push('The attached image is a tight crop of the CURRENT CAPTCHA. Read this image visually; do not reuse any historical CAPTCHA text.')
        } else {
          lines.push(`The crop was saved but could not be attached as an image (${value.imageStatus}). Use read_image on the returned path.`)
          if (value.imageError) lines.push(`Image attachment note: ${value.imageError}`)
        }
        const blocks = [{ type: 'text', text: lines.join('\n') }]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Capture current CAPTCHA crop',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      assertImageCodeCaptureCapability(bridge)
      const captured = await bridge.request('captureImageCode', {
        tabId: args.tabId,
        inputSelector: args.inputSelector,
        imageSelector: args.imageSelector,
      }, { timeoutMs, signal: exec?.signal })
      if (!captured || typeof captured !== 'object' || captured.ok === false || typeof captured.dataUrl !== 'string') {
        throw new Error(String(captured?.error || 'captureImageCode did not return a CAPTCHA image'))
      }

      const workspace = exec?.agent?.session?.header?.cwd
      const targetDirectory = typeof workspace === 'string' && workspace.trim() !== ''
        ? join(workspace, '.dsh-patrol', 'captcha-visual')
        : undefined
      const path = bridge.saveScreenshot(captured.dataUrl, targetDirectory)

      const attached = await tryReadImage(ctx, exec, path)
      return {
        ok: true,
        path,
        captureMode: typeof captured.captureMode === 'string' ? captured.captureMode : '',
        inputSelector: typeof captured.inputSelector === 'string' ? captured.inputSelector : '',
        imageSelector: typeof captured.imageSelector === 'string' ? captured.imageSelector : '',
        imageStatus: attached.status,
        ...(attached.error ? { imageError: attached.error } : {}),
        ...(attached.image === undefined ? {} : { image: attached.image }),
      }
    },
  })

  return ctx.tools.register(definition)
}

export function assertImageCodeCaptureCapability(bridge) {
  if (typeof bridge?.status !== 'function') return
  const extension = bridge.status()?.extension
  if (!extension || typeof extension !== 'object') return
  const capabilities = Array.isArray(extension.capabilities)
    ? extension.capabilities.filter(item => typeof item === 'string')
    : undefined
  if (capabilities === undefined) {
    throw new Error(`Patrol browser extension ${extension.version || '?'} does not advertise runtime capabilities. A stale extension is probably still loaded; restart Harness so the managed browser reinstalls the bundled extension before using browser_capture_image_code_visual.`)
  }
  if (!capabilities.includes('captureImageCode')) {
    throw new Error(`Patrol browser extension ${extension.version || '?'} is missing capability captureImageCode. This is a runtime/extension version mismatch; restart Harness before CAPTCHA visual capture.`)
  }
}

async function tryReadImage(ctx, exec, path) {
  if (ctx.tools.get('read_image', exec?.agent) === undefined) {
    return { status: 'tool-unavailable', error: 'Harness read_image is not registered for this Patrol route.' }
  }
  try {
    const result = await ctx.tools.execute({
      callId: `patrol-captcha-visual-${randomUUID()}`,
      rootCallId: exec.rootCallId,
      name: 'read_image',
      arguments: { file_path: path },
      signal: exec.signal,
      ...(exec.agent === undefined ? {} : { agent: exec.agent }),
      parent: exec.token,
    })
    if (result.isError) {
      return { status: 'read-failed', error: String(result.error?.message || 'read_image failed') }
    }
    if (!result.value || typeof result.value !== 'object') {
      return { status: 'read-failed', error: 'read_image returned no image attachment value' }
    }
    return { status: 'attached', image: result.value }
  } catch (error) {
    return { status: 'read-failed', error: error instanceof Error ? error.message : String(error) }
  }
}
