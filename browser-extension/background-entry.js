// Keep the legacy bridge as the compatibility core, then layer audited frame
// handling and MAIN-world recovery on top. snapshot-resilient guarantees that
// semantic target discovery survives content-script/frame churn; interaction-
// hardening prefers MAIN-world actionability clicks; selector-scope-hardening
// finally makes raw legacy CSS top-document-first so identical iframe structure
// cannot create false ambiguity.
importScripts('background.js')
importScripts('frame-registration.js')
importScripts('frame-support.js')
importScripts('frame-resilient.js')
importScripts('snapshot-resilient.js')
importScripts('interaction-hardening.js')
importScripts('selector-scope-hardening.js')
