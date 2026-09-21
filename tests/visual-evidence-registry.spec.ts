import { describe, expect, it } from 'vitest'
import { createPatrolVisualEvidenceRegistry } from '../src/visual-evidence-registry.ts'

describe('Patrol model-visible visual evidence registry', () => {
  it('allows exactly the CURRENT model-visible frame once', () => {
    let now = 1000
    const registry = createPatrolVisualEvidenceRegistry(() => now)
    registry.mark('browser-visual-current', 'demo', 'root-a')

    expect(registry.consume('browser-visual-current', 'demo', 'root-a')).toEqual({ ok: true })
    expect(registry.consume('browser-visual-current', 'demo', 'root-a')).toMatchObject({ ok: false })
  })

  it('rejects frames from another turn, inspection, or expired visual evidence', () => {
    let now = 1000
    const registry = createPatrolVisualEvidenceRegistry(() => now)

    registry.mark('browser-visual-turn', 'demo', 'root-a')
    expect(registry.consume('browser-visual-turn', 'demo', 'root-b')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/earlier model turn/i),
    })

    registry.mark('browser-visual-inspection', 'demo', 'root-a')
    expect(registry.consume('browser-visual-inspection', 'other', 'root-a')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/different inspection/i),
    })

    registry.mark('browser-visual-expired', 'demo', 'root-a')
    now += 120_001
    expect(registry.consume('browser-visual-expired', 'demo', 'root-a')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not backed by a model-visible/i),
    })
  })
})
