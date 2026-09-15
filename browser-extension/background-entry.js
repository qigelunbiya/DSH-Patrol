// Keep the legacy bridge as the compatibility core, then install atomic
// semantic click immediately so an unrelated optional layer cannot prevent
// this essential command from loading. The row-context hardening then resolves
// duplicate action labels such as RDP/SSH/详情 against the nearest ancestor that
// contains the task's business identity. title-backed-row-action-hardening adds
// a focused MAIN-world path for enterprise action cells rendered as clickable
// spans/divs with title attributes instead of anchors/buttons. The generic title
// row layer broadens that proven click path to arbitrary title-backed row actions
// and business identifiers without replacing the compatibility resolver. The
// layout-correlated layer is the final row-action precision fallback: it handles
// ordinary tables, div grids and fixed/split columns by binding visible identity
// text to the requested action through CURRENT DOM ancestry or screen-row
// alignment, so models do not need to invent :has-text/:contains/nth-child CSS.
// Frame handling and MAIN-world recovery are layered afterwards.
// snapshot-resilient guarantees that semantic target discovery survives
// content-script/frame churn; snapshot-title-action-enrichment adds read-only
// CURRENT evidence for custom title-backed span/div actions so callers do not
// invent anchor selectors for DOM nodes that are not anchors.
// interaction-hardening prefers MAIN-world actionability clicks;
// selector-scope-hardening makes raw legacy CSS top-document-first so identical
// iframe structure cannot create false ambiguity. modal-target-hardening scopes
// ordinary snapshots to a real foreground dialog. The final semantic-intent
// fallback only relaxes an over-specific text locator when the user explicitly
// asked for a Logo and the atomic resolver found no target.
importScripts('background.js')
importScripts('semantic-click.js')
importScripts('semantic-row-context-hardening.js')
importScripts('title-backed-row-action-hardening.js')
importScripts('generic-title-row-action-hardening.js')
importScripts('semantic-layout-row-action.js')
importScripts('frame-registration.js')
importScripts('frame-support.js')
importScripts('frame-resilient.js')
importScripts('snapshot-resilient.js')
importScripts('snapshot-title-action-enrichment.js')
importScripts('interaction-hardening.js')
importScripts('selector-scope-hardening.js')
importScripts('modal-target-hardening.js')
importScripts('semantic-intent-fallback.js')
