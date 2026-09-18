import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

describe('TEST MODE operational click fallbacks', () => {
  it('keeps click-strategy loop protection active in TEST MODE without disabling low-level fallbacks', () => {
    const source = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    const planningIndex = source.indexOf('planningGuard(execution)')
    const strictIndex = source.indexOf('if (runtimePolicy.installGuards)')
    expect(planningIndex).toBeGreaterThan(0)
    expect(planningIndex).toBeLessThan(strictIndex)
    expect(source).toContain('Selector/click strategy budgets are safety against model loops')
    expect(source).toContain("build=${TEST_MODE_BUILD_MARKER}")
    expect(source).toContain("test-bypass-v10-desktop-automation")
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

  it('keeps Desktop Automation directly available in TEST MODE without permission tiers', () => {
    const prompt = readFileSync(join(process.cwd(), 'src', 'test-mode.ts'), 'utf8')
    const index = readFileSync(join(process.cwd(), 'src', 'index.ts'), 'utf8')
    expect(prompt).toContain('desktop_* 原语可以直接操作当前桌面应用')
    expect(prompt).toContain('发消息、删除文件、关闭窗口等当前都允许直接执行')
    expect(prompt).toContain('NORMAL MODE 现阶段同样不分级')
    expect(index).toContain('desktopPermissions=unrestricted')
    expect(index).toContain('registerPatrolDesktopActionTools')
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
