import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { forgetTransientSecret, rememberTransientSecret } from '../browser-bridge-runtime/transient-secret-store.js'
import { isPatrolTestMode } from './test-mode.js'
import { assertSafePersistentText } from './security.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type { InspectionStep, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const IMAGE_CODE_SELECTOR_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|图形验证码|图片验证码|字符验证码|验证码图片|验证码|校验码|图形码)/i
const IMAGE_CODE_MIN_CONFIDENCE = 0.80

export const PATROL_TRANSIENT_INPUT_PROMPT = `敏感输入规则：
- 用户在当前对话里已经明确提供密码或其他敏感字段值时，直接使用 patrol_type_transient，不要因为没有 Harness credential reference 而停止，也不要要求用户额外运行 credential helper。
- patrol_type_transient 这个工具名为兼容旧 Runbook 保留，但当前实现已经不是“仅进程内 transient”：明文只在本次工具执行与浏览器输入的瞬间存在，随后以 AES-256-GCM 认证加密形式保存到本机 DSH Patrol secret vault；Runbook 只保存 PATROL_SECRET_* 不透明引用。
- patrol_validate、patrol_run、Harness 重启后的后续执行都可以自动解密该引用并填写密码。不要把明文密码写进 Runbook、报告、notes 或回复。
- 只有用户明确要求使用 Harness credential reference 时才使用 patrol_type_credential / patrol_credential_help；它不是交互式巡检的前置条件。
- 普通图片字符验证码 image-code 是一次性页面状态，不是密码、OTP 或长期 credential。不要把当前验证码保存进 Patrol secret vault，也不要把它作为固定 browser_type 值写进 Runbook。
- TEST MODE 下，模型对 CURRENT 页面/验证码紧凑裁图完成视觉识别后，优先调用 patrol_type_current_image_code；该工具要求给出 0~1 的当前识别置信度，低于 0.80 时不会输入，高于或等于 0.80 时只填写当前页面且不记录一次性验证码值。验证码刷新或提交后旧值立即失效。
- NORMAL MODE 下继续由 patrol_detect_auth_challenge 的本地自动 solver 负责 image-code；密码、TOTP/OTP、token 等真正敏感值仍必须走专用敏感输入流程。`

export function registerPatrolTransientInputTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const typeTransient = defineTool({
    name: 'patrol_type_transient',
    description: 'Type a sensitive value already supplied by the user, persist only authenticated AES-256-GCM ciphertext, and record an opaque PATROL_SECRET reference so validation/runs can replay it across Harness restarts. The plaintext is never written to the Runbook, reports, or visible tool card.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      text: { type: 'string', required: true },
      clear: { type: 'boolean' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: 'Type encrypted sensitive text',
      kind: 'other',
      rawInput: {
        inspectionId: args.inspectionId,
        stepName: args.stepName,
        selector: args.selector,
        clear: args.clear,
        text: '[REDACTED]',
      },
    }),
    async execute(args, exec: ToolRunContext) {
      assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('sensitive text must not be empty')
      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}; call patrol_begin_edit before teaching sensitive input`)

      const transientRef = rememberTransientSecret(args.text)
      const dispatched = await runner.dispatch('browser_type', {
        selector: args.selector,
        text: args.text,
        clear: args.clear ?? true,
      }, exec, [args.text])
      if (!dispatched.ok) {
        forgetTransientSecret(transientRef)
        return `Sensitive input failed and its encrypted vault entry was removed. ${dispatched.error ?? dispatched.text}`
      }

      const step: ToolStep = {
        id: nextStepId(definition.steps),
        kind: 'tool',
        name: args.stepName,
        tool: 'browser_type_transient_ref',
        arguments: { selector: args.selector, transientRef, clear: args.clear ?? true },
        sensitive: true,
        ...(args.notes === undefined ? {} : { notes: args.notes }),
        recordedAt: new Date().toISOString(),
      }
      definition.steps.push(step)
      definition.schemaVersion = '0.2'
      definition.metadata.updatedAt = new Date().toISOString()
      await store.save(definition)

      return [
        `Typed sensitive text and recorded ${step.id} as an encrypted Patrol secret reference.`,
        'The plaintext value was NOT written to the Patrol Runbook, workspace reports, or tool card.',
        'The encrypted reference can be replayed by patrol_validate/patrol_run after Harness restarts on this machine.',
      ].join('\n')
    },
  })

  const typeCurrentImageCode = defineTool({
    name: 'patrol_type_current_image_code',
    description: 'TEST MODE only: type the CURRENT conventional image-text CAPTCHA without persisting its one-time value. Requires an explicit confidence from 0 to 1 and refuses to type below 0.80 so a weak visual guess is not submitted to lockout-prone sites.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      text: { type: 'string', required: true },
      confidence: { type: 'number', required: true },
      source: { type: 'string', enum: ['model-visual', 'ddddocr', 'consensus', 'manual-debug'] },
      clear: { type: 'boolean' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: 'Type current CAPTCHA',
      kind: 'other',
      rawInput: {
        inspectionId: args.inspectionId,
        selector: args.selector,
        confidence: args.confidence,
        source: args.source,
        clear: args.clear,
        text: '[CURRENT CAPTCHA]',
      },
    }),
    async execute(args, exec: ToolRunContext) {
      if (!isPatrolTestMode()) {
        throw new Error('patrol_type_current_image_code is available only in DSH Patrol TEST MODE')
      }
      if (!IMAGE_CODE_SELECTOR_HINT.test(String(args.selector || ''))) {
        throw new Error('patrol_type_current_image_code requires an explicit image-code/CAPTCHA input selector')
      }
      const confidence = Number(args.confidence)
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error('image-code confidence must be a finite number from 0 to 1')
      }
      if (confidence < IMAGE_CODE_MIN_CONFIDENCE) {
        return `CURRENT CAPTCHA was NOT typed because confidence=${confidence.toFixed(3)} is below ${IMAGE_CODE_MIN_CONFIDENCE.toFixed(2)}. Refresh/re-observe the CAPTCHA and recognize the fresh image before any login submission.`
      }

      const code = String(args.text || '').replace(/\s+/g, '').trim()
      if (!/^[A-Za-z0-9]{2,16}$/.test(code)) {
        throw new Error('current image-code must contain 2-16 ASCII letters/digits after whitespace removal')
      }

      const dispatched = await runner.dispatch('browser_type', {
        selector: args.selector,
        text: code,
        clear: args.clear ?? true,
      }, exec)
      if (!dispatched.ok) {
        return `CURRENT CAPTCHA typing failed and nothing was recorded. ${dispatched.error ?? dispatched.text}`
      }
      return `TEST MODE: typed the CURRENT image-code with confidence=${confidence.toFixed(3)}${args.source ? ` (${args.source})` : ''}. Its one-time value was NOT written to the Runbook, Patrol secret vault, notes, reports, or visible tool card.`
    },
  })

  const reteachTransient = defineTool({
    name: 'patrol_reteach_transient',
    description: 'Replace one existing encrypted sensitive-input step with a newly supplied value while preserving its stable step id. The previous encrypted vault entry is removed after the replacement is safely stored.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepId: { type: 'string', required: true },
      selector: { type: 'string', required: true },
      text: { type: 'string', required: true },
      clear: { type: 'boolean' },
      stepName: { type: 'string' },
      notes: { type: 'string' },
    },
    output: TEXT_OUTPUT,
    presentCall: args => ({
      card: 'generic',
      title: 'Refresh encrypted sensitive step',
      kind: 'other',
      rawInput: {
        inspectionId: args.inspectionId,
        stepId: args.stepId,
        selector: args.selector,
        clear: args.clear,
        stepName: args.stepName,
        text: '[REDACTED]',
      },
    }),
    async execute(args, exec: ToolRunContext) {
      if (args.stepName !== undefined) assertSafePersistentText(args.stepName, 'stepName')
      if (args.notes !== undefined) assertSafePersistentText(args.notes, 'step notes')
      if (typeof args.text !== 'string' || args.text.length === 0) throw new Error('sensitive text must not be empty')
      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}; call patrol_begin_edit before re-teaching`)
      const index = definition.steps.findIndex(step => step.id === args.stepId)
      const current = index >= 0 ? definition.steps[index] : undefined
      if (current === undefined || current.kind !== 'tool' || current.tool !== 'browser_type_transient_ref') {
        throw new Error(`${args.stepId} is not an encrypted sensitive input step`)
      }
      const oldRef = typeof current.arguments.transientRef === 'string' ? current.arguments.transientRef : undefined

      const transientRef = rememberTransientSecret(args.text)
      const dispatched = await runner.dispatch('browser_type', {
        selector: args.selector,
        text: args.text,
        clear: args.clear ?? true,
      }, exec, [args.text])
      if (!dispatched.ok) {
        forgetTransientSecret(transientRef)
        return `Sensitive re-teach failed and the stored step was NOT changed. ${dispatched.error ?? dispatched.text}`
      }

      const replacement: ToolStep = {
        id: current.id,
        kind: 'tool',
        name: args.stepName ?? current.name,
        tool: 'browser_type_transient_ref',
        arguments: { selector: args.selector, transientRef, clear: args.clear ?? true },
        sensitive: true,
        ...(args.notes !== undefined ? { notes: args.notes } : current.notes === undefined ? {} : { notes: current.notes }),
        recordedAt: new Date().toISOString(),
      }
      definition.steps[index] = replacement
      definition.metadata.updatedAt = new Date().toISOString()
      delete definition.metadata.validatedAt
      await store.save(definition)
      if (oldRef !== undefined && oldRef !== transientRef) forgetTransientSecret(oldRef)
      return `Re-taught ${current.id} with a persistent encrypted Patrol secret reference. No plaintext secret was persisted.`
    },
  })

  const disposers = [typeTransient, typeCurrentImageCode, reteachTransient].map(tool => ctx.tools.register(tool))
  return () => { for (const dispose of disposers) dispose() }
}

function nextStepId(steps: readonly InspectionStep[]): string {
  let max = 0
  for (const step of steps) {
    const match = /^step-(\d+)$/.exec(step.id)
    if (match !== null) max = Math.max(max, Number.parseInt(match[1] ?? '0', 10))
  }
  return `step-${String(max + 1).padStart(3, '0')}`
}
