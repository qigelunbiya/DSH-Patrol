// @ts-nocheck
import { describe, expect, it } from 'vitest'
import {
  certificateActionForUrl,
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

  it('installs a browser-level Security handler before page DOM access is needed', async () => {
    const listeners = new Map()
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
      on() {},
    }

    await expect(installPrivateCertificateErrorHandler(browser, { info() {}, warn() {} })).resolves.toBe(true)
    expect(sends[0]).toEqual({ method: 'Security.setOverrideCertificateErrors', params: { override: true } })

    listeners.get('Security.certificateError')?.({ eventId: 7, url: 'https://10.192.1.125/login' })
    await Promise.resolve()
    await Promise.resolve()
    expect(sends).toContainEqual({
      method: 'Security.handleCertificateError',
      params: { eventId: 7, action: 'continue' },
    })

    listeners.get('Security.certificateError')?.({ eventId: 8, url: 'https://example.com/' })
    await Promise.resolve()
    await Promise.resolve()
    expect(sends).toContainEqual({
      method: 'Security.handleCertificateError',
      params: { eventId: 8, action: 'cancel' },
    })
  })

  it('falls back cleanly when a Chromium build exposes no browser CDP session', async () => {
    await expect(installPrivateCertificateErrorHandler({ on() {} }, { info() {}, warn() {} })).resolves.toBe(false)
  })
})
