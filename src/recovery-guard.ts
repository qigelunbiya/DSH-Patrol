const DIAGNOSTIC_TOOLS = new Set([
  'patrol_navigate',
  'patrol_wait',
  'patrol_snapshot',
  'patrol_read_page',
  'patrol_screenshot',
  'patrol_doctor',
  'patrol_paths',
  'patrol_show',
  // Challenge detection is only "progress" after it actually succeeds. Guards
  // run before execution and cannot know that outcome, so treating detector as
  // progress here allowed every failed image-code attempt to reset the breaker.
  'patrol_detect_auth_challenge',
])

const PROGRESS_TOOLS = new Set([
  'patrol_click',
  'patrol_press',
  'patrol_scroll',
  'patrol_type',
  'patrol_type_text',
  'patrol_type_credential',
  'patrol_type_transient',
  'patrol_reteach_text',
  'patrol_reteach_credential',
  'patrol_reteach_transient',
  'patrol_reteach_browser_step',
  'patrol_reteach_checkpoint',
  'patrol_login_state',
  'patrol_handoff',
  'patrol_resume',
  'patrol_resume_validation',
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

const CAPTCHA_HINT = /(captcha|图形验证码|图片验证码|字符验证码|验证码图片|图形码|校验码|\b验证码\b)/i
const HUMAN_ONLY_HINT = /(otp|one[- ]?time|动态码|动态验证码|一次性|短信|手机验证码|邮箱验证码|二次验证|passkey|security key|扫码|二维码|确认登录|设备.{0,12}确认|recaptcha|hcaptcha|turnstile|arkose|funcaptcha)/i

const STATE_TTL_MS = 2 * 60_000
const MAX_SAME_EFFECTIVE_ACTIONS = 2
const MAX_DIAGNOSTICS_WITHOUT_PROGRESS = 8
const MAX_DIAGNOSTICS_AFTER_REPEAT = 6
const MAX_STEP_DELETIONS_PER_RECOVERY = 1

interface RecoveryState {
  touchedAt: number
  diagnostics: number
  repeated: boolean
  doctorUsed: boolean
  stepDeletions: number
  fingerprints: Map<string, number>
}

export const PATROL_RECOVERY_PROMPT = `Patrol recovery and loop discipline:
- A failed teaching/browser action is diagnostic evidence, not a reason to repeat the same action indefinitely. Read the concrete error and make at most one materially different recovery attempt.
- patrol_detect_auth_challenge is part of the diagnostic budget until a following real browser action makes progress. In one stalled phase, do not call the same detector twice. This still permits the normal two-stage login flow because a successful image-code detector is followed by the recorded Login click, which starts a fresh phase before a later OTP detector.
- Never retry the same navigation in a new tab. Patrol Runbooks are active-tab deterministic; omit newTab or set it false.
- After two attempts with the same effective action/arguments, STOP repeating it. Do not hide repetition by changing stepName/notes or by alternating wait, snapshot, read-page, screenshot, delete-step, and navigate around the same blocker.
- A manual captcha typing/captcha-refresh attempt is NOT progress and must not reset the recovery budget. The verification guard separately rejects those operations.
- During one stalled recovery, deleting more than one Runbook step is blocked. Use patrol_last_failure and re-teach the stable failed step instead of dismantling previously successful steps.
- If a transient password step expired after restart, re-teach only that stable step with patrol_reteach_transient.
- If a private HTTPS target still shows a Chrome certificate interstitial after one navigation, patrol_doctor is allowed exactly once even after the diagnostic budget trips. After that doctor result, stop and report the managed-browser certificate-handler blocker; page snapshot/read tools cannot repair a Chrome interstitial.
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

    let state = states.get(key)
    if (state === undefined || now - state.touchedAt > STATE_TTL_MS) {
      state = { touchedAt: now, diagnostics: 0, repeated: false, doctorUsed: false, stepDeletions: 0, fingerprints: new Map() }
      states.set(key, state)
    }
    state.touchedAt = now

    if (name === 'patrol_delete_step') {
      if (state.stepDeletions >= MAX_STEP_DELETIONS_PER_RECOVERY) {
        return 'Patrol recovery circuit breaker: one Runbook step has already been deleted during this stalled recovery. Do not delete more previously successful steps. Call patrol_last_failure and repair/re-teach that stable failed step instead.'
      }
      state.stepDeletions += 1
      return undefined
    }

    if (PROGRESS_TOOLS.has(name)) {
      // Do not let a forbidden captcha guess/refresh clear the stalled state
      // before the verification guard gets a chance to reject it.
      if (looksLikeManualImageCodeAction(name, args)) return undefined
      states.delete(key)
      return undefined
    }

    if (!DIAGNOSTIC_TOOLS.has(name)) return undefined

    // The breaker itself tells the model to run patrol_doctor once for a final
    // managed-browser diagnosis. Do not immediately block that exact recovery
    // action with the same diagnostic budget that produced the instruction.
    if (name === 'patrol_doctor') {
      if (state.doctorUsed) {
        return 'Patrol recovery circuit breaker: patrol_doctor has already been used once for this stalled inspection. Stop diagnostics and report the exact blocker instead of running doctor or browser probes again.'
      }
      state.doctorUsed = true
      return undefined
    }

    const fingerprint = `${name}:${stableStringify(normalizeArguments(args))}`
    const previous = state.fingerprints.get(fingerprint) ?? 0

    // A detector failure is terminal for the current stalled phase. One later
    // detector remains valid after a real Login/Submit click because that click
    // clears this state and starts a new phase (e.g. the post-login OTP stage).
    if (name === 'patrol_detect_auth_challenge' && previous >= 1) {
      return 'Patrol recovery circuit breaker: patrol_detect_auth_challenge has already run once in this stalled phase. Do not retry the same image-code detector or surround it with screenshot/snapshot/navigate loops. Preserve the first concrete automation error and stop this attempt. A later OTP detector is allowed only after a real Login/Submit action makes progress.'
    }

    if (previous >= MAX_SAME_EFFECTIVE_ACTIONS) {
      return 'Patrol recovery circuit breaker: this same effective diagnostic/browser action has already been attempted twice for the current inspection. Do not repeat it or rename the step to retry. Stop, preserve the concrete error, and report the blocker or make a genuinely different progress action.'
    }

    state.fingerprints.set(fingerprint, previous + 1)
    if (previous >= 1) state.repeated = true
    state.diagnostics += 1

    const budget = state.repeated ? MAX_DIAGNOSTICS_AFTER_REPEAT : MAX_DIAGNOSTICS_WITHOUT_PROGRESS
    if (state.diagnostics > budget) {
      if (state.doctorUsed) {
        return 'Patrol recovery circuit breaker: too many diagnostic actions have run without meaningful browser progress, and patrol_doctor has already been used. Stop now and report the exact blocker; do not continue navigate/wait/snapshot/read-page/screenshot cycles.'
      }
      return 'Patrol recovery circuit breaker: too many diagnostic actions have run without a meaningful browser progress action. Do not continue cycling navigate/wait/snapshot/read-page/screenshot. Run patrol_doctor once, then stop and report the exact blocker.'
    }
    return undefined
  }
}

function looksLikeManualImageCodeAction(name: string, args: Record<string, any>): boolean {
  if (!['patrol_click', 'patrol_press', 'patrol_type', 'patrol_type_text', 'patrol_type_credential', 'patrol_type_transient', 'patrol_reteach_text', 'patrol_reteach_credential', 'patrol_reteach_transient'].includes(name)) {
    return false
  }
  const descriptor = [args.stepName, args.selector, args.notes, args.prompt, args.reason, args.locatorText]
    .filter(value => typeof value === 'string')
    .join(' ')
  return CAPTCHA_HINT.test(descriptor) && !HUMAN_ONLY_HINT.test(descriptor)
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
