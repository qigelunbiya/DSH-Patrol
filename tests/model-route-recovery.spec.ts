import { describe, expect, it } from 'vitest'
import {
  choosePatrolModelRecovery,
  isAuthUnavailableFailure,
  isLegacyUnavailablePatrolRoute,
  shouldRetryPatrolModelRouteAfterFailure,
} from '../src/model-route-recovery.js'

describe('Patrol model route recovery', () => {
  it('recognizes the legacy qwen-local route that can break old Patrol conversations', () => {
    expect(isLegacyUnavailablePatrolRoute({
      provider: 'qwen-local',
      model: 'qwen3.5_122b_a10b_fp4',
    })).toBe(true)
  })

  it('does not rewrite unrelated routes', () => {
    expect(isLegacyUnavailablePatrolRoute({
      provider: 'openai',
      model: 'gpt-5.6-sol',
    })).toBe(false)
  })

  it('switches stale Patrol requests to the current default model selection', () => {
    expect(choosePatrolModelRecovery({
      provider: 'qwen-local',
      model: 'qwen3.5_122b_a10b_fp4',
      temperature: 0.2,
      reasoningEffort: 'high',
    }, {
      provider: 'openai',
      model: 'gpt-5.6-sol',
    })).toEqual({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      temperature: 0.2,
    })
  })

  it('keeps the selected reasoning effort when the default model has one', () => {
    expect(choosePatrolModelRecovery({
      provider: 'qwen-local',
      model: 'qwen3.5_122b_a10b_fp4',
    }, {
      provider: 'openai',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    })).toMatchObject({
      provider: 'openai',
      model: 'gpt-5.6-sol',
      reasoningEffort: 'medium',
    })
  })

  it('detects auth_unavailable failures from normalized LLM errors', () => {
    expect(isAuthUnavailableFailure({
      code: 'internal_server_error',
      message: '503: {"message":"auth_unavailable: no auth available"}',
    })).toBe(true)
  })

  it('only retries auth failures when the current default route can leave qwen-local', () => {
    const failure = {
      code: 'internal_server_error',
      message: 'auth_unavailable: no auth available',
    }

    expect(shouldRetryPatrolModelRouteAfterFailure('qwen-local', failure, {
      provider: 'openai',
      model: 'gpt-5.6-sol',
    })).toBe(true)
    expect(shouldRetryPatrolModelRouteAfterFailure('qwen-local', failure, {
      provider: 'qwen-local',
      model: 'qwen3.5_122b_a10b_fp4',
    })).toBe(false)
  })
})
