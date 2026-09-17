import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'dashboard-records-client.js'), 'utf8')

describe('Patrol records dashboard batch grouping', () => {
  it('treats one batch as one top-level record and hides its child runs from the top level', () => {
    expect(source).toContain('function topLevelRecords()')
    expect(source).toContain('const childKeys = new Set()')
    expect(source).toContain("childKeys.add(`${child.flowId}\\u0000${child.runId}`)")
    expect(source).toContain("recordType: 'single'")
    expect(source).toContain("record.recordType === 'batch'")
  })

  it('provides explicit single/batch filtering', () => {
    expect(source).toContain('<option value="single">单次巡检</option>')
    expect(source).toContain('<option value="batch">批量巡检</option>')
    expect(source).toContain("const kind = document.getElementById('kind')?.value || 'all'")
  })

  it('renders a batch overview and lets users switch into each child run', () => {
    expect(source).toContain('function renderBatchDetail()')
    expect(source).toContain('function renderBatchOverview(batch)')
    expect(source).toContain('data-batch-child-inspection')
    expect(source).toContain('data-batch-child-run')
    expect(source).toContain("data-action=\"batch-overview\"")
    expect(source).toContain("void openRun(child.getAttribute('data-batch-child-inspection')")
  })

  it('keeps single-run detail behavior available', () => {
    expect(source).toContain('function renderRunDetail()')
    expect(source).toContain('function detailContent(report, definition, artifacts)')
    expect(source).toContain('function artifactsView(artifacts)')
    expect(source).toContain('function logsView(report, definition)')
  })
  it('closes an artifact preview from the document-level modal handler', () => {
    expect(source).toContain(`target?.closest('[data-action="close-modal"]')`)
    expect(source).toContain('if (event.target === modal) modal.remove()')
  })

})
