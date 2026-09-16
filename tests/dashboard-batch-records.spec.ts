import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { listBatchRecords, loadBatchDetail } from '../browser-bridge-runtime/dashboard-batch-records.js'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-batch-dashboard-'))
  roots.push(root)
  return root
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
}

async function writeInspection(storageRoot: string, id: string, name: string, workspaceRoot: string, url: string): Promise<void> {
  const directory = join(storageRoot, 'inspections', id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, 'inspection.json'), `${JSON.stringify({
    schemaVersion: '0.2',
    id,
    name,
    description: 'test flow',
    status: 'ready',
    target: { type: 'browser', url },
    expectedResult: 'healthy',
    artifacts: ['markdown-report'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [{ id: 'step-1', kind: 'tool', name: 'Navigate', tool: 'browser_navigate', arguments: { url }, recordedAt: '2026-09-16T01:00:00.000Z' }],
    metadata: { createdAt: '2026-09-16T01:00:00.000Z', updatedAt: '2026-09-16T01:00:00.000Z', workspaceRoot },
  }, null, 2)}\n`, 'utf8')
}

async function writeBatch(storageRoot: string, batchRunId: string, workspaceRoot: string): Promise<void> {
  const directory = join(storageRoot, 'batches', batchRunId)
  await mkdir(directory, { recursive: true })
  const state = {
    schemaVersion: 1,
    batchRunId,
    mode: 'serial',
    startedAt: '2026-09-16T02:00:00.000Z',
    updatedAt: '2026-09-16T02:03:00.000Z',
    status: 'failed',
    workspaceRoot,
    currentIndex: 2,
    flows: [
      { id: 'device-a', name: '设备 A', definitionUpdatedAt: '2026-09-16T01:00:00.000Z' },
      { id: 'device-b', name: '设备 B', definitionUpdatedAt: '2026-09-16T01:00:00.000Z' },
    ],
    results: [
      { order: 1, flowId: 'device-a', flowName: '设备 A', status: 'passed', runId: 'run-a', report: 'secret-local-path-a', json: 'secret-local-json-a' },
      { order: 2, flowId: 'device-b', flowName: '设备 B', status: 'failed', runId: 'run-b', report: 'secret-local-path-b', json: 'secret-local-json-b' },
    ],
  }
  await writeFile(join(directory, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await writeFile(join(directory, 'summary.json'), `${JSON.stringify({
    schemaVersion: 1,
    batchRunId,
    status: 'failed',
    totalFlows: 2,
    passedFlows: 1,
    failedFlows: 1,
    waitingFlows: 0,
  }, null, 2)}\n`, 'utf8')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('batch patrol dashboard records', () => {
  it('lists one batch as one top-level record with child run identities', async () => {
    const root = await tempRoot()
    const storageRoot = join(root, '.dsh-patrol')
    const workspace = join(root, 'workspace')
    const foreignWorkspace = join(root, 'other-workspace')
    await writeInspection(storageRoot, 'device-a', '设备 A', workspace, 'https://a.example.test')
    await writeInspection(storageRoot, 'device-b', '设备 B', workspace, 'https://b.example.test')
    await writeBatch(storageRoot, 'batch-2026-09-16-a', workspace)
    await writeBatch(storageRoot, 'batch-2026-09-16-foreign', foreignWorkspace)

    const catalog = await listBatchRecords(storageRoot, workspace)
    expect(catalog.truncated).toBe(false)
    expect(catalog.batches).toHaveLength(1)
    expect(catalog.batches[0]).toMatchObject({
      recordType: 'batch',
      batchRunId: 'batch-2026-09-16-a',
      status: 'failed',
      totalFlows: 2,
      passedFlows: 1,
      failedFlows: 1,
      children: [
        { flowId: 'device-a', runId: 'run-a', status: 'passed' },
        { flowId: 'device-b', runId: 'run-b', status: 'failed' },
      ],
    })
  })

  it('loads batch children with flow metadata without exposing internal report paths', async () => {
    const root = await tempRoot()
    const storageRoot = join(root, '.dsh-patrol')
    const workspace = join(root, 'workspace')
    await writeInspection(storageRoot, 'device-a', '设备 A', workspace, 'https://a.example.test')
    await writeInspection(storageRoot, 'device-b', '设备 B', workspace, 'https://b.example.test')
    await writeBatch(storageRoot, 'batch-2026-09-16-a', workspace)

    const batch = await loadBatchDetail(storageRoot, workspace, 'batch-2026-09-16-a')
    expect(batch.children).toEqual([
      expect.objectContaining({ order: 1, flowId: 'device-a', runId: 'run-a', targetUrl: 'https://a.example.test', stepCount: 1 }),
      expect.objectContaining({ order: 2, flowId: 'device-b', runId: 'run-b', targetUrl: 'https://b.example.test', stepCount: 1 }),
    ])
    expect(batch.children[0]).not.toHaveProperty('report')
    expect(batch.children[0]).not.toHaveProperty('json')
  })

  it('rejects batch detail access from a different workspace', async () => {
    const root = await tempRoot()
    const storageRoot = join(root, '.dsh-patrol')
    const workspace = join(root, 'workspace')
    await writeBatch(storageRoot, 'batch-2026-09-16-a', workspace)

    await expect(loadBatchDetail(storageRoot, join(root, 'other'), 'batch-2026-09-16-a'))
      .rejects.toThrow('batch does not belong to the current workspace')
  })
})
