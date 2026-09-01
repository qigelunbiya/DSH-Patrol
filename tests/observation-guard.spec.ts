import { describe, expect, it } from 'vitest'
import { createPatrolObservationGate } from '../src/observation-guard.js'

function sessionEvents(turn: number, observedCallId?: string) {
  const events: any[] = [
    { type: 'turn/start', seq: 0, time: 1_000 + turn * 100, data: { turn } },
  ]
  if (observedCallId !== undefined) {
    events.push({
      type: 'tool/call',
      seq: 1,
      time: 1_010 + turn * 100,
      data: { turn, step: 1, callId: observedCallId, name: 'patrol_observe', arguments: '{}' },
    })
  }
  return events
}

function nextTurnEvents(previousTurn: number, observedCallId: string) {
  return [
    ...sessionEvents(previousTurn, observedCallId),
    { type: 'turn/end', seq: 2, time: 1_020 + previousTurn * 100, data: { turn: previousTurn, reason: 'completed' } },
    { type: 'turn/start', seq: 3, time: 2_000 + previousTurn * 100, data: { turn: previousTurn + 1 } },
  ]
}

function execution(
  name: string,
  inspectionId: string,
  rootCallId: string,
  args: Record<string, unknown> = {},
  events?: any[],
) {
  return {
    name,
    arguments: { inspectionId, ...args },
    rootCallId,
    ...(events === undefined ? {} : {
      agent: {
        session: {
          header: { id: 'session-demo' },
          events,
        },
      },
    }),
  }
}

describe('current-state observation gate', () => {
  it('blocks browser mutation before a fresh observation', () => {
    const gate = createPatrolObservationGate()
    expect(gate.guard(execution('patrol_navigate', 'demo', 'navigate-call', { url: 'https://example.com' }, sessionEvents(1)))).toMatch(/patrol_observe/)
  })

  it('uses the Harness session turn instead of requiring identical rootCallId values', () => {
    const gate = createPatrolObservationGate()
    const observedCallId = 'observe-call'
    gate.markObserved('demo', observedCallId as any)

    const sameTurn = sessionEvents(1, observedCallId)
    expect(gate.guard(execution('patrol_type_text', 'demo', 'type-call', {}, sameTurn))).toBeUndefined()
    expect(gate.guard(execution('patrol_detect_auth_challenge', 'demo', 'captcha-call', {}, sameTurn))).toBeUndefined()

    const nextTurn = nextTurnEvents(1, observedCallId)
    expect(gate.guard(execution('patrol_type_transient', 'demo', 'otp-call', {}, nextTurn))).toMatch(/patrol_observe/)
  })

  it('consumes observation after a page-changing action', () => {
    const gate = createPatrolObservationGate()
    const observedCallId = 'observe-click-call'
    const events = sessionEvents(2, observedCallId)
    gate.markObserved('demo', observedCallId as any)

    expect(gate.guard(execution('patrol_click', 'demo', 'click-1', {}, events))).toBeUndefined()
    expect(gate.guard(execution('patrol_click', 'demo', 'click-2', {}, events))).toMatch(/patrol_observe/)
  })

  it('forces observation before replay/validation tools so OTP state is not destroyed blindly', () => {
    const gate = createPatrolObservationGate()
    expect(gate.guard(execution('patrol_resume', 'demo', 'resume-call', {}, sessionEvents(3)))).toMatch(/patrol_observe/)
    expect(gate.guard(execution('patrol_validate', 'demo', 'validate-call', {}, sessionEvents(3)))).toMatch(/patrol_observe/)
  })

  it('breaks the initial blank-tab deadlock across separate top-level tool call ids', () => {
    const gate = createPatrolObservationGate()
    const observedCallId = 'bootstrap-observe-call'
    const events = sessionEvents(4, observedCallId)
    gate.markBootstrap('demo', observedCallId as any, 'unobservable-tab')

    expect(gate.guard(execution('patrol_click', 'demo', 'click-call', {}, events))).toMatch(/bootstrap gate/)
    expect(gate.guard(execution('patrol_navigate', 'demo', 'navigate-call', { url: 'https://example.com/login' }, events))).toBeUndefined()
    expect(gate.guard(execution('patrol_type_text', 'demo', 'type-call', {}, events))).toMatch(/patrol_observe/)
  })

  it('requires newTab=true when bootstrap observation found no browser tabs', () => {
    const gate = createPatrolObservationGate()
    const observedCallId = 'no-tab-observe-call'
    const events = sessionEvents(5, observedCallId)
    gate.markBootstrap('demo', observedCallId as any, 'no-tab')

    expect(gate.guard(execution('patrol_navigate', 'demo', 'navigate-1', { url: 'https://example.com' }, events))).toMatch(/newTab=true/)
    expect(gate.guard(execution('patrol_navigate', 'demo', 'navigate-2', { url: 'https://example.com', newTab: true }, events))).toBeUndefined()
  })

  it('falls back to rootCallId correlation when no Harness session is available', () => {
    const gate = createPatrolObservationGate()
    gate.markObserved('demo', 'legacy-root' as any)
    expect(gate.guard(execution('patrol_type_text', 'demo', 'legacy-root'))).toBeUndefined()
    expect(gate.guard(execution('patrol_type_text', 'demo', 'other-root'))).toMatch(/patrol_observe/)
  })
})
