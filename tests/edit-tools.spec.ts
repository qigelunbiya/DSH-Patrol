import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolEditTools } from '../src/edit-tools.ts'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-edit-'))
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
    get(name: string) {
      if (name === 'credentials') {
        return {
          async describe() { return { configured: true, source: 'test' } },
        }
      }
      return undefined
    },
  } as unknown as Context

  const runner = {
    async dispatch() {
      return { ok: true, text: 'ok', value: { ok: true } }
    },
    async run(definition: InspectionDefinition) {
      return {
        report: {
          schemaVersion: '0.2' as const,
          runId: 'validation-run',
          inspectionId: definition.id,
          inspectionName: definition.name,
          startedAt: new Date().toISOString(),
          finishedAt: new Date().toISOString(),
          status: 'passed' as const,
          expectedResult: definition.expectedResult,
          results: [],
        },
        paths: {
          directory: join(root, 'runs', definition.id, 'validation-run'),
          json: join(root, 'runs', definition.id, 'validation-run', 'report.json'),
          markdown: join(root, 'runs', definition.id, 'validation-run', 'report.md'),
        },
      }
    },
    async resume(definition: InspectionDefinition) {
      return await this.run(definition)
    },
  } as unknown as PatrolRunner

  registerPatrolEditTools(ctx, store, runner)
  const tool = (name: string) => {
    const found = definitions.find(item => item.name === name)
    if (!found) throw new Error(`tool ${name} not registered`)
    return found
  }
  const exec = {
    token: Symbol('edit-test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { store, tool, exec }
}

function readyDefinition(): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'editable-login',
    name: 'Editable login',
    description: 'Login editing test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.com/login' },
    expectedResult: 'logged in',
    artifacts: [],
    auth: { mode: 'secret-ref' },
    schedule: { enabled: true, cron: '0 9 * * 1-5' },
    steps: [
      {
        id: 'step-001',
        kind: 'tool',
        name: 'username',
        tool: 'browser_type',
        arguments: { selector: '#username', text: 'old@example.com', clear: true },
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'step-002',
        kind: 'tool',
        name: 'password',
        tool: 'browser_type_credential',
        arguments: { selector: '#password', credentialRef: '${credential:OLD_PASSWORD}', clear: true },
        sensitive: true,
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'step-003',
        kind: 'checkpoint',
        name: 'verification',
        prompt: 'Complete the verification shown in the managed browser.',
        reason: 'other',
        when: {
          sourceStepId: 'step-002',
          mode: 'contains',
          value: 'challenge',
          caseSensitive: false,
        },
        notes: 'old note',
        recordedAt: '2026-01-01T00:00:00.000Z',
      },
    ],
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      validatedAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

describe('editable Patrol runbooks', () => {
  it('re-teaches username and credential steps, validates, then returns to READY', async () => {
    const { store, tool, exec } = await setup()
    await store.create(readyDefinition())

    await tool('patrol_begin_edit').execute({ inspectionId: 'editable-login' }, exec)
    let definition = await store.load('editable-login')
    expect(definition.status).toBe('draft')
    expect(definition.metadata.validatedAt).toBeUndefined()
    expect(definition.schedule?.enabled).toBe(true)

    await tool('patrol_reteach_text').execute({
      inspectionId: 'editable-login',
      stepId: 'step-001',
      selector: '#new-username',
      text: 'new@example.com',
    }, exec)
    await tool('patrol_reteach_credential').execute({
      inspectionId: 'editable-login',
      stepId: 'step-002',
      selector: '#new-password',
      credentialRef: 'NEW_PASSWORD',
    }, exec)

    definition = await store.load('editable-login')
    expect(definition.steps[0]?.id).toBe('step-001')
    expect(definition.steps[0]?.kind === 'tool' ? definition.steps[0].arguments.text : undefined).toBe('new@example.com')
    expect(definition.steps[1]?.id).toBe('step-002')
    expect(definition.steps[1]?.kind === 'tool' ? definition.steps[1].arguments.credentialRef : undefined).toBe('${credential:NEW_PASSWORD}')

    await tool('patrol_validate').execute({ inspectionId: 'editable-login' }, exec)
    definition = await store.load('editable-login')
    expect(definition.metadata.validatedAt).toBeDefined()

    await tool('patrol_confirm_edit').execute({ inspectionId: 'editable-login', confirmed: true }, exec)
    definition = await store.load('editable-login')
    expect(definition.status).toBe('ready')
    expect(definition.schedule?.enabled).toBe(true)
  })

  it('refuses to confirm an edited runbook before full validation', async () => {
    const { store, tool, exec } = await setup()
    await store.create(readyDefinition())
    await tool('patrol_begin_edit').execute({ inspectionId: 'editable-login' }, exec)
    await expect(tool('patrol_confirm_edit').execute({ inspectionId: 'editable-login', confirmed: true }, exec)).rejects.toThrow(/has not passed patrol_validate/i)
  })

  it('can clear an obsolete checkpoint condition and notes without changing the step id', async () => {
    const { store, tool, exec } = await setup()
    await store.create(readyDefinition())
    await tool('patrol_begin_edit').execute({ inspectionId: 'editable-login' }, exec)
    await tool('patrol_reteach_checkpoint').execute({
      inspectionId: 'editable-login',
      stepId: 'step-003',
      clearCondition: true,
      clearNotes: true,
      prompt: 'Complete the current human verification, then continue.',
    }, exec)
    const definition = await store.load('editable-login')
    const step = definition.steps[2]
    expect(step?.id).toBe('step-003')
    expect(step?.kind).toBe('checkpoint')
    if (step?.kind === 'checkpoint') {
      expect(step.when).toBeUndefined()
      expect(step.notes).toBeUndefined()
    }
  })
})
