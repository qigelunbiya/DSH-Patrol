import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolCreationTools } from '../src/creation-tools.ts'
import { PatrolStore } from '../src/store.ts'

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
})
