import { describe, expect, it } from 'vitest'
import { compactFlowConservatively } from '../browser-bridge-runtime/safe-flow-cleanup.js'

function step(id, tool, extra = {}) {
  return {
    id,
    kind: 'tool',
    name: `${tool} ${id}`,
    tool,
    arguments: {},
    recordedAt: `2026-09-04T00:00:${id.slice(-3)}Z`,
    ...extra,
  }
}

describe('dashboard conservative flow cleanup', () => {
  it('never treats a later repeated navigation as permission to delete the earlier flow', () => {
    const definition = {
      artifacts: ['screenshot', 'page-text'],
      steps: [
        step('step-001', 'browser_navigate'),
        step('step-002', 'browser_login_state'),
        step('step-003', 'browser_type'),
        step('step-004', 'browser_click'),
        step('step-005', 'browser_wait'),
        step('step-006', 'browser_screenshot', { artifact: 'screenshot' }),
        step('step-007', 'browser_read_page', { artifact: 'page-text' }),

        // A later ad-hoc "run" accidentally recorded another mini round.
        step('step-008', 'browser_navigate'),
        step('step-009', 'browser_login_state'),
        step('step-010', 'browser_screenshot', { artifact: 'screenshot' }),
        step('step-011', 'browser_read_page', { artifact: 'page-text' }),
      ],
    }

    const result = compactFlowConservatively(definition)

    expect(result.originalSteps).toBe(11)
    expect(definition.steps.some(item => item.tool === 'browser_type')).toBe(true)
    expect(definition.steps.some(item => item.tool === 'browser_click')).toBe(true)
    expect(definition.steps[0].tool).toBe('browser_navigate')
    expect(definition.steps.length).toBeGreaterThan(4)
  })
})
