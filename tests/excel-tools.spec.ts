import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXCEL_POWERSHELL,
  PATROL_EXCEL_PROMPT,
  normalizeExcelUpdates,
  normalizeWorkbookLookupKey,
  resolveExistingWorkspaceXlsx,
  resolveWorkspaceWorkbook,
  resolveWorkspaceXlsx,
  workbookRefForPath,
} from '../src/excel-tools.js'

describe('workspace Excel safety and adaptive updates', () => {
  it('allows only xlsx files inside the current workspace', () => {
    const root = resolve('/tmp/patrol-workspace')
    expect(resolveWorkspaceXlsx(root, 'reports/week.xlsx')).toBe(resolve(root, 'reports/week.xlsx'))
    expect(() => resolveWorkspaceXlsx(root, '../escape.xlsx')).toThrow(/inside the current Harness workspace/)
    expect(() => resolveWorkspaceXlsx(root, 'week.xls')).toThrow(/xlsx/)
  })

  it('normalizes harmless model filename drift for Chinese weekly-report names', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-excel-path-'))
    const exactName = '开发工作周报-方泽铭-2026年08月24日~2026年08月30日.xlsx'
    const rewrittenName = '开发工作周报 - 方泽铭 -2026 年 08 月 24 日\\~2026 年 08 月 30 日.xlsx'
    try {
      const exactPath = join(root, exactName)
      await writeFile(exactPath, '')
      expect(normalizeWorkbookLookupKey(rewrittenName)).toBe(normalizeWorkbookLookupKey(exactName))
      await expect(resolveExistingWorkspaceXlsx(root, rewrittenName)).resolves.toBe(exactPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('resolves Chinese and special-character workbook names through a stable ASCII workbookRef', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-excel-ref-'))
    const exactName = '开发工作周报-方泽铭-2026年08月24日～2026年08月30日.xlsx'
    try {
      const exactPath = join(root, exactName)
      await writeFile(exactPath, '')
      const ref = workbookRefForPath(exactName)
      expect(ref).toMatch(/^xlsx-[0-9a-f]{16}$/)
      await expect(resolveWorkspaceWorkbook(root, ref)).resolves.toBe(exactPath)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not use normalized fallback to escape the current workspace', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-excel-root-'))
    try {
      await expect(resolveExistingWorkspaceXlsx(root, '../outside.xlsx')).rejects.toThrow(/inside the current Harness workspace/)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('avoids fragile optional COM Range/Open arguments and reports the failing bridge stage', () => {
    expect(EXCEL_POWERSHELL).toContain('function Get-A1Address')
    expect(EXCEL_POWERSHELL).toContain('function ConvertFrom-A1Cell')
    expect(EXCEL_POWERSHELL).toContain('function Get-WorksheetCell')
    expect(EXCEL_POWERSHELL).not.toContain('.Address(')
    expect(EXCEL_POWERSHELL).not.toContain('$sheet.Range(')
    expect(EXCEL_POWERSHELL).not.toContain('Workbooks.Open([string]$payload.filePath, 0, $readOnly)')
    expect(EXCEL_POWERSHELL).toContain('$workbook = $workbooks.Open([string]$payload.filePath)')
    expect(EXCEL_POWERSHELL).toContain('stage=$stage;')
    expect(EXCEL_POWERSHELL).toContain('DSH Patrol Excel bridge failed:')
  })

  it('forbids blind writes when inspect failed', () => {
    expect(PATROL_EXCEL_PROMPT).toContain('MUST have passed patrol_excel_inspect')
    expect(PATROL_EXCEL_PROMPT).toContain('do not guess cell addresses')
    expect(PATROL_EXCEL_PROMPT).toContain('do not call write anyway')
  })

  it('normalizes A1 cells and supports template-driven formatting reuse', () => {
    expect(normalizeExcelUpdates([
      { cell: ' b12 ', value: '本周完成 4 项工作', copyFormatFrom: ' a11 ' },
      { cell: '$C$12', value: '4', valueType: 'number' },
      { cell: 'D12', valueType: 'clear' },
    ])).toEqual([
      { cell: 'B12', valueType: 'text', value: '本周完成 4 项工作', copyFormatFrom: 'A11' },
      { cell: 'C12', valueType: 'number', value: '4' },
      { cell: 'D12', valueType: 'clear' },
    ])
  })

  it('rejects duplicate cells and malformed formulas', () => {
    expect(() => normalizeExcelUpdates([
      { cell: 'A1', value: 'one' },
      { cell: '$A$1', value: 'two' },
    ])).toThrow(/duplicate/)
    expect(() => normalizeExcelUpdates([{ cell: 'B2', value: 'SUM(A1:A2)', valueType: 'formula' }])).toThrow(/start with =/)
  })
})
