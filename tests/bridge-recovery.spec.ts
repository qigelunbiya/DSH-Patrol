import { describe, expect, it } from 'vitest'
import { BrowserBridge } from '../browser-bridge-runtime/bridge.js'

describe('BrowserBridge recovery reset', () => {
  it('drops a stale client and rejects in-flight work so the managed extension can reconnect', async () => {
    let closeArgs: any[] | undefined
    const connection: any = {
      onMessage() {},
      onClose() {},
      onError() {},
      send() {},
      close(...args: any[]) { closeArgs = args },
    }
    const bridge = new BrowserBridge({ timeoutMs: 60_000, logger: { info() {}, warn() {} } })
    bridge.attach(connection, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })
    expect(bridge.connected).toBe(true)

    const pending = bridge.request('snapshot')
    expect(bridge.resetConnection('synthetic stale transport')).toBe(true)

    await expect(pending).rejects.toMatchObject({ code: 'DISCONNECTED' })
    expect(bridge.connected).toBe(false)
    expect(bridge.status().pending).toBe(0)
    expect(closeArgs).toEqual([4001, 'synthetic stale transport'])
  })
})
