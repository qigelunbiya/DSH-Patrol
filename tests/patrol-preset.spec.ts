import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const normalizeNewlines = (value: string) => value.replace(/\r\n/g, '\n')

describe('Patrol preset workspace image tools', () => {
  it('mounts Harness native filesystem/image tools in both source and installed preset templates', () => {
    const preset = normalizeNewlines(readFileSync(join(root, 'presets', 'patrol', 'agent.cordis.yml'), 'utf8'))
    const installer = normalizeNewlines(readFileSync(join(root, 'scripts', 'install-local.ps1'), 'utf8'))

    expect(preset).toContain("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'")
    expect(installer).toContain("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'")
  })
})
