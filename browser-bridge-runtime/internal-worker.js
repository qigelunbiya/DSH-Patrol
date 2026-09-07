import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'

/** Resolve a Patrol-owned worker composition that deliberately lives outside
 * Harness's discoverable agent-preset roots. */
export function internalPatrolWorkerPath(root, kind) {
  const value = String(root ?? '').trim()
  if (!value) throw new Error('DSH Patrol internal worker root is not configured; reinstall the local Patrol integration')
  if (!isAbsolute(value)) throw new Error(`DSH Patrol internal worker root must be absolute: ${value}`)
  return join(value, `${kind}.cordis.yml`)
}

/** Mount one hidden worker composition into an ephemeral scoped Agent.
 *
 * Browser runtime modules are executed directly from the source/package tree,
 * so this helper intentionally lives beside them instead of importing lib/.
 * The TypeScript Patrol shell keeps an equivalent typed helper under src/. */
export async function mountInternalPatrolWorker(agentCtx, compositionPath, kind) {
  if (!isAbsolute(compositionPath)) throw new Error(`internal Patrol worker composition must be absolute: ${compositionPath}`)
  await access(compositionPath)
  const loader = agentCtx?.get?.('loader')
  const baseUrl = loader?.config?.baseUrl
  const importer = loader?.internal?.import
  if (!baseUrl || typeof importer !== 'function') {
    throw new Error('Harness Loader is unavailable; cannot mount a hidden Patrol worker composition')
  }
  const loaded = await Promise.resolve(importer.call(loader.internal, '@deepseek-ai/dsh-agent-presets', baseUrl, {}))
  if (typeof loaded?.mountPreset !== 'function') {
    throw new Error('Harness @deepseek-ai/dsh-agent-presets does not export mountPreset; update Harness before using hidden Patrol workers')
  }
  await loaded.mountPreset(agentCtx, {
    id: `dsh-patrol-internal-${kind}`,
    trust: 'user',
    path: compositionPath,
  })
}
