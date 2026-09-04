import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  isCudaOutOfMemoryFailure,
  isPatrolQwenConstrainedRoute,
  PATROL_QWEN_SOFT_REQUEST_LIMIT,
  registerPatrolContextPressureGuard,
  shouldForcePatrolCompaction,
} from '../src/context-pressure-guard.js'

const QWEN_ROUTE = {
  provider: 'cliproxy',
  model: 'qwen3.5_122b_a10b_fp4',
}

function fakeAgent(totalReplaceGeneration = 0) {
  const session = {
    requestHeader: () => ({ config: QWEN_ROUTE }),
    surface: { replaceGeneration: totalReplaceGeneration },
  }
  return {
    id: 'patrol-session',
    session,
    options: QWEN_ROUTE,
  }
}

function preStepPayload(agent: ReturnType<typeof fakeAgent>) {
  return {
    agent,
    messages: [],
    turn: 1,
    step: 1,
    signal: new AbortController().signal,
  }
}

function requestErrorPayload(agent: ReturnType<typeof fakeAgent>, message: string) {
  return {
    agent,
    turn: 1,
    step: 1,
    provider: QWEN_ROUTE.provider,
    failure: { code: 'RATE_LIMIT', message },
    retryPolicy: undefined,
    signal: new AbortController().signal,
  }
}

describe('Patrol constrained-Qwen context pressure guard', () => {
  it('matches the real cliproxy route from the failing Session log and the older direct alias', () => {
    expect(isPatrolQwenConstrainedRoute(QWEN_ROUTE)).toBe(true)
    expect(isPatrolQwenConstrainedRoute({ ...QWEN_ROUTE, provider: 'qwen-local' })).toBe(true)
    expect(isPatrolQwenConstrainedRoute({ ...QWEN_ROUTE, provider: 'deepseek-official' })).toBe(false)
    expect(isPatrolQwenConstrainedRoute({ ...QWEN_ROUTE, model: 'another-model' })).toBe(false)
  })

  it('forces early compaction at the Patrol soft limit instead of the advertised 262k context threshold', () => {
    expect(shouldForcePatrolCompaction(QWEN_ROUTE, PATROL_QWEN_SOFT_REQUEST_LIMIT - 1)).toBe(false)
    expect(shouldForcePatrolCompaction(QWEN_ROUTE, PATROL_QWEN_SOFT_REQUEST_LIMIT)).toBe(true)
    expect(shouldForcePatrolCompaction({ provider: 'openai', model: QWEN_ROUTE.model }, 100_000)).toBe(false)
  })

  it('recognizes CUDA OOM even when the adapter normalizes it as another retryable code', () => {
    expect(isCudaOutOfMemoryFailure({
      code: 'RATE_LIMIT',
      message: '500: Internal server error: CUDA out of memory. Tried to allocate 576.00 MiB.',
    })).toBe(true)
    expect(isCudaOutOfMemoryFailure({
      code: 'SERVER',
      message: '503: auth_unavailable: no auth available',
    })).toBe(false)
  })

  it('compacts before dispatch when measured request pressure crosses the soft limit', async () => {
    const ctx = new Context()
    const agent = fakeAgent()
    const compactIfNeeded = vi.fn(async () => {
      agent.session.surface.replaceGeneration += 1
      return { shadowedSeqs: [1] }
    })
    const measure = vi.fn(() => ({ totalTokens: PATROL_QWEN_SOFT_REQUEST_LIMIT + 500 }))
    ctx.provide('tokenMeter', { measure })
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    const downstream = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
    await ctx.waterfall(
      'agent/pre-step',
      preStepPayload(agent) as never,
      downstream,
    )

    expect(compactIfNeeded).toHaveBeenCalledOnce()
    expect(compactIfNeeded).toHaveBeenCalledWith(agent, 'context-overflow', expect.any(AbortSignal))
    expect(downstream).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('does not compact healthy low-pressure steps', async () => {
    const ctx = new Context()
    const agent = fakeAgent()
    const compactIfNeeded = vi.fn(async () => null)
    ctx.provide('tokenMeter', { measure: () => ({ totalTokens: PATROL_QWEN_SOFT_REQUEST_LIMIT - 500 }) })
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    await ctx.waterfall(
      'agent/pre-step',
      preStepPayload(agent) as never,
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(compactIfNeeded).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })

  it('owns one immediate retry when CUDA OOM recovery advances the durable surface', async () => {
    const ctx = new Context()
    const agent = fakeAgent()
    const compactIfNeeded = vi.fn(async () => {
      agent.session.surface.replaceGeneration += 1
      return { shadowedSeqs: [1] }
    })
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    const downstream = vi.fn(async () => undefined)
    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(agent, '500: CUDA out of memory. Tried to allocate 576.00 MiB.') as never,
      downstream,
    )).resolves.toEqual({ kind: 'retry' })

    expect(compactIfNeeded).toHaveBeenCalledOnce()
    expect(downstream).not.toHaveBeenCalled()

    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(agent, '500: CUDA out of memory. Tried to allocate 576.00 MiB.') as never,
      downstream,
    )).resolves.toBeUndefined()
    expect(downstream).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('delegates auth_unavailable because the Session log proves it is the post-OOM symptom', async () => {
    const ctx = new Context()
    const agent = fakeAgent()
    const compactIfNeeded = vi.fn(async () => null)
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    const downstream = vi.fn(async () => undefined)
    await expect(ctx.waterfall(
      'agent/request-error',
      requestErrorPayload(agent, '503: auth_unavailable: no auth available') as never,
      downstream,
    )).resolves.toBeUndefined()

    expect(compactIfNeeded).not.toHaveBeenCalled()
    expect(downstream).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
