/**
 * Patrol-specific image history hardening.
 *
 * Harness' ordinary tool-result pruner only trims text blocks; it intentionally
 * preserves rich image blocks. Patrol therefore uses the Harness image/offload
 * projection when available so older read_image/tool-result images stop being
 * resent to the model while their durable attachment references remain in the
 * session log.
 */

interface SurfaceLike {
  nodes?: readonly number[]
}

interface SessionLike {
  surface?: SurfaceLike
  eventAt?: (seq: number) => unknown
  deriveEventMessage?: (event: unknown) => unknown
  append?: (type: string, data: unknown, options?: unknown) => unknown
}

interface EventLike {
  type?: string
}

interface MessageLike {
  content?: unknown[]
}

interface ImageOccurrence {
  seq: number
  imageIndex: number
}

export interface PatrolImageOffloadResult {
  retainedBefore: number
  retainedAfter: number
  offloaded: number
  applied: boolean
  error?: string
}

export function countRetainedToolResultImages(session: unknown): number {
  return collectRetainedToolResultImages(session).length
}

/**
 * Permanently offload the oldest image occurrences from CURRENT tool-result
 * surface nodes, retaining only the newest `keepLatest` images.
 *
 * This relies on Harness' shipped compaction-image-offload projection. If the
 * projection is not mounted, append() rejects and Patrol fails open without
 * corrupting the session.
 */
export function offloadHistoricalToolResultImages(
  session: unknown,
  keepLatest = 1,
): PatrolImageOffloadResult {
  const retained = collectRetainedToolResultImages(session)
  const safeKeep = Number.isInteger(keepLatest) && keepLatest >= 0 ? keepLatest : 1
  if (retained.length <= safeKeep) {
    return {
      retainedBefore: retained.length,
      retainedAfter: retained.length,
      offloaded: 0,
      applied: false,
    }
  }

  const targetOccurrences = retained.slice(0, retained.length - safeKeep)
  const bySeq = new Map<number, number[]>()
  for (const item of targetOccurrences) {
    const indexes = bySeq.get(item.seq) ?? []
    indexes.push(item.imageIndex)
    bySeq.set(item.seq, indexes)
  }
  const targets = [...bySeq.entries()].map(([seq, imageIndexes]) => ({ seq, imageIndexes }))

  const typed = asSessionLike(session)
  if (typed?.append === undefined) {
    return {
      retainedBefore: retained.length,
      retainedAfter: retained.length,
      offloaded: 0,
      applied: false,
      error: 'session.append is unavailable; Harness image/offload projection cannot be used',
    }
  }

  try {
    typed.append('image/offload', { targets })
    const after = countRetainedToolResultImages(session)
    return {
      retainedBefore: retained.length,
      retainedAfter: after,
      offloaded: targetOccurrences.length,
      applied: true,
    }
  } catch (error: unknown) {
    return {
      retainedBefore: retained.length,
      retainedAfter: retained.length,
      offloaded: 0,
      applied: false,
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

function collectRetainedToolResultImages(session: unknown): ImageOccurrence[] {
  const typed = asSessionLike(session)
  const nodes = Array.isArray(typed?.surface?.nodes) ? typed.surface.nodes : []
  if (typed?.eventAt === undefined || typed?.deriveEventMessage === undefined || nodes.length === 0) return []

  const out: ImageOccurrence[] = []
  for (const seq of nodes) {
    if (!Number.isSafeInteger(seq) || seq < 0) continue
    let event: unknown
    try {
      event = typed.eventAt(seq)
    } catch {
      continue
    }
    if (!isRecord(event) || String((event as EventLike).type ?? '') !== 'tool/result') continue

    let message: unknown
    try {
      message = typed.deriveEventMessage(event)
    } catch {
      continue
    }
    if (!isRecord(message) || !Array.isArray((message as MessageLike).content)) continue

    let imageIndex = 0
    const visit = (blocks: readonly unknown[]): void => {
      for (const raw of blocks) {
        if (!isRecord(raw)) continue
        const type = typeof raw.type === 'string' ? raw.type : ''
        if (type === 'image') {
          if (raw.offloaded !== true) out.push({ seq, imageIndex })
          imageIndex += 1
          continue
        }
        if (type === 'tool-result' && Array.isArray(raw.content)) visit(raw.content)
      }
    }
    visit((message as MessageLike).content ?? [])
  }
  return out
}

function asSessionLike(value: unknown): SessionLike | undefined {
  if (!isRecord(value)) return undefined
  return value as SessionLike
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
