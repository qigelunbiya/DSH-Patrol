import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import { forgetTransientSecret, rememberTransientSecret } from '../browser-bridge-runtime/transient-secret-store.js'
import { assertSafePersistentText } from './security.js'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type { InspectionStep, ToolStep } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export const PATROL_TRANSIENT_INPUT_PROMPT = `敏感输入规则：
- 用户在当前对话里已经明确提供密码或其他敏感字段值时，直接使用 patrol_type_transient，不要因为没有 Harness credential reference 而停止，也不要要求用户额外运行 credential helper。
- patrol_type_transient 这个工具名为兼容旧 Runbook 保留，但当前实现已经不是“仅进程内 transient”：明文只在本次工具执行与浏览器输入的瞬间存在，随后以 AES-256-GCM 认证加密形式保存到本机 DSH Patrol secret vault；Runbook 只保存 PATROL_SECRET_* 不透明引用。
- patrol_validate、patrol_run、Harness 重启后的后续执行都可以自动解密该引用并填写密码。不要把明文密码写进 Runbook、报告、notes 或回复。
- 只有用户明确要求使用 Harness credential reference 时才使用 patrol_type_credential / patrol_credential_help；它不是交互式巡检的前置条件。
- 普通图片字符验证码必须由 patrol_detect_auth_challenge 自动识别和填写；识别失败直接报错，绝不创建人工验证码 checkpoint。`

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

  const disposers = [typeTransient, reteachTransient].map(tool => ctx.tools.register(tool))
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
