import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolStore } from '../src/store.js'
import type { RunReport } from '../src/types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('workspace-visible Patrol outputs', () => {
  it('keeps an internal run archive while grouping reports under patrol-results/<inspection>/<run>/reports', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patrol-output-'))
    cleanup.push(temp)
    const store = new PatrolStore(join(temp, 'internal'))
    const workspace = join(temp, 'workspace')
    await store.init()
    await mkdir(workspace, { recursive: true })
    await writeFile(join(workspace, 'screenshot-teaching.png'), Buffer.from([9, 8, 7]))

    const report: RunReport = {
      schemaVersion: '0.2',
      runId: 'run-001',
      inspectionId: 'weekly',
      inspectionName: 'Weekly',
      startedAt: '2026-08-28T00:00:00.000Z',
      finishedAt: '2026-08-28T00:01:00.000Z',
      status: 'passed',
      expectedResult: 'ok',
      results: [],
      outputWorkspace: workspace,
    }

    const visible = await store.saveRun(report, '# report\n', workspace)
    const runRoot = join(workspace, 'patrol-results', 'weekly', 'run-001')
    expect(visible.directory).toBe(runRoot)
    expect(visible.markdown).toBe(join(runRoot, 'reports', 'report.md'))
    expect(visible.json).toBe(join(runRoot, 'reports', 'report.json'))
    expect(await readFile(visible.markdown, 'utf8')).toBe('# report\n')
    expect(await readFile(join(runRoot, 'screenshots', 'teaching', 'screenshot-teaching.png'))).toEqual(Buffer.from([9, 8, 7]))
    await expect(readFile(join(workspace, 'screenshot-teaching.png'))).rejects.toThrow()
    expect(JSON.parse(await readFile(store.runJsonPath('weekly', 'run-001'), 'utf8')).inspectionId).toBe('weekly')
  })

  it('exports screenshot and page-text artifacts into categorized run folders while retaining internal copies', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patrol-artifact-'))
    cleanup.push(temp)
    const store = new PatrolStore(join(temp, 'internal'))
    const workspace = join(temp, 'workspace')
    const source = join(workspace, 'screenshot-runtime.png')
    await store.init()
    await mkdir(workspace, { recursive: true })
    await writeFile(source, Buffer.from([1, 2, 3, 4]))

    const screenshot = await store.copyArtifact('weekly', 'run-002', source, 'step-001-screenshot', workspace)
    const pageText = await store.saveTextArtifact('weekly', 'run-002', 'step-002-page.txt', 'hello', workspace)
    const runRoot = join(workspace, 'patrol-results', 'weekly', 'run-002')

    expect(screenshot).toBe(join(runRoot, 'screenshots', 'step-001-screenshot.png'))
    expect(pageText).toBe(join(runRoot, 'page-text', 'step-002-page.txt'))
    expect(await readFile(screenshot)).toEqual(Buffer.from([1, 2, 3, 4]))
    expect(await readFile(pageText, 'utf8')).toBe('hello')
    await expect(readFile(source)).rejects.toThrow()
    expect(await readFile(join(store.runDirectory('weekly', 'run-002'), 'artifacts', 'step-001-screenshot.png'))).toEqual(Buffer.from([1, 2, 3, 4]))
  })
})
