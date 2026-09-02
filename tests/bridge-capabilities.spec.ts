// @ts-nocheck
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BrowserBridge } from '../browser-bridge-runtime/bridge.js'

function fakeConnection() {
  let messageListener
  let closeListener
  return {
    sent: [],
    onMessage(listener) { messageListener = listener },
    onClose(listener) { closeListener = listener },
    onError() {},
    send(text) { this.sent.push(JSON.parse(text)) },
    close() { closeListener?.() },
    fireMessage(value) { messageListener?.(JSON.stringify(value)) },
  }
}

describe('browser extension capability handshake', () => {
  it('keeps the live manifest version and a normalized capability set in bridge status', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-capabilities-'))
    try {
      const bridge = new BrowserBridge({ screenshotDir: join(root, 'shots') })
      const connection = fakeConnection()
      bridge.attach(connection, { origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' })

      connection.fireMessage({
        type: 'hello',
        name: 'dsh-patrol-browser-extension',
        version: '0.2.1',
        capabilities: ['visualSnapshot', 'captureImageCode', 'captureImageCode', '', 123],
      })

      expect(bridge.status().extension).toEqual({
        name: 'dsh-patrol-browser-extension',
        version: '0.2.1',
        capabilities: ['captureImageCode', 'visualSnapshot'],
      })
      expect(connection.sent).toContainEqual(expect.objectContaining({
        type: 'welcome',
        protocol: 1,
        server: 'dsh-patrol-browser-bridge',
      }))
      bridge.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('stays compatible with older extensions that do not advertise capabilities', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-capabilities-'))
    try {
      const bridge = new BrowserBridge({ screenshotDir: join(root, 'shots') })
      const connection = fakeConnection()
      bridge.attach(connection)
      connection.fireMessage({ type: 'hello', name: 'legacy-extension', version: '0.2.0' })

      expect(bridge.status().extension).toEqual({ name: 'legacy-extension', version: '0.2.0' })
      bridge.dispose()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
