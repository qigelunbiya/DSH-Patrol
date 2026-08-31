import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { EXCEL_POWERSHELL_V4, PATROL_EXCEL_V4_PROMPT } from '../src/excel-tools-v4.ts'

const execFileAsync = promisify(execFile)

describe('Excel bridge v4', () => {
  it('keeps the proven one-argument Workbooks.Open path', () => {
    expect(EXCEL_POWERSHELL_V4).toContain('$opened = $workbooks.Open($filePath)')
    expect(EXCEL_POWERSHELL_V4).toContain("[System.__ComObject].InvokeMember('Open'")
    expect(EXCEL_POWERSHELL_V4).toContain('[Reflection.BindingFlags]::OptionalParamBinding')
  })

  it('turns UsedRange metadata mismatch into a bounded scan instead of a fatal worksheet error', () => {
    expect(EXCEL_POWERSHELL_V4).toContain("$used = Get-ComProperty $sheet 'UsedRange'")
    expect(EXCEL_POWERSHELL_V4).toContain("Get-ComProperty $used 'Rows'")
    expect(EXCEL_POWERSHELL_V4).toContain("Get-ComProperty $used 'Columns'")
    expect(EXCEL_POWERSHELL_V4).toContain('UsedRange metadata unavailable')
    expect(EXCEL_POWERSHELL_V4).toContain('$endRow = $maxRows')
    expect(EXCEL_POWERSHELL_V4).toContain('$endColumn = $maxColumns')
    expect(PATROL_EXCEL_V4_PROMPT).toContain('bounded A1 scan')
  })

  it('uses numeric worksheet enumeration and A1 Range access', () => {
    expect(EXCEL_POWERSHELL_V4).toContain('$sheet = $worksheets.Item($index)')
    expect(EXCEL_POWERSHELL_V4).toContain('$cell = $sheet.Range($address)')
    expect(EXCEL_POWERSHELL_V4).not.toContain('$worksheets.Item($name)')
  })

  it('keeps formatting copy non-fatal and writes/saves with fallbacks', () => {
    expect(EXCEL_POWERSHELL_V4).toContain('copy formatting $sourceAddress -> $address failed')
    expect(EXCEL_POWERSHELL_V4).toContain("Invoke-ComSet $cell 'Value2'")
    expect(EXCEL_POWERSHELL_V4).toContain("Invoke-ComSet $cell 'Formula'")
    expect(EXCEL_POWERSHELL_V4).toContain("Invoke-ComCall $workbook 'Save'")
  })

  it('parses the v4 PowerShell bridge on Windows', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-excel-v4-parse-'))
    const script = join(root, 'excel-bridge-v4.ps1')
    try {
      await writeFile(script, EXCEL_POWERSHELL_V4, 'utf8')
      const command = `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`
      await expect(execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
