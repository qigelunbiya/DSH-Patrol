import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { CallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { resolveFlowReference, type FlowReferenceResult } from './flow-reference-tools.js'
import { PatrolStore } from './store.js'
import type { InspectionDefinition, RunReport } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

const RUN_OUTPUT = {
  schema: {
    type: 'object' as const,
    additionalProperties: false,
    properties: {
      inspectionId: { type: 'string' as const, required: true },
      runId: { type: 'string' as const, required: true },
      status: { type: 'string' as const, required: true, enum: ['passed', 'failed', 'waiting'] as const },
      report: { type: 'string' as const, required: true },
      recoverySessionId: { type: 'string' as const },
      message: { type: 'string' as const, required: true },
    },
  },
  render: (_args: unknown, value: {
    inspectionId: string
    runId: string
    status: 'passed' | 'failed' | 'waiting'
    report: string
    recoverySessionId?: string
    message: string
  }) => [{ type: 'text' as const, text: [
    `flow=${value.inspectionId}`,
    `runId=${value.runId}`,
    `status=${value.status}`,
    `report=${value.report}`,
    ...(value.recoverySessionId === undefined ? [] : [`recoverySessionId=${value.recoverySessionId}`]),
    value.message,
  ].join('\n') }],
}

type AgentOptionsLike = {
  provider?: string
  model?: string
  reasoningEffort?: unknown
  maxTokens?: number
}

interface WorkerAgentLike {
  readonly id: string
  readonly ctx: Context
  readonly options: AgentOptionsLike
  followup(message: ReturnType<typeof createUserMessage>): void
  runMaintenance<T>(task: (signal: AbortSignal) => Promise<T>): Promise<T>
}

interface WorkerHandleLike {
  readonly agent: WorkerAgentLike
  dispose(): Promise<void>
}

interface AgentRegistryLike {
  create(options: {
    sessionId: string
    meta?: { cwd?: string; agentPreset?: string }
    agentOptions?: AgentOptionsLike
    setup?: (agentCtx: Context) => Promise<void> | void
  }): Promise<WorkerHandleLike>
}

interface AgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

interface AgentDefaultModelLike {
  currentSelection(): AgentOptionsLike
}

export interface PatrolShellOptions {
  replayPresetId?: string
  teachingPresetId?: string
  recoveryPresetId?: string
}

export function registerPatrolShellTools(
  ctx: Context,
  store: PatrolStore,
  options: PatrolShellOptions = {},
): () => void {
  const replayPresetId = options.replayPresetId ?? 'patrol-replay'
  const teachingPresetId = options.teachingPresetId ?? 'patrol-teaching'
  const recoveryPresetId = options.recoveryPresetId ?? 'patrol-recovery'

  const listFlows = defineTool({
    name: 'patrol_list_flows',
    description: 'List existing Patrol flows compactly. This is a lightweight catalog tool and does not load browser/SSH/Excel capabilities.',
    parameters: {},
    output: TEXT_OUTPUT,
    async execute(_args, exec) {
      const definitions = preferWorkspace(await store.list(), exec.agent?.session.header.cwd)
      if (definitions.length === 0) return 'No Patrol flows are available in the current workspace.'
      return definitions.map(item => `${item.id}\t${item.status}\t${item.steps.length} steps\t${item.name}`).join('\n')
    },
  })

  const resolveFlow = defineTool({
    name: 'patrol_resolve_flow',
    description: 'Resolve an existing Patrol flow from its stable id, display name, or @name without loading browser capabilities.',
    parameters: {
      flow: { type: 'string', required: true },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const result = resolveFlowReference(await store.list(), args.flow, exec.agent?.session.header.cwd)
      return renderResolution(args.flow, result)
    },
  })

  const startTeaching = defineTool({
    name: 'patrol_start_teaching',
    description: 'Start a fresh heavy Patrol teaching worker only when the user wants to create, reteach, or modify a browser Runbook. Keep task text free of plaintext passwords/OTP/captcha answers; the teaching worker uses transient/credential tools for secrets.',
    parameters: {
      task: { type: 'string', required: true, description: 'Secret-free teaching goal, target URL, and desired outcome.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const workspace = exec.agent?.session.header.cwd
      if (!workspace) throw new Error('Patrol teaching requires a Harness workspace')
      const sessionId = await launchWorker(
        ctx,
        teachingPresetId,
        workspace,
        exec.agent?.options,
        [
          '你是由轻量 Patrol Shell 按需启动的教学 Worker。',
          '只处理下面这一个巡检创建/修改任务；需要浏览器能力时使用当前 Teaching preset 已提供的 Patrol 工具。',
          '不要把明文密码、OTP、验证码答案写入 Runbook。',
          '',
          args.task,
        ].join('\n'),
      )
      return `Started Patrol teaching worker session ${sessionId}. Heavy browser/teaching capabilities are isolated from this lightweight shell session.`
    },
  })

  const runFlow = defineTool({
    name: 'patrol_run_flow',
    description: 'Run or continue an existing Patrol flow with the deterministic runner. Normal replay makes zero additional LLM calls. A human-checkpoint run resumes through the same tool after the user completes the checkpoint. Unexpected browser failures start one narrow Recovery worker.',
    parameters: {
      flow: { type: 'string', required: true, description: 'Stable inspectionId, display name, or @name.' },
    },
    output: RUN_OUTPUT,
    async execute(args, exec) {
      const definitions = await store.list()
      const resolution = resolveFlowReference(definitions, args.flow, exec.agent?.session.header.cwd)
      const definition = requireUniqueResolution(args.flow, resolution)
      if (definition.steps.length === 0) throw new Error(`inspection ${definition.id} has no reusable steps`)
      const workspace = exec.agent?.session.header.cwd ?? definition.metadata.workspaceRoot
      if (!workspace) throw new Error(`inspection ${definition.id} has no workspace; open it from a workspace before replay`)

      const pending = await store.loadResume(definition.id)
      if (pending?.reason === 'recovery') {
        const report = await store.loadRun(definition.id, pending.runId)
        return {
          inspectionId: definition.id,
          runId: pending.runId,
          status: 'failed',
          report: `${definition.id}/${pending.runId}`,
          message: 'This run is already paused at a Recovery boundary. Do not start a second replay or Recovery worker; wait for the active Recovery worker to hand control back, or abort the pending run explicitly.',
        }
      }

      const replayTool = pending === undefined ? 'patrol_run_flow' : 'patrol_resume_flow'
      const replayText = await executeReplayWorker(ctx, replayPresetId, workspace, definition.id, replayTool)
      const runId = extractField(replayText, 'runId')
      if (!runId) throw new Error(`deterministic replay for ${definition.id} returned no runId`)
      const report = await store.loadRun(definition.id, runId)
      const reportPath = extractField(replayText, 'report') || `${definition.id}/${runId}`

      if (report.status !== 'failed') {
        return {
          inspectionId: definition.id,
          runId,
          status: report.status,
          report: reportPath,
          message: report.status === 'passed'
            ? 'Deterministic replay completed without invoking an additional conversation model.'
            : 'Deterministic replay paused at an explicit human checkpoint; complete the checkpoint, then invoke patrol_run_flow again to continue from there.',
        }
      }

      const failure = lastRecoverableFailure(report)
      if (failure === undefined) {
        return {
          inspectionId: definition.id,
          runId,
          status: 'failed',
          report: reportPath,
          message: 'Replay failed outside a recoverable browser step; no automatic Recovery worker was started.',
        }
      }

      const recoverySessionId = await launchWorker(
        ctx,
        recoveryPresetId,
        workspace,
        exec.agent?.options,
        recoveryPrompt(definition, report),
      )
      return {
        inspectionId: definition.id,
        runId,
        status: 'failed',
        report: reportPath,
        recoverySessionId,
        message: `Runner paused at ${failure.stepId}. A narrow Recovery worker was started only for this exception; after clearing the obstruction it must call patrol_resume_after_recovery once to hand control back to the deterministic runner.`,
      }
    },
  })

  const disposers = [listFlows, resolveFlow, startTeaching, runFlow].map(tool => ctx.tools.register(tool))
  return () => { for (const dispose of disposers) dispose() }
}

async function executeReplayWorker(
  ctx: Context,
  presetId: string,
  workspace: string,
  inspectionId: string,
  replayTool: 'patrol_run_flow' | 'patrol_resume_flow',
): Promise<string> {
  const { agents, presets } = workerServices(ctx)
  const resolved = (await presets.resolve(presetId)).id
  const sessionId = `patrol-replay-${randomUUID()}`
  const handle = await agents.create({
    sessionId,
    meta: { cwd: workspace, agentPreset: resolved },
    setup: async agentCtx => { await presets.mount(agentCtx, resolved) },
  })
  try {
    return await handle.agent.runMaintenance(async signal => {
      const result = await handle.agent.ctx.tools.execute({
        callId: CallId(`patrol-shell-replay-${randomUUID()}`),
        name: replayTool,
        arguments: { flow: inspectionId },
        signal,
        agent: handle.agent as never,
      })
      if (result.isError) throw new Error(result.error.message)
      if (typeof result.value === 'string') return result.value
      return result.content.map(block => block.type === 'text' ? block.text : `[${block.type}]`).join('\n')
    })
  } finally {
    await handle.dispose()
  }
}

async function launchWorker(
  ctx: Context,
  presetId: string,
  workspace: string,
  inheritedOptions: AgentOptionsLike | undefined,
  prompt: string,
): Promise<string> {
  const { agents, presets } = workerServices(ctx)
  const resolved = (await presets.resolve(presetId)).id
  const sessionId = `session-${randomUUID()}`
  const handle = await agents.create({
    sessionId,
    meta: { cwd: workspace, agentPreset: resolved },
    agentOptions: resolveAgentOptions(ctx, inheritedOptions),
    setup: async agentCtx => { await presets.mount(agentCtx, resolved) },
  })
  try {
    handle.agent.followup(createUserMessage({
      content: [{ type: 'text', text: prompt }],
      source: { kind: 'user' },
    }))
  } catch (error) {
    await handle.dispose().catch(() => {})
    throw error
  }
  return handle.agent.id
}

function workerServices(ctx: Context): { agents: AgentRegistryLike; presets: AgentPresetsLike } {
  const agents = lookupService<AgentRegistryLike>(ctx, 'agents')
  const presets = lookupService<AgentPresetsLike>(ctx, 'agentPresets')
  if (agents === undefined) throw new Error('Harness Agent registry is unavailable; cannot launch a lazy Patrol worker')
  if (presets === undefined) throw new Error('Harness Agent Presets service is unavailable; cannot launch a lazy Patrol worker')
  return { agents, presets }
}

function resolveAgentOptions(ctx: Context, inherited: AgentOptionsLike | undefined): AgentOptionsLike {
  if (inherited?.provider && inherited.model) return { ...inherited }
  const defaults = lookupService<AgentDefaultModelLike>(ctx, 'agentDefaultModel')
  return defaults?.currentSelection() ?? { ...inherited }
}

function lookupService<T>(ctx: Context, name: string): T | undefined {
  return (ctx as unknown as { get(service: string): unknown }).get(name) as T | undefined
}

function requireUniqueResolution(query: string, result: FlowReferenceResult): InspectionDefinition {
  if (result.kind === 'missing') throw new Error(`no Patrol flow matched ${JSON.stringify(query)}`)
  if (result.kind === 'ambiguous') {
    throw new Error(`flow reference ${JSON.stringify(query)} is ambiguous; matching inspectionIds: ${result.matches.map(item => item.id).join(', ')}`)
  }
  return result.definition
}

function renderResolution(query: string, result: FlowReferenceResult): string {
  if (result.kind === 'missing') return `NO_MATCH: no Patrol flow matched ${JSON.stringify(query)}.`
  if (result.kind === 'ambiguous') {
    return [`AMBIGUOUS: ${JSON.stringify(query)}`, ...result.matches.map(item => `- ${item.id}\t${item.name}`)].join('\n')
  }
  return `MATCH: ${result.definition.id}\t${result.definition.status}\t${result.definition.steps.length} steps\t${result.definition.name}`
}

function preferWorkspace(definitions: readonly InspectionDefinition[], workspace?: string): InspectionDefinition[] {
  if (!workspace) return [...definitions]
  const normalized = normalizeWorkspace(workspace)
  const local = definitions.filter(item => normalizeWorkspace(item.metadata.workspaceRoot) === normalized)
  return local.length > 0 ? local : [...definitions]
}

function normalizeWorkspace(value?: string): string {
  return String(value ?? '').trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase('en-US')
}

function extractField(text: string, field: string): string | undefined {
  const line = text.split(/\r?\n/u).find(item => item.startsWith(`${field}=`))
  const value = line?.slice(field.length + 1).trim()
  return value ? value : undefined
}

function lastRecoverableFailure(report: RunReport): RunReport['results'][number] | undefined {
  return [...report.results].reverse().find(item => item.status === 'failed'
    && item.stepId !== 'artifact-check'
    && typeof item.tool === 'string'
    && item.tool.startsWith('browser_'))
}

function recoveryPrompt(definition: InspectionDefinition, report: RunReport): string {
  const failure = lastRecoverableFailure(report)
  const failedIndex = failure === undefined ? -1 : report.results.findIndex(item => item === failure)
  const nearby = report.results.slice(Math.max(0, failedIndex - 2), Math.max(0, failedIndex) + 1)
  const context = nearby.map(item => [
    `${item.stepId} ${item.name} [${item.status}]${item.tool ? ` tool=${item.tool}` : ''}`,
    item.error ? `error=${trimContext(item.error, 700)}` : '',
    item.output ? `output=${trimContext(item.output, 900)}` : '',
  ].filter(Boolean).join('\n')).join('\n---\n')
  return [
    '你是 DSH Patrol 的按需 Recovery Worker。正常流程已经由 deterministic runner 执行；只有这一个异常需要模型介入。',
    '目标：解除当前页面阻塞，然后立即把控制权交还 Runner。不要从头重跑流程，不要修改/重教 Runbook，不要调用 begin_edit/finalize/create 类工具。',
    '只读取当前浏览器状态，并使用最少的 browser_* 动作处理新弹窗、选择器漂移或其他瞬时页面变化。',
    '确认阻塞解除后，必须调用且只调用一次 patrol_resume_after_recovery，让 Runner 从失败步骤重新尝试并继续后续步骤。',
    '如果无法安全恢复，停止并说明原因；不要猜测或无限重试。',
    '',
    `flow=${definition.id} (${definition.name})`,
    `runId=${report.runId}`,
    `failedStep=${failure?.stepId ?? 'unknown'}`,
    '',
    '仅提供失败附近的运行上下文（不是完整聊天历史）：',
    context || '(no nearby step context)',
  ].join('\n')
}

function trimContext(value: string, max: number): string {
  const normalized = value.replace(/\s+/gu, ' ').trim()
  return normalized.length <= max ? normalized : `${normalized.slice(0, max)}…`
}