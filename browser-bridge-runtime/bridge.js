// Derived from dsh-browser-bridge (MIT). See THIRD_PARTY_NOTICES.md.
import { mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PING_INTERVAL_MS = 15000

export class BridgeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'BridgeError'
    this.code = code
  }
}

function defaultScreenshotDir() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return join(home, 'patrol', 'browser-bridge')
}

export class BrowserBridge {
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? 60000
    this.screenshotDir = options.screenshotDir || defaultScreenshotDir()
    this.logger = options.logger ?? null
    this.client = null
    this.clientOrigin = null
    this.extensionInfo = null
    this.pending = new Map()
    this.seq = 0
    this.pingTimer = null
    mkdirSync(this.screenshotDir, { recursive: true, mode: 0o700 })
  }

  get connected() { return this.client !== null }
  get origin() { return this.clientOrigin }

  attach(connection, metadata = {}) {
    if (this.client && this.client !== connection) {
      try { this.client.close(4000, 'replaced by newer Patrol browser connection') } catch {}
    }
    this.client = connection
    this.clientOrigin = typeof metadata.origin === 'string' ? metadata.origin : null
    this.extensionInfo = null
    connection.onMessage(text => this.onMessage(text))
    connection.onClose(() => {
      if (this.client !== connection) return
      this.client = null
      this.clientOrigin = null
      this.extensionInfo = null
      this.failAll(new BridgeError('DISCONNECTED', 'The Patrol browser extension disconnected while a command was in flight.'))
    })
    connection.onError(error => this.logger?.warn?.(`[dsh-patrol/browser-bridge] connection error: ${error?.message ?? error}`))
    this.startPing()
    this.logger?.info?.(`[dsh-patrol/browser-bridge] browser extension connected${this.clientOrigin ? ` from ${this.clientOrigin}` : ''}`)
  }

  request(cmd, args = {}, options = {}) {
    const client = this.client
    if (!client) {
      return Promise.reject(new BridgeError('NOT_CONNECTED', 'Patrol managed browser is not connected. Automatic provisioning should start or repair it; run patrol_doctor and inspect the managed-browser error if it remains unavailable.'))
    }
    const id = `r${++this.seq}`
    return new Promise((resolve, reject) => {
      const timeoutMs = options.timeoutMs ?? this.timeoutMs
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new BridgeError('TIMEOUT', `The browser did not answer ${cmd} within ${Math.round(timeoutMs / 1000)}s.`))
      }, timeoutMs)
      const settle = (fn, value) => {
        clearTimeout(timer)
        this.pending.delete(id)
        fn(value)
      }
      this.pending.set(id, {
        resolve: value => settle(resolve, value),
        reject: error => settle(reject, error),
      })
      if (options.signal) {
        if (options.signal.aborted) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new BridgeError('ABORTED', 'The browser command was aborted.'))
          return
        }
        options.signal.addEventListener('abort', () => {
          const entry = this.pending.get(id)
          if (!entry) return
          clearTimeout(timer)
          this.pending.delete(id)
          reject(new BridgeError('ABORTED', 'The browser command was aborted.'))
        }, { once: true })
      }
      try {
        client.send(JSON.stringify({ type: 'request', id, cmd, args }))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new BridgeError('SEND_FAILED', `Failed to send browser command: ${safeMessage(error)}`))
      }
    })
  }

  saveScreenshot(dataUrl) {
    const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl || ''))
    if (!match) throw new BridgeError('BAD_SCREENSHOT', 'The browser extension returned an invalid screenshot payload.')
    const kind = match[1]
    const base64 = match[2]
    if (!kind || !base64) throw new BridgeError('BAD_SCREENSHOT', 'The browser extension returned an empty screenshot payload.')
    const buffer = Buffer.from(base64, 'base64')
    if (buffer.length > 20 * 1024 * 1024) throw new BridgeError('BAD_SCREENSHOT', 'Screenshot exceeds the 20 MiB Patrol safety limit.')
    const extension = kind === 'jpeg' ? 'jpg' : 'png'
    const file = join(this.screenshotDir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 8)}.${extension}`)
    writeFileSync(file, buffer, { mode: 0o600 })
    return file
  }

  status() {
    return { connected: this.connected, origin: this.clientOrigin, extension: this.extensionInfo, pending: this.pending.size }
  }

  onMessage(text) {
    let message
    try { message = JSON.parse(text) } catch { return }
    if (!message || typeof message !== 'object') return
    if (message.type === 'hello') {
      this.extensionInfo = { name: String(message.name ?? 'unknown'), version: String(message.version ?? '?') }
      this.client?.send(JSON.stringify({ type: 'welcome', protocol: 1, server: 'dsh-patrol-browser-bridge', version: '0.2.0' }))
      return
    }
    if (message.type === 'pong') return
    if (message.type !== 'response' || typeof message.id !== 'string') return
    const entry = this.pending.get(message.id)
    if (!entry) return
    if (message.ok) entry.resolve(message.value ?? {})
    else entry.reject(new BridgeError('EXTENSION', safeMessage(message.error ?? 'browser extension reported an error')))
  }

  startPing() {
    this.stopPing()
    this.pingTimer = setInterval(() => {
      try { this.client?.send(JSON.stringify({ type: 'ping' })) } catch {}
    }, PING_INTERVAL_MS)
    this.pingTimer.unref?.()
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  failAll(error) {
    for (const entry of this.pending.values()) entry.reject(error)
    this.pending.clear()
  }

  dispose() {
    this.stopPing()
    this.failAll(new BridgeError('SHUTDOWN', 'Patrol browser bridge is shutting down.'))
    try { this.client?.close(1001, 'server shutting down') } catch {}
    this.client = null
    this.clientOrigin = null
  }
}

function safeMessage(error) {
  const text = error instanceof Error ? error.message : String(error)
  return text.replace(/(password|passwd|pwd|token|secret|authorization|cookie|otp|captcha)\s*[:=：]\s*\S+/gi, '$1=[REDACTED]')
}
