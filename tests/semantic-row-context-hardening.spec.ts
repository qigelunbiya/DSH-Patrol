import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('semantic row-context hardening', () => {
  it('loads immediately after atomic semantic click and parses as JavaScript', () => {
    const entry = readFileSync(join(root, 'browser-extension', 'background-entry.js'), 'utf8')
    const source = readFileSync(join(root, 'browser-extension', 'semantic-row-context-hardening.js'), 'utf8')
    expect(entry).toContain("importScripts('semantic-row-context-hardening.js')")
    expect(entry.indexOf("importScripts('semantic-row-context-hardening.js')")).toBeGreaterThan(entry.indexOf("importScripts('semantic-click.js')"))
    expect(entry.indexOf("importScripts('semantic-row-context-hardening.js')")).toBeLessThan(entry.indexOf("importScripts('frame-registration.js')"))
    expect(() => new Function(source)).not.toThrow()
  })

  it('requires both business identity and row action before taking over semanticClick', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-row-context-hardening.js'), 'utf8')
    expect(source).toMatch(/identityTokens/)
    expect(source).toMatch(/actionTokens/)
    expect(source).toMatch(/RDP\|SSH\|VNC\|SFTP\|FTP/)
    expect(source).toContain('identities.every')
  })

  it('prefers the nearest small row context rather than the outer table containing every duplicate action', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-row-context-hardening.js'), 'utf8')
    expect(source).toContain('depth * 45')
    expect(source).toContain('contextLengthPenalty')
    expect(source).toContain('rowLikeBonus')
    expect(source).toContain('atomic-main-world-row-context-click')
  })
})
