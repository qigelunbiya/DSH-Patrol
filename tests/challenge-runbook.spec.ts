import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolStore } from '../src/store.js'
import type { InspectionDefinition, RunReport } from '../src/types.js'

const cleanup: string[] = []

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

describe('Runbook verification memory', () => {
  it('learns the observed challenge family from a successful run and mirrors it without secrets', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'dsh-patrol-challenge-runbook-'))
    cleanup.push(temp)
    const workspace = join(temp, 'workspace')
    const store = new PatrolStore(join(temp, 'internal'))
    await store.init()
    await mkdir(workspace, { recursive: true })

    const definition: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'weekly',
      name: 'Weekly',
      description: 'Weekly browser inspection.',
      status: 'ready',
      target: { type: 'browser', url: 'https://example.com/login' },
      expectedResult: 'Application page is visible.',
      artifacts: ['markdown-report'],
      auth: { mode: 'secret-ref' },
      schedule: null,
      steps: [],
      metadata: {
        createdAt: '2026-08-28T00:00:00.000Z',
        updatedAt: '2026-08-28T00:00:00.000Z',
        workspaceRoot: workspace,
      },
    }
    await store.create(definition)

    const report: RunReport = {
      schemaVersion: '0.2',
      runId: 'run-001',
      inspectionId: 'weekly',
      inspectionName: 'Weekly',
      startedAt: '2026-08-28T01:00:00.000Z',
      finishedAt: '2026-08-28T01:01:00.000Z',
      status: 'waiting',
      expectedResult: 'Application page is visible.',
      outputWorkspace: workspace,
      results: [{
        stepId: 'step-001',
        name: 'Detect verification',
        kind: 'tool',
        tool: 'browser_detect_auth_challenge',
        status: 'passed',
        startedAt: '2026-08-28T01:00:10.000Z',
        finishedAt: '2026-08-28T01:00:11.000Z',
        output: 'Auth challenge: kind=slider; subtype=slider-puzzle; observed=slider/slider-puzzle; strategy=manual-slider; hasChallenge=true; handoffRequired=true',
      }],
    }

    await store.saveRun(report, '# report\n', workspace)
    const learned = await store.load('weekly')
    expect(learned.auth.challengeProfiles).toEqual([{
      kind: 'slider',
      subtype: 'slider-puzzle',
      strategy: 'manual-slider',
      firstObservedAt: '2026-08-28T01:00:11.000Z',
      lastObservedAt: '2026-08-28T01:00:11.000Z',
      occurrences: 1,
      autoCompletedOccurrences: 0,
    }])
    expect(learned.metadata.updatedAt).toBe('2026-08-28T00:00:00.000Z')

    const mirror = store.workspaceRunbookPaths('weekly', workspace)
    const json = await readFile(mirror.json, 'utf8')
    const markdown = await readFile(mirror.markdown, 'utf8')
    expect(json).toContain('"slider-puzzle"')
    expect(markdown).toContain('Learned verification profiles')
    expect(markdown).toContain('manual-slider')
    // Safety documentation may name these secret classes. What must never
    // appear is an assignment/value-shaped persisted secret.
    expect(markdown).not.toMatch(/cookie\s*=|otp\s*=|captcha[-_ ]?answer\s*=/i)
  })
})
