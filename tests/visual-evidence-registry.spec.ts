import { describe, expect, it } from 'vitest'
import { createPatrolVisualEvidenceRegistry } from '../src/visual-evidence-registry.ts'

describe('Patrol model-visible visual evidence registry', () => {
  it('allows repeated observe-to-click handoffs for the same model-visible frame', () => {
    const registry = createPatrolVisualEvidenceRegistry()
    registry.mark('browser-visual-current', 'demo')

    expect(registry.consume('browser-visual-current', 'demo')).toEqual({ ok: true })
    expect(registry.consume('browser-visual-current', 'demo')).toEqual({ ok: true })
    expect(registry.consume('browser-visual-current', 'demo')).toEqual({ ok: true })
  })

  it('tracks the latest model-visible frame per inspection for automatic click binding', () => {
    const registry = createPatrolVisualEvidenceRegistry()
    expect(registry.latest('demo')).toBeUndefined()

    registry.mark('browser-visual-first', 'demo')
    expect(registry.latest('demo')).toBe('browser-visual-first')

    registry.mark('browser-visual-other', 'other')
    registry.mark('browser-visual-second', 'demo')
    expect(registry.latest('demo')).toBe('browser-visual-second')
    expect(registry.latest('other')).toBe('browser-visual-other')

    registry.clearInspection('demo')
    expect(registry.latest('demo')).toBeUndefined()
    expect(registry.latest('other')).toBe('browser-visual-other')
  })

  it('rejects frames from another inspection but does not expire model-visible evidence by time', () => {
    let now = 1000
    const registry = createPatrolVisualEvidenceRegistry(() => now)

    registry.mark('browser-visual-inspection', 'demo')
    expect(registry.consume('browser-visual-inspection', 'other')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/different inspection/i),
    })

    registry.mark('browser-visual-old', 'demo')
    now += 24 * 60 * 60 * 1000
    expect(registry.consume('browser-visual-old', 'demo')).toEqual({ ok: true })
  })

  it('uses clearInspection as the lifecycle cleanup boundary while the extension owns CURRENT-page freshness', () => {
    const registry = createPatrolVisualEvidenceRegistry()
    registry.mark('browser-visual-current', 'demo')

    expect(registry.consume('browser-visual-current', 'demo')).toEqual({ ok: true })
    registry.clearInspection('demo')
    expect(registry.consume('browser-visual-current', 'demo')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not backed by a model-visible/i),
    })
  })
})
