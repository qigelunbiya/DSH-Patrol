import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import { registerPatrolTransientRecoveryTools } from '../src/transient-recovery-tools.ts'
import type { InspectionDefinition, JsonObject } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function definition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'transient-recovery',
    name: 'Transient recovery',
    description: 'Recovery action test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.com' },
    expectedResult: 'ready',
    artifacts: ['markdown-report', 'json-report'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [
      { id: 'step-001', kind: 'tool', name: 'Continue', tool: 'browser_click', arguments: { selector: '#continue' }, recordedAt: now },
    ],
    metadata: { createdAt: now, updatedAt: now },
  }
}

async function setup(reason: 'checkpoint' | 'recovery') {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-transient-recovery-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const flow = definition()
  await store.create(flow)
  await store.saveResume({
    schemaVersion: '0.2',
    inspectionId: flow.id,
    runId: 'run-1',
    startedAt: new Date().toISOString(),
    definitionUpdatedAt: flow.metadata.updatedAt,
    nextStepIndex: 0,
    results: [],
    reason,
    blockedStepId: 'step-001',
  })

  const definitions: any[] = []
  const calls: Array<{ tool: string; args: JsonObject }> = []
  const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
  const runner = {
    async dispatch(tool: string, args: JsonObject) {
      calls.push({ tool, args })
      return { ok: true, text: 'ok', value: { ok: true } }
    },
  } as unknown as PatrolRunner
  registerPatrolTransientRecoveryTools(ctx, store, runner)
  const tool = definitions.find(item => item.name === 'patrol_recovery_action')
  if (!tool) throw new Error('patrol_recovery_action was not registered')
  const exec = {
    token: Symbol('recovery-action-test'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { store, flow, tool, calls, exec }
}

describe('transient model recovery action', () => {
  it('clicks a CURRENT selector without changing the Runbook', async () => {
    const { store, flow, tool, calls, exec } = await setup('recovery')
    const before = await store.load(flow.id)
    const output = await tool.execute({
      inspectionId: flow.id,
      action: 'click',
      selector: '.unexpected-dialog .continue',
    }, exec)
    const after = await store.load(flow.id)

    expect(calls).toEqual([{ tool: 'browser_click', args: { selector: '.unexpected-dialog .continue' } }])
    expect(after).toEqual(before)
    expect(output).toContain('Runbook was NOT modified')
  })

  it('refuses to treat a human checkpoint as an automatic recovery opportunity', async () => {
    const { flow, tool, exec } = await setup('checkpoint')
    await expect(tool.execute({
      inspectionId: flow.id,
      action: 'click',
      selector: '#approve',
    }, exec)).rejects.toThrow(/waiting for checkpoint/i)
  })
})
