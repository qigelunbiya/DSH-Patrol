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
  route: RequestRoute
}

const QWEN_MODEL = 'qwen3.5_122b_a10b_fp4'
const QWEN_ROUTE_PROVIDERS = new Set(['cliproxy', 'qwen-local'])

/**
 * The local 122B route advertises a 262k context window, but the real 24 GB
 * inference worker used by Patrol can exhaust CUDA memory far earlier. Session
 * evidence from real failing Patrol runs showed OOM around the mid-30k token
 * range, followed by the gateway putting qwen-local into cooldown and returning
 * misleading `auth_unavailable` errors for the remaining Harness retries.
 *
 * Keep a conservative margin below that observed failure point. This is a
 * Patrol-only soft limit, not a claim about the model's architectural context
 * length. The normal Harness compaction policy still owns every other route.
 */
export const PATROL_QWEN_SOFT_REQUEST_LIMIT = 24_000

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
  if (config !== undefined && config.provider.length > 0 && config.model.length > 0) {
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
  const seenSteps = new Map<string, SeenStep>()

  function stepKey(turn: number, step: number): string {
    return `${turn}:${step}`
  }

  function rememberStep(turn: number, step: number, agent: AgentLike, route: RequestRoute): void {
    seenSteps.set(stepKey(turn, step), { agent, route })
    if (seenSteps.size <= 24) return
    const oldest = seenSteps.keys().next().value
    if (typeof oldest === 'string') seenSteps.delete(oldest)
  }

  const disposePreStep = ctx.on(
    'agent/pre-step',
    async (payload, next) => {
      const agent = asAgentLike(payload.agent)
      if (agent === undefined) return next()
      const route = routeFromAgent(agent)
      if (route === undefined || !isPatrolQwenConstrainedRoute(route) || payload.signal.aborted) {
        return next()
      }
      rememberStep(payload.turn, payload.step, agent, route)

      const tokenMeter = readTokenMeter(ctx)
      if (tokenMeter === undefined) return next()

      let measurement: TokenMeasurementLike
      try {
        measurement = tokenMeter.measure(agent.session)
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[dsh-patrol/context-pressure] token measurement failed: ${message}; continuing the step`)
        return next()
      }

      if (!shouldForcePatrolCompaction(route, measurement.totalTokens, softLimit)) return next()

      const pruner = readToolResultPruner(ctx)
      if (pruner !== undefined) {
        const pruneBefore = replaceGeneration(agent.session)
        const result = pruner.pruneSession(agent.session)
        const pruneAfter = replaceGeneration(agent.session)
        measurement = tokenMeter.measure(agent.session)
        const pruned = Array.isArray(result.pruned) ? result.pruned.length : 0
        if (pruned > 0 || result.charsRemoved !== undefined || (pruneBefore !== undefined && pruneAfter !== undefined && pruneAfter > pruneBefore)) {
          ctx.logger.warn(
            `[dsh-patrol/context-pressure] pruned Patrol tool results before model dispatch; `
            + `request pressure is now ~${measurement.totalTokens} tokens`,
          )
        }
        if (!shouldForcePatrolCompaction(route, measurement.totalTokens, softLimit)) return next()
      }

      const compaction = readCompaction(ctx)
      if (compaction === undefined) {
        ctx.logger.warn(
          `[dsh-patrol/context-pressure] ${route.provider}/${route.model} request is ~${measurement.totalTokens} tokens `
          + `(Patrol soft limit ${softLimit}), but no compaction service is available; model-side CUDA OOM is likely`,
        )
        return next()
      }

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
        const pruneBefore = replaceGeneration(agent.session)
        const result = pruner.pruneSession(agent.session)
        const pruneAfter = replaceGeneration(agent.session)
        const advanced = (Array.isArray(result.pruned) && result.pruned.length > 0)
          || (pruneBefore !== undefined && pruneAfter !== undefined && pruneAfter > pruneBefore)
        if (advanced && !payload.signal.aborted) {
          const measured = tokenMeter === undefined ? '' : `; request pressure is now ~${tokenMeter.measure(agent.session).totalTokens} tokens`
          ctx.logger.warn(`[dsh-patrol/context-pressure] model-free pruning advanced the durable surface after qwen failure${measured}; retrying this model step once`)
          return { kind: 'retry' as const }
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
