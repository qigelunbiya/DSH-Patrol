// Keep the legacy bridge as the compatibility core, then layer the separately
// audited all-frame DOM bridge on top without broadening the legacy content
// scripts themselves.
importScripts('background.js')
importScripts('frame-registration.js')
importScripts('frame-support.js')
