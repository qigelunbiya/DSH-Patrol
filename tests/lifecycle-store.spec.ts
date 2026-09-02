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
  it('persists an in-progress patrol immediately and finalizes the same run when teaching completes', async () => {
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

    const startedRunIds = await readdir(join(root, 'runs', 'teaching-flow'))
    expect(startedRunIds).toHaveLength(1)
    const started = await store.loadRun('teaching-flow', startedRunIds[0]!)
    expect(started.status).toBe('waiting')
    expect(started.summary).toContain('巡检进行中')
    expect(started.results).toHaveLength(3)

    const ready = await store.load('teaching-flow')
    ready.status = 'ready'
    ready.metadata.validatedAt = '2026-09-02T01:00:03.000Z'
    ready.metadata.updatedAt = '2026-09-02T01:00:03.000Z'
    await store.save(ready)

    const saved = await store.load('teaching-flow')
    expect(saved.steps.map(step => step.tool)).toEqual(['browser_navigate', 'browser_read_page'])

    const runIds = await readdir(join(root, 'runs', 'teaching-flow'))
    expect(runIds).toEqual(startedRunIds)
    expect(runIds[0]).toMatch(/^teaching-/)

    const report = await store.loadRun('teaching-flow', runIds[0]!)
    expect(report.status).toBe('passed')
    expect(report.summary).toContain('交互教学巡检已完成')
    expect(report.summary).toContain('移除 1 个')
    expect(report.results).toHaveLength(2)
  })

  it('starts a new WAITING record when an existing draft receives its first new step', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-lifecycle-existing-draft-'))
    roots.push(root)
    const store = new PatrolLifecycleStore(root)
    await store.init()

    const draft: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'existing-draft',
      name: 'Existing draft',
      description: 'test',
      status: 'draft',
      target: { type: 'browser', url: 'https://example.test' },
      expectedResult: 'done',
      artifacts: [],
      auth: { mode: 'none' },
      schedule: null,
      steps: [],
      metadata: {
        createdAt: '2026-09-02T01:00:00.000Z',
        updatedAt: '2026-09-02T01:00:00.000Z',
      },
    }
    await store.create(draft)
    await expect(readdir(join(root, 'runs', 'existing-draft'))).rejects.toMatchObject({ code: 'ENOENT' })

    const teaching = await store.load('existing-draft')
    teaching.steps.push({
      id: 'step-001',
      kind: 'tool',
      name: 'Navigate',
      tool: 'browser_navigate',
      arguments: { url: 'https://example.test' },
      recordedAt: '2026-09-02T02:00:00.000Z',
    })
    teaching.metadata.updatedAt = '2026-09-02T02:00:00.000Z'
    await store.save(teaching)

    const runIds = await readdir(join(root, 'runs', 'existing-draft'))
    expect(runIds).toHaveLength(1)
    const report = await store.loadRun('existing-draft', runIds[0]!)
    expect(report.status).toBe('waiting')
    expect(report.results).toHaveLength(1)
    expect(report.results[0]).toMatchObject({ name: 'Navigate', status: 'passed' })
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
