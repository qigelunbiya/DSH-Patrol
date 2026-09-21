const VISUAL_EVIDENCE_TTL_MS = 120_000

interface VisualEvidenceRecord {
  inspectionId: string
  createdAt: number
}

export interface PatrolVisualEvidenceRegistry {
  mark(frameId: string, inspectionId: string): void
  consume(frameId: string, inspectionId: string): { ok: true } | { ok: false; reason: string }
  clearInspection(inspectionId: string): void
}

export function createPatrolVisualEvidenceRegistry(
  now: () => number = () => Date.now(),
): PatrolVisualEvidenceRegistry {
  const frames = new Map<string, VisualEvidenceRecord>()

  const prune = (): void => {
    const current = now()
    for (const [frameId, record] of frames) {
      if (current - record.createdAt > VISUAL_EVIDENCE_TTL_MS) frames.delete(frameId)
    }
  }

  return {
    mark(frameId, inspectionId) {
      prune()
      frames.set(frameId, { inspectionId, createdAt: now() })
    },
    consume(frameId, inspectionId) {
      prune()
      const record = frames.get(frameId)
      if (record === undefined) {
        return {
          ok: false,
          reason: 'this visualFrameId is not backed by a recent model-visible patrol_observe(includeImage=true) image',
        }
      }
      frames.delete(frameId)
      if (record.inspectionId !== inspectionId) {
        return { ok: false, reason: 'the visual frame belongs to a different inspection' }
      }
      // Do NOT bind to ToolRunContext.rootCallId. patrol_observe and the next
      // patrol_visual_click_target are separate model-requested root tool calls,
      // so their rootCallId values are expected to differ. The browser extension
      // remains the authoritative freshness gate for tab/URL/scroll/zoom/viewport.
      return { ok: true }
    },
    clearInspection(inspectionId) {
      for (const [frameId, record] of frames) {
        if (record.inspectionId === inspectionId) frames.delete(frameId)
      }
    },
  }
}
