// Keep the legacy bridge as the compatibility core, then layer the separately
// audited all-frame DOM bridge on top without broadening the legacy content
// scripts themselves. The final resilient layer only runs when the ordinary
// content/frame bridge cannot execute a DOM command; it uses MAIN-world
// chrome.scripting with the same strict unique-target semantics.
importScripts('background.js')
importScripts('frame-registration.js')
importScripts('frame-support.js')
importScripts('frame-resilient.js')
