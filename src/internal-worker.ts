import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export type PatrolInternalWorkerKind = 'teaching' | 'replay' | 'recovery'

type LoaderLike = {
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
  agentCtx: Context,
  compositionPath: string,
  kind: PatrolInternalWorkerKind,
): Promise<void> {
  if (!isAbsolute(compositionPath)) throw new Error(`internal Patrol worker composition must be absolute: ${compositionPath}`)
  await access(compositionPath)
  const loader = (agentCtx as unknown as { get(name: string): unknown }).get('loader') as LoaderLike | undefined
  const baseUrl = loader?.config?.baseUrl
  const importer = loader?.internal?.import
  if (!baseUrl || typeof importer !== 'function') {
    throw new Error('Harness Loader is unavailable; cannot mount a hidden Patrol worker composition')
  }
  const loaded = await Promise.resolve(importer.call(loader.internal, '@deepseek-ai/dsh-agent-presets', baseUrl, {})) as AgentPresetsModuleLike
  if (typeof loaded?.mountPreset !== 'function') {
    throw new Error('Harness @deepseek-ai/dsh-agent-presets does not export mountPreset; update Harness before using hidden Patrol workers')
  }
  await loaded.mountPreset(agentCtx, {
    id: `dsh-patrol-internal-${kind}`,
    trust: 'user',
    path: compositionPath,
  })
}
