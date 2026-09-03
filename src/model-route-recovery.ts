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

type RequestErrorAction = { kind: 'retry' } | undefined

const LEGACY_UNAVAILABLE_PROVIDER = 'qwen-local'
const LEGACY_UNAVAILABLE_MODEL = 'qwen3.5_122b_a10b_fp4'

export function isLegacyUnavailablePatrolRoute(config: Pick<LlmCallConfig, 'provider' | 'model'>): boolean {
  return config.provider === LEGACY_UNAVAILABLE_PROVIDER
    || config.model === LEGACY_UNAVAILABLE_MODEL
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
  if (selection.provider === config.provider && selection.model === config.model) return undefined

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
): boolean {
  return provider === LEGACY_UNAVAILABLE_PROVIDER
    && isAuthUnavailableFailure(failure)
    && selection !== undefined
    && selection.provider !== provider
}

function readDefaultModelSelection(ctx: Context): ModelSelection | undefined {
  try {
    return (ctx.get('agentDefaultModel') as AgentDefaultModelService | undefined)?.currentSelection()
      ?? (ctx as PatrolModelRecoveryContext).agentDefaultModel?.currentSelection()
  } catch {
    return undefined
  }
}

export function registerPatrolModelRouteRecovery(ctx: Context): () => void {
  const disposeRequest = ctx.on(
    'agent/request',
    async (_payload: unknown, next: () => Promise<LlmCallConfig>): Promise<LlmCallConfig> => {
      const resolved = await next()
      return choosePatrolModelRecovery(resolved, readDefaultModelSelection(ctx)) ?? resolved
    },
    { prepend: true },
  )

  const disposeRequestError = ctx.on(
    'agent/request-error',
    async (
      payload: { provider: string; failure: FailureLike },
      next: () => Promise<RequestErrorAction>,
    ): Promise<RequestErrorAction> => {
      return shouldRetryPatrolModelRouteAfterFailure(payload.provider, payload.failure, readDefaultModelSelection(ctx))
        ? { kind: 'retry' }
        : next()
    },
    { prepend: true },
  )

  return () => {
    disposeRequest()
    disposeRequestError()
  }
}
