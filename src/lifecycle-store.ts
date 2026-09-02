import { compactTeachingFlow, type FlowCompactionResult } from './flow-optimizer.js'
import { PatrolStore } from './store.js'
import type { InspectionDefinition, RunReport, StepRunResult } from './types.js'

/**
 * Store variant used by the Patrol runtime. A draft -> ready transition is the
 * moment an interactive teaching session becomes a reusable flow, so we make
 * that transition durable in two ways:
 *
 * 1. compact away teaching-only probes before the runbook is frozen;
 * 2. persist the successful teaching session as a normal Patrol run so both
 *    "recent patrols" and the global patrol history include conversational
 *    patrols, not only deterministic patrol_run replays.
 */
export class PatrolLifecycleStore extends PatrolStore {
  override async save(definition: InspectionDefinition): Promise<void> {
    let previous: InspectionDefinition | undefined
    if (await this.exists(definition.id)) {
      previous = await this.load(definition.id)
    }

    const completingTeaching = previous?.status === 'draft' && definition.status === 'ready'
    let compaction: FlowCompactionResult | undefined
    if (completingTeaching) {
      compaction = compactTeachingFlow(definition)
      definition.metadata.updatedAt = new Date().toISOString()
    }

    await super.save(definition)

    if (completingTeaching) {
      const report = createTeachingReport(definition, compaction!)
      await super.saveRun(
        report,
        renderTeachingReport(report, compaction!),
        definition.metadata.workspaceRoot,
      )
    }
  }
}

function createTeachingReport(definition: InspectionDefinition, compaction: FlowCompactionResult): RunReport {
  const startedAt = earliestRecordedAt(definition) ?? definition.metadata.createdAt
  const finishedAt = definition.metadata.validatedAt ?? definition.metadata.updatedAt
  const runId = teachingRunId(finishedAt)
  const results: StepRunResult[] = definition.steps.map(step => {
    const timestamp = step.recordedAt || finishedAt
    return {
      stepId: step.id,
      name: step.name,
      kind: step.kind,
      status: 'passed',
      startedAt: timestamp,
      finishedAt: timestamp,
      ...(step.kind === 'tool' ? { tool: step.tool } : {}),
      output: step.kind === 'checkpoint'
        ? '交互教学完成后由用户确认，该人工检查点已纳入最终流程。'
        : '该步骤已在交互教学过程中成功执行，并在确认流程时固化。',
    }
  })

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
    summary: compaction.removedSteps > 0
      ? `交互教学巡检已完成；从 ${compaction.originalSteps} 个教学步骤中移除 ${compaction.removedSteps} 个试探/诊断步骤，固化为 ${compaction.finalSteps} 个可复用步骤。`
      : `交互教学巡检已完成并固化为 ${compaction.finalSteps} 个可复用步骤。`,
    ...(definition.metadata.workspaceRoot === undefined ? {} : { outputWorkspace: definition.metadata.workspaceRoot }),
  }
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

  for (const result of report.results) {
    lines.push(
      `### ${result.stepId} — ${result.name}`,
      '',
      `- 状态：**${result.status.toUpperCase()}**`,
      ...(result.tool ? [`- 工具：\`${result.tool}\``] : []),
      `- 输出：${result.output ?? ''}`,
      '',
    )
  }
  return `${lines.join('\n')}\n`
}
