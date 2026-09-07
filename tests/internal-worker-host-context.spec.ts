import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { mountInternalPatrolWorker as mountRuntimeWorker } from '../browser-bridge-runtime/internal-worker.js'
import { mountInternalPatrolWorker as mountTypedWorker } from '../src/internal-worker.js'

type MountWorker = (
  hostCtx: never,
  agentCtx: never,
  compositionPath: string,
  kind: 'teaching',
) => Promise<void>

const implementations = [
  ['typed shell helper', mountTypedWorker as MountWorker],
  ['browser runtime helper', mountRuntimeWorker as MountWorker],
] as const

describe('hidden Patrol worker mounting', () => {
  for (const [label, mountWorker] of implementations) {
    it(`${label} uses the real Harness context base when Loader config has no baseUrl`, async () => {
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

      // This is the important production shape. Harness app boot does:
      //   ctx.baseUrl = ...; await ctx.plugin(Loader)
      // so Loader.config.baseUrl is normally absent even though Loader is healthy.
      const harnessBaseUrl = 'file:///harness-profile/'
      const loader = {
        config: {},
        ctx: { baseUrl: harnessBaseUrl },
        internal: { import: importer },
      }
      const hostRoot = {
        baseUrl: harnessBaseUrl,
        get: vi.fn((name: string) => name === 'loader' ? loader : undefined),
      }
      const hostCtx = { root: hostRoot, get: vi.fn(() => undefined) }
      const disposers: Array<() => Promise<void> | void> = []
      const agentCtx = {
        get: vi.fn(() => undefined),
        effect: vi.fn((factory: () => () => Promise<void> | void) => { disposers.push(factory()) }),
      }

      expect(loader.config).not.toHaveProperty('baseUrl')
      await mountWorker(hostCtx as never, agentCtx as never, composition, 'teaching')

      expect(agentCtx.get).not.toHaveBeenCalledWith('loader')
      expect(importer).toHaveBeenCalledWith('@deepseek-ai/dsh-agent-presets', harnessBaseUrl, {})
      expect(importer).toHaveBeenCalledWith('@deepseek-ai/dsh-scope', harnessBaseUrl, {})
      expect(createScope).toHaveBeenCalledWith(hostRoot, { agentPreset: 'dsh-patrol-internal-teaching' })
      expect(mountPreset).toHaveBeenCalledWith(workerScope.ctx, {
        id: 'dsh-patrol-internal-teaching', trust: 'user', path: composition,
      })
      expect(bindScopeParent).toHaveBeenCalledWith(agentKey, { agentPreset: 'dsh-patrol-internal-teaching' })
      expect(disposers).toHaveLength(1)
      await disposers[0]?.()
      expect(workerScope.dispose).toHaveBeenCalledOnce()
    })

    it(`${label} falls back to the root context base when the Loader proxy does not expose ctx.baseUrl`, async () => {
      const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-worker-'))
      const composition = join(root, 'recovery.cordis.yml')
      await writeFile(composition, '[]\n', 'utf8')

      const workerScope = { ctx: {}, dispose: vi.fn(async () => {}) }
      const agentKey = { session: 'bare-agent' }
      const mountPreset = vi.fn(async () => {})
      const createScope = vi.fn(() => workerScope)
      const scopeOf = vi.fn(() => agentKey)
      const bindScopeParent = vi.fn()
      const importer = vi.fn(async (name: string) => name === '@deepseek-ai/dsh-agent-presets'
        ? { mountPreset }
        : { createScope, scopeOf, bindScopeParent })
      const harnessBaseUrl = 'file:///profile-root/'
      const loader = { config: {}, internal: { import: importer } }
      const hostRoot = {
        baseUrl: harnessBaseUrl,
        get: vi.fn((name: string) => name === 'loader' ? loader : undefined),
      }
      const hostCtx = { root: hostRoot, get: vi.fn(() => undefined) }
      const agentCtx = { effect: vi.fn(() => {}) }

      await mountWorker(hostCtx as never, agentCtx as never, composition, 'teaching')

      expect(importer).toHaveBeenCalledWith('@deepseek-ai/dsh-agent-presets', harnessBaseUrl, {})
      expect(importer).toHaveBeenCalledWith('@deepseek-ai/dsh-scope', harnessBaseUrl, {})
    })
  }
})
