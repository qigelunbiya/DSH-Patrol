import { redactLikelySecrets } from './security.ts'
import type { RunReport } from './types.ts'

export function renderRunReport(report: RunReport, maxChars: number): string {
  const lines: string[] = [
    `# DSH Patrol 巡检报告：${report.inspectionName}`,
    '',
    `- 巡检 ID：\`${report.inspectionId}\``,
    `- Run ID：\`${report.runId}\``,
    `- 状态：**${report.status.toUpperCase()}**`,
    `- 开始：${report.startedAt}`,
    `- 结束：${report.finishedAt}`,
    `- 预期结果：${report.expectedResult}`,
  ]

  if (report.startedAtStepId !== undefined) lines.push(`- 从步骤开始：\`${report.startedAtStepId}\``)
  lines.push('', '## 步骤结果', '')

  for (const result of report.results) {
    lines.push(`### ${result.stepId} · ${result.name}`)
    lines.push(`- 类型：${result.kind}`)
    lines.push(`- 状态：**${result.status.toUpperCase()}**`)
    if (result.tool !== undefined) lines.push(`- 工具：\`${result.tool}\``)
    if (result.error !== undefined) lines.push(`- 错误：${redactLikelySecrets(result.error)}`)
    if (result.output !== undefined && result.output.length > 0) {
      lines.push('', '```text', clip(redactLikelySecrets(result.output), 4000), '```')
    }
    lines.push('')
  }

  const body = `${lines.join('\n')}\n`
  return clip(body, maxChars)
}

export function summarizeReport(report: RunReport): string {
  const passed = report.results.filter(item => item.status === 'passed').length
  const failed = report.results.filter(item => item.status === 'failed').length
  const waiting = report.results.filter(item => item.status === 'waiting').length
  return `run ${report.runId}: ${report.status}; passed=${passed}, failed=${failed}, waiting=${waiting}`
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n\n[TRUNCATED by DSH Patrol report limit]\n`
}
