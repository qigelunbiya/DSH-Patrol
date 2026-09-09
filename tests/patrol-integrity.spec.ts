import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  createPatrolTeachingIntegrityGuard,
  PATROL_INTEGRITY_PROMPT,
  patrolTeachingIntegrityGuard,
  registerPatrolIntegrity,
} from '../src/patrol-integrity.js'

describe('Patrol reusable-flow integrity', () => {
  it('blocks a semantic click before execution when expectedText is missing', () => {
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', locatorText: '登录' },
    })).toMatch(/click was NOT executed/i)
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', locatorText: '登录', expectedText: '首页' },
    })).toBeUndefined()
  })

  it('also protects legacy and reteach click surfaces', () => {
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_click',
      arguments: { selector: '#submit' },
    })).toMatch(/expectedText/)
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_browser_step',
      arguments: { action: 'click', arguments: { selector: '#submit' } },
    })).toMatch(/expectedText/)
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_reteach_browser_step',
      arguments: { action: 'click', arguments: { selector: '#submit' } },
    })).toMatch(/expectedText/)
  })

  it('keeps non-click actions available in the stateless click guard', () => {
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_browser_step',
      arguments: { action: 'navigate', arguments: { url: 'https://example.test' } },
    })).toBeUndefined()
  })

  it('blocks guessed internal URLs after a draft declares its target, including generic browser-step navigation', () => {
    const guard = createPatrolTeachingIntegrityGuard()
    expect(guard({
      name: 'patrol_create_draft',
      arguments: { inspectionId: 'demo', targetUrl: 'http://172.21.9.122/com-portal' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'demo', url: 'http://172.21.9.122/com-portal' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'demo', url: 'http://172.21.9.122/com-portal/todo' },
    })).toMatch(/navigation was NOT executed/i)
    expect(guard({
      name: 'patrol_browser_step',
      arguments: {
        inspectionId: 'demo',
        action: 'navigate',
        arguments: { url: 'http://172.21.9.122/com-portal/home' },
      },
    })).toMatch(/Do not guess an internal URL/i)
  })

  it('allows an explicit target update before teaching a genuinely changed URL', () => {
    const guard = createPatrolTeachingIntegrityGuard()
    guard({ name: 'patrol_create_draft', arguments: { inspectionId: 'demo', targetUrl: 'https://example.test/a' } })
    expect(guard({ name: 'patrol_navigate', arguments: { inspectionId: 'demo', url: 'https://example.test/b' } })).toBeDefined()
    expect(guard({ name: 'patrol_update_inspection', arguments: { inspectionId: 'demo', targetUrl: 'https://example.test/b' } })).toBeUndefined()
    expect(guard({ name: 'patrol_navigate', arguments: { inspectionId: 'demo', url: 'https://example.test/b?session=1' } })).toBeUndefined()
  })

  it('states the non-negotiable checklist, prefilled-input, and no guessed-URL rules', () => {
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/业务任务清单/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/自动填好.*也必须/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/不得用猜测 URL 的 patrol_navigate 代替/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/patrol_finalize_flow/s)
  })

  it('registers its prompt later than test mode and installs an always-on tool guard', async () => {
    const ctx = new Context()
    const section = vi.fn(() => vi.fn())
    ctx.provide('systemPrompt', { section })
    const dispose = registerPatrolIntegrity(ctx)
    expect(section).toHaveBeenCalledWith(expect.objectContaining({ order: 1100 }))
    dispose()
    await ctx.fiber.dispose()
  })
})
