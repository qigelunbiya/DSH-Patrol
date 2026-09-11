// Keep the legacy bridge as the compatibility core, then install atomic
// semantic click immediately so an unrelated optional layer cannot prevent
// this essential command from loading. Frame handling and MAIN-world recovery
// are layered afterwards. snapshot-resilient guarantees that
// semantic target discovery survives content-script/frame churn; interaction-
// hardening prefers MAIN-world actionability clicks; selector-scope-hardening
// makes raw legacy CSS top-document-first so identical iframe structure cannot
// create false ambiguity. modal-target-hardening scopes ordinary snapshots to a
// real foreground dialog. Interaction hardening delegates non-legacy commands
// through the semantic wrapper, so its later load remains compatible. The final
// semantic-intent fallback only relaxes an over-specific text locator when the
// user explicitly asked for a Logo and the atomic resolver found no target.
importScripts('background.js')
importScripts('semantic-click.js')
importScripts('frame-registration.js')
importScripts('frame-support.js')
importScripts('frame-resilient.js')
importScripts('snapshot-resilient.js')
importScripts('interaction-hardening.js')
importScripts('selector-scope-hardening.js')
importScripts('modal-target-hardening.js')
importScripts('semantic-intent-fallback.js')
