import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { registerPatrolActionTools } from '../src/action-tools.ts'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition, JsonObject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-actions-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  await store.create(draftDefinition())

  const definitions: any[] = []
  const calls: Array<{ tool: string; args: JsonObject }> = []
  const ctx = {
    tools: {
      register(definition: any) {
        definitions.push(definition)
        return () => {}
      },
    },
  } as unknown as Context

  const runner = {
    async dispatch(tool: string, args: JsonObject) {
      calls.push({ tool, args })
      if (tool === 'browser_count') return { ok: true, text: `Count .row: 4 element(s) (visible only).`, value: { ok: true, count: 4 } }
      if (tool === 'browser_read_page') return { ok: true, text: 'Page: Tasks\n\nrow one\nrow two', value: { ok: true } }
      return { ok: true, text: 'ok', value: { ok: true } }
    },
  } as unknown as PatrolRunner

  registerPatrolActionTools(ctx, store, runner, { maxSteps: 50 })
  const tool = (name: string) => {
    const found = definitions.find(item => item.name === name)
    if (!found) throw new Error(`tool ${name} not registered`)
    return found
  }
  const exec = {
    token: Symbol('action-test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext

  return { store, calls, tool, definitions, exec }
}

function draftDefinition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'flat-actions',
    name: 'Flat actions',
    description: 'Flat action tool test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.com' },
    expectedResult: 'four rows',
    artifacts: ['screenshot', 'page-text'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [],
    metadata: { createdAt: now, updatedAt: now },
  }
}

describe('flat Patrol action tools', () => {
  it('registers model-facing actions without a nested arguments parameter', async () => {
    const { definitions } = await setup()
    for (const name of ['patrol_navigate', 'patrol_snapshot', 'patrol_read_page', 'patrol_count', 'patrol_detect_auth_challenge', 'patrol_click', 'patrol_wait', 'patrol_screenshot']) {
      const definition = definitions.find(item => item.name === name)
      expect(definition).toBeDefined()
      expect(definition.parameters.arguments).toBeUndefined()
    }
  })

  it('navigates using flat URL fields and stores provider arguments as an object', async () => {
    const { store, calls, tool, exec } = await setup()
    await tool('patrol_navigate').execute({
      inspectionId: 'flat-actions',
      stepName: 'Open IDC',
      url: 'http://10.192.1.121:8069/web/login',
    }, exec)

    expect(calls[0]).toEqual({
      tool: 'browser_navigate',
      args: { url: 'http://10.192.1.121:8069/web/login', action: 'navigate' },
    })
    const definition = await store.load('flat-actions')
    expect(definition.steps[0]?.kind).toBe('tool')
    if (definition.steps[0]?.kind === 'tool') {
      expect(definition.steps[0].arguments).toEqual({ url: 'http://10.192.1.121:8069/web/login', action: 'navigate' })
    }
  })

  it('records an exact count assertion without generic JSON arguments', async () => {
    const { store, tool, exec } = await setup()
    await tool('patrol_count').execute({
      inspectionId: 'flat-actions',
      stepName: 'Verify task rows',
      selector: '.row',
      expectedCount: 4,
    }, exec)

    const definition = await store.load('flat-actions')
    const step = definition.steps[0]
    expect(step?.kind).toBe('tool')
    if (step?.kind === 'tool') {
      expect(step.tool).toBe('browser_count')
      expect(step.arguments).toEqual({ selector: '.row' })
      expect(step.expectation?.value).toBe(': 4 element(s)')
    }
  })

  it('captures page text by default and screenshots as artifacts', async () => {
    const { store, tool, exec } = await setup()
    await tool('patrol_read_page').execute({ inspectionId: 'flat-actions', stepName: 'Read tasks' }, exec)
    await tool('patrol_screenshot').execute({ inspectionId: 'flat-actions', stepName: 'Capture tasks', format: 'png' }, exec)

    const definition = await store.load('flat-actions')
    expect(definition.steps[0]?.kind === 'tool' ? definition.steps[0].artifact : undefined).toBe('page-text')
    expect(definition.steps[1]?.kind === 'tool' ? definition.steps[1].artifact : undefined).toBe('screenshot')
  })
})
