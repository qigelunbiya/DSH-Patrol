# Adaptive replay edge hardening follow-up

This follow-up records the final compile-safety correction after the adaptive replay edge-hardening merge.

- Keep the merged slow-SPA settle, semantic pre-click validation, extended post-click observation, and placeholder-aware snapshot behavior unchanged.
- Narrow snapshot JSON elements to `JsonObject` before reading the `selector` field so strict TypeScript builds on Linux and Windows accept the runtime-safe guard.
- No replay semantics, Runbook persistence, CAPTCHA/OCR, TOTP, RDP, batch scheduling, or browser behavior changes are introduced by this follow-up.
