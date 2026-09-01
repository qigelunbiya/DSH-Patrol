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
    expect(EXCEL_POWERSHELL_V4).toContain('$x=$books.Open($path)')
    expect(EXCEL_POWERSHELL_V4).toContain("[System.__ComObject].InvokeMember('Open'")
    expect(EXCEL_POWERSHELL_V4).toContain('[Reflection.BindingFlags]::OptionalParamBinding')
  })

  it('turns UsedRange metadata mismatch into a bounded scan instead of a fatal worksheet error', () => {
    expect(EXCEL_POWERSHELL_V4).toContain("$u=Prop $s 'UsedRange'")
    expect(EXCEL_POWERSHELL_V4).toContain("$rows=Prop $u 'Rows'")
    expect(EXCEL_POWERSHELL_V4).toContain("$cols=Prop $u 'Columns'")
    expect(EXCEL_POWERSHELL_V4).toContain('UsedRange metadata unavailable')
    expect(EXCEL_POWERSHELL_V4).toContain('$er=$maxRows')
    expect(EXCEL_POWERSHELL_V4).toContain('$ec=$maxCols')
    expect(PATROL_EXCEL_V4_PROMPT).toContain('bounded A1 scan')
  })

  it('uses numeric worksheet enumeration and A1 Range access', () => {
    expect(EXCEL_POWERSHELL_V4).toContain('$x=$s.Item($i)')
    expect(EXCEL_POWERSHELL_V4).toContain('$x=$s.Range($a)')
    expect(EXCEL_POWERSHELL_V4).not.toContain('$s.Item($name)')
  })

  it('keeps formatting copy non-fatal and writes/saves with fallbacks', () => {
    expect(EXCEL_POWERSHELL_V4).toContain('copy formatting $([string]$u.copyFormatFrom) -> $a failed')
    expect(EXCEL_POWERSHELL_V4).toContain("CSet $c 'Value2'")
    expect(EXCEL_POWERSHELL_V4).toContain("CSet $c 'Formula'")
    expect(EXCEL_POWERSHELL_V4).toContain("CCall $b 'Save'")
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
