import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('snapshot title action enrichment', () => {
  it('loads after resilient snapshot and parses as JavaScript', () => {
    const entry = readFileSync(join(root, 'browser-extension', 'background-entry.js'), 'utf8')
    const source = readFileSync(join(root, 'browser-extension', 'snapshot-title-action-enrichment.js'), 'utf8')
    expect(entry).toContain("importScripts('snapshot-title-action-enrichment.js')")
    expect(entry.indexOf("importScripts('snapshot-title-action-enrichment.js')")).toBeGreaterThan(entry.indexOf("importScripts('snapshot-resilient.js')"))
    expect(() => new Function(source)).not.toThrow()
  })

  it('is read-only and captures title-backed span/div action evidence with row context', () => {
    const source = readFileSync(join(root, 'browser-extension', 'snapshot-title-action-enrichment.js'), 'utf8')
    expect(source).toContain("document.querySelectorAll('[title]')")
    expect(source).toContain("evidence: 'title-backed-custom-action'")
    expect(source).toContain("evidence: target === label ? 'title-backed-custom-action' : 'title-backed-descendant-action'")
    expect(source).toContain('promotedActionTarget')
    expect(source).toContain("'.ant-tree-node-content-wrapper'")
    expect(source).toContain('const explicitRole = target.getAttribute(\'role\')')
    expect(source).not.toContain("element.getAttribute('role') || 'button'")
    expect(source).toContain('context: compact')
    expect(source).toContain('[data-row-key=')
    expect(source).not.toContain("element.click()")
    expect(source).not.toContain("dispatchEvent(new MouseEvent('click'")
  })
})
