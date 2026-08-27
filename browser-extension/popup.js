const stateEl = document.getElementById('state')
const urlEl = document.getElementById('url')
function refresh() {
  chrome.runtime.sendMessage({ type: 'bridge:getStatus' }, status => {
    if (chrome.runtime.lastError || !status) return
    stateEl.textContent = status.connected ? 'Connected to DeepSeek Harness' : `Not connected (${status.state || 'disconnected'})`
    stateEl.className = status.connected ? 'ok' : 'bad'
    urlEl.textContent = status.bridgeUrl || ''
  })
}
document.getElementById('connect').addEventListener('click', () => chrome.runtime.sendMessage({ type: 'bridge:connect' }, () => setTimeout(refresh, 300)))
document.getElementById('options').addEventListener('click', () => chrome.runtime.openOptionsPage())
refresh()
setInterval(refresh, 1500)
