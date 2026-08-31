import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { EXCEL_POWERSHELL_V2, PATROL_EXCEL_V2_PROMPT } from '../src/excel-tools-v2.js'

const execFileAsync = promisify(execFile)

describe('resilient Excel bridge v2', () => {
  it('avoids string-indexed worksheet COM binding and has reflection fallbacks', () => {
    expect(EXCEL_POWERSHELL_V2).toContain('function Invoke-ComGet')
    expect(EXCEL_POWERSHELL_V2).toContain('function Invoke-ComCall')
    expect(EXCEL_POWERSHELL_V2).toContain('function Invoke-ComSet')
    expect(EXCEL_POWERSHELL_V2).toContain('function Get-WorksheetByName')
    expect(EXCEL_POWERSHELL_V2).toContain('open worksheet')
    expect(EXCEL_POWERSHELL_V2).toContain('by enumeration')
    expect(EXCEL_POWERSHELL_V2).not.toContain('Worksheets.Item([string]')
    expect(EXCEL_POWERSHELL_V2).toContain("Invoke-ComCall $workbooks 'Open'")
    expect(EXCEL_POWERSHELL_V2).toContain("Invoke-ComGet $sheet 'Range'")
    expect(EXCEL_POWERSHELL_V2).toContain("Invoke-ComSet $cell 'Value2'")
    expect(EXCEL_POWERSHELL_V2).toContain("Invoke-ComSet $cell 'Formula'")
    expect(EXCEL_POWERSHELL_V2).toContain('Save-Workbook $workbook')
  })

  it('keeps formatting-copy failure non-fatal while preserving the write', () => {
    expect(EXCEL_POWERSHELL_V2).toContain('copy formatting $sourceAddress -> $($address)')
    expect(EXCEL_POWERSHELL_V2).toContain('Add-Warning $warnings')
    expect(PATROL_EXCEL_V2_PROMPT).toContain('formatting-copy failure is non-fatal')
    expect(PATROL_EXCEL_V2_PROMPT).toContain('参数类型不匹配')
  })

  it('parses the v2 PowerShell bridge on Windows', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-excel-v2-parse-'))
    const script = join(root, 'excel-bridge-v2.ps1')
    try {
      await writeFile(script, EXCEL_POWERSHELL_V2, 'utf8')
      const command = `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`
      await expect(execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
