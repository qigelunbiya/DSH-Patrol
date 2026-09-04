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
  estimateMessage?(message: unknown): number
}

interface CompactionLike {
  compactIfNeeded(
    agent: unknown,
    trigger: 'pressure' | 'context-overflow',
    signal: AbortSignal,
  ): Promise<unknown | null>
}

interface ContentBlockLike {
  type?: string
  text?: string
  content?: ContentBlockLike[]
  [key: string]: unknown
}

interface MessageLike {
  content?: ContentBlockLike[]
  [key: string]: unknown
}

interface SessionEventLike {
  type?: string
  data?: {
    message?: MessageLike
    [key: string]: unknown
  }
  [key: string]: unknown
}

interface SessionLike {
  requestHeader(): { config?: Pick<LlmCallConfig, 'provider' | 'model'> } | undefined
  surface?: {
    replaceGeneration?: number
    nodes?: Iterable<number>
  }
  events?: readonly SessionEventLike[]
  eventAt?(seq: number): SessionEventLike | undefined
  append?(
    type: string,
    data: unknown,
    options?: {
      surfaceOp?: unknown
      sourceEventSeqs?: number[]
    },
  ): { seq?: number }
}

interface AgentLike {
  session: SessionLike
}

export interface PatrolEmergencyPruneResult {
  pruned: number
  charsRemoved: number
  beforeTokens: number
  afterTokens: number
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

/** Leave headroom for small request-envelope changes between measurement and dispatch. */
export const PATROL_QWEN_EMERGENCY_TARGET = 29_500

/**
 * Harness' stock tool-result pruner only touches results above 8192 characters.
 * The real failing Patrol session had dozens of browser results around 1-3k
 * characters, so the stock pass removed nothing and compaction immediately fell
 * through to an LLM-backed summary using the same already-memory-starved Qwen.
 * These emergency budgets are deliberately much smaller and apply only after
 * the Patrol Qwen request has crossed the soft memory limit.
 */
const EMERGENCY_TOOL_RESULT_THRESHOLD_CHARS = 192
const EMERGENCY_TOOL_RESULT_HEAD_CHARS = 48
const EMERGENCY_TOOL_RESULT_TAIL_CHARS = 24
const EMERGENCY_TOOL_RESULT_MARKER = '\n\n[... old tool result pruned ...]\n\n'
const EMERGENCY_RECENT_TOOL_RESULTS_TO_KEEP = 4
const EMERGENCY_MIN_TOOL_RESULTS_TO_KEEP = 1

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
  if (config === undefined || config.provider.length === 0 || config.model.length === 0) return undefined
  return { provider: config.provider, model: config.model }
}

function replaceGeneration(session: SessionLike): number | undefined {
  const generation = session.surface?.replaceGeneration
  return typeof generation === 'number' && Number.isFinite(generation) ? generation : undefined
}

function readTokenMeter(ctx: Context): TokenMeterLike | undefined {
  try {
    const service = ctx.get('tokenMeter') as TokenMeterLike | undefined
    if (service !== undefined) return service
  } catch {
    // Some scoped Cordis contexts expose inherited services through properties
    // even when an optional ctx.get() lookup is unavailable in that scope.
  }
  return (ctx as unknown as { tokenMeter?: TokenMeterLike }).tokenMeter
}

function readCompaction(ctx: Context): CompactionLike | undefined {
  try {
    const service = ctx.get('compaction') as CompactionLike | undefined
    if (service !== undefined) return service
  } catch {
    // Keep the direct service-property fallback for scoped Patrol contexts.
  }
  return (ctx as unknown as { compaction?: CompactionLike }).compaction
}

function eventAt(session: SessionLike, seq: number): SessionEventLike | undefined {
  const fromArray = session.events?.[seq]
  if (fromArray !== undefined) return fromArray
  return session.eventAt?.(seq)
}

function codePointLength(text: string): number {
  return Array.from(text).length
}

function textCharCount(blocks: readonly ContentBlockLike[]): number {
  let count = 0
  for (const block of blocks) {
    if (block.type === 'text' && typeof block.text === 'string') count += codePointLength(block.text)
  }
  return count
}

/**
 * Shrink one tool-result payload without changing rich-block ordering or tool
 * identity. This mirrors Harness' replay-safe head/middle/tail pruner, but with
 * a Patrol-only emergency budget suitable for browser observations.
 */
function pruneTextBlocks(blocks: readonly ContentBlockLike[]): ContentBlockLike[] | undefined {
  const totalChars = textCharCount(blocks)
  if (totalChars <= EMERGENCY_TOOL_RESULT_THRESHOLD_CHARS) return undefined

  const removedStart = EMERGENCY_TOOL_RESULT_HEAD_CHARS
  const removedEnd = totalChars - EMERGENCY_TOOL_RESULT_TAIL_CHARS
  const pruned: ContentBlockLike[] = []
  let consumed = 0
  let markerInserted = false

  for (const block of blocks) {
    if (block.type !== 'text' || typeof block.text !== 'string') {
      pruned.push(block)
      continue
    }

    const points = Array.from(block.text)
    const blockStart = consumed
    const blockEnd = blockStart + points.length
    const headEnd = Math.min(points.length, Math.max(0, removedStart - blockStart))
    const tailStart = Math.min(points.length, Math.max(0, removedEnd - blockStart))
    const intersectsRemoved = blockStart < removedEnd && blockEnd > removedStart
    const marker = intersectsRemoved && !markerInserted ? EMERGENCY_TOOL_RESULT_MARKER : ''
    if (marker.length > 0) markerInserted = true
    const text = points.slice(0, headEnd).join('') + marker + points.slice(tailStart).join('')
    if (text.length > 0) pruned.push({ ...block, text })
    consumed = blockEnd
  }

  return markerInserted ? pruned : undefined
}

function pruneToolResultMessage(message: MessageLike): { message: MessageLike; charsRemoved: number } | undefined {
  if (!Array.isArray(message.content)) return undefined
  let changed = false
  let charsRemoved = 0
  const content = message.content.map((block) => {
    if (block.type !== 'tool-result' || !Array.isArray(block.content)) return block
    const before = textCharCount(block.content)
    const pruned = pruneTextBlocks(block.content)
    if (pruned === undefined) return block
    changed = true
    charsRemoved += before - textCharCount(pruned)
    return { ...block, content: pruned }
  })
  return changed ? { message: { ...message, content }, charsRemoved } : undefined
}

function appendEmergencyReplacement(
  session: SessionLike,
  tokenMeter: TokenMeterLike,
  seq: number,
  event: SessionEventLike,
  replacement: { message: MessageLike; charsRemoved: number },
): boolean {
  const append = session.append
  const estimateMessage = tokenMeter.estimateMessage
  const originalMessage = event.data?.message
  if (append === undefined || estimateMessage === undefined || originalMessage === undefined) return false

  append.call(session, 'compaction/prune', {
    shadowedRange: { start: seq, end: seq },
    shadowedSeqs: [seq],
    shadowedTokenCount: estimateMessage(originalMessage),
  })
  append.call(session, 'tool/result', {
    ...event.data,
    message: replacement.message,
  }, {
    surfaceOp: { op: 'replace', start: seq, end: seq },
    sourceEventSeqs: [seq],
  })
  return true
}

/**
 * Model-free emergency reduction for long Patrol browser sessions.
 *
 * The first pass preserves the four newest tool results verbatim. If that is
 * still insufficient, a second pass may trim three of those while always
 * keeping the newest result intact. Each landed replacement uses Harness'
 * compaction/prune + surface replace protocol, so replay and token metering stay
 * consistent. No model call is made by this function.
 */
export function emergencyPrunePatrolToolResults(
  session: SessionLike,
  tokenMeter: TokenMeterLike,
  targetTokens = PATROL_QWEN_EMERGENCY_TARGET,
): PatrolEmergencyPruneResult {
  const beforeTokens = tokenMeter.measure(session).totalTokens
  let afterTokens = beforeTokens
  if (afterTokens < targetTokens
    || tokenMeter.estimateMessage === undefined
    || session.append === undefined
    || session.surface?.nodes === undefined) {
    return { pruned: 0, charsRemoved: 0, beforeTokens, afterTokens }
  }

  const candidates: Array<{ seq: number; event: SessionEventLike }> = []
  for (const seq of Array.from(session.surface.nodes)) {
    const event = eventAt(session, seq)
    if (event?.type === 'tool/result' && event.data?.message !== undefined) {
      candidates.push({ seq, event })
    }
  }
  if (candidates.length === 0) return { pruned: 0, charsRemoved: 0, beforeTokens, afterTokens }

  let pruned = 0
  let charsRemoved = 0
  const runPass = (endExclusive: number): void => {
    for (let index = 0; index < endExclusive && afterTokens >= targetTokens; index += 1) {
      const candidate = candidates[index]
      if (candidate === undefined) continue
      const message = candidate.event.data?.message
      if (message === undefined) continue
      const replacement = pruneToolResultMessage(message)
      if (replacement === undefined) continue
      if (!appendEmergencyReplacement(session, tokenMeter, candidate.seq, candidate.event, replacement)) continue
      pruned += 1
      charsRemoved += replacement.charsRemoved
      afterTokens = tokenMeter.measure(session).totalTokens
    }
  }

  const firstPassEnd = Math.max(0, candidates.length - EMERGENCY_RECENT_TOOL_RESULTS_TO_KEEP)
  runPass(firstPassEnd)

  if (afterTokens >= targetTokens) {
    const secondPassEnd = Math.max(firstPassEnd, candidates.length - EMERGENCY_MIN_TOOL_RESULTS_TO_KEEP)
    for (let index = firstPassEnd; index < secondPassEnd && afterTokens >= targetTokens; index += 1) {
      const candidate = candidates[index]
      if (candidate === undefined) continue
      const current = eventAt(session, candidate.seq)
      const message = current?.data?.message ?? candidate.event.data?.message
      if (message === undefined) continue
      const replacement = pruneToolResultMessage(message)
      if (replacement === undefined) continue
      const sourceEvent = current?.type === 'tool/result' ? current : candidate.event
      if (!appendEmergencyReplacement(session, tokenMeter, candidate.seq, sourceEvent, replacement)) continue
      pruned += 1
      charsRemoved += replacement.charsRemoved
      afterTokens = tokenMeter.measure(session).totalTokens
    }
  }

  return { pruned, charsRemoved, beforeTokens, afterTokens }
}

/**
 * Add two Patrol-specific safeguards around Harness' ordinary compaction:
 *
 * 1. Before every model step, measure the real durable request. Once it crosses
 *    the 30k soft limit, first run a Patrol-only MODEL-FREE pruning pass over old
 *    browser tool results. Only if that cannot create enough headroom do we fall
 *    through to Harness' model-backed context-overflow summarizer.
 * 2. If an OOM still escapes the soft limit, perform the same model-free pass
 *    before one bounded compaction/retry attempt. This prevents the recovery
 *    path itself from immediately asking the already-OOM Qwen model to summarize
 *    the oversized request.
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
      const agent = asAgentLike(payload.agent)
      if (agent === undefined) return next()
      const route = routeFromAgent(agent)
      if (route === undefined || !isPatrolQwenConstrainedRoute(route) || payload.signal.aborted) {
        return next()
      }

      // The model-free emergency pass only needs tokenMeter. Do not gate it on
      // ctx.compaction: the real exported Session proved that optional compaction
      // lookup can be absent while the oversized Qwen request still dispatches.
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

      ctx.logger.warn(
        `[dsh-patrol/context-pressure] ${route.provider}/${route.model} request is ~${measurement.totalTokens} tokens `
        + `(Patrol soft limit ${softLimit}); pruning old tool results before any model-backed compaction`,
      )

      try {
        const emergency = emergencyPrunePatrolToolResults(
          agent.session,
          tokenMeter,
          Math.min(PATROL_QWEN_EMERGENCY_TARGET, softLimit - 1),
        )
        measurement = tokenMeter.measure(agent.session)
        if (emergency.pruned > 0) {
          ctx.logger.warn(
            `[dsh-patrol/context-pressure] model-free emergency prune replaced ${emergency.pruned} old tool results `
            + `(${emergency.charsRemoved} chars removed); request pressure ${emergency.beforeTokens} -> ${measurement.totalTokens}`,
          )
        }
        if (measurement.totalTokens < softLimit) return next()
      } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error)
        ctx.logger.warn(`[dsh-patrol/context-pressure] model-free emergency prune failed: ${message}; trying normal compaction`)
      }

      // Only the model-backed fallback depends on the compaction service.
      const compaction = readCompaction(ctx)
      if (compaction === undefined) {
        ctx.logger.warn(
          `[dsh-patrol/context-pressure] request remains above ${softLimit} tokens after model-free pruning, `
          + 'but compaction service is unavailable in this scope; continuing with the reduced surface',
        )
        return next()
      }

      const before = replaceGeneration(agent.session)
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
      const agent = asAgentLike(payload.agent)
      if (agent === undefined) return next()
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

      const tokenMeter = readTokenMeter(ctx)
      const before = replaceGeneration(agent.session)
      ctx.logger.warn(
        `[dsh-patrol/context-pressure] ${route.provider}/${route.model} returned CUDA OOM at turn ${payload.turn} `
        + `step ${payload.step}; pruning old tool results before any summary call`,
      )

      // The first recovery phase is model-free and must remain available even
      // when the optional model-backed compaction service cannot be resolved.
      if (tokenMeter !== undefined) {
        try {
          const emergency = emergencyPrunePatrolToolResults(
            agent.session,
            tokenMeter,
            Math.min(PATROL_QWEN_EMERGENCY_TARGET, softLimit - 1),
          )
          if (emergency.pruned > 0 && emergency.afterTokens < softLimit && !payload.signal.aborted) {
            ctx.logger.warn(
              `[dsh-patrol/context-pressure] OOM recovery used only model-free pruning `
              + `(${emergency.beforeTokens} -> ${emergency.afterTokens} tokens); retrying this step once`,
            )
            return { kind: 'retry' as const }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error)
          ctx.logger.warn(`[dsh-patrol/context-pressure] OOM model-free prune failed: ${message}; trying normal compaction`)
        }
      }

      const compaction = readCompaction(ctx)
      if (compaction === undefined) {
        const after = replaceGeneration(agent.session)
        if (!payload.signal.aborted && before !== undefined && after !== undefined && after > before) {
          ctx.logger.warn(
            '[dsh-patrol/context-pressure] OOM recovery advanced the durable surface without compaction; retrying this model step once',
          )
          return { kind: 'retry' as const }
        }
        return next()
      }

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
            `[dsh-patrol/context-pressure] OOM compaction reported ${message}, but durable pruning advanced the surface; `
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
