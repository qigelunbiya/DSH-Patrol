import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import {
  choosePatrolModelRecovery,
  isAuthUnavailableFailure,
  isLegacyUnavailablePatrolRoute,
  registerPatrolModelRouteRecovery,
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

  it('reads the default model service from a runtime plugin context without declaring it as an injected property', async () => {
    const ctx = new Context()
    ctx.provide('tools', {})
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'openai', model: 'gpt-5.6-sol' }),
    })

    await ctx.plugin({
      name: 'patrol-recovery-test-plugin',
      inject: ['tools'],
      apply(pluginCtx: Context) {
        registerPatrolModelRouteRecovery(pluginCtx)
      },
    })

    await expect(ctx.waterfall(
      'agent/request',
      { turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ provider: 'qwen-local', model: 'qwen3.5_122b_a10b_fp4' }),
    )).resolves.toEqual({ provider: 'openai', model: 'gpt-5.6-sol' })
    await ctx.fiber.dispose()
  })

  it('runs outside older model-selection listeners so stale persisted headers cannot override recovery', async () => {
    const ctx = new Context()
    ctx.provide('agentDefaultModel', {
      currentSelection: () => ({ provider: 'openai', model: 'gpt-5.6-sol' }),
    })
    ctx.on('agent/request', async (_payload, next) => {
      const resolved = await next()
      return { ...resolved, provider: 'qwen-local', model: 'qwen3.5_122b_a10b_fp4' }
    })
    registerPatrolModelRouteRecovery(ctx)

    await expect(ctx.waterfall(
      'agent/request',
      { turn: 1, step: 1, signal: new AbortController().signal },
      () => Promise.resolve({ provider: 'openai', model: 'gpt-5.6-sol' }),
    )).resolves.toEqual({ provider: 'openai', model: 'gpt-5.6-sol' })
    await ctx.fiber.dispose()
  })
})
