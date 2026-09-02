import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPatrolDashboardCatalog, parseLegacyMarkdownSummary } from '../browser-bridge-runtime/dashboard-fast.js'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-dashboard-'))
  roots.push(root)
  const storageRoot = join(root, '.dsh-patrol')
  const workspace = join(root, 'workspace')
  const inspectionId = 'test-flow'
  await mkdir(join(storageRoot, 'inspections', inspectionId), { recursive: true })
  await mkdir(workspace, { recursive: true })
  const definition = {
    schemaVersion: '0.2',
    id: inspectionId,
    name: 'Fast flow',
    description: 'dashboard performance fixture',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.com/login' },
    expectedResult: 'dashboard',
    artifacts: ['markdown-report', 'json-report'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [{ id: 'step-1', kind: 'tool', name: 'Login', tool: 'browser_click', arguments: {}, recordedAt: '2026-09-02T08:00:00.000Z' }],
    metadata: { createdAt: '2026-09-02T08:00:00.000Z', updatedAt: '2026-09-02T08:00:00.000Z', workspaceRoot: workspace },
  }
  await writeFile(join(storageRoot, 'inspections', inspectionId, 'inspection.json'), JSON.stringify(definition))
  return { root, storageRoot, workspace, inspectionId, definition }
}

function markdown(runId: string) {
  return [
    '# DSH Patrol 巡检报告：Fast flow',
    '',
    '- 巡检 ID：`test-flow`',
    `- Run ID：\`${runId}\``,
    '- 状态：**PASSED**',
    '- 开始：2026-09-02T08:00:00.000Z',
    '- 结束：2026-09-02T08:00:03.000Z',
    '- 预期结果：dashboard',
    '',
    '## 页面摘要',
    '',
    '```text',
    'Successfully logged in.',
    '```',
    '',
    '## 步骤结果',
    '',
    '### step-1 · Login',
    '- 类型：tool',
    '- 状态：**PASSED**',
    '- 产物（screenshot）：`shot.png`',
    '',
  ].join('\n')
}

describe('fast Patrol dashboard catalog', () => {
  it('uses bounded markdown metadata instead of parsing a huge legacy report.json', async () => {
    const value = await fixture()
    const runId = '2026-09-02T08-00-00-000Z-deadbeef'
    const runRoot = join(value.storageRoot, 'runs', value.inspectionId, runId)
    await mkdir(runRoot, { recursive: true })
    await writeFile(join(runRoot, 'report.json'), `{${'x'.repeat(600 * 1024)}`)
    await writeFile(join(runRoot, 'report.md'), markdown(runId))

    const catalog = await buildPatrolDashboardCatalog(value.storageRoot, value.workspace)

    expect(catalog.inspections).toHaveLength(1)
    expect(catalog.runs).toHaveLength(1)
    expect(catalog.runs[0]).toMatchObject({
      runId,
      inspectionId: value.inspectionId,
      status: 'passed',
      source: 'markdown',
      stepCount: 1,
      passedSteps: 1,
      artifactCount: 3,
      summary: 'Successfully logged in.',
    })
  })

  it('prefers tiny summary.json indexes even when the full report is huge', async () => {
    const value = await fixture()
    const runId = '2026-09-02T09-00-00-000Z-feedface'
    const runRoot = join(value.storageRoot, 'runs', value.inspectionId, runId)
    await mkdir(runRoot, { recursive: true })
    await writeFile(join(runRoot, 'report.json'), `{${'x'.repeat(700 * 1024)}`)
    await writeFile(join(runRoot, 'summary.json'), JSON.stringify({
      schemaVersion: 1,
      runId,
      inspectionId: value.inspectionId,
      inspectionName: 'Fast flow',
      status: 'failed',
      startedAt: '2026-09-02T09:00:00.000Z',
      finishedAt: '2026-09-02T09:00:05.000Z',
      expectedResult: 'dashboard',
      summary: 'Login failed.',
      stepCount: 142,
      passedSteps: 141,
      failedSteps: 1,
      artifactCount: 8,
    }))

    const catalog = await buildPatrolDashboardCatalog(value.storageRoot, value.workspace)

    expect(catalog.runs[0]).toMatchObject({
      runId,
      status: 'failed',
      source: 'summary',
      stepCount: 142,
      passedSteps: 141,
      failedSteps: 1,
      artifactCount: 8,
    })
  })

  it('parses the bounded markdown report format used by historical runs', async () => {
    const value = await fixture()
    const runId = '2026-09-02T08-00-00-000Z-cafebabe'
    const summary = parseLegacyMarkdownSummary(markdown(runId), value.definition, runId)
    expect(summary).toMatchObject({
      runId,
      inspectionName: 'Fast flow',
      status: 'passed',
      startedAt: '2026-09-02T08:00:00.000Z',
      finishedAt: '2026-09-02T08:00:03.000Z',
      stepCount: 1,
      passedSteps: 1,
    })
  })
})