// Agent-plane browser tool registrar for DSH Patrol.
//
// The WebSocket/HTTP transport and the zero-config managed Chromium launcher
// are host-owned by browser-bridge-runtime/index.js. This plugin belongs in the
// Patrol Agent Preset and contributes only browser_* tool schemas to that
// preset's scoped ToolRuntime layer.
//
// Keep this as a namespace Cordis plugin: do NOT add `export default apply`.
// Harness Loader prefers a module's default export and would otherwise discard
// the sibling `inject` metadata before the preset is mounted.
import { registerChallengeTool } from './challenge-tool.js'
import { registerCountTool } from './count-tool.js'
import { registerImageCodeRefreshTool } from './image-code-refresh-tool.js'
import { registerImageCodeVisualTool } from './image-code-visual-tool.js'
import { registerLoginStateTool } from './login-state-tool.js'
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

  // Selecting Patrol mode should be enough for the browser side to become
  // usable. The host launches an isolated Chromium profile and installs the
  // bundled extension through CDP. Startup failures are logged but do not make
  // the preset snap back to Standard mode; patrol_doctor can still diagnose it.
  if (typeof service.ensureBrowser === 'function') {
    try {
      await service.ensureBrowser()
    } catch (error) {
      ctx.logger.warn?.(`[dsh-patrol/browser-tools] managed browser is not ready: ${error?.message ?? error}`)
    }
  }

  // Re-check managed browser availability before every real browser request so
  // closing the Patrol browser window does not permanently break the session.
  // DOM commands get a short bounded retry because a newly navigated page can
  // exist before its content-script bridge finishes attaching.
  const retryableDomCommands = new Set([
    'snapshot', 'readPage', 'challengeSignals', 'imageCodeTarget', 'captureImageCode', 'count',
    'click', 'type', 'press', 'scroll', 'wait',
  ])
  const bridge = {
    get connected() { return service.bridge.connected },
    status: (...args) => service.bridge.status(...args),
    saveScreenshot: (...args) => service.bridge.saveScreenshot(...args),
    async request(cmd, args, options) {
      if (!service.bridge.connected && typeof service.ensureBrowser === 'function') {
        await service.ensureBrowser()
      }
      const delays = retryableDomCommands.has(cmd) ? [0, 160, 360, 700] : [0]
      let lastError
      for (const delay of delays) {
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay))
        try {
          return await service.bridge.request(cmd, args, options)
        } catch (error) {
          lastError = error
          const message = String(error?.message ?? error)
          if (!retryableDomCommands.has(cmd)
            || !/page bridge unavailable|receiving end does not exist|could not establish connection|message port closed/i.test(message)) {
            throw error
          }
        }
      }
      throw lastError
    },
  }

  ctx.effect(() => registerTools(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
    bridgeUrlHint: typeof service.bridgeUrlHint === 'function' ? service.bridgeUrlHint : () => '',
  }), 'dsh-patrol/browser-tools: scoped browser tools')
  ctx.effect(() => registerCountTool(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
  }), 'dsh-patrol/browser-tools: scoped count tool')
  ctx.effect(() => registerChallengeTool(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
  }), 'dsh-patrol/browser-tools: scoped auth challenge detector')
  ctx.effect(() => registerImageCodeVisualTool(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
  }), 'dsh-patrol/browser-tools: current image-code visual crop')
  ctx.effect(() => registerImageCodeRefreshTool(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
  }), 'dsh-patrol/browser-tools: current image-code refresh recovery')
  ctx.effect(() => registerTotpTool(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
    minimumValiditySeconds: config.totpMinimumValiditySeconds ?? 5,
  }), 'dsh-patrol/browser-tools: encrypted TOTP profile input')
  ctx.effect(() => registerLoginStateTool(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
  }), 'dsh-patrol/browser-tools: scoped login-state detector')
  ctx.effect(() => registerTransientTool(ctx, bridge, {
    commandTimeoutMs: config.commandTimeoutMs ?? 60000,
  }), 'dsh-patrol/browser-tools: scoped transient input replay')
}
