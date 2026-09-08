// Keep the legacy bridge as the compatibility core, then layer frame-aware DOM
// routing on top. Classic service-worker scripts share the same worker global,
// so frame-support.js can replace only sendDomCommand without duplicating the
// WebSocket, screenshot, CAPTCHA, or managed-browser logic.
importScripts('background.js')
importScripts('frame-support.js')
