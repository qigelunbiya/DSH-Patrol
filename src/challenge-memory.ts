import type { ChallengeProfile, ChallengeStrategy, InspectionDefinition, JsonValue } from './types.js'

const CHALLENGE_KINDS = new Set(['otp', 'captcha', 'slider', 'approval', 'unknown'])
const CHALLENGE_SUBTYPES = new Set([
  'otp',
  'image-code',
  'click-sequence',
  'third-party',
  'generic-captcha',
  'slider',
  'slider-puzzle',
  'rotate',
  'approval',
  'unknown',
])
const CHALLENGE_STRATEGIES = new Set<ChallengeStrategy>([
  'windows-system-ocr',
  'manual-click-sequence',
  'manual-slider',
  'manual-third-party',
  'manual-otp',
  'manual-approval',
  'manual-review',
])
const MAX_PROFILES = 8

export interface ChallengeObservation {
  kind: ChallengeProfile['kind']
  subtype: ChallengeProfile['subtype']
  strategy: ChallengeStrategy
  autoCompleted: boolean
}

export function challengeObservationFromValue(value: JsonValue | undefined): ChallengeObservation | undefined {
  if (value === undefined || value === null || Array.isArray(value) || typeof value !== 'object') return undefined
  // browser_detect_auth_challenge reports both the final state and the initially
  // observed state. An image code can disappear after local OCR succeeds, so
  // learned Runbook metadata must remember the observed family, not only the
  // final kind=none result.
  const kind = typeof value.observedKind === 'string'
    ? value.observedKind
    : typeof value.kind === 'string' ? value.kind : undefined
  const subtype = typeof value.observedSubtype === 'string'
    ? value.observedSubtype
    : typeof value.subtype === 'string' ? value.subtype : undefined
  if (kind === undefined || subtype === undefined || kind === 'none') return undefined
  if (!CHALLENGE_KINDS.has(kind) || !CHALLENGE_SUBTYPES.has(subtype)) return undefined

  const rawStrategy = typeof value.strategy === 'string' ? value.strategy : undefined
  const strategy = rawStrategy !== undefined && CHALLENGE_STRATEGIES.has(rawStrategy as ChallengeStrategy)
    ? rawStrategy as ChallengeStrategy
    : defaultChallengeStrategy(kind, subtype)

  return {
    kind: kind as ChallengeProfile['kind'],
    subtype: subtype as ChallengeProfile['subtype'],
    strategy,
    autoCompleted: value.autoFilled === true && value.hasChallenge === false,
  }
}

export function rememberChallengeObservation(
  definition: InspectionDefinition,
  value: JsonValue | undefined,
  observedAt = new Date().toISOString(),
): boolean {
  const observation = challengeObservationFromValue(value)
  if (observation === undefined) return false

  const profiles = [...(definition.auth.challengeProfiles ?? [])]
  const index = profiles.findIndex(profile => profile.kind === observation.kind && profile.subtype === observation.subtype)
  if (index >= 0) {
    const previous = profiles[index] as ChallengeProfile
    profiles[index] = {
      ...previous,
      strategy: observation.strategy,
      lastObservedAt: observedAt,
      occurrences: previous.occurrences + 1,
      autoCompletedOccurrences: previous.autoCompletedOccurrences + (observation.autoCompleted ? 1 : 0),
    }
  } else {
    profiles.push({
      kind: observation.kind,
      subtype: observation.subtype,
      strategy: observation.strategy,
      firstObservedAt: observedAt,
      lastObservedAt: observedAt,
      occurrences: 1,
      autoCompletedOccurrences: observation.autoCompleted ? 1 : 0,
    })
  }

  profiles.sort((a, b) => b.lastObservedAt.localeCompare(a.lastObservedAt))
  definition.auth.challengeProfiles = profiles.slice(0, MAX_PROFILES)
  return true
}

export function defaultChallengeStrategy(kind: string, subtype: string): ChallengeStrategy {
  if (kind === 'captcha' && subtype === 'image-code') return 'windows-system-ocr'
  if (kind === 'captcha' && subtype === 'click-sequence') return 'manual-click-sequence'
  if (kind === 'captcha' && subtype === 'third-party') return 'manual-third-party'
  if (kind === 'slider') return 'manual-slider'
  if (kind === 'otp') return 'manual-otp'
  if (kind === 'approval') return 'manual-approval'
  return 'manual-review'
}
