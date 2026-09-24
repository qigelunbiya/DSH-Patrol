interface VisualEvidenceRecord {
  inspectionId: string
}

export interface PatrolVisualEvidenceRegistry {
  mark(frameId: string, inspectionId: string): void
  latest(inspectionId: string): string | undefined
  consume(frameId: string, inspectionId: string): { ok: true } | { ok: false; reason: string }
  clearInspection(inspectionId: string): void
}

export function createPatrolVisualEvidenceRegistry(
  _now: () => number = () => Date.now(),
): PatrolVisualEvidenceRegistry {
  const frames = new Map<string, VisualEvidenceRecord>()
  const latestByInspection = new Map<string, string>()

  return {
    mark(frameId, inspectionId) {
      frames.set(frameId, { inspectionId })
      latestByInspection.set(inspectionId, frameId)
    },
    latest(inspectionId) {
      const frameId = latestByInspection.get(inspectionId)
      return frameId && frames.has(frameId) ? frameId : undefined
    },
    consume(frameId, inspectionId) {
      const record = frames.get(frameId)
      if (record === undefined) {
        return {
          ok: false,
          reason: 'this visualFrameId is not backed by a model-visible patrol_observe(includeImage=true) image',
        }
      }
      if (record.inspectionId !== inspectionId) {
        return { ok: false, reason: 'the visual frame belongs to a different inspection' }
      }
      // Deliberately non-consuming and non-expiring. A model-visible frame may
      // be reused for repeated visual attempts while the browser extension
      // independently verifies that tab/URL/scroll/zoom/viewport still match
      // the screenshot. clearInspection remains the lifecycle cleanup boundary.
      return { ok: true }
    },
    clearInspection(inspectionId) {
      for (const [frameId, record] of frames) {
        if (record.inspectionId === inspectionId) frames.delete(frameId)
      }
      latestByInspection.delete(inspectionId)
    },
  }
}
