import { describe, expect, it } from 'vitest'
import { renderRunReport, summarizeReport } from '../src/report.ts'
import type { RunReport } from '../src/types.ts'

const report: RunReport = {
  schemaVersion: '0.1',
  runId: 'run-1',
  inspectionId: 'demo',
  inspectionName: 'Demo inspection',
  startedAt: '2026-08-26T00:00:00.000Z',
  finishedAt: '2026-08-26T00:00:01.000Z',
  status: 'passed',
  expectedResult: 'Example Domain is visible',
  results: [{
    stepId: 'step-001',
    name: 'Read page',
    kind: 'tool',
    tool: 'browser_get_text',
    status: 'passed',
    startedAt: '2026-08-26T00:00:00.000Z',
    finishedAt: '2026-08-26T00:00:01.000Z',
    output: 'Example Domain',
  }],
}

describe('report rendering', () => {
  it('renders markdown and a compact summary', () => {
    expect(renderRunReport(report, 30000)).toContain('Demo inspection')
    expect(renderRunReport(report, 30000)).toContain('Example Domain')
    expect(summarizeReport(report)).toContain('passed=1')
  })
})
