import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('atomic semantic click extension layer', () => {
  it('is loaded last by the extension background entry and parses as JavaScript', () => {
    const entry = readFileSync(join(root, 'browser-extension', 'background-entry.js'), 'utf8')
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(entry).toContain("importScripts('semantic-click.js')")
    expect(entry.lastIndexOf("importScripts('semantic-click.js')")).toBeGreaterThan(entry.lastIndexOf("importScripts('modal-target-hardening.js')"))
    expect(() => new Function(source)).not.toThrow()
  })

  it('keeps semantic resolution and click inside one command without content-script messaging', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(source).toContain("cmd === 'semanticClick'")
    expect(source).toContain("world: 'MAIN'")
    expect(source).toContain("'probe'")
    expect(source).toContain("'click'")
    expect(source).toContain('expectedFingerprint')
    expect(source).not.toContain('chrome.tabs.sendMessage')
  })

  it('contains row-context scoring for host identity plus RDP-style actions', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(source).toContain('ipTokens')
    expect(source).toContain('actionTokens')
    expect(source).toMatch(/closest\?\.\('tr,li,form,nav/)
    expect(source).toContain('context.includes(token)')
  })
})
