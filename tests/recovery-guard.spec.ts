import { describe, expect, it } from 'vitest'
import { createPatrolRecoveryGuard } from '../src/recovery-guard.js'

describe('Patrol recovery circuit breaker', () => {
  it('blocks new-tab retries for deterministic navigation', () => {
    const guard = createPatrolRecoveryGuard()
    expect(guard({
      name: 'patrol_navigate',
      arguments: { inspectionId: 'demo', url: 'https://10.192.1.125/login', newTab: true },
    })).toMatch(/newTab=true/)
  })

  it('blocks a third identical effective diagnostic even when cosmetic fields change', () => {
    const guard = createPatrolRecoveryGuard()
    const call = (stepName: string) => guard({
      name: 'patrol_snapshot',
      arguments: { inspectionId: 'demo', stepName, maxElements: 150, notes: `note-${stepName}` },
    })
    expect(call('snapshot one')).toBeUndefined()
    expect(call('snapshot two')).toBeUndefined()
    expect(call('snapshot three')).toMatch(/already been attempted twice/)
  })

  it('stops a diagnostic loop but still permits exactly one doctor call', () => {
    const guard = createPatrolRecoveryGuard()
    const names = [
      'patrol_navigate',
      'patrol_wait',
      'patrol_snapshot',
      'patrol_read_page',
      'patrol_screenshot',
      'patrol_paths',
      'patrol_show',
      'patrol_read_page',
      'patrol_wait',
    ]
    const outputs = names.map((name, index) => guard({
      name,
      arguments: { inspectionId: 'demo', stepName: `probe-${index}`, ...(name === 'patrol_navigate' ? { url: 'https://10.192.1.125/login' } : {}) },
    }))
    expect(outputs.some(value => typeof value === 'string' && /too many diagnostic actions|already been attempted twice/.test(value))).toBe(true)

    // This matches the recovery instruction emitted by the breaker: doctor is
    // still allowed once even though the general diagnostic budget is spent.
    expect(guard({ name: 'patrol_doctor', arguments: { inspectionId: 'demo' } })).toBeUndefined()
    expect(guard({ name: 'patrol_doctor', arguments: { inspectionId: 'demo' } })).toMatch(/already been used once/)
  })

  it('resets the diagnostic episode after a meaningful browser progress action', () => {
    const guard = createPatrolRecoveryGuard()
    const snapshot = () => guard({ name: 'patrol_snapshot', arguments: { inspectionId: 'demo', maxElements: 50 } })
    expect(snapshot()).toBeUndefined()
    expect(snapshot()).toBeUndefined()
    expect(guard({ name: 'patrol_click', arguments: { inspectionId: 'demo', selector: '#login' } })).toBeUndefined()
    expect(snapshot()).toBeUndefined()
    expect(snapshot()).toBeUndefined()
  })
})
