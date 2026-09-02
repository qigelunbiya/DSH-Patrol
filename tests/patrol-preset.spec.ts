import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const normalizeNewlines = (value: string) => value.replace(/\r\n/g, '\n')

describe('Patrol preset workspace image tools', () => {
  it('keeps the preset persona in Chinese with same-language reply guidance', () => {
    const preset = normalizeNewlines(readFileSync(join(root, 'presets', 'patrol', 'agent.cordis.yml'), 'utf8'))
    const installer = normalizeNewlines(readFileSync(join(root, 'scripts', 'install-local.ps1'), 'utf8'))

    expect(preset).toContain('你是 DSH Patrol 专用巡检 Agent')
    expect(preset).toContain('跟随用户最近一条自然语言消息')
    expect(installer).toContain('\\u4f60\\u662f DSH Patrol')
    expect(installer).toContain('\\u8ddf\\u968f\\u7528\\u6237\\u6700\\u8fd1\\u4e00\\u6761')
  })

  it('mounts Harness native filesystem/image tools in both source and installed preset templates', () => {
    const preset = normalizeNewlines(readFileSync(join(root, 'presets', 'patrol', 'agent.cordis.yml'), 'utf8'))
    const installer = normalizeNewlines(readFileSync(join(root, 'scripts', 'install-local.ps1'), 'utf8'))

    expect(preset).toContain("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'")
    expect(installer).toContain("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'")
  })
})
