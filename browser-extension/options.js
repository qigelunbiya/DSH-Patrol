const DEFAULTS = { bridgeUrl: 'ws://127.0.0.1:3080/patrol-browser-bridge', autoConnect: true }
const urlEl = document.getElementById('bridgeUrl')
const autoEl = document.getElementById('autoConnect')
const msgEl = document.getElementById('msg')
async function load() {
  const stored = await chrome.storage.local.get(DEFAULTS)
  urlEl.value = stored.bridgeUrl || DEFAULTS.bridgeUrl
  autoEl.checked = stored.autoConnect !== false
}
document.getElementById('save').addEventListener('click', async () => {
  const bridgeUrl = urlEl.value.trim()
  if (!/^ws:\/\/(127\.0\.0\.1|localhost):\d+\/[-A-Za-z0-9_/]+$/.test(bridgeUrl)) {
    msgEl.textContent = 'Only local ws://127.0.0.1 or ws://localhost bridge URLs are accepted.'
    return
  }
  await chrome.storage.local.set({ bridgeUrl, autoConnect: autoEl.checked })
  msgEl.textContent = 'Saved.'
})
document.getElementById('test').addEventListener('click', async () => {
  try {
    const url = urlEl.value.trim().replace(/^ws:/, 'http:') + '/info'
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const info = await response.json()
    msgEl.textContent = `Server reachable. connected=${String(info.connected)}`
  } catch (error) {
    msgEl.textContent = `Test failed: ${error.message || error}`
  }
})
load()
