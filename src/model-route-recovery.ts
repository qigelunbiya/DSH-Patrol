import type { Context } from '@deepseek-ai/cordis'
import type LlmRuntime from '@deepseek-ai/dsh-llm'
import {
  isAgentLoopRequest,
  markAgentLoopRequest,
  type GenerateOptions,
  type LlmCallConfig,
  type ReasoningEffortId,
  type StreamChunk,
} from '@deepseek-ai/dsh-llm'

interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

interface AgentDefaultModelService {
  currentSelection(): ModelSelection
}

type PatrolModelRecoveryContext = Context & {
  agentDefaultModel?: AgentDefaultModelService
}

interface FailureLike {
  code?: string
  message?: string
}

interface RequestPosition {
  turn: number
  step: number
}

interface ResolvedRequestRoute extends RequestPosition {
  provider: string
  model: string
}

interface PendingRecovery extends RequestPosition {
  selection: ModelSelection
}

type RequestErrorAction = { kind: 'retry' } | undefined

const LEGACY_UNAVAILABLE_PROVIDER = 'qwen-local'
const LEGACY_UNAVAILABLE_MODEL = 'qwen3.5_122b_a10b_fp4'

function positionKey(position: RequestPosition): string {
  return `${position.turn}:${position.step}`
}

function samePosition(left: RequestPosition, right: RequestPosition): boolean {
  return left.turn === right.turn && left.step === right.step
}

function sameRoute(
  left: Pick<LlmCallConfig, 'provider' | 'model'>,
  right: Pick<LlmCallConfig, 'provider' | 'model'>,
): boolean {
  return left.provider === right.provider && left.model === right.model
}

export function isLegacyUnavailablePatrolRoute(config: Pick<LlmCallConfig, 'provider' | 'model'>): boolean {
  return config.provider === LEGACY_UNAVAILABLE_PROVIDER
    && config.model === LEGACY_UNAVAILABLE_MODEL
}

export function isAuthUnavailableFailure(failure: FailureLike): boolean {
  const code = failure.code?.toLowerCase() ?? ''
  const message = failure.message?.toLowerCase() ?? ''
  return code === 'auth_unavailable'
    || message.includes('auth_unavailable')
    || message.includes('no auth available')
}

/**
 * qwen-local sits behind a local OpenAI-compatible gateway. pi-ai can attach
 * provider-hidden session-affinity headers when a model's compat metadata says
 * they are supported. That is normally useful for prompt caching, but a local
 * auth-pool gateway can then pin one Harness conversation to one credential.
 * When that credential enters an unavailable/cooldown state the conversation
 * keeps receiving `auth_unavailable`, while a newly-created conversation gets a
 * new session id and appears healthy for a while.
 *
 * Patrol is especially exposed because one user turn can make dozens of model
 * calls between browser actions. Strip the transport-only session id for the
 * qwen-local calls owned by THIS Patrol agent. The actual conversation history
 * remains in `messages`; only provider-side affinity/cache routing metadata is
 * removed. Other agents and other providers are untouched.
 */
export function shouldDetachPatrolSessionAffinity(
  provider: string,
  requestSessionId: unknown,
  patrolAgentId: string | undefined,
): boolean {
  return provider === LEGACY_UNAVAILABLE_PROVIDER
    && patrolAgentId !== undefined
    && requestSessionId !== undefined
    && String(requestSessionId) === patrolAgentId
}

/** Clone one request without its provider-hidden transport session id. */
export function detachPatrolSessionAffinity(options: GenerateOptions): GenerateOptions {
  const { sessionId: _sessionId, ...rest } = options
  const detached = Object.isFrozen(options) ? Object.freeze(rest) : rest
  return isAgentLoopRequest(options) ? markAgentLoopRequest(detached) : detached
}

export function choosePatrolModelRecovery(
  config: LlmCallConfig,
  selection: ModelSelection | undefined,
): LlmCallConfig | undefined {
  if (selection === undefined) return undefined
  if (!isLegacyUnavailablePatrolRoute(config)) return undefined
  if (sameRoute(selection, config)) return undefined

  const {
    provider: _oldProvider,
    model: _oldModel,
    reasoningEffort: _oldReasoningEffort,
    ...rest
  } = config
  return {
    ...rest,
    provider: selection.provider,
    model: selection.model,
    ...selection.reasoningEffort === undefined
      ? {}
      : { reasoningEffort: selection.reasoningEffort },
  }
}

export function shouldRetryPatrolModelRouteAfterFailure(
  provider: string,
  failure: FailureLike,
  selection: ModelSelection | undefined,
  model = LEGACY_UNAVAILABLE_MODEL,
): boolean {
  return selection !== undefined
    && isLegacyUnavailablePatrolRoute({ provider, model })
    && isAuthUnavailableFailure(failure)
    && !sameRoute(selection, { provider, model })
}

function readDefaultModelSelection(ctx: Context): ModelSelection | undefined {
  try {
    return (ctx.get('agentDefaultModel') as AgentDefaultModelService | undefined)?.currentSelection()
      ?? (ctx as PatrolModelRecoveryContext).agentDefaultModel?.currentSelection()
  } catch {
    return undefined
  }
}

function readPatrolAgentId(ctx: Context): string | undefined {
  try {
    const agent = ctx.get('agent') as { id?: unknown } | undefined
    const id = agent?.id
    return typeof id === 'string' && id.length > 0 ? id : undefined
  } catch {
    return undefined
  }
}

/**
 * Old Patrol conversations can carry a qwen-local request header after the
 * deployment default has moved elsewhere. Recover that stale route only after
 * the exact old route actually returns auth_unavailable.
 *
 * Separately, qwen-local Patrol calls are re-dispatched without `sessionId` so
 * provider-side auth affinity cannot poison one conversation while new
 * conversations still work. The recursive dispatch is bounded naturally: the
 * replacement request has no sessionId, so this listener delegates it to the
 * normal adapter path on the second pass.
 *
 * Route recovery remains deliberately one-shot per model step:
 * - healthy qwen-local traffic is never rewritten to a different model;
 * - the first matching stale-route auth failure arms exactly one immediate retry;
 * - the following agent/request consumes that arm and swaps to the current
 *   default route, which the agent loop then persists as the new request header;
 * - any later failure delegates to Harness' normal bounded retry policy.
 */
export function registerPatrolModelRouteRecovery(ctx: Context): () => void {
  let lastResolvedRoute: ResolvedRequestRoute | undefined
  let pendingRecovery: PendingRecovery | undefined
  let attemptedPositionKey: string | undefined
  const patrolAgentId = readPatrolAgentId(ctx)

  const disposeTransport = patrolAgentId === undefined
    ? () => {}
    : ctx.on(
      'llm/stream',
      function isolatePatrolQwenSession(
        this: LlmRuntime,
        options: GenerateOptions,
        next: () => AsyncIterable<StreamChunk>,
      ): AsyncIterable<StreamChunk> {
        if (!shouldDetachPatrolSessionAffinity(options.provider, options.sessionId, patrolAgentId)) {
          return next()
        }
        ctx.logger.debug(
          '[dsh-patrol/model-route-recovery] stripping qwen-local transport session affinity for Patrol agent %s',
          patrolAgentId,
        )
        return this.stream(detachPatrolSessionAffinity(options))
      },
      { prepend: true },
    )

  const disposeRequest = ctx.on(
    'agent/request',
    async (
      payload: RequestPosition,
      next: () => Promise<LlmCallConfig>,
    ): Promise<LlmCallConfig> => {
      const key = positionKey(payload)
      if (attemptedPositionKey !== undefined && attemptedPositionKey !== key) {
        attemptedPositionKey = undefined
      }
      if (pendingRecovery !== undefined && !samePosition(pendingRecovery, payload)) {
        pendingRecovery = undefined
      }

      const resolved = await next()
      let effective = resolved

      if (pendingRecovery !== undefined && samePosition(pendingRecovery, payload)) {
        const armed = pendingRecovery
        pendingRecovery = undefined
        effective = choosePatrolModelRecovery(resolved, armed.selection) ?? resolved
      }

      lastResolvedRoute = {
        turn: payload.turn,
        step: payload.step,
        provider: effective.provider,
        model: effective.model,
      }
      return effective
    },
    { prepend: true },
  )

  const disposeRequestError = ctx.on(
    'agent/request-error',
    async (
      payload: RequestPosition & { provider: string; failure: FailureLike },
      next: () => Promise<RequestErrorAction>,
    ): Promise<RequestErrorAction> => {
      const failedRoute = lastResolvedRoute
      if (failedRoute === undefined
        || !samePosition(failedRoute, payload)
        || failedRoute.provider !== payload.provider) {
        return next()
      }

      const key = positionKey(payload)
      if (attemptedPositionKey === key) return next()

      const selection = readDefaultModelSelection(ctx)
      if (selection === undefined || !shouldRetryPatrolModelRouteAfterFailure(
        failedRoute.provider,
        payload.failure,
        selection,
        failedRoute.model,
      )) {
        return next()
      }

      attemptedPositionKey = key
      pendingRecovery = {
        turn: payload.turn,
        step: payload.step,
        selection,
      }
      ctx.logger.warn(
        `[dsh-patrol/model-route-recovery] ${failedRoute.provider}/${failedRoute.model} returned auth_unavailable; `
        + `retrying this step once with ${selection.provider}/${selection.model}`,
      )
      return { kind: 'retry' }
    },
    { prepend: true },
  )

  return () => {
    disposeTransport()
    disposeRequest()
    disposeRequestError()
  }
}
