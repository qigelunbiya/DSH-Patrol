import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  emergencyPrunePatrolToolResults,
  isCudaOutOfMemoryFailure,
  isPatrolQwenConstrainedRoute,
  PATROL_QWEN_EMERGENCY_TARGET,
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

function replayableAgent(toolResultCount = 16, charsPerResult = 2000) {
  const events: Array<Record<string, any>> = []
  const nodes: number[] = []
  for (let index = 0; index < toolResultCount; index += 1) {
    const seq = events.length
    const message = {
      role: 'user',
      source: { kind: 'tool', callId: `call-${index}` },
      content: [{
        type: 'tool-result',
        toolCallId: `call-${index}`,
        content: [{ type: 'text', text: String(index).padStart(2, '0') + '-'.repeat(charsPerResult - 2) }],
        isError: false,
      }],
    }
    events.push({ type: 'tool/result', seq, data: { turn: 1, step: index + 1, message }, surfaceOp: 'append' })
    nodes.push(seq)
  }

  const session = {
    requestHeader: () => ({ config: QWEN_ROUTE }),
    surface: { replaceGeneration: 0, nodes },
    events,
    append(type: string, data: unknown, options?: { surfaceOp?: any; sourceEventSeqs?: number[] }) {
      const seq = events.length
      const event = { type, seq, data, ...options }
      events.push(event)
      const replace = options?.surfaceOp
      if (replace && typeof replace === 'object' && replace.op === 'replace') {
        const index = nodes.indexOf(replace.start)
        if (index >= 0) nodes[index] = seq
        session.surface.replaceGeneration += 1
      }
      return { seq }
    },
  }
  return {
    id: 'patrol-session',
    session,
    options: QWEN_ROUTE,
  }
}

function textChars(message: any): number {
  let chars = 0
  for (const outer of message?.content ?? []) {
    if (outer?.type !== 'tool-result') continue
    for (const block of outer.content ?? []) {
      if (block?.type === 'text') chars += String(block.text ?? '').length
    }
  }
  return chars
}

function replayTokenMeter() {
  return {
    measure(session: ReturnType<typeof replayableAgent>['session']) {
      let surfaceTokens = 0
      for (const seq of session.surface.nodes) {
        const event = session.events[seq]
        if (event?.type !== 'tool/result') continue
        surfaceTokens += Math.ceil(textChars(event.data.message) / 4) + 12
      }
      return { totalTokens: 24_000 + surfaceTokens }
    },
    estimateMessage(message: unknown) {
      return Math.ceil(textChars(message) / 4) + 12
    },
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

  it('model-free emergency pruning shrinks old browser results while preserving the newest four', () => {
    const agent = replayableAgent()
    const meter = replayTokenMeter()
    const newestFour = [...agent.session.surface.nodes].slice(-4)
    const before = meter.measure(agent.session).totalTokens

    const result = emergencyPrunePatrolToolResults(agent.session, meter)

    expect(before).toBeGreaterThan(PATROL_QWEN_SOFT_REQUEST_LIMIT)
    expect(result.pruned).toBeGreaterThan(0)
    expect(result.afterTokens).toBeLessThan(PATROL_QWEN_EMERGENCY_TARGET)
    expect(agent.session.surface.replaceGeneration).toBe(result.pruned)
    for (const seq of newestFour) {
      expect(agent.session.surface.nodes).toContain(seq)
      expect(textChars(agent.session.events[seq]?.data?.message)).toBe(2000)
    }
  })

  it('avoids the Qwen-backed summarizer when model-free pruning creates enough headroom', async () => {
    const ctx = new Context()
    const agent = replayableAgent()
    const tokenMeter = replayTokenMeter()
    const compactIfNeeded = vi.fn(async () => null)
    ctx.provide('tokenMeter', tokenMeter)
    ctx.provide('compaction', { compactIfNeeded })
    registerPatrolContextPressureGuard(ctx)

    const downstream = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
    await ctx.waterfall(
      'agent/pre-step',
      {
        agent,
        messages: [],
        turn: 1,
        step: 1,
        signal: new AbortController().signal,
      } as never,
      downstream,
    )

    expect(tokenMeter.measure(agent.session).totalTokens).toBeLessThan(PATROL_QWEN_SOFT_REQUEST_LIMIT)
    expect(compactIfNeeded).not.toHaveBeenCalled()
    expect(downstream).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })

  it('compacts before dispatch when measured request pressure crosses the soft limit and model-free pruning is unavailable', async () => {
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
