# Adaptive replay edge hardening

This change closes three replay edge cases without changing the stable CAPTCHA/OCR, TOTP, RDP, batch scheduling, or Runbook mutation contracts.

## Scope

- Add bounded settling after an inserted structural-recovery click so slow SPA/iframe transitions can expose the next known checklist target before replay fails.
- Extend ordinary post-click expectation observation with one additional bounded read window.
- Before an expectation-bearing semantic click mutates the page, inspect the CURRENT snapshot. If the stored selector still exists but now belongs to a different semantic control, use one unique recorded-locator match for this run or fail closed before clicking.
- Surface input placeholder text through the existing snapshot `text` channel in top-frame, frame, and MAIN-world fallback transports so username/account recovery can use placeholder-only cues without changing the snapshot schema.

## Safety constraints

- No automatic second click is attempted merely because a post-click expectation fails.
- Confirmation, submit, save, destructive, ambiguous, authentication, CAPTCHA, OTP, and select boundaries keep their existing fail-closed behavior.
- Structural recovery remains click-only and bounded to the existing missing-task limit.
- Healing remains run-local. Existing flow replay stays non-mutating; no recovered selector or inserted path is persisted to the Runbook automatically.
