// @ts-nocheck
import { describe, expect, it } from 'vitest'
import {
  certificateActionForUrl,
  certificateErrorRequestUrl,
  installPrivateCertificateErrorHandler,
} from '../browser-bridge-runtime/private-cert.js'

describe('private certificate browser policy', () => {
  it('continues only private/local certificate errors', () => {
    expect(certificateActionForUrl('https://10.192.1.125/u-s-m-ADBBAF-v8/login')).toBe('continue')
    expect(certificateActionForUrl('https://172.20.10.5/')).toBe('continue')
    expect(certificateActionForUrl('https://192.168.1.20/')).toBe('continue')
    expect(certificateActionForUrl('https://localhost:8443/')).toBe('continue')
    expect(certificateActionForUrl('https://example.com/')).toBe('cancel')
    expect(certificateActionForUrl('https://8.8.8.8/')).toBe('cancel')
  })

  it('reads the actual Security.certificateError requestURL field', () => {
    expect(certificateErrorRequestUrl({ requestURL: 'https://10.192.1.125/login' })).toBe('https://10.192.1.125/login')
    expect(certificateErrorRequestUrl({ url: 'https://legacy.example/' })).toBe('https://legacy.example/')
    expect(certificateErrorRequestUrl({})).toBe('')
  })

  it('installs a browser-level Security handler before page DOM access is needed', async () => {
    const listeners = new Map()
    const browserListeners = new Map()
    const sends = []
    const session = {
      async send(method, params) {
        sends.push({ method, params })
      },
      on(name, handler) { listeners.set(name, handler) },
      off() {},
      async detach() {},
    }
    const browser = {
      async createBrowserCDPSession() { return session },
      on(name, handler) { browserListeners.set(name, handler) },
    }

    await expect(installPrivateCertificateErrorHandler(browser, { info() {}, warn() {} })).resolves.toBe(true)
    expect(sends).toContainEqual({ method: 'Security.enable', params: undefined })
    expect(sends).toContainEqual({ method: 'Security.setOverrideCertificateErrors', params: { override: true } })

    // This is the real CDP event shape. The URL property is named requestURL,
    // not url. A regression here would cancel the private request and leave
    // Chrome on NET::ERR_CERT_AUTHORITY_INVALID.
    listeners.get('Security.certificateError')?.({ eventId: 7, requestURL: 'https://10.192.1.125/login' })
    await Promise.resolve()
    await Promise.resolve()
    expect(sends).toContainEqual({
      method: 'Security.handleCertificateError',
      params: { eventId: 7, action: 'continue' },
    })

    listeners.get('Security.certificateError')?.({ eventId: 8, requestURL: 'https://example.com/' })
    await Promise.resolve()
    await Promise.resolve()
    expect(sends).toContainEqual({
      method: 'Security.handleCertificateError',
      params: { eventId: 8, action: 'cancel' },
    })

    browserListeners.get('disconnected')?.()
    await Promise.resolve()
  })

  it('swallows Puppeteer already-detached rejection during browser shutdown', async () => {
    const browserListeners = new Map()
    const warnings = []
    const session = {
      async send() {},
      on() {},
      off() {},
      detach() { return Promise.reject(new Error('Session already detached. Most likely the browser has been closed.')) },
    }
    const browser = {
      async createBrowserCDPSession() { return session },
      on(name, handler) { browserListeners.set(name, handler) },
    }

    await installPrivateCertificateErrorHandler(browser, { info() {}, warn(message) { warnings.push(message) } })
    browserListeners.get('disconnected')?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(warnings).toEqual([])
  })

  it('falls back cleanly when a Chromium build exposes no browser CDP session', async () => {
    await expect(installPrivateCertificateErrorHandler({ on() {} }, { info() {}, warn() {} })).resolves.toBe(false)
  })
})
