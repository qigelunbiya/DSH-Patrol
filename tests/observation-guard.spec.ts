import { describe, expect, it } from 'vitest'
import { createPatrolObservationGate } from '../src/observation-guard.js'

function execution(name: string, inspectionId: string, rootCallId: string, args: Record<string, unknown> = {}) {
  return { name, arguments: { inspectionId, ...args }, rootCallId }
}

describe('current-state observation gate', () => {
  it('blocks browser mutation before a fresh observation', () => {
    const gate = createPatrolObservationGate()
    expect(gate.guard(execution('patrol_navigate', 'demo', 'turn-1', { url: 'https://example.com' }))).toMatch(/patrol_observe/)
  })

  it('allows same-turn form work after observation but does not carry trust into the next user turn', () => {
    const gate = createPatrolObservationGate()
    gate.markObserved('demo', 'turn-1' as any)
    expect(gate.guard(execution('patrol_type_text', 'demo', 'turn-1'))).toBeUndefined()
    expect(gate.guard(execution('patrol_detect_auth_challenge', 'demo', 'turn-1'))).toBeUndefined()
    expect(gate.guard(execution('patrol_type_transient', 'demo', 'turn-2'))).toMatch(/patrol_observe/)
  })

  it('consumes observation after a page-changing action', () => {
    const gate = createPatrolObservationGate()
    gate.markObserved('demo', 'turn-1' as any)
    expect(gate.guard(execution('patrol_click', 'demo', 'turn-1'))).toBeUndefined()
    expect(gate.guard(execution('patrol_click', 'demo', 'turn-1'))).toMatch(/patrol_observe/)
  })

  it('forces observation before replay/validation tools so OTP state is not destroyed blindly', () => {
    const gate = createPatrolObservationGate()
    expect(gate.guard(execution('patrol_resume', 'demo', 'turn-3'))).toMatch(/patrol_observe/)
    expect(gate.guard(execution('patrol_validate', 'demo', 'turn-3'))).toMatch(/patrol_observe/)
  })

  it('breaks the initial blank-tab deadlock with exactly one bootstrap navigate', () => {
    const gate = createPatrolObservationGate()
    gate.markBootstrap('demo', 'turn-4' as any, 'unobservable-tab')

    expect(gate.guard(execution('patrol_click', 'demo', 'turn-4'))).toMatch(/bootstrap gate/)
    expect(gate.guard(execution('patrol_navigate', 'demo', 'turn-4', { url: 'https://example.com/login' }))).toBeUndefined()
    expect(gate.guard(execution('patrol_type_text', 'demo', 'turn-4'))).toMatch(/patrol_observe/)
  })

  it('requires newTab=true when bootstrap observation found no browser tabs', () => {
    const gate = createPatrolObservationGate()
    gate.markBootstrap('demo', 'turn-5' as any, 'no-tab')

    expect(gate.guard(execution('patrol_navigate', 'demo', 'turn-5', { url: 'https://example.com' }))).toMatch(/newTab=true/)
    expect(gate.guard(execution('patrol_navigate', 'demo', 'turn-5', { url: 'https://example.com', newTab: true }))).toBeUndefined()
  })
})
