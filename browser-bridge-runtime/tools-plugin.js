// Agent-plane browser tool registrar for DSH Patrol.
//
// The WebSocket/HTTP transport and the zero-config managed Chromium launcher
// are host-owned by browser-bridge-runtime/index.js. This plugin belongs in the
// Patrol Agent Preset and contributes browser primitives plus transient Patrol
// recovery helpers to that preset's scoped ToolRuntime layer.
//
// Keep this as a namespace Cordis plugin: do NOT add `export default apply`.
// Harness Loader prefers a module's default export and would otherwise discard
// the sibling `inject` metadata before the preset is mounted.
//
// Transport delegation now lives in resilient-bridge.js. That wrapper delegates
// requests to service.bridge.request and screenshot persistence to
// service.bridge.saveScreenshot while adding bounded repair/retry semantics.
import { registerChallengeTool } from './challenge-tool.js'
import { registerCountTool } from './count-tool.js'
import { registerImageCodeRefreshTool } from './image-code-refresh-tool.js'
import { registerImageCodeVisualTool } from './image-code-visual-tool.js'
import { registerLoginStateTool } from './login-state-tool.js'
import { registerBrowserRecoveryTools } from './recovery-tool.js'
import { createResilientBrowserBridge } from './resilient-bridge.js'
import { registerSelectTool } from './select-tool.js'
import { registerSemanticClickTool } from './semantic-click-tool.js'
import { registerTotpTool } from './totp-tool.js'
import { registerTransientTool } from './transient-tool.js'
import { registerTools } from './tools.js'

export const name = 'dsh-patrol-browser-tools'
export const inject = ['tools', 'patrolBrowserBridge']

export async function apply(ctx, config = {}) {
  const service = ctx.get('patrolBrowserBridge')
  if (!service || !service.bridge) {
    throw new Error('dsh-patrol/browser-tools: host patrolBrowserBridge service is unavailable; install the DSH Patrol host bundle before using the Patrol preset')
  }

  // Browser startup is intentionally kicked in the background. A slow Chromium
  // launch or stale extension worker must not make the whole Patrol preset wait
  // past Harness' foreground tool deadline. Every actual browser command below
  // goes through the bounded resilient bridge and will wait briefly for the same
  // deduplicated managed-browser startup before failing with actionable state.
  if (typeof service.ensureBrowser === 'function') {
    try {
      const pending = service.ensureBrowser()
      if (pending && typeof pending.then === 'function') {
        void pending.catch(error => ctx.logger.warn?.(`[dsh-patrol/browser-tools] background managed browser startup failed: ${error?.message ?? error}`))
      }
    } catch (error) {
      ctx.logger.warn?.(`[dsh-patrol/browser-tools] could not start managed browser: ${error?.message ?? error}`)
    }
  }

  const commandTimeoutMs = config.commandTimeoutMs ?? 60000
  const bridge = createResilientBrowserBridge(service, {
    commandTimeoutMs,
    logger: ctx.logger,
  })

  ctx.effect(() => registerTools(ctx, bridge, {
    commandTimeoutMs,
    bridgeUrlHint: typeof service.bridgeUrlHint === 'function' ? service.bridgeUrlHint : () => '',
  }), 'dsh-patrol/browser-tools: scoped browser tools')
  ctx.effect(() => registerCountTool(ctx, bridge, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: scoped count tool')
  ctx.effect(() => registerSelectTool(ctx, bridge, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: native select tool')
  ctx.effect(() => registerSemanticClickTool(ctx, bridge, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: atomic semantic click')
  ctx.effect(() => registerChallengeTool(ctx, bridge, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: scoped auth challenge detector')
  ctx.effect(() => registerImageCodeVisualTool(ctx, bridge, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: current image-code visual crop')
  ctx.effect(() => registerImageCodeRefreshTool(ctx, bridge, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: current image-code refresh recovery')
  ctx.effect(() => registerTotpTool(ctx, bridge, {
    commandTimeoutMs,
    minimumValiditySeconds: config.totpMinimumValiditySeconds ?? 5,
  }), 'dsh-patrol/browser-tools: encrypted TOTP profile input')
  ctx.effect(() => registerLoginStateTool(ctx, bridge, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: scoped login-state detector')
  ctx.effect(() => registerTransientTool(ctx, bridge, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: scoped transient input replay')
  ctx.effect(() => registerBrowserRecoveryTools(ctx, bridge, service, {
    commandTimeoutMs,
  }), 'dsh-patrol/browser-tools: bounded managed-browser recovery helpers')
}
