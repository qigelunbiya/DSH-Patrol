import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = fileURLToPath(new URL('../', import.meta.url))
const normalizeNewlines = (value: string) => value.replace(/\r\n/g, '\n')
const preset = (id: string) => normalizeNewlines(readFileSync(join(root, 'presets', id, 'agent.cordis.yml'), 'utf8'))

describe('Patrol lazy presets', () => {
  it('keeps the user-facing Patrol preset lightweight and Chinese', () => {
    const shell = preset('patrol')
    expect(shell).toContain('你是 DSH Patrol 轻量巡检入口 Agent')
    expect(shell).toContain('跟随用户最近一条自然语言消息')
    expect(shell).toContain('profile: shell')
    expect(shell).not.toContain("name: 'dsh-patrol/browser-tools'")
    expect(shell).not.toContain("name: '@deepseek-ai/dsh-tool-fs'")
  })

  it('mounts filesystem and browser capabilities only in the teaching worker', () => {
    const teaching = preset('patrol-teaching')
    expect(teaching).toContain("name: '@deepseek-ai/dsh-tool-fs'")
    expect(teaching).toContain("name: 'dsh-patrol/browser-tools'")
    expect(teaching).toContain('profile: teaching')
  })

  it('keeps deterministic replay persona-free and recovery separate', () => {
    const replay = preset('patrol-replay')
    const recovery = preset('patrol-recovery')
    expect(replay).toContain('profile: replay')
    expect(replay).not.toContain("name: '@deepseek-ai/dsh-persona'")
    expect(recovery).toContain('profile: recovery')
    expect(recovery).toContain('异常恢复 Worker')
  })
})
