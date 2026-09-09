// Keep the legacy bridge as the compatibility core, then layer the separately
// audited all-frame DOM bridge on top without broadening the legacy content
// scripts themselves. frame-resilient supplies the MAIN-world recovery path;
// interaction-hardening is loaded last so snapshot scoping, click preference,
// background-focus behavior, and native select handling apply consistently.
importScripts('background.js')
importScripts('frame-registration.js')
importScripts('frame-support.js')
importScripts('frame-resilient.js')
importScripts('interaction-hardening.js')
