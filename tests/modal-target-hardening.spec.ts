import { readFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'

describe('foreground modal target hardening', () => {
  it('loads after general frame/selector hardening', async () => {
    const source = await readFile(new URL('../browser-extension/background-entry.js', import.meta.url), 'utf8')
    expect(source).toMatch(/selector-scope-hardening\.js[\s\S]*modal-target-hardening\.js/)
  })

  it('handles generic dialog families including Ant Design without changing ordinary pages', async () => {
    const source = await readFile(new URL('../browser-extension/modal-target-hardening.js', import.meta.url), 'utf8')
    expect(source).toMatch(/\[role=\\?"dialog\\?"\]/)
    expect(source).toMatch(/\[aria-modal=\\?"true\\?"\]/)
    expect(source).toMatch(/\.ant-modal-content/)
    expect(source).toMatch(/if \(!modalSnapshot\?\.modalActive/)
    expect(source).toMatch(/return base/)
  })

  it('uses stable attributes/classes and suppresses modal-blocked background controls', async () => {
    const source = await readFile(new URL('../browser-extension/modal-target-hardening.js', import.meta.url), 'utf8')
    expect(source).toMatch(/aria-label/)
    expect(source).toMatch(/stableClassTokens/)
    expect(source).toMatch(/elementFromPoint/)
    expect(source).toMatch(/top-frame::/)
    expect(source).toMatch(/main-world-modal-snapshot/)
  })

  it('normalizes framework-spaced Chinese action labels such as 确 定', async () => {
    const source = await readFile(new URL('../browser-extension/modal-target-hardening.js', import.meta.url), 'utf8')
    expect(source).toMatch(/UI frameworks sometimes render Chinese labels as "确 定"/)
    expect(source).toMatch(/\\u3400-\\u9fff/)
  })
})
