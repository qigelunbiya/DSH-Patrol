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

const QWEN_MODEL = 'qwen3.5_122b_a10b_fp4'
const QWEN_ROUTE_PROVIDERS = new Set(['cliproxy', 'qwen-local'])

/**
 * The local 122B route advertises a 262k context window, but the real 24 GB
 * inference worker used by Patrol can exhaust CUDA memory far earlier. Real
 * failing Patrol sessions have shown the worker disappear after long chains of
 * observe/snapshot/tool output even though the architectural context window was
 * nowhere near full.
 *
 * Keep two deliberately conservative Patrol-only thresholds. Tool-result
 * pruning starts first, then full compaction is forced well before the observed
 * failure range. This is a runtime capacity guard, not a statement about the
 * model's architectural context length.
 */
export const PATROL_QWEN_EAGER_PRUNE_LIMIT = 10_000
export const PATROL_QWEN_SOFT_REQUEST_LIMIT = 16_000

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

function asAgentLike(value: unknown): AgentLike | undefined {
  if (value === null || typeof value !== 'object') return undefined
  const session = (value as { session?: unknown }).session
  if (session === null || typeof session !== 'object') return undefined
  if (typeof (session as { requestHeader?: unknown }).requestHeader !== 'function') return undefined
  return value as AgentLike
}

function routeFromAgent(agent: AgentLike): RequestRoute | undefined {
  const config = agent.session.requestHeader()?.config
  if (typeof config?.provider === 'string' && config.provider.length > 0
    && typeof config.model === 'string' && config.model.length > 0) {
    return { provider: config.provider, model: config.model }
  }
  const provider = agent.options?.provider
  const model = agent.options?.model
  if (typeof provider !== 'string' || provider.length === 0 || typeof model !== 'string' || model.length === 0) return undefined
  return { provider, model }
}

export function isQwenLocalAuthUnavailableFailure(failure: FailureLike): boolean {
  const code = failure.code?.toLowerCase() ?? ''
  const message = failure.message?.toLowerCase() ?? ''
  return code === 'auth_unavailable'
    || message.includes('auth_unavailable')
    || message.includes('no auth available')
}

export function qwenLocalMemoryPressureDiagnostic(failure: FailureLike): string | undefined {
  if (isCudaOutOfMemoryFailure(failure)) {
    return 'Probable qwen-local CUDA memory exhaustion while processing this Patrol conversation.'
  }
  if (isQwenLocalAuthUnavailableFailure(failure)) {
    return [
      'Probable qwen-local GPU memory pressure or cooldown after an oversized Patrol conversation request.',
      'The gateway reports this as auth_unavailable/503 even though the practical cause can be the local inference worker becoming unavailable after OOM.',
    ].join(' ')
  }
  return undefined
}

function annotateFailureWithDiagnostic(failure: FailureLike): void {
  const diagnostic = qwenLocalMemoryPressureDiagnostic(failure)
  if (diagnostic === undefined) return
  if (failure.message?.includes('[DSH Patrol diagnostic]') === true) return
  failure.message = [
    failure.message ?? failure.code ?? 'model request failed',
    `[DSH Patrol diagnostic] ${diagnostic}`,
    'Mitigation attempted: compact/prune Patrol tool-result history before retrying so the next request is smaller.',
  ].join('\n')
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

function readToolResultPruner(ctx: Context): ToolResultPrunerLike | undefined {
  try {
    return ctx.get('toolResultPruner') as ToolResultPrunerLike | undefined
  } catch {
    return undefined
  }
}

function measuredTokens(tokenMeter: TokenMeterLike | undefined, session: SessionLike): TokenMeasurementLike | undefined {
  if (tokenMeter === undefined) return undefined
  try {
    const measurement = tokenMeter.measure(session)
    return Number.isFinite(measurement.totalTokens) ? measurement : undefined
  } catch {
    return undefined
  }
}

function routeLabel(route: RequestRoute | undefined): string {
  return route === undefined ? 'unresolved Patrol model route' : `${route.provider}/${route.model}`
}

/**
 * Add Patrol-specific safeguards around Harness' ordinary compaction:
 *
 * 1. Capture every Patrol pre-step before request routing is fully resolved.
 *    Older code skipped the guard when requestHeader/options did not yet expose
 *    provider/model; that is exactly the timing window in which a long Patrol
 *    request can reach qwen-local untrimmed.
 * 2. For the constrained Qwen route, and conservatively for an unresolved
 *    Patrol route, prune bulky historical tool results at 10k tokens and force
 *    compaction at 16k tokens.
 * 3. If CUDA OOM/auth-unavailable still escapes the preventive guard, perform
 *    one bounded model-free prune/compaction recovery before normal retries.
 *
 * This plugin is mounted only inside the Patrol preset, so treating an
 * unresolved Patrol route conservatively cannot affect ordinary Harness chats.
 */
export function registerPatrolContextPressureGuard(
  ctx: Context,
  softLimit = PATROL_QWEN_SOFT_REQUEST_LIMIT,
): () => void {
  const attemptedOomRecovery = new WeakMap<object, string>()
  const seenSteps = new Map<string, SeenStep>()

  function stepKey(turn: number, step: number): string {
    return `${turn}:${step}`
  }

  function rememberStep(turn: number, step: number, agent: AgentLike, route?: RequestRoute): void {
    seenSteps.set(stepKey(turn, step), { agent, ...(route === undefined ? {} : { route }) })
    if (seenSteps.size <= 24) return
    const oldest = seenSteps.keys().next().value
    if (typeof oldest === 'string') seenSteps.delete(oldest)
  }

  const disposePreStep = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const agent = asAgentLike(payload.agent)
      if (agent === undefined || payload.signal.aborted) return next()

      const route = routeFromAgent(agent)
      rememberStep(payload.turn, payload.step, agent, route)

      // A known non-Qwen route keeps Harness' stock policy. An unresolved route
      // is protected because this hook runs before final request routing and is
      // installed only for Patrol.
      if (route !== undefined && !isPatrolQwenConstrainedRoute(route)) return next()

      const tokenMeter = readTokenMeter(ctx)
      let measurement = measuredTokens(tokenMeter, agent.session)
      if (tokenMeter !== undefined && measurement === undefined) {
        ctx.logger.warn('[dsh-patrol/context-pressure] token measurement failed; falling back to bounded model-free pruning when the Patrol step is mature')
      }

      const eagerLimit = Math.min(PATROL_QWEN_EAGER_PRUNE_LIMIT, softLimit)
      const shouldEagerPrune = measurement === undefined
        ? payload.step >= 6
        : measurement.totalTokens >= eagerLimit
      const pruner = readToolResultPruner(ctx)
      if (pruner !== undefined && shouldEagerPrune) {
        try {
          const pruneBefore = replaceGeneration(agent.session)
          const result = pruner.pruneSession(agent.session)
          const pruneAfter = replaceGeneration(agent.session)
          measurement = measuredTokens(tokenMeter, agent.session) ?? measurement
          const pruned = Array.isArray(result.pruned) ? result.pruned.length : 0
          if (pruned > 0 || result.charsRemoved !== undefined || (pruneBefore !== undefined && pruneAfter !== undefined && pruneAfter > pruneBefore)) {
            const pressure = measurement === undefined ? '' : `; request pressure is now ~${measurement.totalTokens} tokens`
            ctx.logger.warn(`[dsh-patrol/context-pressure] pruned historical Patrol tool results before model dispatch${pressure}`)
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`[dsh-patrol/context-pressure] model-free pruning failed: ${message}; continuing with compaction checks`)
        }
      }

      if (measurement === undefined || measurement.totalTokens < softLimit) return next()

      const compaction = readCompaction(ctx)
      if (compaction === undefined) {
        ctx.logger.warn(
          `[dsh-patrol/context-pressure] ${routeLabel(route)} request is ~${measurement.totalTokens} tokens `
          + `(Patrol soft limit ${softLimit}), but no compaction service is available; local-model memory pressure is likely`,
        )
        return next()
      }

      const before = replaceGeneration(agent.session)
      ctx.logger.warn(
        `[dsh-patrol/context-pressure] ${routeLabel(route)} request is ~${measurement.totalTokens} tokens `
        + `(Patrol soft limit ${softLimit}); compacting before model dispatch`,
      )
      try {
        await compaction.compactIfNeeded(payload.agent, 'context-overflow', payload.signal)
        const after = replaceGeneration(agent.session)
        const compacted = before !== undefined && after !== undefined && after > before
        const nextMeasurement = measuredTokens(tokenMeter, agent.session)
        const pressure = nextMeasurement === undefined ? '' : `; request pressure is now ~${nextMeasurement.totalTokens} tokens`
        ctx.logger.info(
          `[dsh-patrol/context-pressure] early compaction ${compacted ? 'advanced the surface' : 'completed'}${pressure}`,
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
    async (payload: RequestErrorLike, next) => {
      const captured = seenSteps.get(stepKey(payload.turn, payload.step))
      const agent = asAgentLike(payload.agent) ?? captured?.agent
      if (agent === undefined) return next()
      const route = routeFromAgent(agent) ?? captured?.route
      if (route === undefined
        || !isPatrolQwenConstrainedRoute(route)
        || (!isCudaOutOfMemoryFailure(payload.failure) && !isQwenLocalAuthUnavailableFailure(payload.failure))
        || payload.signal.aborted) {
        return next()
      }
      annotateFailureWithDiagnostic(payload.failure)

      const key = `${payload.turn}:${payload.step}`
      const agentKey = agent as unknown as object
      if (attemptedOomRecovery.get(agentKey) === key) return next()
      attemptedOomRecovery.set(agentKey, key)

      const tokenMeter = readTokenMeter(ctx)
      const pruner = readToolResultPruner(ctx)
      if (pruner !== undefined) {
        try {
          const pruneBefore = replaceGeneration(agent.session)
          const result = pruner.pruneSession(agent.session)
          const pruneAfter = replaceGeneration(agent.session)
          const advanced = (Array.isArray(result.pruned) && result.pruned.length > 0)
            || (pruneBefore !== undefined && pruneAfter !== undefined && pruneAfter > pruneBefore)
          if (advanced && !payload.signal.aborted) {
            const measurement = measuredTokens(tokenMeter, agent.session)
            const pressure = measurement === undefined ? '' : `; request pressure is now ~${measurement.totalTokens} tokens`
            ctx.logger.warn(`[dsh-patrol/context-pressure] model-free pruning advanced the durable surface after qwen failure${pressure}; retrying this model step once`)
            return { kind: 'retry' as const }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`[dsh-patrol/context-pressure] post-failure model-free pruning failed: ${message}`)
        }
      }

      const compaction = readCompaction(ctx)
      if (compaction === undefined) return next()

      const before = replaceGeneration(agent.session)
      ctx.logger.warn(
        `[dsh-patrol/context-pressure] ${route.provider}/${route.model} returned memory-pressure failure at turn ${payload.turn} `
        + `step ${payload.step}; attempting one immediate compaction before Harness retries`,
      )
      try {
        const result = await compaction.compactIfNeeded(agent, 'context-overflow', payload.signal)
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
