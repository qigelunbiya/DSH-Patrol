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
    expect(source).toContain('semanticRowContextSource')
    expect(source).toContain('identities.every')
  })

  it('correlates fixed or split action columns back to the identity row', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-row-context-hardening.js'), 'utf8')
    expect(source).toContain('data-row-key')
    expect(source).toContain('aria-rowindex')
    expect(source).toContain('rowOrdinal')
    expect(source).toContain('parallel-row-ordinal')
    expect(source).toContain('parallel-row-top')
    expect(source).toContain('correlateLogicalRow')
  })

  it('marks row-context selectors unsafe for direct replay and prefers trusted native input', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-row-context-hardening.js'), 'utf8')
    expect(source).toContain('replaySelectorSafe: false')
    expect(source).toContain('semanticTrustedMouseClick')
    expect(source).toContain("args: ['measure', spec]")
    expect(source).toContain('atomic-row-context+trusted-native-mouse')
  })

  it('prefers a real actionable target and still reports the row-context transport', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-row-context-hardening.js'), 'utf8')
    expect(source).toContain('nativeActionBonus')
    expect(source).toContain('contextLengthPenalty')
    expect(source).toContain('rowLikeBonus')
    expect(source).toContain('atomic-main-world-row-context-click')
  })
})
