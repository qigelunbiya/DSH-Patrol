import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const source = readFileSync(join(process.cwd(), 'browser-bridge-runtime', 'tools-plugin.js'), 'utf8')

describe('Patrol managed browser lazy start', () => {
  it('does not launch Chromium merely because Patrol mode was selected', () => {
    const starts = source.match(/await service\.ensureBrowser\(\)/g) || []
    expect(starts).toHaveLength(1)
    expect(source).toContain("if (!service.bridge.connected && typeof service.ensureBrowser === 'function')")
    expect(source).toContain('starts only when a deterministic runner, teaching worker, or recovery worker')
    expect(source).not.toContain('Selecting Patrol mode should be enough for the browser side to become')
  })
})
