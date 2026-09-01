import type { Context } from '@deepseek-ai/cordis'
import { describe, expect, it } from 'vitest'
import { registerPatrolRecoveryTools } from '../src/recovery-tools.ts'
import type { PatrolStore } from '../src/store.ts'

describe('Patrol targeted failed-step recovery', () => {
  it('reports the exact stable failed step and tells the agent not to restart', async () => {
    const definitions: any[] = []
    const ctx = {
      tools: {
        register(definition: any) {
          definitions.push(definition)
          return () => {}
        },
      },
    } as unknown as Context
    const store = {
      root: 'unused',
      async loadRun() {
        return {
          schemaVersion: '0.2',
          runId: 'run-1',
          inspectionId: 'demo',
          inspectionName: 'demo',
          startedAt: '2026-01-01T00:00:00.000Z',
          finishedAt: '2026-01-01T00:00:01.000Z',
          status: 'failed',
          expectedResult: 'done',
          results: [
            { stepId: 'step-001', name: 'navigate', kind: 'tool', tool: 'browser_navigate', status: 'passed', startedAt: '', finishedAt: '' },
            { stepId: 'step-007', name: 'click login', kind: 'tool', tool: 'browser_click', status: 'failed', startedAt: '', finishedAt: '', error: 'element not found: #login' },
          ],
        }
      },
    } as unknown as PatrolStore

    registerPatrolRecoveryTools(ctx, store)
    const tool = definitions.find(item => item.name === 'patrol_last_failure')
    const result = await tool.execute({ inspectionId: 'demo', runId: 'run-1' })
    expect(result).toContain('step-007')
    expect(result).toContain('browser_click')
    expect(result).toContain('Earlier passed steps retained: 1')
    expect(result).toContain('patrol_reteach_browser_step')
    expect(result).toContain('Do not delete and rebuild')
  })
})
