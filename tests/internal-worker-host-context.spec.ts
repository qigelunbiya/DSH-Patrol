import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mountInternalPatrolWorker } from '../src/internal-worker.js'

describe('hidden Patrol worker mounting', () => {
  it('loads Harness modules from the host context while the new Agent is still bare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-worker-'))
    const composition = join(root, 'teaching.cordis.yml')
    await writeFile(composition, '[]\n', 'utf8')

    const workerScope = { ctx: { marker: 'worker-scope' }, dispose: vi.fn(async () => {}) }
    const agentKey = { session: 'bare-agent' }
    const createScope = vi.fn(() => workerScope)
    const scopeOf = vi.fn(() => agentKey)
    const bindScopeParent = vi.fn()
    const mountPreset = vi.fn(async () => {})
    const importer = vi.fn(async (name: string) => {
      if (name === '@deepseek-ai/dsh-agent-presets') return { mountPreset }
      if (name === '@deepseek-ai/dsh-scope') return { createScope, scopeOf, bindScopeParent }
      throw new Error(`unexpected import ${name}`)
    })
    const hostRoot = {
      get: vi.fn((name: string) => name === 'loader' ? { config: { baseUrl: 'file:///harness/' }, internal: { import: importer } } : undefined),
    }
    const hostCtx = { root: hostRoot, get: vi.fn(() => undefined) }
    const disposers: Array<() => Promise<void> | void> = []
    const agentCtx = {
      get: vi.fn(() => undefined),
      effect: vi.fn((factory: () => () => Promise<void> | void) => { disposers.push(factory()) }),
    }

    await mountInternalPatrolWorker(hostCtx as never, agentCtx as never, composition, 'teaching')

    expect(agentCtx.get).not.toHaveBeenCalledWith('loader')
    expect(importer).toHaveBeenCalledWith('@deepseek-ai/dsh-agent-presets', 'file:///harness/', {})
    expect(importer).toHaveBeenCalledWith('@deepseek-ai/dsh-scope', 'file:///harness/', {})
    expect(createScope).toHaveBeenCalledWith(hostRoot, { agentPreset: 'dsh-patrol-internal-teaching' })
    expect(mountPreset).toHaveBeenCalledWith(workerScope.ctx, {
      id: 'dsh-patrol-internal-teaching', trust: 'user', path: composition,
    })
    expect(bindScopeParent).toHaveBeenCalledWith(agentKey, { agentPreset: 'dsh-patrol-internal-teaching' })
    expect(disposers).toHaveLength(1)
    await disposers[0]?.()
    expect(workerScope.dispose).toHaveBeenCalledOnce()
  })
})
