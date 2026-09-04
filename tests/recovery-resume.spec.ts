import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PatrolRunner } from '../src/runner.ts'
import { PatrolStore } from '../src/store.ts'
import type { InspectionDefinition } from '../src/types.ts'

const roots: string[] = []
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

function definition(): InspectionDefinition {
  const now = new Date().toISOString()
  return {
    schemaVersion: '0.2',
    id: 'recover-me',
    name: 'Recover me',
    description: 'Transient recovery test',
    status: 'ready',
    target: { type: 'browser', url: 'https://example.com' },
    expectedResult: 'three deterministic steps pass',
    artifacts: ['markdown-report', 'json-report'],
    auth: { mode: 'none' },
    schedule: null,
    steps: [
      { id: 'step-001', kind: 'tool', name: 'one', tool: 'browser_wait', arguments: { timeoutMs: 1 }, recordedAt: now },
      { id: 'step-002', kind: 'tool', name: 'blocked click', tool: 'browser_click', arguments: { selector: '#continue' }, recordedAt: now },
      { id: 'step-003', kind: 'tool', name: 'three', tool: 'browser_wait', arguments: { timeoutMs: 1 }, recordedAt: now },
    ],
    metadata: { createdAt: now, updatedAt: now },
  }
}

describe('model-on-exception resumable deterministic runner', () => {
  it('persists a failed step as a recovery boundary and retries that same step after recovery', async () => {
    const root = await mkdtemp(join(tmpdir(), 'dsh-patrol-recovery-resume-'))
    roots.push(root)
    const store = new PatrolStore(root)
    await store.init()
    const flow = definition()
    await store.create(flow)

    let blockedOnce = false
    const execute = vi.fn(async (input: { name: string }) => {
      if (input.name === 'browser_click' && !blockedOnce) {
        blockedOnce = true
        return {
          isError: true,
          error: new Error('unexpected confirmation dialog covered #continue'),
          content: [{ type: 'text' as const, text: 'click blocked' }],
          value: null,
        }
      }
      return {
        isError: false,
        content: [{ type: 'text' as const, text: 'ok' }],
        value: { ok: true },
      }
    })
    const ctx = { tools: { execute } } as unknown as Context
    const runner = new PatrolRunner(ctx, store, { reportMaxChars: 30_000 })
    const exec = {
      token: Symbol('runner-recovery-test'),
      rootCallId: 'root',
      signal: new AbortController().signal,
    } as unknown as ToolRunContext

    const first = await runner.run(flow, exec)
    expect(first.report.status).toBe('failed')
    expect(first.report.results.map(item => item.stepId)).toEqual(['step-001', 'step-002'])

    const pending = await store.loadResume(flow.id)
    expect(pending?.reason).toBe('recovery')
    expect(pending?.blockedStepId).toBe('step-002')
    expect(pending?.nextStepIndex).toBe(1)
    expect(pending?.results.map(item => item.stepId)).toEqual(['step-001'])

    const resumed = await runner.resume(flow, exec)
    expect(resumed.report.status).toBe('passed')
    expect(resumed.report.runId).toBe(first.report.runId)
    expect(resumed.report.results.map(item => item.stepId)).toEqual(['step-001', 'step-002', 'step-003'])
    expect(await store.loadResume(flow.id)).toBeUndefined()

    const names = execute.mock.calls.map(call => call[0].name)
    expect(names).toEqual(['browser_wait', 'browser_click', 'browser_click', 'browser_wait'])
  })
})
