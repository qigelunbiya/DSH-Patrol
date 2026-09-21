import { describe, expect, it } from 'vitest'
import { createPatrolVisualEvidenceRegistry } from '../src/visual-evidence-registry.ts'

describe('Patrol model-visible visual evidence registry', () => {
  it('allows exactly one observe-to-click handoff even though the two model tool calls have different rootCallIds', () => {
    let now = 1000
    const registry = createPatrolVisualEvidenceRegistry(() => now)

    // patrol_observe and patrol_visual_click_target are separate model-requested
    // root tool calls in Harness. The frame gate must therefore be independent
    // of ToolRunContext.rootCallId.
    registry.mark('browser-visual-current', 'demo')

    expect(registry.consume('browser-visual-current', 'demo')).toEqual({ ok: true })
    expect(registry.consume('browser-visual-current', 'demo')).toMatchObject({ ok: false })
  })

  it('rejects frames from another inspection or expired visual evidence', () => {
    let now = 1000
    const registry = createPatrolVisualEvidenceRegistry(() => now)

    registry.mark('browser-visual-inspection', 'demo')
    expect(registry.consume('browser-visual-inspection', 'other')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/different inspection/i),
    })

    registry.mark('browser-visual-expired', 'demo')
    now += 120_001
    expect(registry.consume('browser-visual-expired', 'demo')).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/not backed by a recent model-visible/i),
    })
  })

  it('lets the browser extension own CURRENT-page freshness while the registry owns only model visibility and single use', () => {
    const registry = createPatrolVisualEvidenceRegistry(() => 1000)
    registry.mark('browser-visual-current', 'demo')

    // URL/scroll/zoom/viewport staleness is validated by interactionVisualClick
    // against the extension's bound visual frame after this registry handoff.
    expect(registry.consume('browser-visual-current', 'demo')).toEqual({ ok: true })
  })
})
