import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolTaskChecklistTools } from '../src/task-checklist-tools.js'
import { PatrolStore } from '../src/store.js'
import type { InspectionDefinition } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(steps = 0, checklist?: string[]) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-checklist-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const now = new Date().toISOString()
  const definition: InspectionDefinition = {
    schemaVersion: '0.2',
    id: 'legacy-draft',
    name: 'Legacy draft',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: [],
    auth: { mode: 'none' },
    schedule: null,
    steps: Array.from({ length: steps }, (_, index) => ({
      id: `step-${String(index + 1).padStart(3, '0')}`,
      kind: 'tool' as const,
      name: index === 0 ? '访问目标 URL' : '输入用户名',
      tool: index === 0 ? 'browser_navigate' : 'browser_type',
      arguments: index === 0 ? { url: 'https://example.test', action: 'navigate' } : { selector: '#username', text: 'demo' },
      recordedAt: now,
    })),
    metadata: { createdAt: now, updatedAt: now, ...(checklist ? { taskChecklist: checklist } : {}) },
  }
  await store.create(definition)

  const definitions: any[] = []
  const ctx = { tools: { register(tool: any) { definitions.push(tool); return () => {} } } } as unknown as Context
  registerPatrolTaskChecklistTools(ctx, store)
  return { store, set: definitions.find(item => item.name === 'patrol_set_task_checklist') }
}

describe('Patrol task checklist backfill', () => {
  it('rejects appending a teaching step until the persisted checklist exists', async () => {
    const { store } = await setup(0)
    const definition = await store.load('legacy-draft')
    definition.steps.push({
      id: 'step-001', kind: 'tool', name: '访问目标 URL', tool: 'browser_navigate',
      arguments: { url: 'https://example.test', action: 'navigate' }, recordedAt: new Date().toISOString(),
    })

    await expect(store.save(definition)).rejects.toThrow(/persisted task checklist/i)
    definition.metadata.taskChecklist = ['访问目标 URL']
    await expect(store.save(definition)).resolves.toBeUndefined()
  })

  it('backfills a legacy non-empty DRAFT without deleting existing steps', async () => {
    const { store, set } = await setup(2)
    const result = await set.execute({
      inspectionId: 'legacy-draft',
      items: ['访问目标 URL', '输入用户名', '点击登录'],
    })
    expect(result).toContain('Backfilled 3 ordered business task(s)')
    expect(result).toContain('preserved all 2 existing step(s)')
    const saved = await store.load('legacy-draft')
    expect(saved.steps).toHaveLength(2)
    expect(saved.metadata.taskChecklist).toEqual(['访问目标 URL', '输入用户名', '点击登录'])
  })

  it('is idempotent when the same checklist is supplied again', async () => {
    const items = ['访问目标 URL', '点击登录']
    const { store, set } = await setup(1, items)
    const result = await set.execute({ inspectionId: 'legacy-draft', items })
    expect(result).toContain('same 2-item business checklist')
    expect((await store.load('legacy-draft')).steps).toHaveLength(1)
  })

  it('refuses to silently rewrite a conflicting existing checklist', async () => {
    const { set } = await setup(1, ['访问目标 URL', '点击登录'])
    await expect(set.execute({
      inspectionId: 'legacy-draft',
      items: ['访问目标 URL', '点击工作台'],
    })).rejects.toThrow(/different persisted task checklist/)
  })
})
