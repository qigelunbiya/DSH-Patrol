import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(
  join(process.cwd(), 'browser-extension', 'interaction-hardening.js'),
  'utf8',
)
const backgroundSource = readFileSync(
  join(process.cwd(), 'browser-extension', 'background.js'),
  'utf8',
)
const controllerSource = readFileSync(
  join(process.cwd(), 'browser-bridge-runtime', 'stable-managed-browser-controller.js'),
  'utf8',
)

describe('browser Action Map compact icon controls', () => {
  it('admits small unlabeled pointer controls without changing broad-wrapper rules', () => {
    expect(source).toContain('const compactIconPointer =')
    expect(source).toContain('(pointerAction || parentPointerAction)')
    expect(source).toContain('width <= 72 && height <= 72')
    expect(source).toContain('width * height <= 4_096')
    expect(source).toContain("'icon-control'")
    expect(source).toContain('hasStrongActionDescendant(element)')
  })

  it('forces a best-effort in-place extension refresh when the icon-candidate capability is stale', () => {
    expect(backgroundSource).toContain("'compactIconActionMapV1'")
    expect(controllerSource).toContain("!capabilities.includes('compactIconActionMapV1')")
    expect(controllerSource).toContain('attempting a best-effort in-place refresh without closing Chromium')
  })

  it('uses nearby labels to ground triangle/dropdown/filter icon candidates', () => {
    expect(source).toContain('const nearbyControlContext = element =>')
    expect(source).toContain('parent.previousElementSibling')
    expect(source).toContain('parent.nextElementSibling')
    expect(source).toContain('candidate.nearbyContext')
    expect(source).toMatch(/三角.*箭头.*下拉.*展开.*筛选/s)
    expect(source).toContain('compactIconPointer) score += iconIntent ? 980 : 180')
  })
})
