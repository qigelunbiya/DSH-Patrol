import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  PATROL_QWEN_SOFT_REQUEST_LIMIT,
  registerPatrolContextPressureGuard,
} from '../src/context-pressure-guard.js'

const QWEN_ROUTE = {
  provider: 'cliproxy',
  model: 'qwen3.5_122b_a10b_fp4',
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
        const surfaceIndex = nodes.indexOf(replace.start)
        if (surfaceIndex >= 0) nodes[surfaceIndex] = seq
        session.surface.replaceGeneration += 1
      }
      return { seq }
    },
  }
  return { id: 'patrol-session', session, options: QWEN_ROUTE }
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

function tokenMeter() {
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

describe('Patrol model-free pressure recovery without ctx.compaction', () => {
  it('prunes an oversized Qwen session even when the compaction service is absent', async () => {
    const ctx = new Context()
    const agent = replayableAgent()
    const meter = tokenMeter()
    ctx.provide('tokenMeter', meter)
    registerPatrolContextPressureGuard(ctx)

    expect(meter.measure(agent.session).totalTokens).toBeGreaterThan(PATROL_QWEN_SOFT_REQUEST_LIMIT)

    const downstream = vi.fn(async () => ({ kind: 'enter' as const, messages: [] }))
    await ctx.waterfall('agent/pre-step', {
      agent,
      messages: [],
      turn: 1,
      step: 1,
      signal: new AbortController().signal,
    } as never, downstream)

    expect(agent.session.events.some(event => event.type === 'compaction/prune')).toBe(true)
    expect(meter.measure(agent.session).totalTokens).toBeLessThan(PATROL_QWEN_SOFT_REQUEST_LIMIT)
    expect(downstream).toHaveBeenCalledOnce()
    await ctx.fiber.dispose()
  })
})
