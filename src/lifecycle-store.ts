import { compactTeachingFlow, type FlowCompactionResult } from './flow-optimizer.js'
import { redactLikelySecrets } from './security.js'
import { PatrolStore } from './store.js'
import type { InspectionDefinition, RunArtifact, RunReport, StepRunResult } from './types.js'

interface ActiveTeachingRun {
  runId: string
  startedAt: string
  workspaceRoot?: string
  stepData: Map<string, TeachingStepData>
}

interface TeachingStepData {
  output?: string
  artifacts: RunArtifact[]
}

/**
 * Store variant used by the Patrol runtime.
 *
 * Interactive teaching is a real patrol from the moment the user starts it,
 * not only after a draft is eventually confirmed. A WAITING run is therefore
 * created as soon as the first new teaching step is recorded and the same run
 * is updated throughout the conversation. A later DRAFT -> READY transition
 * compacts the reusable runbook and finalizes that same record as PASSED.
 */
export class PatrolLifecycleStore extends PatrolStore {
  private readonly activeTeachingRuns = new Map<string, ActiveTeachingRun>()

  async beginTeachingRun(inspectionId: string, workspaceRoot?: string): Promise<RunReport> {
    const definition = await this.load(inspectionId)
    if (definition.status !== 'draft') {
      throw new Error(`inspection ${inspectionId} is ${definition.status}; interactive teaching requires a draft`)
    }

    const existing = this.activeTeachingRuns.get(inspectionId)
    if (existing !== undefined) {
      if (existing.workspaceRoot === undefined && workspaceRoot !== undefined && workspaceRoot.trim() !== '') {
        existing.workspaceRoot = workspaceRoot
      }
      return await this.writePendingTeachingReport(definition, existing)
    }

    const startedAt = new Date().toISOString()
    const active: ActiveTeachingRun = {
      runId: teachingRunId(startedAt),
      startedAt,
      stepData: new Map(),
      ...(workspaceRoot === undefined || workspaceRoot.trim() === '' ? {} : { workspaceRoot }),
    }
    this.activeTeachingRuns.set(inspectionId, active)
    return await this.writePendingTeachingReport(definition, active)
  }

  override async save(definition: InspectionDefinition): Promise<void> {
    let previous: InspectionDefinition | undefined
    if (await this.exists(definition.id)) previous = await this.load(definition.id)

    const completingTeaching = previous?.status === 'draft' && definition.status === 'ready'
    let active = this.activeTeachingRuns.get(definition.id)

    // Existing drafts are commonly reused in a new conversation. The first
    // successfully recorded step is sufficient evidence that a new patrol has
    // actually started, so create its WAITING history row immediately instead
    // of waiting for patrol_confirm.
    if (definition.status === 'draft' && active === undefined && hasNewTeachingStep(previous, definition)) {
      const firstNewStepIndex = previous?.steps.length ?? 0
      const firstNewStep = definition.steps[firstNewStepIndex]
      const startedAt = firstNewStep?.recordedAt || new Date().toISOString()
      active = {
        runId: teachingRunId(startedAt),
        startedAt,
        stepData: new Map(),
        ...(definition.metadata.workspaceRoot === undefined ? {} : { workspaceRoot: definition.metadata.workspaceRoot }),
      }
      this.activeTeachingRuns.set(definition.id, active)
    }

    let compaction: FlowCompactionResult | undefined
    if (completingTeaching) {
      compaction = compactTeachingFlow(definition)
      definition.metadata.updatedAt = new Date().toISOString()
    }

    await super.save(definition)

    if (completingTeaching) {
      const report = createTeachingReport(definition, compaction!, active)
      await super.saveRun(
        report,
        renderTeachingReport(report, compaction!),
        active?.workspaceRoot ?? definition.metadata.workspaceRoot,
      )
      this.activeTeachingRuns.delete(definition.id)
      return
    }

    if (definition.status === 'draft' && active !== undefined) {
      if (active.workspaceRoot === undefined && definition.metadata.workspaceRoot !== undefined) {
        active.workspaceRoot = definition.metadata.workspaceRoot
      }
      await this.writePendingTeachingReport(definition, active)
    }
  }

  async recordTeachingStepResult(
    inspectionId: string,
    stepId: string,
    update: { output?: string; artifacts?: RunArtifact[]; pageText?: string },
  ): Promise<RunArtifact[]> {
    const active = this.activeTeachingRuns.get(inspectionId)
    if (active === undefined) return []
    const definition = await this.load(inspectionId)
    const step = definition.steps.find(item => item.id === stepId)
    if (step === undefined) return []

    const key = teachingStepKey(step)
    const current = active.stepData.get(key) ?? { artifacts: [] }
    const artifacts = [...current.artifacts]
    if (update.artifacts !== undefined) {
      for (const artifact of update.artifacts) {
        let normalized = artifact
        if (artifact.kind === 'screenshot' && typeof artifact.path === 'string' && artifact.path.trim() !== '') {
          const runOwnedPath = await this.copyArtifact(
            inspectionId,
            active.runId,
            artifact.path,
            `${step.id}-screenshot`,
            active.workspaceRoot ?? definition.metadata.workspaceRoot,
            true,
          )
          normalized = { ...artifact, path: runOwnedPath }
        }
        if (!artifacts.some(item => item.kind === normalized.kind && item.path === normalized.path)) artifacts.push(normalized)
      }
    }
    if (update.pageText !== undefined && step.kind === 'tool' && step.artifact === 'page-text') {
      const saved = await this.saveTextArtifact(
        inspectionId,
        active.runId,
        `${step.id}-page.txt`,
        redactLikelySecrets(update.pageText),
        active.workspaceRoot ?? definition.metadata.workspaceRoot,
      )
      if (!artifacts.some(item => item.kind === 'page-text' && item.path === saved)) artifacts.push({ kind: 'page-text', path: saved })
    }

    const output = update.output === undefined ? current.output : redactLikelySecrets(update.output)
    active.stepData.set(key, {
      ...(output === undefined ? {} : { output }),
      artifacts,
    })
    await this.writePendingTeachingReport(definition, active)
    return artifacts
  }

  async recordTeachingArtifact(inspectionId: string, stepId: string, artifact: RunArtifact): Promise<void> {
    await this.recordTeachingStepResult(inspectionId, stepId, { artifacts: [artifact] })
  }

  private async writePendingTeachingReport(
    definition: InspectionDefinition,
    active: ActiveTeachingRun,
  ): Promise<RunReport> {
    const now = new Date().toISOString()
    const sessionSteps = teachingSessionSteps(definition, active.startedAt)
    const results = sessionSteps.map(step => teachingStepResult(step, now, step.kind === 'checkpoint' ? 'waiting' : 'passed', active))
    const waitingCheckpoints = results.filter(result => result.status === 'waiting').length
    const passedSteps = results.filter(result => result.status === 'passed').length
    const status: RunReport['status'] = waitingCheckpoints > 0 ? 'waiting' : 'passed'
    const summary = waitingCheckpoints > 0
      ? `巡检进行中：本轮已完成 ${passedSteps} 个步骤，当前有 ${waitingCheckpoints} 个人工检查点等待处理。即使本轮未继续完成，这条巡检记录也会保留。`
      : `交互巡检本轮已完成 ${passedSteps} 个步骤；流程定义仍可继续编辑或确认固化。`

    const report: RunReport = {
      schemaVersion: '0.2',
      runId: active.runId,
      inspectionId: definition.id,
      inspectionName: definition.name,
      startedAt: active.startedAt,
      finishedAt: now,
      status,
      expectedResult: definition.expectedResult,
      results,
      summary,
      ...(active.workspaceRoot === undefined ? {} : { outputWorkspace: active.workspaceRoot }),
    }

    // Pending teaching runs are written only to the internal Patrol history on
    // each step. This keeps interactive teaching fast. The finalized run is
    // mirrored to the workspace once DRAFT -> READY succeeds.
    await super.saveRun(report, renderPendingTeachingReport(report))
    return report
  }
}

function hasNewTeachingStep(previous: InspectionDefinition | undefined, current: InspectionDefinition): boolean {
  if (current.steps.length === 0) return false
  if (previous === undefined) return current.steps.length > 0
  if (previous.status !== 'draft') return false
  return current.steps.length > previous.steps.length
}

function createTeachingReport(
  definition: InspectionDefinition,
  compaction: FlowCompactionResult,
  active?: ActiveTeachingRun,
): RunReport {
  const startedAt = active?.startedAt ?? earliestRecordedAt(definition) ?? definition.metadata.createdAt
  const finishedAt = definition.metadata.validatedAt ?? definition.metadata.updatedAt
  const runId = active?.runId ?? teachingRunId(finishedAt)
  const sessionSteps = active === undefined
    ? definition.steps
    : teachingSessionSteps(definition, active.startedAt)
  const results: StepRunResult[] = sessionSteps.map(step => teachingStepResult(step, finishedAt, 'passed', active))
  const outputWorkspace = active?.workspaceRoot ?? definition.metadata.workspaceRoot
  const pageSummary = teachingPageSummary(results)

  return {
    schemaVersion: '0.2',
    runId,
    inspectionId: definition.id,
    inspectionName: definition.name,
    startedAt,
    finishedAt,
    status: 'passed',
    expectedResult: definition.expectedResult,
    results,
    summary: pageSummary ?? (compaction.removedSteps > 0
      ? `交互教学巡检已完成；从 ${compaction.originalSteps} 个教学步骤中移除 ${compaction.removedSteps} 个试探/诊断步骤，固化为 ${compaction.finalSteps} 个可复用步骤。`
      : `交互教学巡检已完成并固化为 ${compaction.finalSteps} 个可复用步骤。`),
    ...(outputWorkspace === undefined ? {} : { outputWorkspace }),
  }
}

function teachingSessionSteps(definition: InspectionDefinition, startedAt: string) {
  return definition.steps.filter(step => !step.recordedAt || step.recordedAt >= startedAt)
}

function teachingStepResult(
  step: InspectionDefinition['steps'][number],
  fallback: string,
  status: StepRunResult['status'],
  active?: ActiveTeachingRun,
): StepRunResult {
  const timestamp = step.recordedAt || fallback
  const data = active?.stepData.get(teachingStepKey(step))
  return {
    stepId: step.id,
    name: step.name,
    kind: step.kind,
    status,
    startedAt: timestamp,
    finishedAt: timestamp,
    ...(step.kind === 'tool' ? { tool: step.tool } : {}),
    output: data?.output ?? (step.kind === 'checkpoint'
      ? status === 'waiting'
        ? '交互巡检已到达人工检查点，等待用户完成后继续。'
        : '交互教学完成后由用户确认，该人工检查点已纳入最终流程。'
      : '该步骤已在本轮交互巡检过程中成功执行。'),
    ...(data !== undefined && data.artifacts.length > 0 ? { artifacts: data.artifacts } : {}),
  }
}

function teachingStepKey(step: InspectionDefinition['steps'][number]): string {
  const tool = step.kind === 'tool' ? step.tool : step.reason
  return [step.recordedAt || '', step.kind, tool, step.name].join('\u001f')
}

function teachingPageSummary(results: readonly StepRunResult[]): string | undefined {
  const source = [...results].reverse().find(result => result.tool === 'browser_read_page' && result.status === 'passed' && result.output !== undefined)
  if (source?.output === undefined) return undefined
  if (source.output === '该步骤已在本轮交互巡检过程中成功执行。') return undefined
  const clean = source.output
    .replace(/^--- BEGIN UNTRUSTED PAGE DATA ---\n?/, '')
    .replace(/\n?--- END UNTRUSTED PAGE DATA ---$/, '')
    .split(/\r?\n/)
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
  if (clean.length === 0) return '交互教学巡检已完成；页面已读取，但没有可见文本。'
  const titleLine = clean[0]?.startsWith('Page:') ? clean.shift() : undefined
  const body = clean.join(' · ')
  return `${titleLine === undefined ? '交互教学巡检已完成。' : `交互教学巡检已完成。\n${titleLine}`}\n可见内容摘要（确定性摘录）：${body.slice(0, 1600)}${body.length > 1600 ? '…' : ''}`
}

function earliestRecordedAt(definition: InspectionDefinition): string | undefined {
  let earliest: string | undefined
  for (const step of definition.steps) {
    if (!step.recordedAt) continue
    if (earliest === undefined || step.recordedAt < earliest) earliest = step.recordedAt
  }
  return earliest
}

function teachingRunId(value: string): string {
  const compact = value.replace(/[^0-9]/g, '').slice(0, 17)
  return `teaching-${compact || Date.now()}`
}

function renderPendingTeachingReport(report: RunReport): string {
  const lines = [
    `# DSH Patrol 巡检报告：${report.inspectionName}`,
    '',
    `- Run ID：\`${report.runId}\``,
    `- Inspection ID：\`${report.inspectionId}\``,
    '- 状态：**WAITING**',
    `- 开始：${report.startedAt}`,
    `- 最近更新：${report.finishedAt}`,
    `- 预期结果：${report.expectedResult}`,
    '- 来源：交互巡检（进行中/未完成）',
    '',
    '## 页面摘要',
    '',
    '```text',
    report.summary ?? '',
    '```',
    '',
    '## 步骤结果',
    '',
  ]
  appendResultMarkdown(lines, report.results)
  return `${lines.join('\n')}\n`
}

function renderTeachingReport(report: RunReport, compaction: FlowCompactionResult): string {
  const lines = [
    `# DSH Patrol 巡检报告：${report.inspectionName}`,
    '',
    `- Run ID：\`${report.runId}\``,
    `- Inspection ID：\`${report.inspectionId}\``,
    `- 状态：**${report.status.toUpperCase()}**`,
    `- 开始：${report.startedAt}`,
    `- 结束：${report.finishedAt}`,
    `- 预期结果：${report.expectedResult}`,
    `- 来源：交互教学`,
    '',
    '## 页面摘要',
    '',
    '```text',
    report.summary ?? '',
    '```',
    '',
    '## 流程优化',
    '',
    `- 教学步骤：${compaction.originalSteps}`,
    `- 移除试探/诊断步骤：${compaction.removedSteps}`,
    `- 最终可复用步骤：${compaction.finalSteps}`,
    '',
    '## 步骤结果',
    '',
  ]
  appendResultMarkdown(lines, report.results)
  return `${lines.join('\n')}\n`
}

function appendResultMarkdown(lines: string[], results: readonly StepRunResult[]): void {
  for (const result of results) {
    lines.push(
      `### ${result.stepId} — ${result.name}`,
      '',
      `- 状态：**${result.status.toUpperCase()}**`,
      ...(result.tool ? [`- 工具：\`${result.tool}\``] : []),
      `- 输出：${result.output ?? ''}`,
      '',
    )
  }
}
