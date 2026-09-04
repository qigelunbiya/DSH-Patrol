import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'

interface FailureLike {
  code?: string
  message?: string
}

interface RequestRoute {
  provider: string
  model: string
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

interface SessionLike {
  requestHeader(): { config?: Pick<LlmCallConfig, 'provider' | 'model'> } | undefined
  surface?: { replaceGeneration?: number }
}

interface AgentLike {
  session: SessionLike
}

const QWEN_MODEL = 'qwen3.5_122b_a10b_fp4'
const QWEN_ROUTE_PROVIDERS = new Set(['cliproxy', 'qwen-local'])

/**
 * The local 122B route advertises a 262k context window, but the real 24 GB
 * inference worker used by Patrol can exhaust CUDA memory far earlier. Session
 * evidence from a real failing Patrol run showed OOM around the mid-30k token
 * range, followed by the gateway putting qwen-local into cooldown and returning
 * misleading `auth_unavailable` errors for the remaining Harness retries.
 *
 * Keep a conservative margin below that observed failure point. This is a
 * Patrol-only soft limit, not a claim about the model's architectural context
 * length. The normal Harness compaction policy still owns every other route.
 */
export const PATROL_QWEN_SOFT_REQUEST_LIMIT = 30_000

export function isPatrolQwenConstrainedRoute(
  route: Pick<LlmCallConfig, 'provider' | 'model'>,
): boolean {
  return QWEN_ROUTE_PROVIDERS.has(route.provider) && route.model === QWEN_MODEL
}

export function isCudaOutOfMemoryFailure(failure: FailureLike): boolean {
  const message = failure.message?.toLowerCase() ?? ''
  return message.includes('cuda out of memory')
    || message.includes('torch.outofmemoryerror')
    || message.includes('cuda error: out of memory')
}

export function shouldForcePatrolCompaction(
  route: Pick<LlmCallConfig, 'provider' | 'model'>,
  totalTokens: number,
  softLimit = PATROL_QWEN_SOFT_REQUEST_LIMIT,
): boolean {
  return isPatrolQwenConstrainedRoute(route)
    && Number.isFinite(totalTokens)
    && totalTokens >= softLimit
}

function routeFromAgent(agent: AgentLike): RequestRoute | undefined {
  const config = agent.session.requestHeader()?.config
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

function replaceGeneration(session: SessionLike): number | undefined {
  const generation = session.surface?.replaceGeneration
  return typeof generation === 'number' && Number.isFinite(generation) ? generation : undefined
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

/**
 * Add two Patrol-specific safeguards around Harness' ordinary compaction:
 *
 * 1. Before every model step, measure the real durable request and force an
 *    early reduction for the memory-constrained local Qwen route at 30k tokens.
 *    Harness' default pressure threshold is based on the advertised context
 *    window (80% of 262k), which is much too late for this worker.
 * 2. If an OOM still escapes the soft limit, intercept the FIRST CUDA OOM and
 *    give the compaction engine one bounded recovery attempt before the normal
 *    llm-retry layer turns the upstream failure into repeated auth cooldowns.
 *
 * The plugin is mounted only inside the Patrol agent preset, so ordinary Harness
 * conversations keep the stock compaction policy.
 */
export function registerPatrolContextPressureGuard(
  ctx: Context,
  softLimit = PATROL_QWEN_SOFT_REQUEST_LIMIT,
): () => void {
  const attemptedOomRecovery = new WeakMap<object, string>()

  const disposePreStep = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const agent = payload.agent as unknown as AgentLike
      const route = routeFromAgent(agent)
      if (route === undefined || !isPatrolQwenConstrainedRoute(route) || payload.signal.aborted) {
        return next()
      }

      const tokenMeter = readTokenMeter(ctx)
      const compaction = readCompaction(ctx)
      if (tokenMeter === undefined || compaction === undefined) return next()

      let measurement: TokenMeasurementLike
      try {
        measurement = tokenMeter.measure(agent.session)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[dsh-patrol/context-pressure] token measurement failed: ${message}; continuing the step`)
        return next()
      }

      if (!shouldForcePatrolCompaction(route, measurement.totalTokens, softLimit)) return next()

      const before = replaceGeneration(agent.session)
      ctx.logger.warn(
        `[dsh-patrol/context-pressure] ${route.provider}/${route.model} request is ~${measurement.totalTokens} tokens `
        + `(Patrol soft limit ${softLimit}); compacting before model dispatch to avoid CUDA OOM`,
      )
      try {
        await compaction.compactIfNeeded(payload.agent, 'context-overflow', payload.signal)
        const after = replaceGeneration(agent.session)
        const compacted = before !== undefined && after !== undefined && after > before
        const nextMeasurement = tokenMeter.measure(agent.session)
        ctx.logger.info(
          `[dsh-patrol/context-pressure] early compaction ${compacted ? 'advanced the surface' : 'completed'}; `
          + `request pressure is now ~${nextMeasurement.totalTokens} tokens`,
        )
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[dsh-patrol/context-pressure] early compaction failed: ${message}; continuing the step`)
      }
      return next()
    },
    { prepend: true },
  )

  const disposeRequestError = ctx.on(
    'agent/request-error',
    async (payload, next) => {
      const agent = payload.agent as unknown as AgentLike
      const route = routeFromAgent(agent)
      if (route === undefined
        || !isPatrolQwenConstrainedRoute(route)
        || !isCudaOutOfMemoryFailure(payload.failure)
        || payload.signal.aborted) {
        return next()
      }

      const key = `${payload.turn}:${payload.step}`
      const agentKey = payload.agent as unknown as object
      if (attemptedOomRecovery.get(agentKey) === key) return next()
      attemptedOomRecovery.set(agentKey, key)

      const compaction = readCompaction(ctx)
      if (compaction === undefined) return next()

      const before = replaceGeneration(agent.session)
      ctx.logger.warn(
        `[dsh-patrol/context-pressure] ${route.provider}/${route.model} returned CUDA OOM at turn ${payload.turn} `
        + `step ${payload.step}; attempting one immediate compaction before Harness retries`,
      )
      try {
        const result = await compaction.compactIfNeeded(payload.agent, 'context-overflow', payload.signal)
        const after = replaceGeneration(agent.session)
        const advanced = result !== null
          || (before !== undefined && after !== undefined && after > before)
        if (advanced && !payload.signal.aborted) {
          ctx.logger.warn('[dsh-patrol/context-pressure] OOM recovery reduced the durable surface; retrying this model step once')
          return { kind: 'retry' as const }
        }
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        const after = replaceGeneration(agent.session)
        if (!payload.signal.aborted && before !== undefined && after !== undefined && after > before) {
          ctx.logger.warn(
            `[dsh-patrol/context-pressure] OOM compaction reported ${message}, but model-free pruning advanced the surface; `
            + 'retrying this model step once',
          )
          return { kind: 'retry' as const }
        }
        ctx.logger.warn(`[dsh-patrol/context-pressure] OOM compaction failed: ${message}; delegating to Harness retry policy`)
      }
      return next()
    },
    { prepend: true },
  )

  return () => {
    disposePreStep()
    disposeRequestError()
  }
}
