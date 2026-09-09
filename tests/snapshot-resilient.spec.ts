import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const entry = readFileSync(join(process.cwd(), 'browser-extension', 'background-entry.js'), 'utf8')
const source = readFileSync(join(process.cwd(), 'browser-extension', 'snapshot-resilient.js'), 'utf8')

describe('resilient browser snapshot layer', () => {
  it('loads after frame resilience and before interaction hardening', () => {
    expect(entry.indexOf("importScripts('snapshot-resilient.js')")).toBeGreaterThan(entry.indexOf("importScripts('frame-resilient.js')"))
    expect(entry.indexOf("importScripts('snapshot-resilient.js')")).toBeLessThan(entry.indexOf("importScripts('interaction-hardening.js')"))
  })

  it('can collect CURRENT interactive DOM through Chrome MAIN world when the content bridge is unavailable', () => {
    expect(source).toContain("world: 'MAIN'")
    expect(source).toContain('snapshotResilientFallback')
    expect(source).toContain('main-world-snapshot-fallback')
  })

  it('preserves exact frame ownership instead of returning ambiguous raw selectors', () => {
    expect(source).toContain('top-frame::')
    expect(source).toContain('frame-url(')
    expect(source).toContain('stableFrameUrl')
  })

  it('recognizes traditional directive controls and builds selectors from stable menu structure', () => {
    expect(source).toContain('[bg-click]')
    expect(source).toContain('[ng-click]')
    expect(source).toContain("'menuid'")
    expect(source).toContain('node.id')
    expect(source).toContain('path.unshift')
  })

  it('filters hidden/offscreen duplicates before semantic click resolution', () => {
    expect(source).toContain("style.display === 'none'")
    expect(source).toContain('getBoundingClientRect')
    expect(source).toContain('includeHidden')
  })
})
