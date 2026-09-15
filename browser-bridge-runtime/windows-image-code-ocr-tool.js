import { defineTool } from '@deepseek-ai/dsh-tools'
import { readCurrentImageCodeWithWindowsOcr } from './windows-image-code-reader.js'

const optStr = { type: 'string' }
const optInt = { type: 'integer' }

export function registerWindowsImageCodeOcrTool(ctx, bridge, config = {}) {
  const timeoutMs = config.commandTimeoutMs ?? 60000
  const definition = defineTool({
    name: 'patrol_windows_ocr_image_code',
    description: 'Read the CURRENT conventional image-code CAPTCHA with Windows System OCR. The shared reader tries tight CURRENT PNG crops first (2x, then 3x) and then the legacy filtered CURRENT-page PNG OCR recovery. Model vision is only a fallback after Windows OCR is exhausted. The tool never types or submits a value.',
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
          ok: { type: 'boolean', required: true },
          status: { type: 'string', required: true },
          text: { type: 'string', required: true },
          confidence: { type: 'number', required: true },
          inputSelector: { type: 'string', required: true },
          imageSelector: { type: 'string', required: true },
          captureMode: { type: 'string', required: true },
          rawOcrText: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: [
          `Windows OCR image-code status=${value.status}; candidate=${value.text || '(none)'}; confidence=${Number(value.confidence || 0).toFixed(2)}`,
          `captureMode=${value.captureMode || 'unknown'}; inputSelector=${value.inputSelector || '(auto)'}; imageSelector=${value.imageSelector || '(auto)'}`,
          value.text && Number(value.confidence) >= 0.90
            ? 'Use patrol_type_current_image_code with this CURRENT candidate and confidence. The persisted taskChecklist format is still authoritative and may reject a mismatching candidate.'
            : 'Windows OCR did not produce a strong CURRENT candidate. If the CURRENT patrol_observe/screenshot has already yielded one clear format-valid candidate, use that candidate directly instead of re-reading the same CAPTCHA; otherwise use model-visual fallback.',
        ].join('\n'),
      }],
    },
    presentCall: args => ({
      card: 'generic',
      title: 'Read current CAPTCHA with Windows OCR',
      kind: 'other',
      rawInput: args,
    }),
    async execute(args, exec) {
      const result = await readCurrentImageCodeWithWindowsOcr(bridge, args, {
        commandTimeoutMs: timeoutMs,
        signal: exec?.signal,
      })
      // resolvedTabId is internal replay state. Never surface or persist it as
      // part of the public CAPTCHA result contract.
      const { resolvedTabId: _resolvedTabId, ...publicResult } = result
      return publicResult
    },
  })

  return ctx.tools.register(definition)
}
