import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolLifecycleStore } from '../src/lifecycle-store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('PatrolLifecycleStore', () => {
  it('compacts a draft and persists the conversational teaching completion as a normal run', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-lifecycle-'))
    roots.push(root)
    const store = new PatrolLifecycleStore(root)
    await store.init()

    const draft: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'teaching-flow',
      name: 'Teaching flow',
      description: 'test',
      status: 'draft',
      target: { type: 'browser', url: 'https://example.test' },
      expectedResult: 'search completed',
      artifacts: ['page-text'],
      auth: { mode: 'none' },
      schedule: null,
      steps: [
        {
          id: 'step-001', kind: 'tool', name: 'Navigate', tool: 'browser_navigate', arguments: { url: 'https://example.test' }, recordedAt: '2026-09-02T01:00:00.000Z',
        },
        {
          id: 'step-002', kind: 'tool', name: 'Teaching snapshot', tool: 'browser_snapshot', arguments: {}, recordedAt: '2026-09-02T01:00:01.000Z',
        },
        {
          id: 'step-003', kind: 'tool', name: 'Final read', tool: 'browser_read_page', arguments: {}, artifact: 'page-text', recordedAt: '2026-09-02T01:00:02.000Z',
        },
      ],
      metadata: {
        createdAt: '2026-09-02T01:00:00.000Z',
        updatedAt: '2026-09-02T01:00:02.000Z',
      },
    }
    await store.create(draft)

    const ready = await store.load('teaching-flow')
    ready.status = 'ready'
    ready.metadata.validatedAt = '2026-09-02T01:00:03.000Z'
    ready.metadata.updatedAt = '2026-09-02T01:00:03.000Z'
    await store.save(ready)

    const saved = await store.load('teaching-flow')
    expect(saved.steps.map(step => step.tool)).toEqual(['browser_navigate', 'browser_read_page'])

    const runIds = await readdir(join(root, 'runs', 'teaching-flow'))
    expect(runIds).toHaveLength(1)
    expect(runIds[0]).toMatch(/^teaching-/)

    const report = await store.loadRun('teaching-flow', runIds[0]!)
    expect(report.status).toBe('passed')
    expect(report.summary).toContain('交互教学巡检已完成')
    expect(report.summary).toContain('移除 1 个')
    expect(report.results).toHaveLength(2)
  })

  it('does not create a teaching run for ordinary READY saves', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-lifecycle-ready-'))
    roots.push(root)
    const store = new PatrolLifecycleStore(root)
    await store.init()

    const ready: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'already-ready',
      name: 'Already ready',
      description: 'test',
      status: 'ready',
      target: { type: 'browser', url: 'https://example.test' },
      expectedResult: 'done',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [{
        id: 'step-001', kind: 'tool', name: 'Navigate', tool: 'browser_navigate', arguments: { url: 'https://example.test' }, recordedAt: '2026-09-02T01:00:00.000Z',
      }],
      metadata: {
        createdAt: '2026-09-02T01:00:00.000Z',
        updatedAt: '2026-09-02T01:00:00.000Z',
      },
    }
    await store.create(ready)
    ready.metadata.updatedAt = '2026-09-02T02:00:00.000Z'
    await store.save(ready)

    await expect(readdir(join(root, 'runs', 'already-ready'))).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
