import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { registerPatrolTransientInputTools } from '../src/transient-input-tools.ts'
import type { PatrolRunner } from '../src/runner.ts'
import type { PatrolStore } from '../src/store.ts'

describe('Patrol transient sensitive input', () => {
  it('types an already-supplied secret and stores only a current-session transient reference', async () => {
    const definitions: any[] = []
    const ctx = {
      tools: {
        register(definition: any) {
          definitions.push(definition)
          return () => {}
        },
      },
    } as unknown as Context
    const inspection: any = {
      schemaVersion: '0.2',
      id: 'demo',
      name: 'demo',
      description: 'demo',
      status: 'draft',
      target: { type: 'browser', url: 'https://example.test/' },
      expectedResult: 'demo',
      artifacts: [],
      auth: { mode: 'manual-checkpoint' },
      schedule: null,
      steps: [],
      metadata: { createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
    }
    const save = vi.fn(async () => {})
    const store = {
      load: vi.fn(async () => inspection),
      save,
    } as unknown as PatrolStore
    const dispatch = vi.fn(async () => ({ ok: true, text: 'Typed public text into #password.' }))
    const runner = { dispatch } as unknown as PatrolRunner

    registerPatrolTransientInputTools(ctx, store, runner)
    const tool = definitions.find(item => item.name === 'patrol_type_transient')
    expect(tool).toBeDefined()

    const secret = 'example-sensitive-value'
    const result = await tool.execute({
      inspectionId: 'demo',
      stepName: 'fill supplied password',
      selector: '#password',
      text: secret,
      clear: true,
    }, { token: Symbol('exec') })

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0]?.[0]).toBe('browser_type')
    expect(dispatch.mock.calls[0]?.[1]).toEqual({ selector: '#password', text: secret, clear: true })
    expect(dispatch.mock.calls[0]?.[3]).toEqual([secret])
    expect(save).toHaveBeenCalledTimes(1)
    expect(inspection.steps).toHaveLength(1)
    expect(inspection.steps[0].tool).toBe('browser_type_transient_ref')
    expect(inspection.steps[0].arguments.selector).toBe('#password')
    expect(inspection.steps[0].arguments.transientRef).toMatch(/^PATROL_TRANSIENT_[A-F0-9]+$/)
    expect(JSON.stringify(inspection)).not.toContain(secret)
    expect(result).not.toContain(secret)
    expect(result).toContain('NOT written')
  })

  it('redacts text from the visible tool-call card', () => {
    const definitions: any[] = []
    const ctx = { tools: { register(definition: any) { definitions.push(definition); return () => {} } } } as unknown as Context
    registerPatrolTransientInputTools(ctx, {} as PatrolStore, {} as PatrolRunner)
    const tool = definitions.find(item => item.name === 'patrol_type_transient')
    const card = tool.presentCall({ inspectionId: 'demo', stepName: 'password', selector: '#password', text: 'never-display-me' })
    expect(JSON.stringify(card)).not.toContain('never-display-me')
    expect(JSON.stringify(card)).toContain('[REDACTED]')
  })
})
