import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, ResumeState, RunReport } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function store(): Promise<PatrolStore> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-'))
  roots.push(root)
  const value = new PatrolStore(root)
  await value.init()
  return value
}

function definition(): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'test',
    name: 'test',
    description: 'test patrol',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.com' },
    expectedResult: 'ok',
    artifacts: ['markdown-report'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
  }
}

describe('PatrolStore', () => {
  it('round-trips definitions and resume state', async () => {
    const value = await store()
    await value.create(definition())
    expect((await value.load('test')).id).toBe('test')

    const resume: ResumeState = {
      schemaVersion: '0.2',
      inspectionId: 'test',
      runId: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      definitionUpdatedAt: '2026-01-01T00:00:00.000Z',
      nextStepIndex: 2,
      results: [],
    }
    await value.saveResume(resume)
    expect((await value.loadResume('test'))?.nextStepIndex).toBe(2)
    await value.clearResume('test')
    expect(await value.loadResume('test')).toBeUndefined()
  })

  it('copies screenshot artifacts into a run directory', async () => {
    const value = await store()
    const source = join(value.root, 'shot.png')
    await writeFile(source, Buffer.from([1, 2, 3]))
    const copied = await value.copyArtifact('test', 'run-1', source, 'step-001-screenshot')
    expect(Buffer.from(await readFile(copied))).toEqual(Buffer.from([1, 2, 3]))
  })

  it('persists a lightweight summary.json index for completed runs', async () => {
    const value = await store()
    await value.create(definition())
    const report: RunReport = {
      schemaVersion: '0.2',
      runId: 'run-1',
      inspectionId: 'test',
      inspectionName: 'test',
      startedAt: '2026-01-01T00:00:00.000Z',
      finishedAt: '2026-01-01T00:00:03.000Z',
      status: 'passed',
      expectedResult: 'ok',
      summary: 'done',
      results: [{
        stepId: 'step-1',
        name: 'read',
        kind: 'tool',
        status: 'passed',
        startedAt: '2026-01-01T00:00:00.000Z',
        finishedAt: '2026-01-01T00:00:03.000Z',
        tool: 'browser_read_page',
        artifacts: [{ kind: 'screenshot', path: join(value.root, 'shot.png') }],
      }],
    }

    await value.saveRun(report, '# report')
    const summary = JSON.parse(await readFile(join(value.runDirectory('test', 'run-1'), 'summary.json'), 'utf8'))
    expect(summary).toMatchObject({
      schemaVersion: 1,
      runId: 'run-1',
      inspectionId: 'test',
      status: 'passed',
      stepCount: 1,
      passedSteps: 1,
      failedSteps: 0,
      artifactCount: 3,
      summary: 'done',
    })
  })
})