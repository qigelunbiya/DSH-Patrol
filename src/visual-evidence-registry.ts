const VISUAL_EVIDENCE_TTL_MS = 120_000

interface VisualEvidenceRecord {
  inspectionId: string
  rootCallId: string
  createdAt: number
}

export interface PatrolVisualEvidenceRegistry {
  mark(frameId: string, inspectionId: string, rootCallId: string): void
  consume(frameId: string, inspectionId: string, rootCallId: string): { ok: true } | { ok: false; reason: string }
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
    mark(frameId, inspectionId, rootCallId) {
      prune()
      frames.set(frameId, { inspectionId, rootCallId, createdAt: now() })
    },
    consume(frameId, inspectionId, rootCallId) {
      prune()
      const record = frames.get(frameId)
      if (record === undefined) {
        return {
          ok: false,
          reason: 'this visualFrameId was not backed by a model-visible patrol_observe(includeImage=true) image in the CURRENT turn',
        }
      }
      frames.delete(frameId)
      if (record.inspectionId !== inspectionId) {
        return { ok: false, reason: 'the visual frame belongs to a different inspection' }
      }
      if (record.rootCallId !== rootCallId) {
        return {
          ok: false,
          reason: 'the visual frame belongs to an earlier model turn; capture a fresh CURRENT image before visual clicking',
        }
      }
      return { ok: true }
    },
    clearInspection(inspectionId) {
      for (const [frameId, record] of frames) {
        if (record.inspectionId === inspectionId) frames.delete(frameId)
      }
    },
  }
}
