import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const read = (path: string): string => readFileSync(join(process.cwd(), path), 'utf8')

const shellPreset = read('presets/patrol/agent.cordis.yml')
const teachingPreset = read('presets/patrol-teaching/agent.cordis.yml')
const replayPreset = read('presets/patrol-replay/agent.cordis.yml')
const recoveryPreset = read('presets/patrol-recovery/agent.cordis.yml')
const shellTools = read('src/shell-tools.ts')
const browserPlugin = read('browser-bridge-runtime/tools-plugin.js')
const installer = read('scripts/install-local.ps1')
const internalWorker = read('src/internal-worker.ts')

describe('lazy Patrol architecture', () => {
  it('keeps the user-facing Patrol preset as a lightweight shell', () => {
    expect(shellPreset).toContain('profile: shell')
    expect(shellPreset).not.toContain("name: 'dsh-patrol/browser-tools'")
    expect(shellPreset).not.toContain("name: '@deepseek-ai/dsh-tool-fs'")
  })


  it('keeps internal workers out of the Harness preset roster', () => {
    expect(installer).toContain('Install-LazyPreset -PresetId "patrol"')
    expect(installer).not.toContain('Install-LazyPreset -PresetId "patrol-teaching"')
    expect(installer).not.toContain('Install-LazyPreset -PresetId "patrol-replay"')
    expect(installer).not.toContain('Install-LazyPreset -PresetId "patrol-recovery"')
    expect(installer).toContain('internal-workers')
    expect(installer).toContain('Remove-LegacyManagedWorkerPreset')
    expect(internalWorker).toContain("'@deepseek-ai/dsh-agent-presets'")
    expect(internalWorker).toContain('mountPreset')
  })

  it('isolates heavy teaching, deterministic replay, and exception recovery', () => {
    expect(teachingPreset).toContain('profile: teaching')
    expect(replayPreset).toContain('profile: replay')
    expect(recoveryPreset).toContain('profile: recovery')
    expect(replayPreset).not.toContain("name: '@deepseek-ai/dsh-persona'")
  })

  it('keeps the shell model-visible surface to four orchestration tools', () => {
    const names = [...shellTools.matchAll(/name:\s*'([^']+)'/g)].map(match => match[1]).filter(name => name.startsWith('patrol_'))
    expect(new Set(names)).toEqual(new Set([
      'patrol_list_flows',
      'patrol_resolve_flow',
      'patrol_start_teaching',
      'patrol_run_flow',
    ]))
  })

  it('caps exception recovery browser capability instead of exposing the full teaching set', () => {
    expect(browserPlugin).toContain("const RECOVERY_BASE_TOOLS = new Set")
    expect(browserPlugin).toContain("profile === 'recovery'")
    expect(browserPlugin).toContain('RECOVERY_BROWSER_TOOL_BUDGET = 15')
  })

  it('runs replay through ToolRuntime without sending an LLM prompt', () => {
    expect(shellTools).toContain("name: 'patrol_run_flow'")
    expect(shellTools).toContain('runMaintenance')
    expect(shellTools).toContain("name: 'patrol_run_flow'")
    expect(shellTools).not.toContain("prompt([{ type: 'text'")
  })
})
