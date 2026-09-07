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
function readLoader(ctx) {
  const read = value => {
    try { return value?.get?.('loader') } catch { return undefined }
  }
  return read(ctx) ?? read(ctx?.root)
}

function nonEmptyBaseUrl(value) {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

// Harness app boot assigns ctx.baseUrl before applying Loader and normally does
// not populate loader.config.baseUrl. Read the real loader/root context first;
// config remains only a compatibility fallback for custom embeddings.
function readHarnessBaseUrl(ctx, loader) {
  return nonEmptyBaseUrl(loader?.ctx?.baseUrl)
    ?? nonEmptyBaseUrl(ctx?.root?.baseUrl)
    ?? nonEmptyBaseUrl(loader?.config?.baseUrl)
    ?? nonEmptyBaseUrl(ctx?.baseUrl)
}

export async function mountInternalPatrolWorker(hostCtx, agentCtx, compositionPath, kind) {
  if (!isAbsolute(compositionPath)) throw new Error(`internal Patrol worker composition must be absolute: ${compositionPath}`)
  await access(compositionPath)
  const loader = readLoader(hostCtx)
  const importer = loader?.internal?.import
  if (!loader || typeof importer !== 'function') {
    throw new Error('Harness Loader module importer is unavailable on the Patrol host context; cannot mount a hidden Patrol worker composition')
  }
  const baseUrl = readHarnessBaseUrl(hostCtx, loader)
  if (!baseUrl) {
    throw new Error('Harness module base URL is unavailable on the Loader/root context; cannot mount a hidden Patrol worker composition')
  }
  const [presetModule, scopeModule] = await Promise.all([
    Promise.resolve(importer.call(loader.internal, '@deepseek-ai/dsh-agent-presets', baseUrl, {})),
    Promise.resolve(importer.call(loader.internal, '@deepseek-ai/dsh-scope', baseUrl, {})),
  ])
  if (typeof presetModule?.mountPreset !== 'function') {
    throw new Error('Harness @deepseek-ai/dsh-agent-presets does not export mountPreset; update Harness before using hidden Patrol workers')
  }
  if (typeof scopeModule?.createScope !== 'function' || typeof scopeModule.scopeOf !== 'function' || typeof scopeModule.bindScopeParent !== 'function') {
    throw new Error('Harness @deepseek-ai/dsh-scope is missing worker scope APIs; update Harness before using hidden Patrol workers')
  }
  const workerKey = { agentPreset: `dsh-patrol-internal-${kind}` }
  const workerScope = scopeModule.createScope(hostCtx?.root ?? hostCtx, workerKey)
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
