import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import {
  isCudaOutOfMemoryFailure,
  isPatrolQwenConstrainedRoute,
  isQwenLocalAuthUnavailableFailure,
} from './context-pressure-guard.js'

interface RequestRoute {
  provider: string
  model: string
}

interface FailureLike {
  code?: string
  message?: string
}

interface TokenMeasurementLike {
  totalTokens: number
}

interface TokenMeterLike {
  measure(session: unknown): TokenMeasurementLike
}

interface CompactionLike {
  compactIfNeeded(
    agent: unknown,
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal,
  ): Promise<unknown | null>
}

interface ToolResultPrunerLike {
  pruneSession(session: unknown): { pruned?: unknown[]; charsRemoved?: number }
}

interface SessionLike {
  requestHeader(): { config?: Pick<LlmCallConfig, 'provider' | 'model'> } | undefined
  surface?: { replaceGeneration?: number }
}

interface AgentLike {
  session: SessionLike
  options?: {
    provider?: string
    model?: string
  }
}

interface RequestErrorLike {
  agent?: unknown
  turn: number
  step: number
  provider: string
  failure: FailureLike
  signal: AbortSignal
}

interface SeenStep {
  agent: AgentLike
  route?: RequestRoute
}

/**
 * The architectural context window of the local 122B model is not the useful
 * Patrol limit. Long browser traces carry many tool blocks and image metadata,
 * and the local worker can become unavailable well before 16k request tokens.
 * Keep enough headroom that a large observation does not become the request
 * which tips the worker into CUDA OOM / provider cooldown.
 */
export const PATROL_QWEN_HARDENED_PRUNE_LIMIT = 6_000
export const PATROL_QWEN_HARDENED_COMPACT_LIMIT = 10_000
export const PATROL_QWEN_NO_METER_PRUNE_STEP = 4
export const PATROL_QWEN_NO_METER_COMPACT_STEP = 8
export const PATROL_QWEN_AUTH_RETRY_DELAY_MS = 900

function asAgentLike(value: unknown): AgentLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const session = (value as { session?: unknown }).session
  if (session === null || typeof session !== 'object') return undefined
  if (typeof (session as { requestHeader?: unknown }).requestHeader !== 'function') return undefined
  return value as AgentLike
}

function routeFromAgent(agent: AgentLike): RequestRoute | undefined {
  try {
    const config = agent.session.requestHeader()?.config
    if (typeof config?.provider === 'string' && config.provider.length > 0
      && typeof config.model === 'string' && config.model.length > 0) {
      return { provider: config.provider, model: config.model }
    }
  } catch {
    // requestHeader can be unavailable while the request is still being built.
  }
  const provider = agent.options?.provider
  const model = agent.options?.model
  if (typeof provider !== 'string' || provider.length === 0
    || typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

function readTokenMeter(ctx: Context): TokenMeterLike | undefined {
  try {
    return ctx.get('tokenMeter') as TokenMeterLike | undefined
  } catch {
    return undefined
  }
}

function readCompaction(ctx: Context): CompactionLike | undefined {
  try {
    return ctx.get('compaction') as CompactionLike | undefined
  } catch {
    return undefined
  }
}

function readToolResultPruner(ctx: Context): ToolResultPrunerLike | undefined {
  try {
    return ctx.get('toolResultPruner') as ToolResultPrunerLike | undefined
  } catch {
    return undefined
  }
}

function measuredTokens(tokenMeter: TokenMeterLike | undefined, session: SessionLike): number | undefined {
  if (tokenMeter === undefined) return undefined
  try {
    const value = tokenMeter.measure(session)?.totalTokens
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

function replaceGeneration(session: SessionLike): number | undefined {
  const value = session.surface?.replaceGeneration
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function pruneAdvanced(
  session: SessionLike,
  before: number | undefined,
  result: { pruned?: unknown[]; charsRemoved?: number },
): boolean {
  const after = replaceGeneration(session)
  return (Array.isArray(result.pruned) && result.pruned.length > 0)
    || (typeof result.charsRemoved === 'number' && result.charsRemoved > 0)
    || (before !== undefined && after !== undefined && after > before)
}

function annotatePressureFailure(failure: FailureLike, sawCudaOom: boolean): void {
  if (failure.message?.includes('[DSH Patrol diagnostic]') === true) return
  const authUnavailable = isQwenLocalAuthUnavailableFailure(failure)
  const explanation = sawCudaOom
    ? 'The local Qwen worker reported CUDA OOM; the following provider unavailability is treated as a likely recovery/cooldown symptom.'
    : authUnavailable
      ? 'The local Qwen provider is currently unavailable. This can be an auth-pool/cooldown condition and can also follow GPU memory pressure; Patrol does not assume OOM unless the backend actually reported it.'
      : 'The local Qwen worker reported GPU memory exhaustion while processing this Patrol request.'
  failure.message = [
    failure.message ?? failure.code ?? 'model request failed',
    `[DSH Patrol diagnostic] ${explanation}`,
    'Patrol pruned browser tool history and attempted early compaction before the bounded retry.',
  ].join('\n')
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
    signal?.addEventListener('abort', () => {
      clearTimeout(timer)
      resolve()
    }, { once: true })
  })
}

/**
 * Patrol-only pressure guard used by the mounted preset.
 *
 * Compared with the older guard this version has two important properties:
 * - it starts model-free pruning at 6k and compaction at 10k for the local 122B
 *   route, leaving more GPU headroom for the next tool result;
 * - when tokenMeter is unavailable it still has a deterministic model-step
 *   fallback carried across user turns, so a long browser trace cannot reset
 *   the protection merely because Harness started a new turn at step 1.
 *
 * On a real CUDA-OOM/auth-unavailable failure it performs one bounded recovery
 * for that exact model step and waits briefly before retrying auth_unavailable,
 * avoiding the immediate retry storm which can hit the same cooling provider.
 */
export function registerPatrolContextPressureGuard(ctx: Context): () => void {
  const seenSteps = new Map<string, SeenStep>()
  const attemptedRecovery = new WeakMap<object, string>()
  const cudaOomAgents = new WeakSet<object>()
  const cumulativeModelSteps = new WeakMap<object, number>()

  const keyOf = (turn: number, step: number) => `${turn}:${step}`

  function remember(turn: number, step: number, agent: AgentLike, route?: RequestRoute): void {
    seenSteps.set(keyOf(turn, step), { agent, ...(route === undefined ? {} : { route }) })
    if (seenSteps.size <= 32) return
    const oldest = seenSteps.keys().next().value
    if (typeof oldest === 'string') seenSteps.delete(oldest)
  }

  const disposePreStep = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const agent = asAgentLike(payload.agent)
      if (agent === undefined || payload.signal.aborted) return next()
      const route = routeFromAgent(agent)
      remember(payload.turn, payload.step, agent, route)

      // This plugin only mounts in Patrol. Before request routing is fully
      // resolved, protect the request conservatively; a known non-Qwen route
      // keeps Harness' normal policy.
      if (route !== undefined && !isPatrolQwenConstrainedRoute(route)) return next()

      const agentKey = agent as unknown as object
      const cumulativeStep = (cumulativeModelSteps.get(agentKey) ?? 0) + 1
      cumulativeModelSteps.set(agentKey, cumulativeStep)
      const pressureStep = Math.max(payload.step, cumulativeStep)

      const tokenMeter = readTokenMeter(ctx)
      let tokens = measuredTokens(tokenMeter, agent.session)
      const shouldPrune = tokens === undefined
        ? pressureStep >= PATROL_QWEN_NO_METER_PRUNE_STEP
        : tokens >= PATROL_QWEN_HARDENED_PRUNE_LIMIT
      const pruner = readToolResultPruner(ctx)
      if (pruner !== undefined && shouldPrune) {
        try {
          const before = replaceGeneration(agent.session)
          const result = pruner.pruneSession(agent.session)
          const advanced = pruneAdvanced(agent.session, before, result)
          tokens = measuredTokens(tokenMeter, agent.session) ?? tokens
          if (advanced) {
            ctx.logger.warn(
              `[dsh-patrol/context-pressure] aggressively pruned historical Patrol tool results before model dispatch`
              + `${tokens === undefined ? '' : `; request pressure is now ~${tokens} tokens`}`,
            )
          }
        } catch (error: unknown) {
          ctx.logger.warn(`[dsh-patrol/context-pressure] proactive prune failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      const shouldCompact = tokens === undefined
        ? pressureStep >= PATROL_QWEN_NO_METER_COMPACT_STEP
        : tokens >= PATROL_QWEN_HARDENED_COMPACT_LIMIT
      if (!shouldCompact || payload.signal.aborted) return next()

      const compaction = readCompaction(ctx)
      if (compaction === undefined) {
        ctx.logger.warn(
          `[dsh-patrol/context-pressure] Patrol reached the hardened local-Qwen pressure guard`
          + `${tokens === undefined ? ' without token measurement' : ` at ~${tokens} tokens`}, but compaction is unavailable`,
        )
        return next()
      }

      const before = replaceGeneration(agent.session)
      try {
        ctx.logger.warn(
          `[dsh-patrol/context-pressure] compacting Patrol before local-Qwen dispatch`
          + `${tokens === undefined ? ` at cumulative model step ${pressureStep}` : ` at ~${tokens} tokens`}`,
        )
        const result = await compaction.compactIfNeeded(payload.agent, 'context-overflow', payload.signal)
        const after = replaceGeneration(agent.session)
        const advanced = result !== null || (before !== undefined && after !== undefined && after > before)
        const nextTokens = measuredTokens(tokenMeter, agent.session)
        ctx.logger.info(
          `[dsh-patrol/context-pressure] hardened compaction ${advanced ? 'advanced the durable surface' : 'completed'}`
          + `${nextTokens === undefined ? '' : `; request pressure is now ~${nextTokens} tokens`}`,
        )
      } catch (error: unknown) {
        ctx.logger.warn(`[dsh-patrol/context-pressure] proactive compaction failed: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    },
    { prepend: true },
  )

  const disposeRequestError = ctx.on(
    'agent/request-error',
    async (payload: RequestErrorLike, next) => {
      const captured = seenSteps.get(keyOf(payload.turn, payload.step))
      const agent = asAgentLike(payload.agent) ?? captured?.agent
      if (agent === undefined || payload.signal.aborted) return next()
      const route = routeFromAgent(agent) ?? captured?.route
      if (route === undefined || !isPatrolQwenConstrainedRoute(route)) return next()

      const oom = isCudaOutOfMemoryFailure(payload.failure)
      const authUnavailable = isQwenLocalAuthUnavailableFailure(payload.failure)
      if (!oom && !authUnavailable) return next()

      const agentKey = agent as unknown as object
      if (oom) cudaOomAgents.add(agentKey)
      annotatePressureFailure(payload.failure, oom || cudaOomAgents.has(agentKey))

      const stepKey = keyOf(payload.turn, payload.step)
      if (attemptedRecovery.get(agentKey) === stepKey) return next()
      attemptedRecovery.set(agentKey, stepKey)

      let advanced = false
      const tokenMeter = readTokenMeter(ctx)
      const pruner = readToolResultPruner(ctx)
      if (pruner !== undefined) {
        try {
          const before = replaceGeneration(agent.session)
          const result = pruner.pruneSession(agent.session)
          advanced = pruneAdvanced(agent.session, before, result)
          if (advanced) {
            const tokens = measuredTokens(tokenMeter, agent.session)
            ctx.logger.warn(
              `[dsh-patrol/context-pressure] post-failure prune reduced Patrol history`
              + `${tokens === undefined ? '' : `; request pressure is now ~${tokens} tokens`}`,
            )
          }
        } catch (error: unknown) {
          ctx.logger.warn(`[dsh-patrol/context-pressure] post-failure prune failed: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      // If pruning already brought a measured request below the hardened limit,
      // do not invoke model-backed compaction unnecessarily. When measurement is
      // unavailable, prefer one compaction because that was the previous blind
      // spot which allowed long traces to escape the guard.
      const tokensAfterPrune = measuredTokens(tokenMeter, agent.session)
      const shouldCompact = tokensAfterPrune === undefined
        || tokensAfterPrune >= PATROL_QWEN_HARDENED_COMPACT_LIMIT
        || !advanced
      const compaction = readCompaction(ctx)
      if (compaction !== undefined && shouldCompact && !payload.signal.aborted) {
        const before = replaceGeneration(agent.session)
        try {
          const result = await compaction.compactIfNeeded(agent, 'context-overflow', payload.signal)
          const after = replaceGeneration(agent.session)
          if (result !== null || (before !== undefined && after !== undefined && after > before)) advanced = true
        } catch (error: unknown) {
          const after = replaceGeneration(agent.session)
          if (before !== undefined && after !== undefined && after > before) advanced = true
          ctx.logger.warn(`[dsh-patrol/context-pressure] post-failure compaction reported: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      if (!advanced || payload.signal.aborted) return next()
      if (authUnavailable) {
        ctx.logger.warn(
          `[dsh-patrol/context-pressure] local Qwen is auth-unavailable; waiting ${PATROL_QWEN_AUTH_RETRY_DELAY_MS}ms before one reduced-context retry`,
        )
        await sleep(PATROL_QWEN_AUTH_RETRY_DELAY_MS, payload.signal)
      }
      if (payload.signal.aborted) return next()
      ctx.logger.warn('[dsh-patrol/context-pressure] retrying this model step once after bounded pressure recovery')
      return { kind: 'retry' as const }
    },
    { prepend: true },
  )

  return () => {
    disposePreStep()
    disposeRequestError()
  }
}
