import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolStore } from '../src/store.js'
import type { InspectionDefinition, RunReport } from '../src/types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('workspace-visible Patrol outputs', () => {
  it('keeps an internal run archive and exports one complete reusable Runbook plus a per-run snapshot', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patrol-output-'))
    cleanup.push(temp)
    const store = new PatrolStore(join(temp, 'internal'))
    const workspace = join(temp, 'workspace')
    await store.init()
    await mkdir(workspace, { recursive: true })

    const definition = sampleDefinition(workspace)
    await store.save(definition)
    const canonical = store.workspaceRunbookPaths('weekly', workspace)
    const canonicalJson = JSON.parse(await readFile(canonical.json, 'utf8')) as InspectionDefinition
    expect(canonicalJson.steps).toHaveLength(2)
    expect(canonicalJson.steps[1]?.kind).toBe('tool')
    expect((canonicalJson.steps[1] as { arguments?: unknown }).arguments).toEqual({ selector: '#password', credentialRef: '${credential:IDC_LOGIN_PASSWORD}', clear: true })
    const canonicalMarkdown = await readFile(canonical.markdown, 'utf8')
    expect(canonicalMarkdown).toContain('## Reusable steps')
    expect(canonicalMarkdown).toContain('step-002 — Fill password when login is required')
    expect(canonicalMarkdown).not.toContain('actual-password')

    const looseTeaching = join(workspace, 'screenshot-teaching.png')
    await writeFile(looseTeaching, Buffer.from([9, 8, 7]))
    const teaching = await store.organizeTeachingScreenshot('weekly', looseTeaching, workspace)
    expect(teaching).toBe(join(workspace, 'patrol-results', 'weekly', 'teaching', 'screenshots', 'screenshot-teaching.png'))
    expect(await readFile(teaching)).toEqual(Buffer.from([9, 8, 7]))
    await expect(readFile(looseTeaching)).rejects.toThrow()

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
    expect(JSON.parse(await readFile(join(runRoot, 'runbook', 'inspection.json'), 'utf8')).steps).toHaveLength(2)
    expect(await readFile(join(runRoot, 'runbook', 'runbook.md'), 'utf8')).toContain('## Reusable steps')
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
    await store.save(sampleDefinition(workspace))
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

function sampleDefinition(workspaceRoot: string): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'weekly',
    name: 'Weekly',
    description: 'Reusable weekly patrol',
    status: 'ready',
    target: { type: 'browser', url: 'http://example.test/web/login' },
    expectedResult: 'ok',
    artifacts: ['markdown-report', 'json-report'],
    auth: { mode: 'secret-ref' },
    schedule: null,
    steps: [
      {
        id: 'step-001',
        kind: 'tool',
        name: 'Check login state',
        tool: 'browser_login_state',
        arguments: {},
        recordedAt: '2026-08-28T00:00:00.000Z',
      },
      {
        id: 'step-002',
        kind: 'tool',
        name: 'Fill password when login is required',
        tool: 'browser_type_credential',
        arguments: { selector: '#password', credentialRef: '${credential:IDC_LOGIN_PASSWORD}', clear: true },
        when: { sourceStepId: 'step-001', mode: 'contains', value: 'login-state=login-required', caseSensitive: false },
        sensitive: true,
        recordedAt: '2026-08-28T00:00:01.000Z',
      },
    ],
    metadata: {
      createdAt: '2026-08-28T00:00:00.000Z',
      updatedAt: '2026-08-28T00:00:01.000Z',
      workspaceRoot,
    },
  }
}
