import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export type PatrolInternalWorkerKind = 'teaching' | 'replay' | 'recovery'

type LoaderLike = {
  /** Loader's own context. App boot stores the active module base here. */
  ctx?: { baseUrl?: string }
  /** Compatibility only: normal Harness app boot does not populate this field. */
  config?: { baseUrl?: string }
  internal?: {
    import(name: string, baseUrl: string, options: Record<string, never>): unknown
  }
}

type AgentPresetsModuleLike = {
  mountPreset?: (
    agentCtx: Context,
    preset: { id: string; trust: 'user'; path: string },
  ) => Promise<void>
}

type ScopeKeyLike = Record<string, unknown>

type ScopeLike = {
  ctx: Context
  dispose(): Promise<void>
}

type ScopeModuleLike = {
  createScope?: (ctx: Context, key: ScopeKeyLike) => ScopeLike
  scopeOf?: (ctx: Context) => ScopeKeyLike | undefined
  bindScopeParent?: (key: ScopeKeyLike, parent: ScopeKeyLike) => unknown
}

function readLoader(ctx: Context): LoaderLike | undefined {
  const read = (value: unknown): LoaderLike | undefined => {
    try {
      return (value as { get?(name: string): unknown } | undefined)?.get?.('loader') as LoaderLike | undefined
    } catch {
      return undefined
    }
  }
  return read(ctx) ?? read((ctx as unknown as { root?: Context }).root)
}

function nonEmptyBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Harness app boot sets `ctx.baseUrl` before applying Loader and normally calls
 * `ctx.plugin(Loader)` with no `Loader.Config.baseUrl`. Therefore
 * `loader.config.baseUrl` is not an availability signal. Prefer the Loader's
 * own context/root base and keep config only as a compatibility fallback.
 */
function readHarnessBaseUrl(ctx: Context, loader: LoaderLike): string | undefined {
  const root = (ctx as unknown as { root?: { baseUrl?: string } }).root
  const local = ctx as unknown as { baseUrl?: string }
  return nonEmptyBaseUrl(loader.ctx?.baseUrl)
    ?? nonEmptyBaseUrl(root?.baseUrl)
    ?? nonEmptyBaseUrl(loader.config?.baseUrl)
    ?? nonEmptyBaseUrl(local.baseUrl)
}

function mountBaseContext(ctx: Context): Context {
  return (ctx as unknown as { root?: Context }).root ?? ctx
}

/** Resolve a Patrol-owned worker composition that deliberately lives outside
 * Harness's discoverable agent-preset roots. */
export function internalPatrolWorkerPath(root: string, kind: PatrolInternalWorkerKind): string {
  const value = root.trim()
  if (!value) throw new Error('DSH Patrol internal worker root is not configured; reinstall the local Patrol integration')
  if (!isAbsolute(value)) throw new Error(`DSH Patrol internal worker root must be absolute: ${value}`)
  return join(value, `${kind}.cordis.yml`)
}

/** Mount one hidden worker composition into an ephemeral scoped Agent.
 *
 * Do not resolve this through agentPresets: discoverable presets are user-facing
 * by design and therefore appear in Harness's mode picker. The low-level
 * mountPreset implementation is loaded from Harness itself through its Loader,
 * guaranteeing the same dsh-scope/Cordis package identities as the host. */
export async function mountInternalPatrolWorker(
  hostCtx: Context,
  agentCtx: Context,
  compositionPath: string,
  kind: PatrolInternalWorkerKind,
): Promise<void> {
  if (!isAbsolute(compositionPath)) throw new Error(`internal Patrol worker composition must be absolute: ${compositionPath}`)
  await access(compositionPath)

  // A freshly-created Agent context is intentionally bare until setup() joins
  // it to a composition. Resolve Loader from the already-running host/Patrol
  // context, then resolve the import base the same way Harness app boot does.
  const loader = readLoader(hostCtx)
  const importer = loader?.internal?.import
  if (loader === undefined || typeof importer !== 'function') {
    throw new Error('Harness Loader module importer is unavailable on the Patrol host context; cannot mount a hidden Patrol worker composition')
  }
  const baseUrl = readHarnessBaseUrl(hostCtx, loader)
  if (baseUrl === undefined) {
    throw new Error('Harness module base URL is unavailable on the Loader/root context; cannot mount a hidden Patrol worker composition')
  }

  const [presetModule, scopeModule] = await Promise.all([
    Promise.resolve(importer.call(loader.internal, '@deepseek-ai/dsh-agent-presets', baseUrl, {})) as Promise<AgentPresetsModuleLike>,
    Promise.resolve(importer.call(loader.internal, '@deepseek-ai/dsh-scope', baseUrl, {})) as Promise<ScopeModuleLike>,
  ])
  if (typeof presetModule?.mountPreset !== 'function') {
    throw new Error('Harness @deepseek-ai/dsh-agent-presets does not export mountPreset; update Harness before using hidden Patrol workers')
  }
  if (typeof scopeModule?.createScope !== 'function' || typeof scopeModule.scopeOf !== 'function' || typeof scopeModule.bindScopeParent !== 'function') {
    throw new Error('Harness @deepseek-ai/dsh-scope is missing worker scope APIs; update Harness before using hidden Patrol workers')
  }

  // Mirror AgentPresets' supported standing-mount shape without adding these
  // workers to its discoverable roster: mount under a loader-bearing host scope,
  // then parent the bare Agent scope to it during setup().
  const workerKey: ScopeKeyLike = { agentPreset: `dsh-patrol-internal-${kind}` }
  const workerScope = scopeModule.createScope(mountBaseContext(hostCtx), workerKey)
  try {
    await presetModule.mountPreset(workerScope.ctx, {
      id: `dsh-patrol-internal-${kind}`,
      trust: 'user',
      path: compositionPath,
    })
    const agentKey = scopeModule.scopeOf(agentCtx)
    if (agentKey === undefined) throw new Error('internal Patrol worker Agent has no Harness scope key')
    scopeModule.bindScopeParent(agentKey, workerKey)
    agentCtx.effect(
      () => () => workerScope.dispose(),
      `dsh-patrol/internal-${kind}: dispose hidden worker composition`,
    )
  } catch (error) {
    await workerScope.dispose().catch(() => {})
    throw error
  }
}
