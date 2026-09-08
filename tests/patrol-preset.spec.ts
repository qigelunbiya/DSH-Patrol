import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const normalizeNewlines = (value: string) => value.replace(/\r\n/g, '\n')

describe('Patrol preset compatibility', () => {
  it('does not couple Patrol mounting to the versioned Harness persona config schema', () => {
    const preset = normalizeNewlines(readFileSync(join(root, 'presets', 'patrol', 'agent.cordis.yml'), 'utf8'))
    const installer = normalizeNewlines(readFileSync(join(root, 'scripts', 'install-local.ps1'), 'utf8'))
    const prompt = normalizeNewlines(readFileSync(join(root, 'src', 'prompt.ts'), 'utf8'))
    const testMode = normalizeNewlines(readFileSync(join(root, 'src', 'test-mode.ts'), 'utf8'))

    // Harness changed @deepseek-ai/dsh-persona from required `config.text` to
    // required `config.prefix` in 2026-09. Patrol owns its identity/workflow
    // prompt itself, so composing that external row only creates a needless
    // compatibility failure that makes the preset visible but unmountable.
    expect(preset).not.toContain("name: '@deepseek-ai/dsh-persona'")
    expect(installer).not.toContain("name: '@deepseek-ai/dsh-persona'")
    expect(prompt).toContain('你正在运行 DSH Patrol 模式')
    expect(testMode).toContain('DSH Patrol TEST MODE')
  })

  it('mounts Harness native filesystem/image tools in both source and installed preset templates', () => {
    const preset = normalizeNewlines(readFileSync(join(root, 'presets', 'patrol', 'agent.cordis.yml'), 'utf8'))
    const installer = normalizeNewlines(readFileSync(join(root, 'scripts', 'install-local.ps1'), 'utf8'))

    expect(preset).toContain("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'")
    expect(installer).toContain("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'")
  })
})
