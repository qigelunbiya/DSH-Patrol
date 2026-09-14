import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { forgetTransientSecret, rememberTransientSecret } from '../browser-bridge-runtime/transient-secret-store.js'
import { isPatrolTestMode } from './test-mode.js'
import { assertSafePersistentText } from './security.js'
import { PatrolRunner } from './runner.js'
import { stepExecutionNotes } from './step-notes.js'
import { assertPersistedTaskChecklist, PatrolStore } from './store.js'
import type { InspectionStep, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const IMAGE_CODE_SELECTOR_HINT = /(captcha|image[-_ ]?code|img[-_ ]?code|图形验证码|图片验证码|字符验证码|验证码图片|验证码|校验码|图形码)/i
const IMAGE_CODE_MIN_CONFIDENCE = 0.90
const MULTIPLE_IMAGE_CODE_CANDIDATES = /(?:\bor\b|或者|或|候选|candidate|[,，/、;；|]|\r?\n)/i
const VISUAL_SOLVER_NOTE = 'PATROL_DYNAMIC_IMAGE_CODE_SOLVER'

export const PATROL_TRANSIENT_INPUT_PROMPT = `敏感输入规则：
- 用户在当前对话里已经明确提供密码或其他敏感字段值时，直接使用 patrol_type_transient，不要因为没有 Harness credential reference 而停止，也不要要求用户额外运行 credential helper。
- patrol_type_transient 明文只在本次工具执行与浏览器输入瞬间存在，随后以 AES-256-GCM 认证加密保存到本机 Patrol secret vault；Runbook 只保存不透明引用。不要把明文密码写进 Runbook、报告、notes 或回复。
- 只有用户明确要求 Harness credential reference 时才使用 patrol_type_credential / patrol_credential_help。
- 普通图片字符验证码 image-code 是一次性页面状态，不得存入 secret vault，也不得作为固定 browser_type 值写进 Runbook。
- TEST MODE 交互教学使用视觉优先：直接 browser_capture_image_code_visual 获取 CURRENT 图像，再以 patrol_type_current_image_code 的 0.90 置信度门槛填写。不要先运行本地 ddddocr/Windows OCR 预检；patrol_solve_current_image_code 仅保留为兼容入口并会立即提示走视觉路径，不再执行 OCR。
- 高置信度视觉验证码填写成功后，Patrol 只记录一个不含验证码字符的动态 browser_detect_auth_challenge solver 步骤，供 NORMAL/无人值守 replay 识别未来的新验证码；重复视觉尝试不会重复追加 solver 步骤。
- 密码、TOTP/OTP、token 等真正敏感值仍必须走专用敏感输入流程。`

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
      assertPersistedTaskChecklist(definition)

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
        notes: stepExecutionNotes({
          tool: 'browser_type_transient_ref',
          args: { selector: args.selector, transientRef, clear: args.clear ?? true },
          providedNotes: args.notes,
        }),
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

  const solveCurrentImageCode = defineTool({
    name: 'patrol_solve_current_image_code',
    description: 'Compatibility entrypoint for TEST MODE image-code teaching. It deliberately does NOT run ddddocr/Windows OCR anymore; interactive teaching is visual-first. Use browser_capture_image_code_visual for the CURRENT image, then patrol_type_current_image_code with confidence >= 0.90.',
    parameters: {
      inspectionId: { type: 'string', required: true },
      stepName: { type: 'string' },
      tabId: { type: 'integer' },
    },
    output: TEXT_OUTPUT,
    async execute(args) {
      if (!isPatrolTestMode()) {
        throw new Error('patrol_solve_current_image_code is available only in DSH Patrol TEST MODE; normal mode uses the replay detector/solver')
      }
      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}; call patrol_begin_edit before teaching image-code handling`)
      assertPersistedTaskChecklist(definition)
      if (args.stepName !== undefined) assertSafePersistentText(args.stepName, 'stepName')
      return 'TEST MODE visual-first CAPTCHA path: no local OCR was executed. Call browser_capture_image_code_visual on the CURRENT page without a historical tabId, read the attached image once, then call patrol_type_current_image_code only when confidence >= 0.90.'
    },
  })

  const typeCurrentImageCode = defineTool({
    name: 'patrol_type_current_image_code',
    description: 'TEST MODE visual input: type the CURRENT conventional image-text CAPTCHA without persisting its one-time characters. Requires confidence >= 0.90. On a successful type, records/reuses one dynamic browser_detect_auth_challenge replay step without storing the CAPTCHA value.',
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
      if (!isPatrolTestMode()) throw new Error('patrol_type_current_image_code is available only in DSH Patrol TEST MODE')
      if (!IMAGE_CODE_SELECTOR_HINT.test(String(args.selector || ''))) {
        throw new Error('patrol_type_current_image_code requires an explicit image-code/CAPTCHA input selector')
      }
      const confidence = Number(args.confidence)
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
        throw new Error('image-code confidence must be a finite number from 0 to 1')
      }
      if (confidence < IMAGE_CODE_MIN_CONFIDENCE) {
        return `CURRENT CAPTCHA was NOT typed because confidence=${confidence.toFixed(3)} is below ${IMAGE_CODE_MIN_CONFIDENCE.toFixed(2)}. Refresh the CAPTCHA and capture the fresh visual before any login submission.`
      }

      const rawCode = String(args.text || '').trim()
      if (MULTIPLE_IMAGE_CODE_CANDIDATES.test(rawCode)) {
        throw new Error('current image-code must be one single candidate; refresh the CAPTCHA when recognition produces multiple possible answers')
      }
      const code = rawCode.replace(/\s+/g, '')
      if (!/^[A-Za-z0-9]{2,16}$/.test(code)) {
        throw new Error('current image-code must contain 2-16 ASCII letters/digits after whitespace removal')
      }

      const definition = await store.load(args.inspectionId)
      if (definition.status !== 'draft') throw new Error(`inspection ${definition.id} is ${definition.status}; call patrol_begin_edit before teaching image-code handling`)
      assertPersistedTaskChecklist(definition)

      const dispatched = await runner.dispatch('browser_type', {
        selector: args.selector,
        text: code,
        clear: args.clear ?? true,
      }, exec)
      if (!dispatched.ok) return `CURRENT CAPTCHA typing failed and nothing was recorded. ${dispatched.error ?? dispatched.text}`

      let solverStep = definition.steps.find(step =>
        step.kind === 'tool'
        && step.tool === 'browser_detect_auth_challenge'
        && typeof step.notes === 'string'
        && step.notes.includes(VISUAL_SOLVER_NOTE),
      ) as ToolStep | undefined
      let recorded = false
      if (solverStep === undefined) {
        solverStep = {
          id: nextStepId(definition.steps),
          kind: 'tool',
          name: '动态识别并填写图片验证码',
          tool: 'browser_detect_auth_challenge',
          arguments: {},
          notes: stepExecutionNotes({
            tool: 'browser_detect_auth_challenge',
            args: {},
            providedNotes: `${VISUAL_SOLVER_NOTE}；教学阶段使用 CURRENT 模型视觉；重放阶段动态识别新验证码；不保存一次性验证码字符。`,
          }),
          recordedAt: new Date().toISOString(),
        }
        definition.steps.push(solverStep)
        definition.schemaVersion = '0.2'
        definition.metadata.updatedAt = new Date().toISOString()
        await store.save(definition)
        recorded = true
      }

      return [
        `TEST MODE: typed the CURRENT image-code with confidence=${confidence.toFixed(3)}${args.source ? ` (${args.source})` : ''}.`,
        'Its one-time characters were NOT written to the Runbook, Patrol secret vault, notes, reports, or visible tool card.',
        recorded
          ? `Recorded ${solverStep.id} as the single dynamic image-code solver step for future replay.`
          : `Reused existing dynamic image-code solver step ${solverStep.id}; no duplicate solver step was appended.`,
      ].join('\n')
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
        notes: stepExecutionNotes({
          tool: 'browser_type_transient_ref',
          args: { selector: args.selector, transientRef, clear: args.clear ?? true },
          providedNotes: args.notes ?? current.notes,
        }),
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

  const disposers = [typeTransient, solveCurrentImageCode, typeCurrentImageCode, reteachTransient].map(tool => ctx.tools.register(tool))
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
