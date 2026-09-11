import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('atomic semantic click extension layer', () => {
  it('advertises the semanticClick protocol capability', () => {
    const source = readFileSync(join(root, 'browser-extension', 'background.js'), 'utf8')
    const advertised = /EXTENSION_CAPABILITIES[\s\S]*['\"]semanticClick['\"]/.test(source)
    expect(advertised).toBe(true)
  })

  it('is loaded immediately after the core bridge and parses as JavaScript', () => {
    const entry = readFileSync(join(root, 'browser-extension', 'background-entry.js'), 'utf8')
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(entry).toContain("importScripts('semantic-click.js')")
    expect(entry.indexOf("importScripts('semantic-click.js')")).toBeGreaterThan(entry.indexOf("importScripts('background.js')"))
    expect(entry.indexOf("importScripts('semantic-click.js')")).toBeLessThan(entry.indexOf("importScripts('frame-registration.js')"))
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

  it('can discover a plain image or SVG logo even when it has no link/button wrapper', () => {
    const source = readFileSync(join(root, 'browser-extension', 'semantic-click.js'), 'utf8')

    expect(source).toContain("'img', 'svg'")
    expect(source).toContain("'[id*=\"logo\" i]'")
    expect(source).toContain("'[class*=\"logo\" i]'")
    expect(source).toContain("element instanceof HTMLImageElement")
    expect(source).toContain("querySelectorAll?.('img,svg')")
  })
})
