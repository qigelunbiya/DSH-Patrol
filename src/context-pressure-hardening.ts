import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig } from '@deepseek-ai/dsh-llm'
import {
  isCudaOutOfMemoryFailure,
  isPatrolQwenConstrainedRoute,
  isQwenLocalAuthUnavailableFailure,
} from './context-pressure-guard.js'
import {
  countRetainedToolResultImages,
  offloadHistoricalToolResultImages,
} from './image-context-hardening.js'

interface RequestRoute {
  provider: string
  model: string
}

interface FailureLike {
  code?: string
  message?: string
  status?: number
  statusCode?: number
  retryAfterMs?: number
  headers?: Record<string, string | number | undefined>
  requestId?: string
  request_id?: string
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
  surface?: { replaceGeneration?: number; nodes?: readonly number[] }
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

interface StepRecoveryState {
  attempts: number
  lastOomAt?: number
}

/**
 * The local 122B route can exhaust GPU/request capacity before the nominal text
 * context window is reached. Patrol therefore controls text and image pressure
 * independently. In particular, Harness' ordinary tool-result pruner trims text
 * only; historical image blocks are offloaded through the image/offload
 * projection instead of being mistaken for "pruned".
 */
export const PATROL_QWEN_HARDENED_PRUNE_LIMIT = 4_000
export const PATROL_QWEN_HARDENED_COMPACT_LIMIT = 7_000
export const PATROL_QWEN_NO_METER_PRUNE_STEP = 2
export const PATROL_QWEN_NO_METER_COMPACT_STEP = 5
export const PATROL_QWEN_AUTH_RETRY_DELAYS_MS = [3_500, 7_000, 14_000, 28_000] as const
export const PATROL_QWEN_AUTH_RETRY_DELAY_MS = PATROL_QWEN_AUTH_RETRY_DELAYS_MS[0]
export const PATROL_QWEN_OOM_DIAGNOSTIC_TTL_MS = 60_000

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

function annotatePressureFailure(
  failure: FailureLike,
  options: { oom: boolean; sameStepRecentOom: boolean; retryAttempt: number; retryDelayMs?: number },
): void {
  if (failure.message?.includes('[DSH Patrol diagnostic]') === true) return
  const authUnavailable = isQwenLocalAuthUnavailableFailure(failure)
  const explanation = options.oom
    ? '本次模型请求直接报告了 CUDA/GPU OOM；Patrol 只会在实际减少请求负载后重试。'
    : authUnavailable && options.sameStepRecentOom
      ? '本次返回 auth_unavailable；同一模型步骤较早一次尝试在 60 秒内报告过 OOM，因此可能处于 worker 恢复/冷却阶段，但这不是新的 OOM 证据。'
      : authUnavailable
        ? '本次返回 auth_unavailable，表示上游当前不可用；它可能来自 worker 冷却、auth pool、并发/排队或其他网关状态，Patrol 不会把它直接解释成 CUDA OOM。'
        : '本次本地 Qwen 请求失败。'
  const retry = options.retryDelayMs === undefined
    ? ''
    : `Patrol 将等待约 ${options.retryDelayMs}ms 后执行第 ${options.retryAttempt} 次有界重试；只重发尚未成功的模型请求，不会重放已完成的浏览器写操作。`
  failure.message = [
    failure.message ?? failure.code ?? 'model request failed',
    `[DSH Patrol diagnostic] ${explanation}`,
    retry,
  ].filter(Boolean).join('\n')
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

function pruneOnce(
  ctx: Context,
  pruner: ToolResultPrunerLike | undefined,
  agent: AgentLike,
  label: string,
): boolean {
  if (pruner === undefined) return false
  try {
    const before = replaceGeneration(agent.session)
    const result = pruner.pruneSession(agent.session)
    const advanced = pruneAdvanced(agent.session, before, result)
    if (advanced) {
      ctx.logger.warn(`[dsh-patrol/context-pressure] ${label}; trimmed historical TEXT tool payloads before model dispatch`)
    }
    return advanced
  } catch (error: unknown) {
    ctx.logger.warn(`[dsh-patrol/context-pressure] ${label} failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

function offloadImages(
  ctx: Context,
  agent: AgentLike,
  keepLatest: number,
  label: string,
): boolean {
  const result = offloadHistoricalToolResultImages(agent.session, keepLatest)
  if (result.applied) {
    ctx.logger.warn(
      `[dsh-patrol/context-pressure] ${label}; offloaded ${result.offloaded} historical image occurrence(s); retained=${result.retainedAfter}`,
    )
    return result.offloaded > 0
  }
  if (result.error !== undefined) {
    ctx.logger.warn(`[dsh-patrol/context-pressure] ${label} unavailable: ${result.error}`)
  }
  return false
}

function retryAfterMs(failure: FailureLike): number | undefined {
  if (typeof failure.retryAfterMs === 'number' && Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs >= 0) {
    return Math.min(120_000, failure.retryAfterMs)
  }
  const raw = failure.headers?.['retry-after'] ?? failure.headers?.['Retry-After']
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.min(120_000, raw * 1000)
  if (typeof raw !== 'string' || raw.trim() === '') return undefined
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(120_000, seconds * 1000)
  const when = Date.parse(raw)
  if (!Number.isFinite(when)) return undefined
  return Math.min(120_000, Math.max(0, when - Date.now()))
}

function failureRequestId(failure: FailureLike): string | undefined {
  const value = failure.requestId ?? failure.request_id
  return typeof value === 'string' && value.trim() !== '' ? value.trim().slice(0, 160) : undefined
}

/**
 * Patrol-only pressure guard used by the mounted preset.
 *
 * Healthy pre-step pressure may use model-backed compaction. Failed-request
 * recovery is intentionally model-free: image offload + text pruning + bounded
 * cooldown retry. That prevents auth_unavailable recovery from calling the same
 * already-failing Qwen model merely to generate a compaction summary.
 */
export function registerPatrolContextPressureGuard(ctx: Context): () => void {
  const seenSteps = new Map<string, SeenStep>()
  const recoveryByAgent = new WeakMap<object, Map<string, StepRecoveryState>>()
  const lastSeenStep = new WeakMap<object, string>()
  const cumulativeModelSteps = new WeakMap<object, number>()
  const lastStepPrune = new WeakMap<object, number>()
  const lastStepCompact = new WeakMap<object, number>()

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

      const agentKey = agent as unknown as object
      const currentStepKey = keyOf(payload.turn, payload.step)
      const previousStepKey = lastSeenStep.get(agentKey)
      if (previousStepKey !== undefined && previousStepKey !== currentStepKey) {
        // A later model step proves the previous one recovered/completed; stale
        // OOM/auth recovery state must not leak into unrelated future 503 text.
        recoveryByAgent.delete(agentKey)
      }
      lastSeenStep.set(agentKey, currentStepKey)

      // This plugin only mounts in Patrol. Before request routing is fully
      // resolved, protect the request conservatively; a known non-Qwen route
      // keeps Harness' normal policy.
      if (route !== undefined && !isPatrolQwenConstrainedRoute(route)) return next()

      // Keep only the newest retained tool-result image in the actual model
      // surface. This is independent of the text-only toolResultPruner.
      offloadImages(ctx, agent, 1, 'proactive Patrol image offload')
      const retainedImages = countRetainedToolResultImages(agent.session)

      const cumulativeStep = (cumulativeModelSteps.get(agentKey) ?? 0) + 1
      cumulativeModelSteps.set(agentKey, cumulativeStep)
      const pressureStep = Math.max(payload.step, cumulativeStep)

      const tokenMeter = readTokenMeter(ctx)
      let tokens = measuredTokens(tokenMeter, agent.session)
      ctx.logger.info(
        `[dsh-patrol/context-pressure] pre-dispatch budget route=${route?.provider ?? 'pending'}/${route?.model ?? 'pending'}`
        + ` turn=${payload.turn} step=${payload.step} textTokens=${tokens ?? 'unknown'} retainedToolImages=${retainedImages}`,
      )

      const lastPrunedAt = lastStepPrune.get(agentKey) ?? 0
      const pruneDueByStep = pressureStep >= PATROL_QWEN_NO_METER_PRUNE_STEP
        && pressureStep - lastPrunedAt >= PATROL_QWEN_NO_METER_PRUNE_STEP
      const shouldPrune = (tokens !== undefined && tokens >= PATROL_QWEN_HARDENED_PRUNE_LIMIT)
        || pruneDueByStep
      const pruner = readToolResultPruner(ctx)
      if (shouldPrune) {
        lastStepPrune.set(agentKey, pressureStep)
        const advanced = pruneOnce(ctx, pruner, agent, 'proactive Patrol history prune')
        if (advanced) tokens = measuredTokens(tokenMeter, agent.session) ?? tokens
      }

      const lastCompactedAt = lastStepCompact.get(agentKey) ?? 0
      const compactDueByStep = pressureStep >= PATROL_QWEN_NO_METER_COMPACT_STEP
        && pressureStep - lastCompactedAt >= PATROL_QWEN_NO_METER_COMPACT_STEP
      const shouldCompact = (tokens !== undefined && tokens >= PATROL_QWEN_HARDENED_COMPACT_LIMIT)
        || compactDueByStep
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
      lastStepCompact.set(agentKey, pressureStep)
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
        if (!payload.signal.aborted && nextTokens !== undefined && nextTokens >= PATROL_QWEN_HARDENED_PRUNE_LIMIT) {
          pruneOnce(ctx, pruner, agent, 'post-compaction Patrol history prune')
        }
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
      const stepKey = keyOf(payload.turn, payload.step)
      let steps = recoveryByAgent.get(agentKey)
      if (steps === undefined) {
        steps = new Map()
        recoveryByAgent.set(agentKey, steps)
      }
      const state = steps.get(stepKey) ?? { attempts: 0 }
      const now = Date.now()
      const sameStepRecentOom = state.lastOomAt !== undefined
        && now - state.lastOomAt <= PATROL_QWEN_OOM_DIAGNOSTIC_TTL_MS
      if (oom) state.lastOomAt = now

      if (state.attempts >= PATROL_QWEN_AUTH_RETRY_DELAYS_MS.length) {
        annotatePressureFailure(payload.failure, {
          oom,
          sameStepRecentOom,
          retryAttempt: state.attempts,
        })
        ctx.logger.warn(
          `[dsh-patrol/context-pressure] recovery exhausted route=${route.provider}/${route.model} turn=${payload.turn} step=${payload.step}; terminating Patrol recovery without delegating to generic retries`,
        )
        return undefined
      }

      // Failed-request recovery must not call compaction.summarize() on the same
      // unavailable model. Reduce only durable/model-free pressure here.
      const imageReduced = offloadImages(ctx, agent, 1, 'post-failure Patrol image offload')
      const pruner = readToolResultPruner(ctx)
      const textReduced = pruneOnce(ctx, pruner, agent, 'post-failure Patrol text history prune')
      const tokenMeter = readTokenMeter(ctx)
      const tokens = measuredTokens(tokenMeter, agent.session)
      const retainedImages = countRetainedToolResultImages(agent.session)

      // A raw OOM retry requires actual request reduction. auth_unavailable may
      // simply need the upstream worker/auth pool to recover, so cooldown retry
      // is allowed even if there was nothing left to prune.
      if (oom && !authUnavailable && !imageReduced && !textReduced) {
        annotatePressureFailure(payload.failure, {
          oom: true,
          sameStepRecentOom,
          retryAttempt: state.attempts,
        })
        ctx.logger.warn('[dsh-patrol/context-pressure] raw OOM had no model-free reduction; preserving original failure without delegating to a generic blind retry')
        return undefined
      }

      state.attempts += 1
      steps.set(stepKey, state)
      const configuredDelay = PATROL_QWEN_AUTH_RETRY_DELAYS_MS[state.attempts - 1]!
      const serverDelay = retryAfterMs(payload.failure)
      const delayMs = Math.max(configuredDelay, serverDelay ?? 0)
      annotatePressureFailure(payload.failure, {
        oom,
        sameStepRecentOom,
        retryAttempt: state.attempts,
        retryDelayMs: delayMs,
      })

      ctx.logger.warn(
        `[dsh-patrol/context-pressure] upstream unavailable/recovery wait route=${route.provider}/${route.model}`
        + ` turn=${payload.turn} step=${payload.step} attempt=${state.attempts}/${PATROL_QWEN_AUTH_RETRY_DELAYS_MS.length}`
        + ` delayMs=${delayMs} status=${payload.failure.status ?? payload.failure.statusCode ?? 'unknown'}`
        + ` code=${payload.failure.code ?? 'unknown'} requestId=${failureRequestId(payload.failure) ?? 'unknown'}`
        + ` textTokens=${tokens ?? 'unknown'} retainedToolImages=${retainedImages}`,
      )

      await sleep(delayMs, payload.signal)
      if (payload.signal.aborted) return next()
      ctx.logger.warn('[dsh-patrol/context-pressure] retrying only the failed model request after bounded model-free recovery')
      return { kind: 'retry' as const }
    },
    { prepend: true },
  )

  return () => {
    disposePreStep()
    disposeRequestError()
  }
}
