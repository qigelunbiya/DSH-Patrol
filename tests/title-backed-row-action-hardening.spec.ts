import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('title-backed enterprise row action hardening', () => {
  it('loads after the generic row-context semantic layer so it gets first chance to resolve title-backed actions', () => {
    const entry = readFileSync(join(root, 'browser-extension', 'background-entry.js'), 'utf8')
    const generic = "importScripts('semantic-row-context-hardening.js')"
    const focused = "importScripts('title-backed-row-action-hardening.js')"

    expect(entry).toContain(generic)
    expect(entry).toContain(focused)
    expect(entry.indexOf(focused)).toBeGreaterThan(entry.indexOf(generic))
  })

  it('targets the real title-backed span/div instead of inventing an anchor selector', () => {
    const source = readFileSync(join(root, 'browser-extension', 'title-backed-row-action-hardening.js'), 'utf8')

    expect(() => new Function(source)).not.toThrow()
    expect(source).toContain("document.querySelectorAll('[title]')")
    expect(source).toContain("element.getAttribute('title')")
    expect(source).toContain('normalizedTitle.includes(token)')
    expect(source).toContain('element.click()')
    expect(source).toContain('atomic-main-world-title-row-action-click')
    expect(source).not.toContain('10.192.3.174')
    expect(source).not.toMatch(/td:last-child\s+a|td:nth-child\([^)]*\)\s+a/)
  })

  it('binds duplicate protocol labels to a business identity without climbing to a whole table containing another row', () => {
    const source = readFileSync(join(root, 'browser-extension', 'title-backed-row-action-hardening.js'), 'utf8')

    expect(source).toContain("const directText = rowText(actionRow)")
    expect(source).toContain("reason: 'same-row'")
    expect(source).toContain("reason = 'row-key'")
    expect(source).toContain("reason = 'parallel-row-ordinal'")
    expect(source).toContain("reason = 'parallel-row-top'")
    expect(source).not.toContain('ancestor = ancestor.parentElement')
  })
})
