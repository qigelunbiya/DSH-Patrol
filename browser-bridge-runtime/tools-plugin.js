// Agent-plane browser tool registrar for DSH Patrol.
//
// The WebSocket/HTTP transport is host-owned by browser-bridge-runtime/index.js.
// This plugin belongs in the Patrol Agent Preset and contributes only browser_*
// tool schemas to that preset's scoped ToolRuntime layer.
//
// Keep this as a namespace Cordis plugin: do NOT add `export default apply`.
// Harness Loader prefers a module's default export and would otherwise discard
// the sibling `inject` metadata before the preset is mounted.
import { registerTools } from './tools.js'

export const name = 'dsh-patrol-browser-tools'
export const inject = ['tools', 'patrolBrowserBridge']

export function apply(ctx, config = {}) {
  const service = ctx.get('patrolBrowserBridge')
  if (!service || !service.bridge) {
    throw new Error('dsh-patrol/browser-tools: host patrolBrowserBridge service is unavailable; install the DSH Patrol host bundle before using the Patrol preset')
  }

  ctx.effect(() => registerTools(ctx, service.bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
    bridgeUrlHint: typeof service.bridgeUrlHint === 'function' ? service.bridgeUrlHint : () => '',
  }), 'dsh-patrol/browser-tools: scoped browser tools')
}
