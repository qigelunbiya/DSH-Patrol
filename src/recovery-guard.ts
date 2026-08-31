const DIAGNOSTIC_TOOLS = new Set([
  'patrol_navigate',
  'patrol_wait',
  'patrol_snapshot',
  'patrol_read_page',
  'patrol_screenshot',
  'patrol_doctor',
  'patrol_paths',
  'patrol_show',
])

const PROGRESS_TOOLS = new Set([
  'patrol_click',
  'patrol_press',
  'patrol_scroll',
  'patrol_type',
  'patrol_type_credential',
  'patrol_login_state',
  'patrol_detect_auth_challenge',
  'patrol_handoff',
  'patrol_resume',
  'patrol_run',
])

const IGNORED_ARGUMENT_KEYS = new Set([
  'stepName',
  'notes',
  'expectedText',
  'expectationMode',
  'caseSensitive',
  'conditionSourceStepId',
  'conditionExpectedText',
  'conditionMode',
])

const STATE_TTL_MS = 2 * 60_000
const MAX_SAME_EFFECTIVE_ACTIONS = 2
const MAX_DIAGNOSTICS_WITHOUT_PROGRESS = 8
const MAX_DIAGNOSTICS_AFTER_REPEAT = 6

interface RecoveryState {
  touchedAt: number
  diagnostics: number
  repeated: boolean
  fingerprints: Map<string, number>
}

export const PATROL_RECOVERY_PROMPT = `Patrol recovery and loop discipline:
- A failed teaching/browser action is diagnostic evidence, not a reason to repeat the same action indefinitely. Read the concrete error and make at most one materially different recovery attempt.
- Never retry the same navigation in a new tab. Patrol Runbooks are active-tab deterministic; omit newTab or set it false.
- After two attempts with the same effective action/arguments, STOP repeating it. Do not hide repetition by changing stepName/notes or by alternating wait, snapshot, read-page, screenshot, delete-step, and navigate around the same blocker.
- If a private HTTPS target still shows a Chrome certificate interstitial after one navigation, run patrol_doctor at most once and report the managed-browser certificate-handler blocker. The host browser layer owns private certificate continuation; page snapshot/read tools cannot repair a Chrome interstitial.
- When several diagnostic calls produce no real browser progress, stop the teaching attempt and explain the exact failing operation and next concrete fix instead of creating more tabs or duplicate steps.`

export function createPatrolRecoveryGuard() {
  const states = new Map<string, RecoveryState>()

  return (execution: any): string | undefined => {
    const name = String(execution?.name ?? '')
    if (!name.startsWith('patrol_')) return undefined

    const args = isRecord(execution?.arguments) ? execution.arguments : {}
    const inspectionId = typeof args.inspectionId === 'string' && args.inspectionId.trim() !== ''
      ? args.inspectionId.trim()
      : '(no-inspection)'
    const key = inspectionId
    const now = Date.now()
    cleanup(states, now)

    if (name === 'patrol_navigate' && args.newTab === true) {
      return 'Patrol recovery circuit breaker: patrol_navigate must reuse the active tab; newTab=true is not replay-stable. Retry once with newTab omitted/false, not with another tab.'
    }

    if (PROGRESS_TOOLS.has(name)) {
      states.delete(key)
      return undefined
    }

    if (!DIAGNOSTIC_TOOLS.has(name)) return undefined

    let state = states.get(key)
    if (state === undefined || now - state.touchedAt > STATE_TTL_MS) {
      state = { touchedAt: now, diagnostics: 0, repeated: false, fingerprints: new Map() }
      states.set(key, state)
    }
    state.touchedAt = now

    const fingerprint = `${name}:${stableStringify(normalizeArguments(args))}`
    const previous = state.fingerprints.get(fingerprint) ?? 0
    if (previous >= MAX_SAME_EFFECTIVE_ACTIONS) {
      return 'Patrol recovery circuit breaker: this same effective diagnostic/browser action has already been attempted twice for the current inspection. Do not repeat it or rename the step to retry. Stop, preserve the concrete error, and report the blocker or make a genuinely different progress action.'
    }

    state.fingerprints.set(fingerprint, previous + 1)
    if (previous >= 1) state.repeated = true
    state.diagnostics += 1

    const budget = state.repeated ? MAX_DIAGNOSTICS_AFTER_REPEAT : MAX_DIAGNOSTICS_WITHOUT_PROGRESS
    if (state.diagnostics > budget) {
      return 'Patrol recovery circuit breaker: too many diagnostic actions have run without a meaningful browser progress action. Do not continue cycling navigate/wait/snapshot/read-page/screenshot. Run patrol_doctor once if it has not already been used, then stop and report the exact blocker.'
    }
    return undefined
  }
}

function normalizeArguments(value: Record<string, unknown>): unknown {
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) {
    if (IGNORED_ARGUMENT_KEYS.has(key)) continue
    out[key] = normalizeValue(value[key])
  }
  return out
}

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(value).sort()) out[key] = normalizeValue(value[key])
  return out
}

function stableStringify(value: unknown): string {
  try { return JSON.stringify(value) } catch { return String(value) }
}

function cleanup(states: Map<string, RecoveryState>, now: number): void {
  for (const [key, state] of states) {
    if (now - state.touchedAt > STATE_TTL_MS) states.delete(key)
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
