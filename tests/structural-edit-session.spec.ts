import { afterEach, describe, expect, it } from 'vitest'
import {
  clearStructuralEditSessionsForTest,
  enterStructuralEditSession,
  isStructuralEditSession,
  leaveStructuralEditSession,
  structuralEditAppendGuard,
} from '../src/structural-edit-session.js'

afterEach(() => clearStructuralEditSessionsForTest())

describe('structural edit isolation', () => {
  it('blocks append-style teaching tools only for inspections explicitly in structural edit mode', () => {
    enterStructuralEditSession('flow-a')

    expect(isStructuralEditSession('flow-a')).toBe(true)
    expect(structuralEditAppendGuard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'flow-a', url: 'https://example.test' },
    })).toMatch(/NOT executed.*append a new tail round/s)

    expect(structuralEditAppendGuard({
      name: 'patrol_scroll',
      arguments: { inspectionId: 'flow-a', direction: 'down' },
    })).toMatch(/structural edit isolation/i)

    expect(structuralEditAppendGuard({
      name: 'patrol_visual_click_target',
      arguments: { inspectionId: 'flow-a', candidateId: 'A1' },
    })).toMatch(/patrol_insert_\*/)

    expect(structuralEditAppendGuard({
      name: 'patrol_screenshot',
      arguments: { inspectionId: 'flow-a' },
    })).toMatch(/NOT executed/)

    expect(structuralEditAppendGuard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'flow-b', url: 'https://example.test' },
    })).toBeUndefined()
  })

  it('allows structural/reteach/read-only verification tools while edit isolation is active', () => {
    enterStructuralEditSession('flow-a')

    for (const name of [
      'patrol_insert_click_step',
      'patrol_update_navigate_step',
      'patrol_move_step',
      'patrol_remove_steps',
      'patrol_reteach_browser_step',
      'patrol_show',
      'patrol_task_checklist',
      'patrol_observe',
      'patrol_run_flow',
      'patrol_validate',
      'patrol_confirm_edit',
    ]) {
      expect(structuralEditAppendGuard({
        name,
        arguments: { inspectionId: 'flow-a' },
      }), name).toBeUndefined()
    }
  })

  it('leaves isolation explicitly', () => {
    enterStructuralEditSession('flow-a')
    leaveStructuralEditSession('flow-a')
    expect(isStructuralEditSession('flow-a')).toBe(false)
  })
})
