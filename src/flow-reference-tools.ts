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
- patrol_resolve_flow 对 inspectionId 做精确匹配，也会对流程显示名称做 NFKC、首尾空白和连续空白归一化后的精确匹配。只要显示名称精确匹配，就必须回答“找到了”；如果有多个同名流程，必须明确说“找到多个同名流程”并列出 inspectionId，不能说“没有完全匹配”。
- 用户说“运行/执行/走一遍/巡检/重放”一个已有流程时，直接调用 patrol_run_flow。patrol_run_flow 对 READY 和非空 DRAFT 都是只读重放：会产生新的巡检 run/report，但绝不能向 Runbook 追加步骤。
- 绝对禁止为了“运行已有 DRAFT 流程”而依次调用 patrol_navigate、patrol_login_state、patrol_screenshot、patrol_read_page、patrol_click、patrol_type_* 等教学/记录工具。这些工具在 DRAFT 上的职责是编辑/教学，会追加步骤；它们不是已有流程的 replay API。
- patrol_select_flow 只表示选择/查看上下文，不代表开始教学，也不代表执行。用户只是要运行已有流程时不需要先 select；解析后直接 patrol_run_flow。
- 只有用户明确说“修改流程、继续教学、重教、调整步骤、修复 Runbook”时，才允许对 DRAFT 使用会记录步骤的 patrol_* 动作工具。
- Dashboard 的“运行”按钮会把稳定 inspectionId 直接提交到对话；收到这类请求后直接 patrol_run_flow，不要再次改写流程。
- @流程名称 与普通自然语言流程名称遵循相同解析规则。若名称唯一可直接使用；若同名冲突则要求用户选择 inspectionId，除非请求本身已经携带稳定 inspectionId。`

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

export function normalizeFlowReference(value: string): string {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .replace(/^@\s*/, '')
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

export function registerPatrolFlowReferenceTools(
  ctx: Context,
  store: PatrolStore,
  runner: PatrolRunner,
): () => void {
  const resolveFlow = defineTool({
    name: 'patrol_resolve_flow',
    description: 'Resolve an existing Patrol flow deterministically from a stable inspectionId, a human-visible flow name, or @flow-name. Use this instead of interpreting patrol_list text when the user names a flow.',
    parameters: {
      flow: { type: 'string', required: true, description: 'Stable inspectionId, display name, or @display-name.' },
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
    description: 'Run/replay an existing non-empty Patrol flow by id, display name, or @name without teaching or appending steps. READY and DRAFT are both supported; DRAFT is executed as a read-only preview and remains DRAFT.',
    parameters: {
      flow: { type: 'string', required: true, description: 'Stable inspectionId, display name, or @display-name.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definitions = await store.list()
      const result = resolveFlowReference(definitions, args.flow, exec.agent?.session.header.cwd)
      const definition = requireUniqueResolution(args.flow, result)
      if (definition.steps.length === 0) throw new Error(`inspection ${definition.id} has no reusable steps`)

      const beforeSteps = JSON.stringify(definition.steps)
      const beforeUpdatedAt = definition.metadata.updatedAt
      const executionDefinition = cloneDefinition(definition)
      const { report, paths } = await runner.run(executionDefinition, exec)

      // Replay is a hard non-mutation boundary. runner.run may update workspaceRoot
      // as execution metadata, but it must not rewrite the reusable step graph.
      const stored = await store.load(definition.id)
      if (JSON.stringify(stored.steps) !== beforeSteps || stored.metadata.updatedAt !== beforeUpdatedAt) {
        throw new Error(
          `non-mutating replay invariant violated for ${definition.id}: the stored Runbook changed during patrol_run_flow`,
        )
      }

      return renderRunResult(definition, report, paths)
    },
  })

  const resumeFlow = defineTool({
    name: 'patrol_resume_flow',
    description: 'Resume a waiting run started by patrol_run_flow. Works for READY and DRAFT flows and does not append teaching steps.',
    parameters: {
      flow: { type: 'string', required: true, description: 'Stable inspectionId, display name, or @display-name.' },
    },
    output: TEXT_OUTPUT,
    async execute(args, exec) {
      const definitions = await store.list()
      const result = resolveFlowReference(definitions, args.flow, exec.agent?.session.header.cwd)
      const definition = requireUniqueResolution(args.flow, result)
      const beforeSteps = JSON.stringify(definition.steps)
      const beforeUpdatedAt = definition.metadata.updatedAt
      const { report, paths } = await runner.resume(cloneDefinition(definition), exec)
      const stored = await store.load(definition.id)
      if (JSON.stringify(stored.steps) !== beforeSteps || stored.metadata.updatedAt !== beforeUpdatedAt) {
        throw new Error(
          `non-mutating resume invariant violated for ${definition.id}: the stored Runbook changed during patrol_resume_flow`,
        )
      }
      return renderRunResult(definition, report, paths)
    },
  })

  const disposers = [resolveFlow, runFlow, resumeFlow].map(tool => ctx.tools.register(tool))
  return () => { for (const dispose of disposers) dispose() }
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
  return [
    `Executed existing flow ${definition.id} (${definition.name}) without changing its ${definition.steps.length} Runbook steps.`,
    `flowStatus=${definition.status}${definition.status === 'draft' ? ' (read-only preview)' : ''}`,
    `runId=${report.runId}`,
    `runStatus=${report.status}`,
    `steps=${passed} passed, ${failed} failed, ${waiting} waiting, ${report.results.length} total`,
    `report=${paths.markdown}`,
    `json=${paths.json}`,
  ].join('\n')
}
