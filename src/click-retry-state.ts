export interface PatrolClickIdentity {
  inspectionId?: unknown
  stepName?: unknown
  locatorText?: unknown
}

export interface PatrolClickOutcomeTracker {
  unverifiedPhysicalClicks(input: PatrolClickIdentity): number
  visualPhysicalClicks(input: PatrolClickIdentity): number
  visualFallbackAuthorized(input: PatrolClickIdentity): boolean
  setVisualFallbackAuthorization(input: PatrolClickIdentity, allowed: boolean): void
  recordUnverifiedPhysicalClick(input: PatrolClickIdentity): void
  recordVisualPhysicalClick(input: PatrolClickIdentity): void
  recordVerified(input: PatrolClickIdentity): void
  clearInspection(inspectionId: string): void
}

export function createPatrolClickOutcomeTracker(): PatrolClickOutcomeTracker {
  const attempts = new Map<string, number>()
  const visualPhysicalAttempts = new Map<string, number>()
  const visualFallbackKeys = new Set<string>()
  return {
    unverifiedPhysicalClicks(input) {
      return attempts.get(clickKey(input)) ?? 0
    },
    visualPhysicalClicks(input) {
      return visualPhysicalAttempts.get(clickKey(input)) ?? 0
    },
    visualFallbackAuthorized(input) {
      return visualFallbackKeys.has(clickKey(input))
    },
    setVisualFallbackAuthorization(input, allowed) {
      const key = clickKey(input)
      if (allowed) visualFallbackKeys.add(key)
      else visualFallbackKeys.delete(key)
    },
    recordUnverifiedPhysicalClick(input) {
      const key = clickKey(input)
      attempts.set(key, (attempts.get(key) ?? 0) + 1)
    },
    recordVisualPhysicalClick(input) {
      const key = clickKey(input)
      visualPhysicalAttempts.set(key, (visualPhysicalAttempts.get(key) ?? 0) + 1)
    },
    recordVerified(input) {
      const key = clickKey(input)
      attempts.delete(key)
      visualFallbackKeys.delete(key)
    },
    clearInspection(inspectionId) {
      const normalizedInspection = normalize(inspectionId)
      const prefix = `${normalizedInspection}|`
      for (const key of attempts.keys()) if (key.startsWith(prefix)) attempts.delete(key)
      for (const key of visualPhysicalAttempts.keys()) if (key.startsWith(prefix)) visualPhysicalAttempts.delete(key)
      for (const key of visualFallbackKeys) if (key.startsWith(prefix)) visualFallbackKeys.delete(key)
    },
  }
}

function inspectionKey(input: PatrolClickIdentity): string {
  return normalize(clean(input.inspectionId) || 'unknown')
}

function clickKey(input: PatrolClickIdentity): string {
  const inspectionId = clean(input.inspectionId) || 'unknown'
  const business = normalizeBusiness(clean(input.stepName) || clean(input.locatorText) || 'click')
  return `${normalize(inspectionId)}|${business.replace(/\d{6,}/g, '#').slice(0, 180)}`
}

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeBusiness(value: string): string {
  return normalize(value)
    .replace(/^(?:请)?(?:点击|打开|选择|进入|查看|访问|尝试)+/g, '')
    .replace(/[（(](?:视觉后备|视觉fallback|fallback|恢复|重试)[）)]$/gi, '')
    .replace(/(?:视觉后备|视觉fallback|fallback|恢复|重试)$/gi, '')
}

function normalize(value: string): string {
  return value.replace(/\s+/g, '').toLocaleLowerCase()
}
