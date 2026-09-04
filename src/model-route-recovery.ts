import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

interface AgentDefaultModelService {
  currentSelection(): ModelSelection
}

interface PatrolModelRecoveryContext extends Context {
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

/**
 * Old Patrol conversations can carry a qwen-local request header after the
 * deployment default has moved elsewhere. Recover that stale route only after
 * the exact old route actually returns auth_unavailable.
 *
 * Recovery is deliberately one-shot per model step:
 * - healthy qwen-local traffic is never rewritten;
 * - the first matching auth failure arms exactly one immediate retry;
 * - the following agent/request consumes that arm and swaps to the current
 *   default route, which the agent loop then persists as the new request header;
 * - any later failure delegates to Harness' normal bounded retry policy.
 *
 * This matters because returning { kind: 'retry' } from agent/request-error
 * bypasses the normal llm-retry listener. The previous implementation returned
 * it on every matching failure, creating an unbounded retry loop when the route
 * could not actually recover.
 */
export function registerPatrolModelRouteRecovery(ctx: Context): () => void {
  let lastResolvedRoute: ResolvedRequestRoute | undefined
  let pendingRecovery: PendingRecovery | undefined
  let attemptedPositionKey: string | undefined

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
    disposeRequest()
    disposeRequestError()
  }
}
