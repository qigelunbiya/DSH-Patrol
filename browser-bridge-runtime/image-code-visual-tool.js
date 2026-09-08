import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { recognizeImageCodeWithDdddocr } from './image-code-ddddocr.js'

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
    description: 'Capture the CURRENT conventional image-code CAPTCHA as a tight enlarged image crop and attach it to the model. It also reports the local ddddocr preprocessing-ensemble hint for the exact same crop as secondary evidence; it never types or submits the hint automatically.',
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
          localOcrText: str,
          localOcrConfidence: { type: 'number' },
          localOcrSupport: { type: 'integer' },
          localOcrAlternatives: str,
          image: IMAGE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const lines = [
          `CURRENT image-code crop: ${value.path}`,
          `captureMode=${value.captureMode || 'unknown'}; inputSelector=${value.inputSelector || '(auto)'}; imageSelector=${value.imageSelector || '(auto)'}`,
        ]
        if (value.localOcrText) {
          lines.push(
            `Local OCR ensemble for THIS crop: ${value.localOcrText}; confidence=${Number(value.localOcrConfidence || 0).toFixed(3)}; support=${value.localOcrSupport || 1}.`,
          )
          if (value.localOcrAlternatives) lines.push(`Other local OCR candidates: ${value.localOcrAlternatives}`)
          lines.push('Use these only as secondary evidence against the attached crop. Never silently turn 4/7/0/1/2/5/8 into A/T/O/I/Z/S/B unless the CURRENT pixels and any known CAPTCHA charset both support it.')
        } else {
          lines.push('Local OCR produced no usable consensus for this crop. Do not compensate by inventing a low-confidence string.')
        }
        if (value.imageStatus === 'attached' && value.image !== undefined) {
          lines.push('The attached image is a tight enlarged crop of the CURRENT CAPTCHA. Read this image visually; do not reuse any historical CAPTCHA text.')
        } else {
          lines.push(`The crop was saved but could not be attached as an image (${value.imageStatus}). Use read_image on the returned path.`)
          if (value.imageError) lines.push(`Image attachment note: ${value.imageError}`)
        }
        lines.push('If local OCR and visual reading disagree or confidence is below the Patrol visual threshold, refresh the CAPTCHA instead of submitting a guess. One failed visual submission is evidence to refresh, not permission to try several nearby strings.')
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
      let captured
      let captureError = ''
      try {
        captured = await bridge.request('captureImageCode', {
          tabId: args.tabId,
          inputSelector: args.inputSelector,
          imageSelector: args.imageSelector,
          visualScale: 3,
        }, { timeoutMs, signal: exec?.signal })
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error)
        if (!/unsupported browser command:\s*captureImageCode/i.test(captureError)) throw error
        const shot = await bridge.request('screenshot', {
          tabId: args.tabId,
          format: 'png',
        }, { timeoutMs, signal: exec?.signal })
        captured = {
          ok: true,
          dataUrl: shot.dataUrl,
          captureMode: 'full-page-screenshot-fallback',
          inputSelector: typeof args.inputSelector === 'string' ? args.inputSelector : '',
          imageSelector: '',
          imageError: captureError,
        }
      }
      if (!captured || typeof captured !== 'object' || captured.ok === false || typeof captured.dataUrl !== 'string') {
        throw new Error(String(captured?.error || 'captureImageCode did not return a CAPTCHA image'))
      }

      const workspace = exec?.agent?.session?.header?.cwd
      const targetDirectory = typeof workspace === 'string' && workspace.trim() !== ''
        ? join(workspace, '.dsh-patrol', 'captcha-visual')
        : undefined
      const path = bridge.saveScreenshot(captured.dataUrl, targetDirectory)

      const [attached, localOcr] = await Promise.all([
        tryReadImage(ctx, exec, path),
        tryLocalOcr(captured.dataUrl, exec?.signal, timeoutMs),
      ])
      return {
        ok: true,
        path,
        captureMode: typeof captured.captureMode === 'string' ? captured.captureMode : '',
        inputSelector: typeof captured.inputSelector === 'string' ? captured.inputSelector : '',
        imageSelector: typeof captured.imageSelector === 'string' ? captured.imageSelector : '',
        imageStatus: attached.status,
        ...(captureError || attached.error ? { imageError: [captureError, attached.error].filter(Boolean).join('; ') } : {}),
        ...localOcr,
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
    return
  }
  if (!capabilities.includes('captureImageCode')) {
    throw new Error(`Patrol browser extension ${extension.version || '?'} is missing capability captureImageCode. This is a runtime/extension version mismatch; restart Harness before CAPTCHA visual capture.`)
  }
}

async function tryLocalOcr(dataUrl, signal, timeoutMs) {
  try {
    const result = await recognizeImageCodeWithDdddocr(dataUrl, {
      signal,
      timeoutMs: Math.min(Number(timeoutMs) || 30000, 30000),
    })
    if (result?.ok !== true || typeof result.text !== 'string') return {}
    const text = String(result.text).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
    if (!text) return {}
    const confidence = Number.isFinite(Number(result.confidence))
      ? Math.max(0, Math.min(1, Number(result.confidence)))
      : 0
    const support = Number.isFinite(Number(result.support)) ? Math.max(1, Math.trunc(Number(result.support))) : 1
    const alternatives = Array.isArray(result.candidates)
      ? result.candidates
        .filter(item => item && typeof item === 'object' && typeof item.text === 'string')
        .filter(item => String(item.text).replace(/[^A-Za-z0-9]/g, '') !== text)
        .slice(0, 3)
        .map(item => {
          const candidate = String(item.text).replace(/[^A-Za-z0-9]/g, '').slice(0, 12)
          const score = Number.isFinite(Number(item.confidence)) ? Math.max(0, Math.min(1, Number(item.confidence))) : 0
          const count = Number.isFinite(Number(item.support)) ? Math.max(1, Math.trunc(Number(item.support))) : 1
          return `${candidate} (${score.toFixed(2)}, support=${count})`
        })
        .filter(Boolean)
        .join('; ')
      : ''
    return {
      localOcrText: text,
      localOcrConfidence: confidence,
      localOcrSupport: support,
      ...(alternatives ? { localOcrAlternatives: alternatives } : {}),
    }
  } catch {
    return {}
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
