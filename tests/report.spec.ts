import { describe, expect, it } from 'vitest'
import { renderRunReport, summarizeReport } from '../src/report.ts'
import type { RunReport } from '../src/types.ts'

const report: RunReport = {
  schemaVersion: '0.2',
  runId: 'run-1',
  inspectionId: 'example',
  inspectionName: 'Example',
  startedAt: '2026-01-01T00:00:00.000Z',
  finishedAt: '2026-01-01T00:00:01.000Z',
  status: 'passed',
  expectedResult: 'page healthy',
  summary: '页面显示全部工单。',
  results: [
    {
      stepId: 'step-001',
      name: 'screenshot',
      kind: 'tool',
      tool: 'browser_screenshot',
      status: 'passed',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
      artifacts: [{ kind: 'screenshot', path: '/tmp/shot.png' }],
    },
    {
      stepId: 'step-002',
      name: 'optional login',
      kind: 'tool',
      tool: 'browser_click',
      status: 'skipped',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:01.000Z',
    },
  ],
}

describe('report', () => {
  it('renders summaries, artifacts, and skipped counts', () => {
    const markdown = renderRunReport(report, 30000)
    expect(markdown).toContain('页面摘要')
    expect(markdown).toContain('/tmp/shot.png')
    expect(summarizeReport(report)).toContain('skipped=1')
  })

  it('uses a fence longer than untrusted backticks in report output', () => {
    const injected: RunReport = {
      ...report,
      summary: 'page says ```markdown\n# injected',
      results: [{ ...report.results[0]!, output: 'visible ``` text' }],
    }
    const markdown = renderRunReport(injected, 30000)
    expect(markdown).toContain('````text')
    expect(markdown).toContain('# injected')
  })

})
