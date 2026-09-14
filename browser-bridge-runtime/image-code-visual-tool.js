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

const CAPTURE_FALLBACK_ERROR = /unsupported browser command:\s*captureImageCode|page bridge unavailable|receiving end does not exist|could not establish connection|no tab with id|element not found/i

export function registerImageCodeVisualTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'browser_capture_image_code_visual',
    description: 'Capture the CURRENT conventional image-code CAPTCHA for model vision. Prefer a tight 3x crop; if the page bridge or a stale tab prevents element discovery, fall back once to the CURRENT active-page screenshot. This visual tool deliberately runs no local OCR and never types or submits a value.',
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
          `CURRENT image-code visual: ${value.path}`,
          `captureMode=${value.captureMode || 'unknown'}; inputSelector=${value.inputSelector || '(auto)'}; imageSelector=${value.imageSelector || '(auto)'}`,
          'No ddddocr/Windows OCR preflight was run for this visual capture.',
        ]
        if (value.imageStatus === 'attached' && value.image !== undefined) {
          lines.push(value.captureMode?.startsWith('full-page')
            ? 'The exact CURRENT page screenshot is attached because tight element capture was unavailable. Read only the visible CURRENT CAPTCHA and do not reuse historical text.'
            : 'The attached image is a tight enlarged crop of the CURRENT CAPTCHA. Read it visually; do not reuse any historical CAPTCHA text.')
        } else {
          lines.push(`The image was saved but could not be attached (${value.imageStatus}). Use read_image once on the returned path.`)
          if (value.imageError) lines.push(`Image attachment note: ${value.imageError}`)
        }
        lines.push('Return one candidate plus confidence. If confidence is below the Patrol visual threshold, refresh instead of submitting a guess.')
        const blocks = [{ type: 'text', text: lines.join('\n') }]
        if (value.image !== undefined) blocks.push({ type: 'image', attachment: value.image })
        return blocks
      },
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Capture current CAPTCHA visual',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      assertImageCodeCaptureCapability(bridge)
      const { captured, captureError } = await captureCurrentImageCodeVisual(bridge, args, exec, timeoutMs)
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
        ...(captureError || attached.error ? { imageError: [captureError, attached.error].filter(Boolean).join('; ') } : {}),
        ...(attached.image === undefined ? {} : { image: attached.image }),
      }
    },
  })

  return ctx.tools.register(definition)
}

async function captureCurrentImageCodeVisual(bridge, args, exec, timeoutMs) {
  let captureError = ''
  try {
    const captured = await bridge.request('captureImageCode', {
      // A caller may provide a CURRENT tab id, but interactive prompts are
      // instructed to omit it so a historical tab id cannot poison capture.
      tabId: args.tabId,
      inputSelector: args.inputSelector,
      imageSelector: args.imageSelector,
      visualScale: 3,
    }, { timeoutMs, signal: exec?.signal })
    return { captured, captureError }
  } catch (error) {
    captureError = error instanceof Error ? error.message : String(error)
    if (!CAPTURE_FALLBACK_ERROR.test(captureError)) throw error
  }

  // Do exactly one fallback on the active CURRENT tab. This absorbs stale tab
  // ids and temporary content-script/selector failures without sending the
  // model through recover -> list-tabs -> screenshot -> read_image loops.
  const shot = await bridge.request('screenshot', {
    format: 'png',
  }, { timeoutMs, signal: exec?.signal })
  return {
    captureError,
    captured: {
      ok: true,
      dataUrl: shot.dataUrl,
      captureMode: 'full-page-current-tab-fallback',
      inputSelector: typeof args.inputSelector === 'string' ? args.inputSelector : '',
      imageSelector: '',
      imageError: captureError,
    },
  }
}

export function assertImageCodeCaptureCapability(bridge) {
  if (typeof bridge?.status !== 'function') return
  const extension = bridge.status()?.extension
  if (!extension || typeof extension !== 'object') return
  const capabilities = Array.isArray(extension.capabilities)
    ? extension.capabilities.filter(item => typeof item === 'string')
    : undefined
  if (capabilities === undefined) return
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
    if (!result.value || typeof result.value !== 'object' || !result.value.image || typeof result.value.image !== 'object') {
      return { status: 'read-failed', error: 'read_image returned no image attachment value' }
    }
    return { status: 'attached', image: result.value.image }
  } catch (error) {
    return { status: 'read-failed', error: error instanceof Error ? error.message : String(error) }
  }
}
