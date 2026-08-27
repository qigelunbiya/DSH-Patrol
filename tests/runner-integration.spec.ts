import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it } from 'vitest'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function setup(execute: (input: { name: string; arguments: unknown }) => Promise<unknown>) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-runner-'))
  roots.push(root)
  const store = new PatrolStore(root)
  await store.init()
  const ctx = { tools: { execute } } as unknown as Context
  const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30000 })
  const exec = {
    token: Symbol('patrol-parent'),
    rootCallId: 'root',
    signal: new AbortController().signal,
  } as unknown as ToolRunContext
  return { store, runner, exec }
}

function definition(steps: InspectionDefinition['steps'], artifacts: InspectionDefinition['artifacts'] = []): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'test',
    name: 'test',
    description: 'test patrol',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.com' },
    expectedResult: 'ok',
    artifacts,
    auth: { mode: 'none' },
    schedule: null,
    steps,
    metadata: {
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      validatedAt: '2026-01-01T00:00:00.000Z',
    },
  }
}

const at = '2026-01-01T00:00:00.000Z'

describe('PatrolRunner integration safety', () => {
  it('fails a screenshot step when the provider returns no path', async () => {
    const { runner, exec } = await setup(async () => ({
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'screenshot returned without path' }],
    }))
    const def = definition([{ id: 'step-001', kind: 'tool', name: 'shot', tool: 'browser_screenshot', arguments: {}, artifact: 'screenshot', recordedAt: at }], ['screenshot'])
    const { report } = await runner.run(def, exec)
    expect(report.status).toBe('failed')
    expect(report.results[0]?.error).toMatch(/no artifact path/i)
  })

  it('fails page-summary requirements without a successful page read', async () => {
    const { runner, exec } = await setup(async () => ({
      isError: false,
      value: { ok: true, connected: true },
      content: [{ type: 'text', text: 'connected' }],
    }))
    const def = definition([{ id: 'step-001', kind: 'tool', name: 'navigate', tool: 'browser_navigate', arguments: { url: 'https://example.com' }, recordedAt: at }], ['page-summary'])
    const { report } = await runner.run(def, exec)
    expect(report.status).toBe('failed')
    expect(report.results.at(-1)?.error).toMatch(/page-summary/i)
  })

  it('refuses to resume a runbook edited after the checkpoint', async () => {
    const { store, runner, exec } = await setup(async () => ({
      isError: false,
      value: { ok: true },
      content: [{ type: 'text', text: 'ok' }],
    }))
    const def = definition([{ id: 'step-001', kind: 'checkpoint', name: 'manual', prompt: '请完成审批', reason: 'approval', recordedAt: at }])
    const first = await runner.run(def, exec)
    expect(first.report.status).toBe('waiting')
    const changed = { ...def, metadata: { ...def.metadata, updatedAt: '2026-01-02T00:00:00.000Z' } }
    await expect(runner.resume(changed, exec)).rejects.toThrow(/changed after run/i)
    expect(await store.loadResume(def.id)).toBeDefined()
  })
})
