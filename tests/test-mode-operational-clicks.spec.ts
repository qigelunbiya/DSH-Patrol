import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('TEST MODE operational click fallbacks', () => {
  it('does not install the strict planning guard outside NORMAL MODE', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    const strictBlock = source.match(/if \(runtimePolicy\.installGuards\) \{[\s\S]*?\n  \} else \{/i)?.[0] ?? ''
    expect(strictBlock).toContain('planningGuard(execution)')
    expect(source.indexOf('planningGuard(execution)')).toBeGreaterThan(source.indexOf('if (runtimePolicy.installGuards)'))
    expect(source).toContain("build=${TEST_MODE_BUILD_MARKER}")
    expect(source).toContain("test-bypass-v8-structural-edit-persistence")
  })

  it('allows non-secret low-level interaction fallbacks in TEST MODE', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    expect(source).toContain("'browser_semantic_click'")
    expect(source).toContain("'browser_click'")
    expect(source).toContain("'browser_press'")
    expect(source).toContain("'browser_scroll'")
    expect(source).toContain("'browser_select'")
    expect(source).toContain('TEST_MODE_DIRECT_BROWSER_ALLOWED.has(execution.name)')
  })

  it('keeps secret-bearing direct browser mutations behind Patrol tools', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    const allowed = source.match(/const TEST_MODE_DIRECT_BROWSER_ALLOWED = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? ''
    expect(allowed).not.toContain("'browser_type'")
    expect(allowed).not.toContain("'browser_type_credential'")
    expect(allowed).not.toContain("'browser_type_transient_ref'")
    expect(allowed).not.toContain("'browser_type_totp_profile'")
    expect(source).toContain('runner.browserGuard(execution.name, execution.parent)')
  })
})
