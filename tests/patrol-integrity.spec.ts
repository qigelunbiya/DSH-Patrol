import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import {
  createPatrolTeachingIntegrityGuard,
  PATROL_INTEGRITY_PROMPT,
  patrolTeachingIntegrityGuard,
  registerPatrolIntegrity,
} from '../src/patrol-integrity.js'

describe('Patrol reusable-flow integrity', () => {
  it('does not require invented expectedText before a semantic click', () => {
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', locatorText: '登录' },
    })).toBeUndefined()
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_click_target',
      arguments: { inspectionId: 'demo', locatorText: '登录', expectedText: '首页' },
    })).toBeUndefined()
  })

  it('leaves click verification to the recorded click composites', () => {
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_click',
      arguments: { selector: '#submit' },
    })).toBeUndefined()
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_browser_step',
      arguments: { action: 'click', arguments: { selector: '#submit' } },
    })).toBeUndefined()
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_reteach_browser_step',
      arguments: { action: 'click', arguments: { selector: '#submit' } },
    })).toBeUndefined()
  })

  it('keeps non-click actions available in the stateless click guard', () => {
    expect(patrolTeachingIntegrityGuard({
      name: 'patrol_browser_step',
      arguments: { action: 'navigate', arguments: { url: 'https://example.test' } },
    })).toBeUndefined()
  })

  it('does not poison a reused flow when a duplicate create call fails downstream', () => {
    const guard = createPatrolTeachingIntegrityGuard()
    expect(guard({
      name: 'patrol_create_draft',
      arguments: { inspectionId: 'demo', targetUrl: 'http://172.21.9.122/com-portal' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'demo', url: 'http://172.21.9.122/com-portal' },
    })).toBeUndefined()
    expect(guard({ name: 'patrol_click_target', arguments: {
      inspectionId: 'demo', stepName: '点击 Logo', locatorText: '长城网际',
    } })).toBeUndefined()
  })

  it('allows real in-flow navigation while keeping the entry target metadata stable', () => {
    const guard = createPatrolTeachingIntegrityGuard()
    expect(guard({
      name: 'patrol_create_draft',
      arguments: { inspectionId: 'demo', targetUrl: 'http://172.21.9.122/com-portal' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_set_task_checklist',
      arguments: { inspectionId: 'demo', tasks: ['访问入口', '点击 Logo', '进入工作台'] },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'demo', url: 'http://172.21.9.122/com-portal' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'demo', url: 'http://172.21.9.122/com-portal/todo' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'demo', action: 'back' },
    })).toBeUndefined()
    expect(guard({
      name: 'patrol_browser_step',
      arguments: {
        inspectionId: 'demo',
        action: 'navigate',
        arguments: { url: 'http://172.21.9.122/com-portal/home' },
      },
    })).toBeUndefined()
  })

  it('blocks target metadata rewriting but does not freeze the CURRENT browser at the entry URL', () => {
    const guard = createPatrolTeachingIntegrityGuard()
    guard({ name: 'patrol_create_draft', arguments: { inspectionId: 'demo', targetUrl: 'https://example.test/a' } })
    guard({ name: 'patrol_set_task_checklist', arguments: { inspectionId: 'demo', tasks: ['访问入口'] } })
    expect(guard({ name: 'patrol_navigate', arguments: { inspectionId: 'demo', url: 'https://example.test/b' } })).toBeUndefined()
    expect(guard({ name: 'patrol_update_inspection', arguments: { inspectionId: 'demo', targetUrl: 'https://example.test/b' } })).toMatch(/targetUrl change was NOT executed/i)
    expect(guard({ name: 'patrol_navigate', arguments: { inspectionId: 'demo', url: 'https://example.test/b?session=1' } })).toBeUndefined()

    expect(guard({ name: 'patrol_delete', arguments: { inspectionId: 'demo' } })).toBeUndefined()
    expect(guard({ name: 'patrol_create_draft', arguments: { inspectionId: 'demo', targetUrl: 'https://example.test/b' } })).toBeUndefined()
    expect(guard({ name: 'patrol_set_task_checklist', arguments: { inspectionId: 'demo', tasks: ['访问新入口'] } })).toBeUndefined()
    expect(guard({ name: 'patrol_navigate', arguments: { inspectionId: 'demo', url: 'https://example.test/b?session=1' } })).toBeUndefined()
  })

  it('states the non-negotiable checklist, prefilled-input, immediate-action, and no guessed-URL rules', () => {
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/patrol_set_task_checklist/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/业务任务清单/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/CURRENT 页面已经出现.*立即执行/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/自动填好.*也必须/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/expectedText.*若未知.*省略/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/不得用模型猜测的内部 URL 替代该业务点击/s)
    expect(PATROL_INTEGRITY_PROMPT).toMatch(/action=back\/forward\/reload/s)
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
