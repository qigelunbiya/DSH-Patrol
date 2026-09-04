import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  choosePatrolModelRecovery,
  isAuthUnavailableFailure,
  isLegacyUnavailablePatrolRoute,
  registerPatrolModelRouteRecovery,
  shouldRetryPatrolModelRouteAfterFailure,
} from '../src/model-route-recovery.js'

const LEGACY_ROUTE = {
  provider: 'qwen-local',
  model: 'qwen3.5_122b_a10b_fp4',
}

const FALLBACK_ROUTE = {
  provider: 'openai',
  model: 'gpt-5.6-sol',
}

const AUTH_FAILURE = {
  code: 'internal_server_error',
  message: '503: {"message":"auth_unavailable: no auth available"}',
}

function requestPayload(turn = 1, step = 1) {
  return { turn, step, signal: new AbortController().signal }
}

function requestErrorPayload(provider: string, turn = 1, step = 1) {
  return {
    turn,
    step,
    provider,
    failure: AUTH_FAILURE,
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }
}

describe('Patrol model route recovery', () => {
  it('recognizes only the exact legacy qwen-local route', () => {
    expect(isLegacyUnavailablePatrolRoute(LEGACY_ROUTE)).toBe(true)
    expect(isLegacyUnavailablePatrolRoute({
      provider: 'qwen-local',
      model: 'another-model',
    })).toBe(false)
    expect(isLegacyUnavailablePatrolRoute({
      provider: 'another-provider',
      model: LEGACY_ROUTE.model,
    })).toBe(false)
  })

  it('does not rewrite unrelated routes', () => {
    expect(isLegacyUnavailablePatrolRoute(FALLBACK_ROUTE)).toBe(false)
  })

  it('switches an armed stale Patrol request to the current default model selection', () => {
    expect(choosePatrolModelRecovery({
      ...LEGACY_ROUTE,
      temperature: 0.2,
      reasoningEffort: 'high',
    }, FALLBACK_ROUTE)).toEqual({
      ...FALLBACK_ROUTE,
      temperature: 0.2,
    })
  })

  it('keeps the selected reasoning effort when the fallback model has one', () => {
    expect(choosePatrolModelRecovery(LEGACY_ROUTE, {
      ...FALLBACK_ROUTE,
      reasoningEffort: 'medium',
    })).toMatchObject({
      ...FALLBACK_ROUTE,
      reasoningEffort: 'medium',
    })
  })

  it('detects auth_unavailable failures from normalized LLM errors', () => {
    expect(isAuthUnavailableFailure(AUTH_FAILURE)).toBe(true)
  })

  it('only requests route recovery for the exact stale route and a different fallback', () => {
    expect(shouldRetryPatrolModelRouteAfterFailure(
      LEGACY_ROUTE.provider,
      AUTH_FAILURE,
      FALLBACK_ROUTE,
      LEGACY_ROUTE.model,
    )).toBe(true)

    expect(shouldRetryPatrolModelRouteAfterFailure(
      LEGACY_ROUTE.provider,
      AUTH_FAILURE,
      LEGACY_ROUTE,
      LEGACY_ROUTE.model,
    )).toBe(false)

    expect(shouldRetryPatrolModelRouteAfterFailure(
      LEGACY_ROUTE.provider,
      AUTH_FAILURE,
      FALLBACK_ROUTE,
      'another-model',
    )).toBe(false)
  })

  it('does not rewrite healthy qwen-local requests before a real auth failure', async () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel', {
      currentSelection: () => FALLBACK_ROUTE,
    })
    registerPatrolModelRouteRecovery(ctx)

    await expect(ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(LEGACY_ROUTE),
    )).resolves.toEqual(LEGACY_ROUTE)
    await ctx.fiber.dispose()
  })

  it('arms exactly one fallback retry after auth_unavailable and persists it through the next request', async () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel', {
      currentSelection: () => FALLBACK_ROUTE,
    })
    registerPatrolModelRouteRecovery(ctx)

    await expect(ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(LEGACY_ROUTE),
    )).resolves.toEqual(LEGACY_ROUTE)

    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(LEGACY_ROUTE.provider),
      () => Promise.resolve(undefined),
    )).resolves.toEqual({ kind: 'retry' })

    await expect(ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(LEGACY_ROUTE),
    )).resolves.toEqual(FALLBACK_ROUTE)

    await ctx.fiber.dispose()
  })

  it('delegates later failures in the same step to Harness bounded retry policy', async () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel', {
      currentSelection: () => FALLBACK_ROUTE,
    })
    registerPatrolModelRouteRecovery(ctx)

    await ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(LEGACY_ROUTE),
    )
    await ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(LEGACY_ROUTE.provider),
      () => Promise.resolve(undefined),
    )
    await ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(LEGACY_ROUTE),
    )

    const downstream = vi.fn(() => Promise.resolve(undefined))
    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(FALLBACK_ROUTE.provider),
      downstream,
    )).resolves.toBeUndefined()
    expect(downstream).toHaveBeenCalledOnce()

    await ctx.fiber.dispose()
  })

  it('waits through one qwen-local auth cooldown quietly, then delegates a repeated failure', async () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel', {
      currentSelection: () => LEGACY_ROUTE,
    })
    registerPatrolModelRouteRecovery(ctx, 0)

    await ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(LEGACY_ROUTE),
    )

    const downstream = vi.fn(() => Promise.resolve(undefined))
    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(LEGACY_ROUTE.provider),
      downstream,
    )).resolves.toEqual({ kind: 'retry' })
    expect(downstream).not.toHaveBeenCalled()

    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(LEGACY_ROUTE.provider),
      downstream,
    )).resolves.toBeUndefined()
    expect(downstream).toHaveBeenCalledOnce()

    await ctx.fiber.dispose()
  })

  it('reads the default model service from a runtime plugin context without declaring it as an injected property', async () => {
    const ctx = new Context()
    ctx.provide('tools', {})
    ctx.provide('agentDefaultModel', {
      currentSelection: () => FALLBACK_ROUTE,
    })

    await ctx.plugin({
      name: 'patrol-recovery-test-plugin',
      inject: ['tools'],
      apply(pluginCtx: Context) {
        registerPatrolModelRouteRecovery(pluginCtx)
      },
    })

    await ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(LEGACY_ROUTE),
    )
    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(LEGACY_ROUTE.provider),
      () => Promise.resolve(undefined),
    )).resolves.toEqual({ kind: 'retry' })
    await expect(ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(LEGACY_ROUTE),
    )).resolves.toEqual(FALLBACK_ROUTE)

    await ctx.fiber.dispose()
  })

  it('runs outside older model-selection listeners after recovery is armed', async () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel', {
      currentSelection: () => FALLBACK_ROUTE,
    })
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, ...LEGACY_ROUTE }
    })
    registerPatrolModelRouteRecovery(ctx)

    await expect(ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(FALLBACK_ROUTE),
    )).resolves.toEqual(LEGACY_ROUTE)

    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(LEGACY_ROUTE.provider),
      () => Promise.resolve(undefined),
    )).resolves.toEqual({ kind: 'retry' })

    await expect(ctx.waterfall(
      'agent/request',
      requestPayload(),
      () => Promise.resolve(FALLBACK_ROUTE),
    )).resolves.toEqual(FALLBACK_ROUTE)

    await ctx.fiber.dispose()
  })
})
