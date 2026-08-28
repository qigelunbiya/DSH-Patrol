# Adaptive login and runbook editing

DSH Patrol keeps login automation deterministic while allowing a stored login flow to be repaired when a site changes.

## Normal password login

A password field is automated with a Harness credential reference. The runbook stores only a placeholder such as `${credential:IDC_PASSWORD}`; the secret value is resolved only while the browser credential provider performs the input operation.

Typical login sequence:

1. Navigate to the target.
2. Read/snapshot the page to decide whether login is required.
3. Type a public username with `patrol_type_text` when appropriate.
4. Type the password with `patrol_type_credential`.
5. Click the login button.
6. Record `patrol_browser_step` with `action=detect-auth-challenge`.
7. If the detector says `kind=none`, continue with the authenticated patrol.
8. If the detector finds a secondary verification, capture a conditional screenshot and pause at a conditional human checkpoint.

## Secondary verification detection

`browser_detect_auth_challenge` uses only the existing safe browser snapshot and visible-page-text providers. It classifies common verification pages as:

- `none`
- `otp`
- `captcha`
- `slider`
- `approval`
- `unknown`

The detector is intentionally classification-only. It does not execute page JavaScript, OCR or solve CAPTCHA images, synthesize challenge answers, drag sliders, or submit verification responses.

A future-proof runbook can always keep the detector step, even when the site currently has no secondary verification. A checkpoint conditioned on detector output not containing `kind=none` will then activate automatically if the site adds or changes a verification step later.

## Editing an existing READY runbook

Use this flow instead of deleting and recreating the inspection:

1. `patrol_begin_edit <inspectionId>` — moves READY to DRAFT while retaining the schedule. The scheduler skips DRAFT runbooks.
2. Re-teach only changed steps:
   - `patrol_reteach_text` for username/public input changes.
   - `patrol_reteach_credential` for password selector or credential-reference changes.
   - `patrol_reteach_browser_step` for navigation, clicks, waits, counts, challenge detection, reads, screenshots, and similar browser steps.
   - `patrol_reteach_checkpoint` for human checkpoint changes.
   - `patrol_update_inspection` for target URL or high-level metadata changes.
3. Append/move/delete steps when the login flow gained or lost a step.
4. `patrol_validate` — replays the complete DRAFT runbook end-to-end.
5. If validation pauses at a human checkpoint, complete it and call `patrol_resume_validation`.
6. After validation passes, review the result and explicitly confirm it.
7. `patrol_confirm_edit` — returns the validated DRAFT to READY. Any enabled schedule resumes automatically.

Re-teach operations preserve the original stable step ID so conditions from later steps do not need to be rewritten just because a selector, username, credential reference, or browser action changed.

## Password value changes

If the password value changes but the Harness credential reference name remains the same, the runbook itself does not need the secret value. Update that credential in the Harness credential source, call `patrol_begin_edit`, then run `patrol_validate` to verify the complete login and patrol before reconfirming it.

If the password field selector or credential reference name changes, use `patrol_reteach_credential`.
