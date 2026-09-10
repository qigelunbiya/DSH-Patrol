// Keep the legacy bridge as the compatibility core, then layer audited frame
// handling and MAIN-world recovery on top. snapshot-resilient guarantees that
// semantic target discovery survives content-script/frame churn; interaction-
// hardening prefers MAIN-world actionability clicks; selector-scope-hardening
// makes raw legacy CSS top-document-first so identical iframe structure cannot
// create false ambiguity. modal-target-hardening runs last and only takes over
// while a real foreground modal/dialog is visible, keeping background controls
// out of target resolution and replacing brittle nth-of-type modal selectors
// with stable attribute/class paths.
importScripts('background.js')
importScripts('frame-registration.js')
importScripts('frame-support.js')
importScripts('frame-resilient.js')
importScripts('snapshot-resilient.js')
importScripts('interaction-hardening.js')
importScripts('selector-scope-hardening.js')
importScripts('modal-target-hardening.js')
