import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { batchToolExecution, executeSingleTool, patrolCallId } from '../src/tool-compat.js'

const signal = new AbortController().signal

interface Captured {
  input?: Record<string, any>
}

/** Stub the tool service with the result shape the mounted contract would return. */
function stubContext(captured: Captured): Context {
  const legacyResult = {
    isError: false as const,
    value: { ok: true },
    content: [{ type: 'text', text: 'done' }],
  }
  return {
    tools: {
      execute: async (input: Record<string, any>) => {
        captured.input = input
        return batchToolExecution ? { results: [{ result: legacyResult }] } : legacyResult
      },
    },
  } as unknown as Context
}

describe('tool compatibility bridge', () => {
  it('brands synthesized call ids without changing the underlying string', () => {
    expect(patrolCallId('patrol-1')).toBe('patrol-1')
  })

  it('forwards one call through whichever contract the Harness exposes', async () => {
    const captured: Captured = {}
    const result = await executeSingleTool(stubContext(captured), {
      callId: 'patrol-1',
      name: 'demo',
      arguments: { a: 1 },
      signal,
      rootCallId: 'root' as never,
      parent: 'token' as never,
    })

    expect(result.isError).toBe(false)
    expect(captured.input).toBeDefined()

    if (batchToolExecution) {
      expect(captured.input?.calls).toEqual([{
        type: 'tool-call',
        id: 'patrol-1',
        name: 'demo',
        arguments: '{"a":1}',
      }])
      expect(captured.input?.parent).toBeUndefined()
    } else {
      expect(captured.input).toMatchObject({
        callId: 'patrol-1',
        name: 'demo',
        arguments: { a: 1 },
        parent: 'token',
      })
      expect(captured.input?.calls).toBeUndefined()
    }
  })

  it('reports an unsettled batch result instead of a silent success', async () => {
    if (!batchToolExecution) return
    const ctx = { tools: { execute: async () => ({ results: [] }) } } as unknown as Context
    const result = await executeSingleTool(ctx, {
      callId: 'patrol-2',
      name: 'demo',
      arguments: {},
      signal,
    })
    expect(result.isError).toBe(true)
  })
})
