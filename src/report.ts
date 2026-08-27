import { redactLikelySecrets } from './security.js'
import type { RunReport } from './types.js'

export function renderRunReport(report: RunReport, maxChars: number): string {
  const lines: string[] = [
    `# DSH Patrol 巡检报告：${headingText(report.inspectionName)}`,
    '',
    `- 巡检 ID：${inlineCode(report.inspectionId)}`,
    `- Run ID：${inlineCode(report.runId)}`,
    `- 状态：**${report.status.toUpperCase()}**`,
    `- 开始：${plainLine(report.startedAt)}`,
    `- 结束：${plainLine(report.finishedAt)}`,
    `- 预期结果：${plainLine(report.expectedResult)}`,
  ]

  if (report.summary !== undefined && report.summary.trim() !== '') {
    lines.push('', '## 页面摘要', '', fencedText(redactLikelySecrets(report.summary)), '')
  }

  lines.push('', '## 步骤结果', '')
  for (const result of report.results) {
    lines.push(`### ${headingText(result.stepId)} · ${headingText(result.name)}`)
    lines.push(`- 类型：${plainLine(result.kind)}`)
    lines.push(`- 状态：**${result.status.toUpperCase()}**`)
    if (result.tool !== undefined) lines.push(`- 工具：${inlineCode(result.tool)}`)
    if (result.healedSelector !== undefined) lines.push(`- 临时自愈 selector：${inlineCode(result.healedSelector)}`)
    if (result.artifacts !== undefined) {
      for (const artifact of result.artifacts) lines.push(`- 产物（${plainLine(artifact.kind)}）：${inlineCode(artifact.path)}`)
    }
    if (result.error !== undefined) lines.push(`- 错误：${plainLine(redactLikelySecrets(result.error))}`)
    if (result.output !== undefined && result.output.length > 0) {
      lines.push('', fencedText(clip(redactLikelySecrets(result.output), 4000)))
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
  const skipped = report.results.filter(item => item.status === 'skipped').length
  return `run ${report.runId}: ${report.status}; passed=${passed}, failed=${failed}, waiting=${waiting}, skipped=${skipped}`
}

function clip(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, Math.max(0, maxChars - 80))}\n\n[TRUNCATED by DSH Patrol report limit]\n`
}

function plainLine(text: string): string {
  return String(text).replace(/[\r\n]+/g, ' ').trim()
}

function headingText(text: string): string {
  return plainLine(text).replace(/([\\`*_{}\[\]()#+.!|>~-])/g, '\\$1')
}

function inlineCode(text: string): string {
  const value = plainLine(text)
  const maxRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(1, maxRun + 1))
  return `${fence}${value}${fence}`
}

function fencedText(text: string): string {
  const value = String(text)
  const maxRun = Math.max(0, ...[...value.matchAll(/`+/g)].map(match => match[0].length))
  const fence = '`'.repeat(Math.max(3, maxRun + 1))
  return `${fence}text\n${value}\n${fence}`
}
