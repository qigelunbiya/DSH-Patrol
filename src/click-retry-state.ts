export interface PatrolClickIdentity {
  inspectionId?: unknown
  stepName?: unknown
  locatorText?: unknown
}

export interface PatrolClickOutcomeTracker {
  unverifiedPhysicalClicks(input: PatrolClickIdentity): number
  recordUnverifiedPhysicalClick(input: PatrolClickIdentity): void
  recordVerified(input: PatrolClickIdentity): void
  clearInspection(inspectionId: string): void
}

export function createPatrolClickOutcomeTracker(): PatrolClickOutcomeTracker {
  const attempts = new Map<string, number>()
  return {
    unverifiedPhysicalClicks(input) {
      return attempts.get(clickKey(input)) ?? 0
    },
    recordUnverifiedPhysicalClick(input) {
      const key = clickKey(input)
      attempts.set(key, (attempts.get(key) ?? 0) + 1)
    },
    recordVerified(input) {
      attempts.delete(clickKey(input))
    },
    clearInspection(inspectionId) {
      const prefix = `${normalize(inspectionId)}|`
      for (const key of attempts.keys()) if (key.startsWith(prefix)) attempts.delete(key)
    },
  }
}

function clickKey(input: PatrolClickIdentity): string {
  const inspectionId = clean(input.inspectionId) || 'unknown'
  const business = clean(input.stepName) || clean(input.locatorText) || 'click'
  return `${normalize(inspectionId)}|${normalize(business).replace(/\d{6,}/g, '#').slice(0, 180)}`
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalize(value: string): string {
  return value.replace(/\s+/g, '').toLocaleLowerCase()
}
