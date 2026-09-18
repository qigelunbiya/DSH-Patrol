import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { PatrolRunner } from './runner.js'
import { PatrolStore } from './store.js'
import type { InspectionDefinition, RunReport, SavedRunPaths } from './types.js'

const TEXT_OUTPUT = {
  schema: { type: 'string' as const },
  render: (_args: unknown, value: string) => [{ type: 'text' as const, text: value }],
}

export const PATROL_FLOW_REFERENCE_PROMPT = `DSH Patrol existing-flow reference and replay rules（本节覆盖旧的“先 select 再手工 patrol_* 走一遍”的做法）：
- 流程有两个不同概念：稳定 inspectionId 和用户可见流程名称 name。用户说出流程名称、带前后空格的名称，或使用 @流程名称 时，不得只凭 patrol_list 的文本自行判断；必须调用 patrol_resolve_flow。
- ChatGPT 输入框中的 Patrol 流程引用会序列化为 @flow:<inspectionId>。它与稳定 inspectionId 完全等价；解析或执行时必须直接使用其中 inspectionId，不要把 flow: 当成流程名称的一部分。
- patrol_resolve_flow 对 inspectionId 做精确匹配，也会对流程显示名称做 NFKC、首尾空白和连续空白归一化后的精确匹配。只要显示名称精确匹配，就必须回答“找到了”；如果有多个同名流程，必须明确说“找到多个同名流程”并列出 inspectionId，不能说“没有完全匹配”。
- 用户说“运行/执行/走一遍/巡检/重放”一个已有流程时，直接调用 patrol_run_flow。patrol_run_flow 对 READY 和非空 DRAFT 都是只读重放：会产生新的巡检 run/report，但绝不能向 Runbook 追加步骤。
- 用户明确要求批量巡检、串行巡检，或一次请求中要求执行多个已有流程时，必须一次调用 patrol_run_batch，并按用户给出的顺序传入 flows。不要让模型自行连续调用多个 patrol_run_flow。批量 V1 固定串行（concurrency=1），单个流程失败后继续后续流程；遇到 waiting/checkpoint 时暂停整个批次并用 patrol_resume_batch 继续。
- patrol_run_flow / patrol_run_batch 的业务状态即使是 passed，也可能包含 skipped 步骤或 warnings（例如最终截图产物抓取失败）。最终答复必须显式说明这些非致命问题，不能只根据 passed 状态概括为“全部正常”或“全部通过且无异常”。
- 多个 @flow:<inspectionId> 可以作为 patrol_run_batch 的 flows。UI 多选同样会提交稳定 inspectionId，因此批量执行前必须先完整解析并预检全部流程，任何缺失/歧义/空流程都必须在第一个流程启动前报错。
- 绝对禁止为了“运行已有 DRAFT 流程”而依次调用 patrol_navigate、patrol_login_state、patrol_screenshot、patrol_read_page、patrol_click、patrol_type_* 等教学/记录工具。这些工具在 DRAFT 上的职责是编辑/教学，会追加步骤；它们不是已有流程的 replay API。
- patrol_select_flow 只表示选择/查看上下文，不代表开始教学，也不代表执行。用户只是要运行已有流程时不需要先 select；解析后直接 patrol_run_flow 或 patrol_run_batch。
- 只有用户明确说“修改流程、继续教学、重教、调整步骤、修复 Runbook”时，才允许修改 Runbook。对“在已有步骤前/后新增等待、截图、点击、读取等步骤”的请求，优先使用 patrol_insert_browser_step 做结构化插入；它不依赖 CURRENT 页面。不要为了把新步骤写进流程而直接调用 patrol_wait、patrol_screenshot、patrol_click 等教学工具，因为这些工具会先操作 CURRENT 页面再追加到尾部，页面不在目标位置时会产生错误试教。
- 编辑已有流程时，patrol_run_flow / patrol_run_batch 只用于用户明确发起的正式巡检，禁止把它们当成内部调试器。完成结构修改后使用 patrol_validate 做端到端校验；validation/teaching 运行属于内部编辑诊断，不进入正式“巡检记录”。如果校验失败，只修复失败原因并再次 patrol_validate，不要为了探测状态反复创建正式巡检。
- 已登录会话下的登录前置步骤可能被 replay 自动跳过；密码/短信验证码如果是 browser_type_transient_ref 也属于登录前置的一部分，不要因为当前页面已经登录就擅自重写整个流程。
- Dashboard 的“运行”按钮会把稳定 inspectionId 直接提交到对话；收到这类请求后直接 patrol_run_flow，不要再次改写流程。
- @流程名称、@flow:<inspectionId> 与普通自然语言流程名称遵循相同解析规则。若名称唯一可直接使用；若同名冲突则要求用户选择 inspectionId，除非请求本身已经携带稳定 inspectionId。`

export type FlowMatchKind = 'exact-id' | 'exact-name' | 'partial'
export interface FlowReferenceMatch {
  kind: FlowMatchKind
  definition: InspectionDefinition
}
export interface FlowReferenceAmbiguous {
  kind: 'ambiguous'
  matches: InspectionDefinition[]
}
export interface FlowReferenceMissing {
  kind: 'missing'
}
export type FlowReferenceResult = FlowReferenceMatch | FlowReferenceAmbiguous | FlowReferenceMissing

export interface ResolvedBatchFlow {
  reference: string
  definition: InspectionDefinition
}

interface BatchItemResult {
  order: number
  flowId: string
  flowName: string
  status: 'passed' | 'failed' | 'waiting'
  runId?: string
  report?: string
  json?: string
  error?: string
  skippedSteps?: Array<{
    stepId: string
    name: string
    reason?: string
  }>
  warnings?: string[]
}

interface BatchState {
  schemaVersion: 1
  batchRunId: string
  mode: 'serial'
  startedAt: string
  updatedAt: string
  status: 'running' | 'waiting' | 'passed' | 'failed'
  workspaceRoot?: string
  currentIndex: number
  flows: Array<{
    id: string
    name: string
    definitionUpdatedAt: string
  }>
  results: BatchItemResult[]
}

export function normalizeFlowReference(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^@\s*/, '')
    .replace(/^flow\s*:\s*/i, '')
    .trim()
    .replace(/\s+/g, ' ')
    .toLocaleLowerCase('en-US')
}

export function resolveFlowReference(
  definitions: readonly InspectionDefinition[],
  query: string,
  workspaceRoot?: string,
): FlowReferenceResult {
  const normalized = normalizeFlowReference(query)
  if (!normalized) return { kind: 'missing' }

  // Stable IDs are global identifiers, so never hide an exact ID merely
  // because the current workspace contains other Patrol definitions.
  const exactId = definitions.filter(item => normalizeFlowReference(item.id) === normalized)
  if (exactId.length === 1) return { kind: 'exact-id', definition: exactId[0]! }
  if (exactId.length > 1) return { kind: 'ambiguous', matches: sortMatches(exactId) }

  const exactName = preferWorkspaceMatches(
    definitions.filter(item => normalizeFlowReference(item.name) === normalized),
    workspaceRoot,
  )
  if (exactName.length === 1) return { kind: 'exact-name', definition: exactName[0]! }
  if (exactName.length > 1) return { kind: 'ambiguous', matches: sortMatches(exactName) }

  const partial = preferWorkspaceMatches(definitions.filter(item => {
    const id = normalizeFlowReference(item.id)
    const name = normalizeFlowReference(item.name)
    return id.includes(normalized) || name.includes(normalized) || normalized.includes(name)
  }), workspaceRoot)
  if (partial.length === 1) return { kind: 'partial', definition: partial[0]! }
  if (partial.length > 1) return { kind: 'ambiguous', matches: sortMatches(partial) }
  return { kind: 'missing' }
}

export function resolveBatchFlowReferences(
  definitions: readonly InspectionDefinition[],
  queries: readonly string[],
  workspaceRoot?: string,
): ResolvedBatchFlow[] {
  if (queries.length === 0) throw new Error('batch patrol requires at least one flow')
  if (queries.length > 50) throw new Error('batch patrol supports at most 50 flows per run')

  const resolved: ResolvedBatchFlow[] = []
  const seen = new Set<string>()
  for (const raw of queries) {
    const reference = String(raw ?? '').trim()
    if (!reference) throw new Error('batch patrol contains an empty flow reference')
    const definition = requireUniqueResolution(reference, resolveFlowReference(definitions, reference, workspaceRoot))
    if (definition.steps.length === 0) throw new Error(`inspection ${definition.id} has no reusable steps`)
    if (seen.has(definition.id)) throw new Error(`batch patrol contains duplicate flow ${definition.id}`)
    seen.add(definition.id)
    resolved.push({ reference, definition })
  }
  return resolved
}

export function registerPatrolFlowReferenceTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const resolveFlow = defineTool({
    name: 'patrol_resolve_flow',
    description: 'Resolve an existing Patrol flow deterministically from a stable inspectionId, a human-visible flow name, @flow-name, or native @flow:<inspectionId> reference. Use this instead of interpreting patrol_list text when the user names a flow.',
    parameters: {
      flow: { type: 'string', required: true, description: 'Stable inspectionId, display name, @display-name, or @flow:<inspectionId>.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definitions = await store.list()
      const result = resolveFlowReference(definitions, args.flow, exec.agent?.session.header.cwd)
      return renderResolution(args.flow, result)
    },
  })

  const runFlow = defineTool({
    name: 'patrol_run_flow',
    description: 'Run/replay one existing non-empty Patrol flow by id, display name, @name, or native @flow:<inspectionId> without teaching or appending steps. READY and DRAFT are both supported; DRAFT is executed as a read-only preview and remains DRAFT. Use patrol_run_batch instead when the user requests multiple flows.',
    parameters: {
      flow: { type: 'string', required: true, description: 'Stable inspectionId, display name, @display-name, or @flow:<inspectionId>.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definitions = await store.list()
      const result = resolveFlowReference(definitions, args.flow, exec.agent?.session.header.cwd)
      const definition = requireUniqueResolution(args.flow, result)
      if (definition.steps.length === 0) throw new Error(`inspection ${definition.id} has no reusable steps`)

      const { report, paths } = await runExistingFlowReadOnly(definition, store, runner, exec, false)
      return renderRunResult(definition, report, paths)
    },
  })

  const resumeFlow = defineTool({
    name: 'patrol_resume_flow',
    description: 'Resume a waiting run started by patrol_run_flow. Works for READY and DRAFT flows and does not append teaching steps.',
    parameters: {
      flow: { type: 'string', required: true, description: 'Stable inspectionId, display name, @display-name, or @flow:<inspectionId>.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definitions = await store.list()
      const result = resolveFlowReference(definitions, args.flow, exec.agent?.session.header.cwd)
      const definition = requireUniqueResolution(args.flow, result)
      const { report, paths } = await runExistingFlowReadOnly(definition, store, runner, exec, true)
      return renderRunResult(definition, report, paths)
    },
  })

  const runBatch = defineTool({
    name: 'patrol_run_batch',
    description: 'Run multiple existing Patrol flows as one serial batch in the supplied order. V1 is fixed to serial concurrency=1. All flows are resolved and preflighted before the first starts. A failed flow is recorded and the batch continues; a waiting/checkpoint flow pauses the whole batch for patrol_resume_batch.',
    parameters: {
      flows: {
        type: 'array',
        required: true,
        items: { type: 'string' },
        description: 'Ordered flow references. Stable inspectionIds and @flow:<inspectionId> are preferred. Selection order is execution order.',
      },
      mode: { type: 'string', description: 'Batch execution mode. V1 supports only serial.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      if (!Array.isArray(args.flows)) throw new Error('flows must be an array')
      const flowQueries = args.flows.map((value, index) => {
        if (typeof value !== 'string') throw new Error(`flows[${index}] must be a string`)
        return value
      })
      const mode = String(args.mode ?? 'serial').trim().toLowerCase()
      if (mode !== 'serial') throw new Error('batch patrol V1 supports only mode=serial (concurrency=1)')
      const definitions = await store.list()
      const resolved = resolveBatchFlowReferences(definitions, flowQueries, exec.agent?.session.header.cwd)

      // Full preflight is deliberate: do not start flow #1 if flow #N is
      // missing, ambiguous, empty, or already paused at a checkpoint.
      for (const item of resolved) {
        const pending = await store.loadResume(item.definition.id)
        if (pending !== undefined) {
          throw new Error(`inspection ${item.definition.id} has a pending checkpoint in run ${pending.runId}; resume/finish it before starting this batch`)
        }
      }

      const now = new Date().toISOString()
      const state: BatchState = {
        schemaVersion: 1,
        batchRunId: `batch-${now.replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`,
        mode: 'serial',
        startedAt: now,
        updatedAt: now,
        status: 'running',
        ...(exec.agent?.session.header.cwd === undefined ? {} : { workspaceRoot: exec.agent.session.header.cwd }),
        currentIndex: 0,
        flows: resolved.map(item => ({
          id: item.definition.id,
          name: item.definition.name,
          definitionUpdatedAt: item.definition.metadata.updatedAt,
        })),
        results: [],
      }
      await saveBatchState(store, state)
      const completed = await continueSerialBatch(state, store, runner, exec, false)
      const paths = await saveBatchSummary(store, completed)
      return renderBatchResult(completed, paths)
    },
  })

  const resumeBatch = defineTool({
    name: 'patrol_resume_batch',
    description: 'Resume a serial batch paused because its current Patrol flow reached a checkpoint. The current flow is resumed first; remaining flows then continue serially. Single-flow patrol_run_flow/patrol_resume_flow behavior is unchanged.',
    parameters: {
      batchRunId: { type: 'string', required: true, description: 'batchRunId returned by patrol_run_batch when the batch is waiting.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const batchRunId = String(args.batchRunId ?? '').trim()
      assertBatchRunId(batchRunId)
      const state = await loadBatchState(store, batchRunId)
      if (state.status !== 'waiting') throw new Error(`batch ${batchRunId} is ${state.status}; only waiting batches can be resumed`)
      if (state.currentIndex < 0 || state.currentIndex >= state.flows.length) throw new Error(`batch ${batchRunId} has an invalid current index`)

      // Validate every remaining definition before resuming the current one so
      // a later edited/deleted flow cannot cause a surprise after browser work starts.
      for (let index = state.currentIndex; index < state.flows.length; index += 1) {
        const snapshot = state.flows[index]!
        const definition = await store.load(snapshot.id)
        if (definition.metadata.updatedAt !== snapshot.definitionUpdatedAt) {
          throw new Error(`inspection ${definition.id} changed after batch ${batchRunId} started; create a new batch instead of resuming stale steps`)
        }
        if (definition.steps.length === 0) throw new Error(`inspection ${definition.id} has no reusable steps`)
      }

      const completed = await continueSerialBatch(state, store, runner, exec, true)
      const paths = await saveBatchSummary(store, completed)
      return renderBatchResult(completed, paths)
    },
  })

  const disposers = [resolveFlow, runFlow, resumeFlow, runBatch, resumeBatch].map(tool => ctx.tools.register(tool))
  return () => { for (const dispose of disposers) dispose() }
}

async function runExistingFlowReadOnly(
  definition: InspectionDefinition,
  store: PatrolStore,
  runner: PatrolRunner,
  exec: Parameters<PatrolRunner['run']>[1],
  resume: boolean,
): Promise<{ report: RunReport; paths: SavedRunPaths }> {
  const beforeSteps = JSON.stringify(definition.steps)
  const beforeUpdatedAt = definition.metadata.updatedAt
  const executionDefinition = cloneForReadOnlyReplay(definition, exec.agent?.session.header.cwd)
  const result = resume
    ? await runner.resume(executionDefinition, exec)
    : await runner.run(executionDefinition, exec)

  // Replay is a hard non-mutation boundary. runner.run/resume may update
  // workspaceRoot as execution metadata, but it must not rewrite the reusable
  // step graph or semantic updatedAt timestamp.
  const stored = await store.load(definition.id)
  if (JSON.stringify(stored.steps) !== beforeSteps || stored.metadata.updatedAt !== beforeUpdatedAt) {
    throw new Error(
      `non-mutating ${resume ? 'resume' : 'replay'} invariant violated for ${definition.id}: the stored Runbook changed during execution`,
    )
  }
  return result
}

async function continueSerialBatch(
  state: BatchState,
  store: PatrolStore,
  runner: PatrolRunner,
  exec: Parameters<PatrolRunner['run']>[1],
  resumeCurrent: boolean,
): Promise<BatchState> {
  state.status = 'running'
  state.updatedAt = new Date().toISOString()
  await saveBatchState(store, state)

  for (let index = state.currentIndex; index < state.flows.length; index += 1) {
    const snapshot = state.flows[index]!
    let report: RunReport | undefined
    let paths: SavedRunPaths | undefined
    let errorText: string | undefined

    try {
      const definition = await store.load(snapshot.id)
      if (definition.metadata.updatedAt !== snapshot.definitionUpdatedAt) {
        throw new Error(`inspection ${definition.id} changed after batch ${state.batchRunId} started`)
      }
      const result = await runExistingFlowReadOnly(
        definition,
        store,
        runner,
        exec,
        resumeCurrent && index === state.currentIndex,
      )
      report = result.report
      paths = result.paths
    } catch (error) {
      errorText = error instanceof Error ? error.message : String(error)
    }

    if (errorText !== undefined) {
      upsertBatchResult(state, {
        order: index + 1,
        flowId: snapshot.id,
        flowName: snapshot.name,
        status: 'failed',
        error: errorText,
      })
      state.currentIndex = index + 1
      state.updatedAt = new Date().toISOString()
      await saveBatchState(store, state)
      await saveBatchSummary(store, state)
      resumeCurrent = false
      continue
    }

    if (report === undefined || paths === undefined) throw new Error(`batch ${state.batchRunId} lost run result for ${snapshot.id}`)
    const skippedSteps = report.results
      .filter(result => result.status === 'skipped')
      .map(result => {
        const reason = result.error ?? result.output
        return {
          stepId: result.stepId,
          name: result.name,
          ...(reason === undefined ? {} : { reason }),
        }
      })
    const item: BatchItemResult = {
      order: index + 1,
      flowId: snapshot.id,
      flowName: snapshot.name,
      status: report.status,
      runId: report.runId,
      report: paths.markdown,
      json: paths.json,
      ...(skippedSteps.length === 0 ? {} : { skippedSteps }),
      ...(report.warnings === undefined || report.warnings.length === 0 ? {} : { warnings: [...report.warnings] }),
    }
    upsertBatchResult(state, item)

    if (report.status === 'waiting') {
      state.currentIndex = index
      state.status = 'waiting'
      state.updatedAt = new Date().toISOString()
      await saveBatchState(store, state)
      await saveBatchSummary(store, state)
      return state
    }

    state.currentIndex = index + 1
    state.updatedAt = new Date().toISOString()
    await saveBatchState(store, state)
    await saveBatchSummary(store, state)
    resumeCurrent = false
  }

  state.status = state.results.some(item => item.status === 'failed') ? 'failed' : 'passed'
  state.currentIndex = state.flows.length
  state.updatedAt = new Date().toISOString()
  await saveBatchState(store, state)
  await saveBatchSummary(store, state)
  return state
}

function upsertBatchResult(state: BatchState, result: BatchItemResult): void {
  const index = state.results.findIndex(item => item.order === result.order)
  if (index >= 0) state.results[index] = result
  else state.results.push(result)
  state.results.sort((left, right) => left.order - right.order)
}

function batchDirectory(store: PatrolStore, batchRunId: string): string {
  assertBatchRunId(batchRunId)
  return join(store.root, 'batches', batchRunId)
}

function batchStatePath(store: PatrolStore, batchRunId: string): string {
  return join(batchDirectory(store, batchRunId), 'state.json')
}

async function saveBatchState(store: PatrolStore, state: BatchState): Promise<void> {
  state.updatedAt = new Date().toISOString()
  await atomicWrite(batchStatePath(store, state.batchRunId), `${JSON.stringify(state, null, 2)}\n`)
}

async function loadBatchState(store: PatrolStore, batchRunId: string): Promise<BatchState> {
  const parsed = JSON.parse(await readFile(batchStatePath(store, batchRunId), 'utf8')) as BatchState
  if (parsed.schemaVersion !== 1 || parsed.batchRunId !== batchRunId || parsed.mode !== 'serial' || !Array.isArray(parsed.flows) || !Array.isArray(parsed.results)) {
    throw new Error(`batch ${batchRunId} state is invalid`)
  }
  return parsed
}

async function saveBatchSummary(
  store: PatrolStore,
  state: BatchState,
): Promise<{ directory: string; json: string; markdown: string }> {
  const internalDirectory = batchDirectory(store, state.batchRunId)
  const summary = batchSummaryObject(state)
  const markdown = renderBatchMarkdown(state)
  await atomicWrite(join(internalDirectory, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`)
  await atomicWrite(join(internalDirectory, 'summary.md'), markdown)

  if (state.workspaceRoot === undefined || state.workspaceRoot.trim() === '') {
    return {
      directory: internalDirectory,
      json: join(internalDirectory, 'summary.json'),
      markdown: join(internalDirectory, 'summary.md'),
    }
  }

  const visibleDirectory = join(state.workspaceRoot, 'patrol-results', 'batches', state.batchRunId)
  const json = join(visibleDirectory, 'summary.json')
  const markdownPath = join(visibleDirectory, 'summary.md')
  await atomicWrite(json, `${JSON.stringify(summary, null, 2)}\n`)
  await atomicWrite(markdownPath, markdown)
  return { directory: visibleDirectory, json, markdown: markdownPath }
}

function batchSummaryObject(state: BatchState): Record<string, unknown> {
  const passed = state.results.filter(item => item.status === 'passed').length
  const failed = state.results.filter(item => item.status === 'failed').length
  const waiting = state.results.filter(item => item.status === 'waiting').length
  return {
    schemaVersion: 1,
    batchRunId: state.batchRunId,
    mode: state.mode,
    concurrency: 1,
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    status: state.status,
    totalFlows: state.flows.length,
    completedFlows: passed + failed,
    passedFlows: passed,
    failedFlows: failed,
    waitingFlows: waiting,
    currentIndex: state.currentIndex,
    flows: state.flows,
    results: state.results,
  }
}

function renderBatchMarkdown(state: BatchState): string {
  const passed = state.results.filter(item => item.status === 'passed').length
  const failed = state.results.filter(item => item.status === 'failed').length
  const waiting = state.results.filter(item => item.status === 'waiting').length
  const lines = [
    '# DSH Patrol 批量巡检报告',
    '',
    `- Batch: \`${state.batchRunId}\``,
    '- 执行模式: 串行（concurrency=1）',
    `- 状态: ${state.status}`,
    `- 流程总数: ${state.flows.length}`,
    `- 成功: ${passed}`,
    `- 失败: ${failed}`,
    `- 等待人工处理: ${waiting}`,
    `- 开始时间: ${state.startedAt}`,
    `- 最近更新: ${state.updatedAt}`,
    '',
    '## 执行顺序与结果',
    '',
  ]
  for (let index = 0; index < state.flows.length; index += 1) {
    const flow = state.flows[index]!
    const result = state.results.find(item => item.order === index + 1)
    const status = result?.status ?? (index < state.currentIndex ? 'unknown' : 'pending')
    lines.push(`${index + 1}. **${flow.name}** (\`${flow.id}\`) — ${status}`)
    if (result?.runId) lines.push(`   - runId: \`${result.runId}\``)
    if (result?.report) lines.push(`   - report: \`${result.report}\``)
    if (result?.error) lines.push(`   - error: ${result.error}`)
    const skippedReasons = new Set<string>()
    if ((result?.skippedSteps?.length ?? 0) > 0) lines.push(`   - 跳过步骤: ${result?.skippedSteps?.length ?? 0}`)
    for (const step of result?.skippedSteps ?? []) {
      if (step.reason !== undefined) skippedReasons.add(step.reason)
      lines.push(`     - ${step.name} (\`${step.stepId}\`)${step.reason === undefined ? '' : `: ${step.reason}`}`)
    }
    for (const warning of result?.warnings ?? []) {
      if (!skippedReasons.has(warning)) lines.push(`   - 警告: ${warning}`)
    }
  }
  lines.push('')
  if (state.status === 'waiting') {
    lines.push(`> 批次已暂停在第 ${state.currentIndex + 1} 个流程。完成当前人工检查点后，使用 \`patrol_resume_batch\` 和 batchRunId \`${state.batchRunId}\` 继续。`, '')
  }
  return `${lines.join('\n')}\n`
}

function renderBatchResult(
  state: BatchState,
  paths: { directory: string; json: string; markdown: string },
): string {
  const passed = state.results.filter(item => item.status === 'passed').length
  const failed = state.results.filter(item => item.status === 'failed').length
  const waiting = state.results.filter(item => item.status === 'waiting').length
  const lines = [
    `Batch patrol ${state.batchRunId}: mode=serial; concurrency=1; status=${state.status}`,
    `flows=${state.flows.length}; passed=${passed}; failed=${failed}; waiting=${waiting}`,
    ...state.flows.flatMap((flow, index) => {
      const result = state.results.find(item => item.order === index + 1)
      const status = result?.status ?? 'pending'
      const detail = result?.runId ? ` runId=${result.runId}` : (result?.error ? ` error=${result.error}` : '')
      const skippedCount = result?.skippedSteps?.length ?? 0
      const warningCount = result?.warnings?.length ?? 0
      const headline = `${index + 1}. ${flow.id} (${flow.name}) => ${status}${detail}${skippedCount > 0 ? ` skipped=${skippedCount}` : ''}${warningCount > 0 ? ` warnings=${warningCount}` : ''}`
      const notices = [headline]
      const skippedReasons = new Set<string>()
      for (const step of result?.skippedSteps ?? []) {
        if (step.reason !== undefined) skippedReasons.add(step.reason)
        notices.push(`   skippedStep=${step.stepId} (${step.name})${step.reason === undefined ? '' : `: ${step.reason}`}`)
      }
      for (const warning of result?.warnings ?? []) {
        if (!skippedReasons.has(warning)) notices.push(`   warning=${warning}`)
      }
      return notices
    }),
    `batchReport=${paths.markdown}`,
    `batchJson=${paths.json}`,
  ]
  if (state.status === 'waiting') {
    lines.push(`Batch paused at flow ${state.currentIndex + 1}/${state.flows.length}. After the checkpoint is completed, call patrol_resume_batch with batchRunId=${state.batchRunId}.`)
  }
  return lines.join('\n')
}

function assertBatchRunId(value: string): void {
  if (!/^batch-[A-Za-z0-9._-]+$/.test(value)) throw new Error('invalid batchRunId')
}

async function atomicWrite(path: string, content: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(temp, content, { encoding: 'utf8', mode: 0o600 })
  await rename(temp, path)
}

function preferWorkspaceMatches(
  matches: readonly InspectionDefinition[],
  workspaceRoot?: string,
): InspectionDefinition[] {
  if (!workspaceRoot || matches.length <= 1) return [...matches]
  const workspace = normalizeWorkspace(workspaceRoot)
  const local = matches.filter(item => normalizeWorkspace(item.metadata.workspaceRoot) === workspace)
  return local.length > 0 ? local : [...matches]
}

function normalizeWorkspace(value?: string): string {
  if (!value) return ''
  return value.trim().replace(/\\/g, '/').replace(/\/+$/, '').toLocaleLowerCase('en-US')
}

function sortMatches(matches: readonly InspectionDefinition[]): InspectionDefinition[] {
  return [...matches].sort((left, right) => {
    const updated = String(right.metadata.updatedAt).localeCompare(String(left.metadata.updatedAt))
    if (updated !== 0) return updated
    return left.id.localeCompare(right.id)
  })
}

function renderResolution(query: string, result: FlowReferenceResult): string {
  if (result.kind === 'missing') {
    return `NO_MATCH: no Patrol flow matched ${JSON.stringify(query)} by id or display name.`
  }
  if (result.kind === 'ambiguous') {
    return [
      `AMBIGUOUS: found ${result.matches.length} matching Patrol flows for ${JSON.stringify(query)}.`,
      ...result.matches.map(item => `- ${item.id}\t${item.status}\t${item.steps.length} steps\t${item.name}`),
      'Ask for/select a stable inspectionId unless the request already provides one.',
    ].join('\n')
  }
  const item = result.definition
  return [
    `MATCH: ${result.kind}`,
    `inspectionId=${item.id}`,
    `name=${item.name}`,
    `status=${item.status}`,
    `steps=${item.steps.length}`,
    `updatedAt=${item.metadata.updatedAt}`,
  ].join('\n')
}

function requireUniqueResolution(query: string, result: FlowReferenceResult): InspectionDefinition {
  if (result.kind === 'missing') throw new Error(`no Patrol flow matched ${JSON.stringify(query)}`)
  if (result.kind === 'ambiguous') {
    throw new Error([
      `flow reference ${JSON.stringify(query)} is ambiguous; matching inspectionIds:`,
      ...result.matches.map(item => `${item.id} (${item.name})`),
    ].join(' '))
  }
  return result.definition
}

export function cloneForReadOnlyReplay(definition: InspectionDefinition, workspaceRoot?: string): InspectionDefinition {
  const cloned = cloneDefinition(definition)
  // PatrolRunner normally remembers the interactive workspace through
  // store.save(). During patrol_run_flow/patrol_resume_flow that write can pass
  // through the DRAFT teaching filter and prune steps after a checklist edit,
  // violating replay's read-only contract. Seed only the execution clone.
  if (workspaceRoot !== undefined && workspaceRoot.trim() !== '') cloned.metadata.workspaceRoot = workspaceRoot
  return cloned
}

function cloneDefinition(definition: InspectionDefinition): InspectionDefinition {
  return JSON.parse(JSON.stringify(definition)) as InspectionDefinition
}

function renderRunResult(
  definition: InspectionDefinition,
  report: RunReport,
  paths: SavedRunPaths,
): string {
  const passed = report.results.filter(item => item.status === 'passed').length
  const failed = report.results.filter(item => item.status === 'failed').length
  const waiting = report.results.filter(item => item.status === 'waiting').length
  const skipped = report.results.filter(item => item.status === 'skipped')
  const skippedReasons = new Set<string>()
  const skippedLines = skipped.map(item => {
    const reason = item.error ?? item.output
    if (reason !== undefined) skippedReasons.add(reason)
    return `skippedStep=${item.stepId} (${item.name})${reason === undefined ? '' : `: ${reason}`}`
  })
  const warningLines = (report.warnings ?? [])
    .filter(warning => !skippedReasons.has(warning))
    .map(warning => `warning=${warning}`)
  return [
    `Executed existing flow ${definition.id} (${definition.name}) without changing its ${definition.steps.length} Runbook steps.`,
    `flowStatus=${definition.status}${definition.status === 'draft' ? ' (read-only preview)' : ''}`,
    `runId=${report.runId}`,
    `runStatus=${report.status}`,
    `steps=${passed} passed, ${failed} failed, ${waiting} waiting, ${skipped.length} skipped, ${report.results.length} total`,
    ...skippedLines,
    ...warningLines,
    `report=${paths.markdown}`,
    `json=${paths.json}`,
  ].join('\n')
}
