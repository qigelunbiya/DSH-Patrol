import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolCreationTools } from '../src/creation-tools.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'
import { registerPatrolTools } from '../src/tools.ts'
import { PatrolLifecycleStore } from '../src/lifecycle-store.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-create-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const definitions: any[] = []
  const ctx = {
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
    },
  } as unknown as Context
  registerPatrolCreationTools(ctx, store)
  const tool = definitions.find(item => item.name === 'patrol_create_inspection')
  if (!tool) throw new Error('patrol_create_inspection not registered')
  return { store, tool }
}

describe('secret-safe Patrol creation', () => {
  it('does not expose any auth notes or plaintext secret parameter', async () => {
    const { tool } = await setup()
    expect(tool.parameters.notes).toBeUndefined()
    expect(tool.parameters.password).toBeUndefined()
    expect(tool.parameters.credentialValue).toBeUndefined()
  })

  it('creates a draft from non-secret metadata', async () => {
    const { store, tool } = await setup()
    await tool.execute({
      inspectionId: 'idc-project-task',
      name: 'IDC tasks',
      description: 'Inspect current project tasks',
      targetUrl: 'http://10.192.1.121:8069/web/login#action=400&model=project.task&view_type=list&cids=1&menu_id=279',
      expectedResult: 'Exactly four visible task rows and a weekly summary',
      authMode: 'secret-ref',
      artifacts: ['markdown-report', 'json-report', 'screenshot', 'page-text', 'page-summary'],
    })
    const definition = await store.load('idc-project-task')
    expect(definition.status).toBe('draft')
    expect(definition.auth.notes).toBeUndefined()
    expect(definition.steps).toEqual([])
  })

  it('normalizes a mixed Chinese inspection id instead of failing the first tool call', async () => {
    const { store, tool } = await setup()
    const result = await tool.execute({
      inspectionId: 'adbba-fz-巡检',
      name: 'ADBBA 运维巡检',
      description: 'Inspect ADBBA RDP access',
      targetUrl: 'https://10.192.1.125/u-s-m-ADBBAF-v8/login',
      expectedResult: '完成截图',
      authMode: 'secret-ref',
      artifacts: ['markdown-report'],
    })

    expect(result).toContain('Created DRAFT adbba-fz')
    expect(await store.exists('adbba-fz')).toBe(true)
  })

  it('reuses an existing id instead of deleting or overwriting it', async () => {
    const { store, tool } = await setup()
    const args = {
      inspectionId: 'existing-id',
      name: 'Existing',
      description: 'Existing inspection',
      targetUrl: 'https://example.com',
      expectedResult: 'ok',
      authMode: 'none',
      artifacts: ['markdown-report'],
    }
    await tool.execute(args)
    const result = await tool.execute({ ...args, name: 'Replacement' })
    expect(result).toMatch(/already exists/i)
    expect((await store.load('existing-id')).name).toBe('Existing')
  })

  it('does not start append-mode teaching when an existing draft already has reusable steps', async () => {
    const { store, tool } = await setup()
    let teachingStarted = false
    ;(store as PatrolStore & { beginTeachingRun: () => Promise<void> }).beginTeachingRun = async () => {
      teachingStarted = true
    }
    const now = new Date().toISOString()
    const existing: InspectionDefinition = {
      schemaVersion: '0.2',
      id: 'existing-draft-flow',
      name: '已有流程',
      description: '已有可复用步骤',
      status: 'draft',
      target: { type: 'browser', url: 'https://example.com' },
      expectedResult: '完成巡检',
      artifacts: ['markdown-report'],
      auth: { mode: 'none' },
      schedule: null,
      steps: [{
        id: 'step-001',
        kind: 'tool',
        name: '打开页面',
        tool: 'browser_navigate',
        arguments: { url: 'https://example.com' },
        recordedAt: now,
      }],
      metadata: { createdAt: now, updatedAt: now },
    }
    await store.create(existing)

    const result = await tool.execute({
      inspectionId: 'existing-draft-flow',
      name: '新请求不应覆盖',
      description: '基于旧流程巡检',
      targetUrl: 'https://example.com',
      expectedResult: '完成巡检',
      authMode: 'none',
      artifacts: ['markdown-report'],
    })

    expect(teachingStarted).toBe(false)
    expect(result).toContain('patrol_run_flow')
    expect(result).toContain('patrol_begin_edit')
    expect((await store.load('existing-draft-flow')).steps).toHaveLength(1)
  })

  it('legacy patrol_create_draft starts a workspace-owned WAITING patrol record', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-create-legacy-'))
    roots.push(root)
    const workspace = join(root, 'workspace')
    const store = new PatrolLifecycleStore(join(root, 'internal'))
    await store.init()
    const definitions: any[] = []
    const ctx = {
      tools: {
        register(definition: any) {
          definitions.push(definition)
          return () => {}
        },
        get() { return {} },
      },
    } as unknown as Context
    registerPatrolTools(ctx, store, {} as any, { maxSteps: 20, reportMaxChars: 10_000 })
    const create = definitions.find(item => item.name === 'patrol_create_draft')
    expect(create).toBeDefined()

    await create.execute({
      inspectionId: 'legacy-created-flow',
      name: 'Legacy created flow',
      description: 'test',
      targetUrl: 'https://example.test',
      expectedResult: 'done',
      authMode: 'none',
      artifacts: ['markdown-report'],
    }, {
      agent: { session: { header: { cwd: workspace } } },
    })

    const saved = await store.load('legacy-created-flow')
    expect(saved.metadata.workspaceRoot).toBe(workspace)
    const runIds = await readdir(join(store.root, 'runs', 'legacy-created-flow'))
    expect(runIds).toHaveLength(1)
    expect((await store.loadRun('legacy-created-flow', runIds[0]!)).status).toBe('waiting')
  })
})
