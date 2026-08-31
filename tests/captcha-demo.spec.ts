import { describe, expect, it } from 'vitest'
import { isCaptchaDemoOriginAllowed, parseCaptchaDemoOrigins } from '../browser-bridge-runtime/captcha-demo.js'

describe('owned-site captcha demo origin gate', () => {
  it('normalizes configured URLs to exact origins and ignores invalid entries', () => {
    expect([...parseCaptchaDemoOrigins('https://demo.example.test/path; http://127.0.0.1:3000/login junk')]).toEqual([
      'https://demo.example.test',
      'http://127.0.0.1:3000',
    ])
  })

  it('requires an exact scheme, host, and port match', () => {
    const configured = 'https://demo.example.test;http://127.0.0.1:3000'
    expect(isCaptchaDemoOriginAllowed('https://demo.example.test/login', configured)).toBe(true)
    expect(isCaptchaDemoOriginAllowed('http://127.0.0.1:3000/captcha', configured)).toBe(true)
    expect(isCaptchaDemoOriginAllowed('http://demo.example.test', configured)).toBe(false)
    expect(isCaptchaDemoOriginAllowed('https://sub.demo.example.test', configured)).toBe(false)
    expect(isCaptchaDemoOriginAllowed('http://127.0.0.1:3001', configured)).toBe(false)
  })

  it('fails closed when no allowlist is configured', () => {
    expect(parseCaptchaDemoOrigins('')).toEqual(new Set())
    expect(isCaptchaDemoOriginAllowed('https://demo.example.test', '')).toBe(false)
    expect(isCaptchaDemoOriginAllowed('not-a-url', 'https://demo.example.test')).toBe(false)
  })
})
