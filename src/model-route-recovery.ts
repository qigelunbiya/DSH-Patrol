import type { Context } from '@deepseek-ai/cordis'
import type {
  LlmCallConfig,
  ReasoningEffortId,
} from '@deepseek-ai/dsh-llm'
import { registerPatrolContextPressureGuard } from './context-pressure-guard.js'

interface ModelSelection {
  provider: string
  model: string
  reasoningEffort?: ReasoningEffortId
}

interface AgentDefaultModelService {
  currentSelection(): ModelSelection
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

const LEGACY_UNAVAILABLE_MODEL = 'qwen3.5_122b_a10b_fp4'
const LEGACY_UNAVAILABLE_PROVIDERS = new Set(['cliproxy', 'qwen-local'])

/**
 * CLIProxy clamps short model/auth cooldown hints to at least 10 seconds. The
 * failing Patrol Session showed the route still unavailable through ~8 seconds
 * and healthy again on the request issued around 15 seconds. Wait just beyond
 * that floor once instead of producing five visible exponential retry events.
 */
export const PATROL_AUTH_UNAVAILABLE_SETTLE_MS = 10_500

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

/**
 * Historical Patrol builds sometimes recorded the local Qwen route directly as
 * `qwen-local`; current Harness configurations route the same backend through
 * the OpenAI-compatible `cliproxy` provider. Accept both durable spellings so a
 * stale conversation can still move to a new default route after a real auth
 * failure. This recovery is NOT the CUDA-OOM fix; context pressure is handled by
 * context-pressure-guard.ts before the request reaches the gateway.
 */
export function isLegacyUnavailablePatrolRoute(config: Pick<LlmCallConfig, 'provider' | 'model'>): boolean {
  return LEGACY_UNAVAILABLE_PROVIDERS.has(config.provider)
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
  } catch {
    return undefined
  }
}

async function waitForPatrolRouteSettle(signal: AbortSignal, delayMs: number): Promise<boolean> {
  if (signal.aborted) return false
  const normalized = Number.isFinite(delayMs)
    ? Math.max(0, Math.floor(delayMs))
    : PATROL_AUTH_UNAVAILABLE_SETTLE_MS
  if (normalized === 0) return true

  return new Promise<boolean>((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (ready: boolean): void => {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      resolve(ready)
    }
    const onAbort = (): void => finish(false)
    timer = setTimeout(() => finish(true), normalized)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Recover ONLY stale durable model routing. A matching auth failure can arm one
 * immediate swap to the current default model for the same model step. Later
 * failures are delegated to Harness' bounded retry layer.
 *
 * A previous Patrol build also stripped the LLM transport session id here. The
 * real failing Session log disproved that hypothesis: Harness routes through
 * `cliproxy`, and the first upstream failure after cooldown is a CUDA OOM. The
 * gateway then reports qwen-local as auth-unavailable on later retries. Session
 * affinity rewriting has therefore been removed instead of masking the actual
 * memory-pressure failure.
 */
export function registerPatrolModelRouteRecovery(
  ctx: Context,
  authUnavailableSettleMs = PATROL_AUTH_UNAVAILABLE_SETTLE_MS,
): () => void {
  let lastResolvedRoute: ResolvedRequestRoute | undefined
  let pendingRecovery: PendingRecovery | undefined
  let attemptedPositionKey: string | undefined
  let quietRetryPositionKey: string | undefined
  const disposePressureGuard = registerPatrolContextPressureGuard(ctx)

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
      if (quietRetryPositionKey !== undefined && quietRetryPositionKey !== key) {
        quietRetryPositionKey = undefined
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
      payload: RequestPosition & { provider: string; failure: FailureLike; signal: AbortSignal },
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
      if (selection !== undefined && shouldRetryPatrolModelRouteAfterFailure(
        failedRoute.provider,
        payload.failure,
        selection,
        failedRoute.model,
      )) {
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
      }

      if (!isLegacyUnavailablePatrolRoute(failedRoute)
        || !isAuthUnavailableFailure(payload.failure)
        || quietRetryPositionKey === key) {
        return next()
      }

      // A same-route auth_unavailable from qwen-local is normally a temporary
      // CLIProxy eligibility/cooldown state, not a credential repair action.
      // Consume exactly one such failure here, wait past the gateway's minimum
      // cooldown floor, then retry without entering dsh-llm-retry. This prevents
      // the UI from showing 5 doomed 0.5/1/2/4s probes. If the quiet retry still
      // fails, the same position is marked and the next error delegates to the
      // ordinary bounded Harness retry policy.
      quietRetryPositionKey = key
      ctx.logger.warn(
        `[dsh-patrol/model-route-recovery] ${failedRoute.provider}/${failedRoute.model} returned auth_unavailable; `
        + `waiting ${authUnavailableSettleMs}ms for gateway cooldown before one quiet retry`,
      )
      const settled = await waitForPatrolRouteSettle(payload.signal, authUnavailableSettleMs)
      if (!settled || payload.signal.aborted) return next()
      return { kind: 'retry' }
    },
    { prepend: true },
  )

  return () => {
    disposePressureGuard()
    disposeRequest()
    disposeRequestError()
  }
}
