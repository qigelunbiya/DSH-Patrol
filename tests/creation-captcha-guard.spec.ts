import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { registerPatrolCreationTools } from '../src/creation-tools.ts'
import type { PatrolStore } from '../src/store.ts'

describe('creation-time image-code contract guard', () => {
  it('blocks a digit candidate after a letters-only four-character checklist is persisted', () => {
    let guard: ((execution: any) => string | undefined) | undefined
    const ctx = {
      tools: {
        register() { return () => {} },
        guard(callback: (execution: any) => string | undefined) { guard = callback; return () => {} },
      },
    } as unknown as Context

    registerPatrolCreationTools(ctx, {} as PatrolStore)
    expect(guard).toBeDefined()

    expect(guard?.({
      name: 'patrol_set_task_checklist',
      arguments: { inspectionId: 'ops-demo', items: ['识别并填写四位英文验证码，没有数字'] },
    })).toBeUndefined()

    const blocked = guard?.({
      name: 'patrol_type_current_image_code',
      arguments: { inspectionId: 'ops-demo', text: 'VC4A' },
    })
    expect(blocked).toMatch(/NOT typed/i)
    expect(blocked).toMatch(/no digits/i)

    expect(guard?.({
      name: 'patrol_type_current_image_code',
      arguments: { inspectionId: 'ops-demo', text: 'QTMZ' },
    })).toBeUndefined()
  })
})
