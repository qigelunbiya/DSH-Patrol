import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(join(process.cwd(), 'browser-extension', 'background-entry.js'), 'utf8')
const source = readFileSync(join(process.cwd(), 'browser-extension', 'selector-scope-hardening.js'), 'utf8')

describe('selector scope hardening', () => {
  it('loads after general interaction hardening and before the modal-only final layer', () => {
    const interactionIndex = entry.indexOf("importScripts('interaction-hardening.js')")
    const selectorIndex = entry.indexOf("importScripts('selector-scope-hardening.js')")
    const modalIndex = entry.indexOf("importScripts('modal-target-hardening.js')")
    expect(interactionIndex).toBeGreaterThanOrEqual(0)
    expect(selectorIndex).toBeGreaterThan(interactionIndex)
    expect(modalIndex).toBeGreaterThan(selectorIndex)
    expect(entry.trim().endsWith("importScripts('modal-target-hardening.js')")).toBe(true)
  })

  it('tries an unqualified selector in the top document before scanning child frames', () => {
    expect(source).toContain('top-document selectors first')
    expect(source).toContain('`top-frame::${raw}`')
    expect(source).toContain("cmd !== 'count'")
    expect(source).toContain("scope: 'top-document-preferred'")
  })

  it('does not rewrite selectors that already carry an explicit frame scope', () => {
    expect(source).toContain("raw.startsWith('top-frame::')")
    expect(source).toContain("raw.startsWith('frame-url(')")
  })
})
