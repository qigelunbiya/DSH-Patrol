// Register the minimal frame-content bridge dynamically. The static Patrol
// content bridge intentionally remains top-frame-only; this separately audited
// script is the only component allowed to run in every document frame.
const FRAME_CONTENT_REGISTRATION_ID = 'dsh-patrol-frame-content-v1'

async function ensureFrameContentRegistration() {
  if (!chrome.scripting?.getRegisteredContentScripts || !chrome.scripting?.registerContentScripts) return
  try {
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: [FRAME_CONTENT_REGISTRATION_ID] })
    if (Array.isArray(existing) && existing.length > 0) return
    await chrome.scripting.registerContentScripts([{
      id: FRAME_CONTENT_REGISTRATION_ID,
      matches: ['<all_urls>'],
      js: ['frame-content.js'],
      runAt: 'document_idle',
      allFrames: true,
      matchOriginAsFallback: true,
      persistAcrossSessions: true,
    }])
  } catch (error) {
    console.warn(`[dsh-patrol/frame-registration] ${error?.message || error}`)
  }
}

chrome.runtime.onInstalled.addListener(() => { void ensureFrameContentRegistration() })
chrome.runtime.onStartup.addListener(() => { void ensureFrameContentRegistration() })
void ensureFrameContentRegistration()
