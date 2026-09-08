import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  PATROL_QWEN_HARDENED_COMPACT_LIMIT,
  PATROL_QWEN_HARDENED_PRUNE_LIMIT,
  PATROL_QWEN_NO_METER_COMPACT_STEP,
  registerPatrolContextPressureGuard,
} from '../src/context-pressure-hardening.js'

const QWEN_ROUTE = { provider: 'cliproxy', model: 'qwen3.5_122b_a10b_fp4' }

function agent() {
  const session = {
    requestHeader: () => ({ config: QWEN_ROUTE }),
    surface: { replaceGeneration: 0 },
  }
  return { session, options: QWEN_ROUTE }
}

function payload(value: ReturnType<typeof agent>, step: number, turn = 1) {
  return {
    agent: value,
    messages: [],
    turn,
    step,
    signal: new AbortController().signal,
  }
}

describe('mounted Patrol local-Qwen hardening', () => {
  it('keeps materially more headroom than the previous 16k dispatch threshold', () => {
    expect(PATROL_QWEN_HARDENED_PRUNE_LIMIT).toBeLessThanOrEqual(6_000)
    expect(PATROL_QWEN_HARDENED_COMPACT_LIMIT).toBeLessThanOrEqual(10_000)
  })

  it('forces compaction by model-step count when tokenMeter is unavailable', async () => {
    const ctx = new Context()
    const current = agent()
    const pruneSession = vi.fn(() => {
      current.session.surface.replaceGeneration += 1
      return { pruned: [{ callId: 'old-observe' }], charsRemoved: 12_000 }
    })
    const compactIfNeeded = vi.fn(async () => {
      current.session.surface.replaceGeneration += 1
      return { shadowedSeqs: [1] }
    })
    ctx.provide('toolResultPruner', { pruneSession })
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    await ctx.waterfall(
      'agent/pre-step',
      payload(current, PATROL_QWEN_NO_METER_COMPACT_STEP) as never,
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(pruneSession).toHaveBeenCalledOnce()
    expect(compactIfNeeded).toHaveBeenCalledOnce()
    expect(compactIfNeeded).toHaveBeenCalledWith(current, 'context-overflow', expect.any(AbortSignal))
    await ctx.fiber.dispose()
  })

  it('carries the no-meter fallback counter across Harness turns', async () => {
    const ctx = new Context()
    const current = agent()
    const pruneSession = vi.fn(() => ({ pruned: [], charsRemoved: 0 }))
    const compactIfNeeded = vi.fn(async () => null)
    ctx.provide('toolResultPruner', { pruneSession })
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    for (let turn = 1; turn <= PATROL_QWEN_NO_METER_COMPACT_STEP; turn += 1) {
      await ctx.waterfall(
        'agent/pre-step',
        payload(current, 1, turn) as never,
        async () => ({ kind: 'enter' as const, messages: [] }),
      )
    }

    expect(compactIfNeeded).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('prunes at 6k and avoids compaction when measurement proves pruning made enough room', async () => {
    const ctx = new Context()
    const current = agent()
    const measure = vi.fn()
      .mockReturnValueOnce({ totalTokens: PATROL_QWEN_HARDENED_PRUNE_LIMIT + 500 })
      .mockReturnValueOnce({ totalTokens: PATROL_QWEN_HARDENED_PRUNE_LIMIT - 1_000 })
    const pruneSession = vi.fn(() => {
      current.session.surface.replaceGeneration += 1
      return { pruned: [{ callId: 'large-snapshot' }], charsRemoved: 8_000 }
    })
    const compactIfNeeded = vi.fn(async () => null)
    ctx.provide('tokenMeter', { measure })
    ctx.provide('toolResultPruner', { pruneSession })
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    await ctx.waterfall(
      'agent/pre-step',
      payload(current, 2) as never,
      async () => ({ kind: 'enter' as const, messages: [] }),
    )

    expect(pruneSession).toHaveBeenCalledOnce()
    expect(compactIfNeeded).not.toHaveBeenCalled()
    await ctx.fiber.dispose()
  })
})
