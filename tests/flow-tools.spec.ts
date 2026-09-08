import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolFlowTools } from '../src/flow-tools.ts'
import { PatrolLifecycleStore } from '../src/lifecycle-store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-flow-tools-'))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const store = new PatrolLifecycleStore(root)
  await store.init()
  const now = '2026-09-04T00:00:00.000Z'
  const definition: InspectionDefinition = {
    schemaVersion: '0.2',
    id: 'conversation-flow',
    name: 'Conversation flow',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: ['page-text'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now, workspaceRoot: workspace },
  }
  await store.create(definition)

  const definitions: any[] = []
  const ctx = {
    tools: {
      register(tool: any) {
        definitions.push(tool)
        return () => {}
      },
    },
  } as unknown as Context
  registerPatrolFlowTools(ctx, store)
  return { root, workspace, store, definitions }
}

describe('Patrol flow session tools', () => {
  it('selecting a DRAFT creates the conversational WAITING patrol record immediately', async () => {
    const { root, workspace, definitions } = await setup()
    const select = definitions.find(item => item.name === 'patrol_select_flow')
    const text = await select.execute({ inspectionId: 'conversation-flow' }, {
      agent: { session: { header: { cwd: workspace } } },
    })

    expect(text).toContain('conversational patrol record is active')
    const runIds = await readdir(join(root, 'runs', 'conversation-flow'))
    expect(runIds).toHaveLength(1)
  })

  it('finalizes only the model-selected successful path plus required output', async () => {
    const { store, definitions } = await setup()
    const draft = await store.load('conversation-flow')
    draft.steps = [
      { id: 'step-001', kind: 'tool', name: 'Navigate', tool: 'browser_navigate', arguments: { url: 'https://example.test' }, recordedAt: '2026-09-04T00:00:01.000Z' },
      { id: 'step-002', kind: 'tool', name: 'Wrong branch', tool: 'browser_click', arguments: { selector: '#wrong' }, recordedAt: '2026-09-04T00:00:02.000Z' },
      { id: 'step-003', kind: 'tool', name: 'Correct branch', tool: 'browser_click', arguments: { selector: '#right' }, recordedAt: '2026-09-04T00:00:03.000Z' },
      { id: 'step-004', kind: 'tool', name: 'Final read', tool: 'browser_read_page', arguments: {}, artifact: 'page-text', recordedAt: '2026-09-04T00:00:04.000Z' },
    ]
    draft.metadata.updatedAt = '2026-09-04T00:00:04.000Z'
    await store.save(draft)

    const finalize = definitions.find(item => item.name === 'patrol_finalize_flow')
    const text = await finalize.execute({
      inspectionId: 'conversation-flow',
      successfulStepIds: ['step-001', 'step-003'],
    })

    expect(text).toContain('4 teaching steps -> 3 reusable steps')
    const saved = await store.load('conversation-flow')
    expect(saved.steps.map(step => step.name)).toEqual(['Navigate', 'Correct branch', 'Final read'])
    expect(saved.steps.map(step => step.id)).toEqual(['step-001', 'step-002', 'step-003'])
  })

  it('rewrites a corrected flow instead of preserving appended retry tails', async () => {
    const { store, definitions } = await setup()
    const draft = await store.load('conversation-flow')
    draft.artifacts = ['screenshot']
    draft.steps = [
      { id: 'step-001', kind: 'tool', name: 'Navigate login', tool: 'browser_navigate', arguments: { url: 'https://example.test' }, recordedAt: '2026-09-04T00:00:01.000Z' },
      { id: 'step-002', kind: 'tool', name: 'Open RDP', tool: 'browser_click', arguments: { selector: '#rdp' }, recordedAt: '2026-09-04T00:00:02.000Z' },
      { id: 'step-003', kind: 'tool', name: 'Type account', tool: 'browser_type', arguments: { selector: '#user', text: 'administrator' }, recordedAt: '2026-09-04T00:00:03.000Z' },
      { id: 'step-004', kind: 'tool', name: 'Clicked confirm too early', tool: 'browser_click', arguments: { selector: '#confirm' }, recordedAt: '2026-09-04T00:00:04.000Z' },
      { id: 'step-005', kind: 'tool', name: 'Probe dialog state', tool: 'browser_screenshot', arguments: {}, recordedAt: '2026-09-04T00:00:05.000Z' },
      { id: 'step-006', kind: 'tool', name: 'Reopen RDP duplicate', tool: 'browser_click', arguments: { selector: '#rdp' }, recordedAt: '2026-09-04T00:00:06.000Z' },
      { id: 'step-007', kind: 'tool', name: 'Retype account duplicate', tool: 'browser_type', arguments: { selector: '#user', text: 'administrator' }, recordedAt: '2026-09-04T00:00:07.000Z' },
      { id: 'step-008', kind: 'tool', name: 'Type password', tool: 'browser_type_transient_ref', arguments: { selector: '#password', secretRef: '${secret:admin}' }, recordedAt: '2026-09-04T00:00:08.000Z' },
      { id: 'step-009', kind: 'tool', name: 'Click confirm', tool: 'browser_click', arguments: { selector: '#confirm' }, recordedAt: '2026-09-04T00:00:09.000Z' },
      { id: 'step-010', kind: 'tool', name: 'Final screenshot', tool: 'browser_screenshot', arguments: {}, artifact: 'screenshot', recordedAt: '2026-09-04T00:00:10.000Z' },
    ]
    await store.save(draft)

    const rewrite = definitions.find(item => item.name === 'patrol_rewrite_flow_path')
    const text = await rewrite.execute({
      inspectionId: 'conversation-flow',
      keptStepIds: ['step-001', 'step-002', 'step-003', 'step-008', 'step-009'],
      reason: 'Insert password before the RDP confirm click and remove the appended duplicate retry tail.',
    })

    expect(text).toContain('10 steps -> 6 reusable steps')
    const saved = await store.load('conversation-flow')
    expect(saved.steps.map(step => step.name)).toEqual([
      'Navigate login',
      'Open RDP',
      'Type account',
      'Type password',
      'Click confirm',
      'Final screenshot',
    ])
    expect(saved.steps.map(step => step.id)).toEqual(['step-001', 'step-002', 'step-003', 'step-004', 'step-005', 'step-006'])
  })
})
