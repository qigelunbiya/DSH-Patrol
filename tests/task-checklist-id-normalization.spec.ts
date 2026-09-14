import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerPatrolTaskChecklistTools } from '../src/task-checklist-tools.ts'
import type { PatrolStore } from '../src/store.ts'

function draft() {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'ADBBAF',
    name: 'ADBBAF',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now },
  }
}

describe('task checklist inspection id normalization', () => {
  it('uses the same normalized id as patrol_create_inspection for follow-up calls', async () => {
    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    const inspection = draft()
    const load = vi.fn(async (id: string) => {
      if (id !== 'ADBBAF') throw new Error(`unexpected id ${id}`)
      return inspection
    })
    const save = vi.fn(async () => {})
    registerPatrolTaskChecklistTools(ctx, { load, save } as unknown as PatrolStore)
    const set = definitions.find(item => item.name === 'patrol_set_task_checklist')

    await set.execute({
      inspectionId: '运维巡检-ADBBAF',
      items: ['访问目标URL', '识别并填写四位数英文验证码（没有数字）'],
    })

    expect(load).toHaveBeenCalledWith('ADBBAF')
    expect(save).toHaveBeenCalledTimes(1)
    expect((inspection.metadata as any).taskChecklist).toHaveLength(2)
  })
})
