import { describe, expect, it } from 'vitest'
import {
  isAgentLoopRequest,
  markAgentLoopRequest,
  type GenerateOptions,
} from '@deepseek-ai/dsh-llm'
import {
  detachPatrolSessionAffinity,
  shouldDetachPatrolSessionAffinity,
} from '../src/model-route-recovery.js'

function request(sessionId = 'patrol-session-1'): GenerateOptions {
  return {
    provider: 'qwen-local',
    model: 'qwen3.5_122b_a10b_fp4',
    messages: [],
    sessionId: sessionId as GenerateOptions['sessionId'],
  }
}

describe('Patrol qwen-local transport affinity isolation', () => {
  it('isolates only the qwen-local request owned by this Patrol agent', () => {
    expect(shouldDetachPatrolSessionAffinity('qwen-local', 'patrol-session-1', 'patrol-session-1')).toBe(true)
    expect(shouldDetachPatrolSessionAffinity('qwen-local', 'another-session', 'patrol-session-1')).toBe(false)
    expect(shouldDetachPatrolSessionAffinity('openai', 'patrol-session-1', 'patrol-session-1')).toBe(false)
    expect(shouldDetachPatrolSessionAffinity('qwen-local', undefined, 'patrol-session-1')).toBe(false)
    expect(shouldDetachPatrolSessionAffinity('qwen-local', 'patrol-session-1', undefined)).toBe(false)
  })

  it('removes only provider-hidden session routing metadata from the request', () => {
    const original = request()
    const detached = detachPatrolSessionAffinity(original)

    expect(detached).toEqual({
      provider: original.provider,
      model: original.model,
      messages: original.messages,
    })
    expect(detached).not.toBe(original)
    expect(original.sessionId).toBe('patrol-session-1')
  })

  it('preserves the agent-loop marker and frozen request contract', () => {
    const original = Object.freeze(request())
    markAgentLoopRequest(original)

    const detached = detachPatrolSessionAffinity(original)

    expect(detached.sessionId).toBeUndefined()
    expect(Object.isFrozen(detached)).toBe(true)
    expect(isAgentLoopRequest(detached)).toBe(true)
  })
})
