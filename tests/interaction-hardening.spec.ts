import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(join(process.cwd(), 'browser-extension', 'background-entry.js'), 'utf8')
const source = readFileSync(join(process.cwd(), 'browser-extension', 'interaction-hardening.js'), 'utf8')

describe('browser interaction hardening layer', () => {
  it('loads after frame resilience so it can normalize every final snapshot/click path', () => {
    expect(entry.indexOf("importScripts('interaction-hardening.js')")).toBeGreaterThan(entry.indexOf("importScripts('frame-resilient.js')"))
  })

  it('makes top-document selectors explicit instead of searching identical CSS across iframes', () => {
    expect(source).toContain("const INTERACTION_TOP_FRAME_PREFIX = 'top-frame::'")
    expect(source).toContain('interactionNormalizeSnapshot')
    expect(source).toContain('`${INTERACTION_TOP_FRAME_PREFIX}${rawSelector}`')
  })

  it('promotes input submit values to semantic text and prefers MAIN-world actionability clicks', () => {
    expect(source).toContain("['button', 'submit', 'reset']")
    expect(source).toContain('inputActionText')
    expect(source).toContain("resilientDomFallback(tabId, 'click', args)")
  })

  it('never focuses the OS browser window for tab activation or screenshots', () => {
    expect(source).toContain("if (cmd === 'activateTab')")
    expect(source).toContain("if (cmd === 'screenshot')")
    expect(source).not.toContain('chrome.windows.update')
    expect(source).toContain('captureVisibleTab(tab.windowId')
  })

  it('implements exact native select by value, label, or index with change events', () => {
    expect(source).toContain("if (cmd === 'select')")
    expect(source).toContain('HTMLSelectElement')
    expect(source).toContain("new Event('change', { bubbles: true })")
  })
})
