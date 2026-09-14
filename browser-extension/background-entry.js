// Keep the legacy bridge as the compatibility core, then install atomic
// semantic click immediately so an unrelated optional layer cannot prevent
// this essential command from loading. The row-context hardening then resolves
// duplicate action labels such as RDP/SSH/详情 against the nearest ancestor that
// contains the task's business identity. Frame handling and MAIN-world recovery
// are layered afterwards. snapshot-resilient guarantees that semantic target
// discovery survives content-script/frame churn; snapshot-title-action-enrichment
// adds read-only CURRENT evidence for custom title-backed span/div actions so
// callers do not invent anchor selectors for DOM nodes that are not anchors.
// interaction-hardening prefers MAIN-world actionability clicks;
// selector-scope-hardening makes raw legacy CSS top-document-first so identical
// iframe structure cannot create false ambiguity. modal-target-hardening scopes
// ordinary snapshots to a real foreground dialog. The final semantic-intent
// fallback only relaxes an over-specific text locator when the user explicitly
// asked for a Logo and the atomic resolver found no target.
importScripts('background.js')
importScripts('semantic-click.js')
importScripts('semantic-row-context-hardening.js')
importScripts('frame-registration.js')
importScripts('frame-support.js')
importScripts('frame-resilient.js')
importScripts('snapshot-resilient.js')
importScripts('snapshot-title-action-enrichment.js')
importScripts('interaction-hardening.js')
importScripts('selector-scope-hardening.js')
importScripts('modal-target-hardening.js')
importScripts('semantic-intent-fallback.js')
