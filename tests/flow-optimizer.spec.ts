import { describe, expect, it } from 'vitest'
import { compactTeachingFlow } from '../src/flow-optimizer.ts'
import type { InspectionDefinition, InspectionStep } from '../src/types.ts'

function definition(steps: InspectionStep[]): InspectionDefinition {
  return {
    schemaVersion: '0.2',
    id: 'compact-test',
    name: 'Compact test',
    description: 'test',
    status: 'draft',
    target: { type: 'browser', url: 'https://example.test' },
    expectedResult: 'done',
    artifacts: ['page-text', 'screenshot'],
    auth: { mode: 'none' },
    schedule: null,
    steps,
    metadata: {
      createdAt: '2026-09-02T00:00:00.000Z',
      updatedAt: '2026-09-02T00:00:00.000Z',
    },
  }
}

const tool = (id: string, name: string, browserTool: string, extra: Partial<InspectionStep> = {}): InspectionStep => ({
  id,
  kind: 'tool',
  name,
  tool: browserTool,
  arguments: {},
  recordedAt: `2026-09-02T00:00:${id.slice(-3)}Z`,
  ...extra,
} as InspectionStep)

describe('flow compaction', () => {
  it('removes teaching probes while keeping real actions and final requested outputs', () => {
    const value = definition([
      tool('step-001', 'Navigate', 'browser_navigate'),
      tool('step-002', 'Probe snapshot', 'browser_snapshot'),
      tool('step-003', 'Probe count', 'browser_count'),
      tool('step-004', 'Early read', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-005', 'Click login', 'browser_click'),
      tool('step-006', 'Early screenshot', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
      tool('step-007', 'Final read', 'browser_read_page', { artifact: 'page-text' } as Partial<InspectionStep>),
      tool('step-008', 'Final screenshot', 'browser_screenshot', { artifact: 'screenshot' } as Partial<InspectionStep>),
    ])

    const result = compactTeachingFlow(value)

    expect(result).toEqual({ originalSteps: 8, finalSteps: 4, removedSteps: 4 })
    expect(value.steps.map(step => step.tool)).toEqual([
      'browser_navigate',
      'browser_click',
      'browser_read_page',
      'browser_screenshot',
    ])
    expect(value.steps.map(step => step.id)).toEqual(['step-001', 'step-002', 'step-003', 'step-004'])
  })

  it('keeps an observational source referenced by a conditional action and rewrites its id', () => {
    const value = definition([
      tool('step-001', 'Probe snapshot', 'browser_snapshot'),
      tool('step-002', 'Login state', 'browser_read_page'),
      tool('step-003', 'Unused count', 'browser_count'),
      tool('step-004', 'Conditional login click', 'browser_click', {
        when: {
          sourceStepId: 'step-002',
          mode: 'contains',
          value: '登录',
          caseSensitive: false,
        },
      } as Partial<InspectionStep>),
    ])

    const result = compactTeachingFlow(value)

    expect(result.finalSteps).toBe(2)
    expect(value.steps[0]).toMatchObject({ id: 'step-001', tool: 'browser_read_page' })
    expect(value.steps[1]).toMatchObject({
      id: 'step-002',
      tool: 'browser_click',
      when: { sourceStepId: 'step-001' },
    })
  })
})
