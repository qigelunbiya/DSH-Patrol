import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { EXCEL_POWERSHELL_V3, PATROL_EXCEL_V3_PROMPT } from '../src/excel-tools-v3.js'

const execFileAsync = promisify(execFile)

describe('hybrid Excel bridge v3', () => {
  it('uses the proven one-argument Workbooks.Open path before a late-binding fallback', () => {
    expect(EXCEL_POWERSHELL_V3).toContain('$opened = $workbooks.Open($filePath)')
    expect(EXCEL_POWERSHELL_V3).toContain("[System.__ComObject].InvokeMember('Open'")
    expect(EXCEL_POWERSHELL_V3).toContain('[Reflection.BindingFlags]::OptionalParamBinding')
    expect(EXCEL_POWERSHELL_V3).toContain('[Type]::Missing')
    expect(EXCEL_POWERSHELL_V3).toContain('Workbooks.Open failed; dynamic=')
  })

  it('enumerates worksheets numerically and uses A1 Range cell access', () => {
    expect(EXCEL_POWERSHELL_V3).toContain('$sheet = $worksheets.Item($index)')
    expect(EXCEL_POWERSHELL_V3).toContain('$cell = $sheet.Range($address)')
    expect(EXCEL_POWERSHELL_V3).not.toContain('$worksheets.Item($name)')
    expect(PATROL_EXCEL_V3_PROMPT).toContain('numeric enumeration')
    expect(PATROL_EXCEL_V3_PROMPT).toContain('per-cell warnings')
  })

  it('keeps formatting-copy failure non-fatal and falls back for writes', () => {
    expect(EXCEL_POWERSHELL_V3).toContain('copy formatting $sourceAddress -> $($address)')
    expect(EXCEL_POWERSHELL_V3).toContain('Invoke-ComSetFallback $cell \'Value2\'')
    expect(EXCEL_POWERSHELL_V3).toContain('Invoke-ComSetFallback $cell \'Formula\'')
    expect(EXCEL_POWERSHELL_V3).toContain("Invoke-ComCallFallback $workbook 'Save'")
    expect(PATROL_EXCEL_V3_PROMPT).toContain('formatting-copy failure is non-fatal')
  })

  it('parses the v3 PowerShell bridge on Windows', async () => {
    if (process.platform !== 'win32') return
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-excel-v3-parse-'))
    const script = join(root, 'excel-bridge-v3.ps1')
    try {
      await writeFile(script, EXCEL_POWERSHELL_V3, 'utf8')
      const command = `$errors=$null; [void][System.Management.Automation.Language.Parser]::ParseFile('${script.replace(/'/g, "''")}', [ref]$null, [ref]$errors); if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`
      await expect(execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8' })).resolves.toBeDefined()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})
