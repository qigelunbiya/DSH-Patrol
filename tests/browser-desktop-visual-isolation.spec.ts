import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(join(process.cwd(), path), 'utf8')

describe('browser/desktop visual plane isolation', () => {
  it('keeps browser visual runtime free of desktop visual tool/state dependencies', () => {
    const browserSources = [
      read('src/visual-click-tools.ts'),
      read('src/observation-tools.ts'),
      read('browser-extension/interaction-hardening.js'),
      read('browser-bridge-runtime/tools.js'),
    ].join('\n')

    expect(browserSources).not.toMatch(/desktop-runtime/)
    expect(browserSources).not.toMatch(/desktop_(?:visual_action_map|click_visual|focus_visual)/)
    expect(browserSources).not.toMatch(/visual-[0-9a-f]{8}-[0-9a-f-]{27,}/i)
  })

  it('keeps desktop visual runtime independent from browser visual frames and browser click primitives', () => {
    const desktopSources = [
      read('desktop-runtime/windows-driver.js'),
      read('desktop-runtime/tools-plugin.js'),
      read('desktop-runtime/windows-desktop.ps1'),
    ].join('\n')

    expect(desktopSources).not.toMatch(/browser_visual_click/)
    expect(desktopSources).not.toMatch(/patrol_visual_click_target/)
    expect(desktopSources).not.toMatch(/browser-visual-/)
  })
})
