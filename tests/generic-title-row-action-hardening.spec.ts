import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = process.cwd()

describe('generic title-backed row action hardening', () => {
  it('loads after the compatibility title-backed resolver and before later frame hardening', () => {
    const entry = readFileSync(join(root, 'browser-extension', 'background-entry.js'), 'utf8')
    const compatibility = "importScripts('title-backed-row-action-hardening.js')"
    const generic = "importScripts('generic-title-row-action-hardening.js')"
    const frames = "importScripts('frame-registration.js')"

    expect(entry).toContain(compatibility)
    expect(entry).toContain(generic)
    expect(entry.indexOf(generic)).toBeGreaterThan(entry.indexOf(compatibility))
    expect(entry.indexOf(generic)).toBeLessThan(entry.indexOf(frames))
  })

  it('derives actions from locatorText and business identities generically from task context', () => {
    const source = readFileSync(join(root, 'browser-extension', 'generic-title-row-action-hardening.js'), 'utf8')

    expect(() => new Function(source)).not.toThrow()
    expect(source).toContain('genericTitleActionTokens(args.locatorText)')
    expect(source).toContain('genericTitleIdentityTokens(args, actionTokens)')
    expect(source).toContain("text.match(/[\\u3400-\\u9fff]{2,}/g)")
    expect(source).toContain("text.match(/[A-Za-z0-9][A-Za-z0-9._:/-]{2,}/g)")
    expect(source).not.toMatch(/RDP\|SSH\|VNC\|SFTP/)
    expect(source).not.toContain('10.192.3.174')
    expect(source).not.toContain('ant-table-cell-fix-right')
    expect(source).not.toContain('act_margin_left')
  })

  it('tries independent row identities so unrelated identifiers do not have to coexist in one row', () => {
    const source = readFileSync(join(root, 'browser-extension', 'generic-title-row-action-hardening.js'), 'utf8')

    expect(source).toContain('for (const identityToken of identityTokens)')
    expect(source).toContain('identityTokens: [identityToken]')
    expect(source).toContain('genericTitleIdentityWeight(identityToken)')
    expect(source).toContain('const byTarget = new Map()')
  })

  it('reuses the proven title-backed click mechanics and refuses equal best matches', () => {
    const source = readFileSync(join(root, 'browser-extension', 'generic-title-row-action-hardening.js'), 'utf8')

    expect(source).toContain('func: titleBackedRowActionPageCommand')
    expect(source).toContain("args: ['probe', spec]")
    expect(source).toContain("args: ['click', chosen.spec]")
    expect(source).toContain('if (best.length !== 1) return undefined')
    expect(source).toContain('atomic-main-world-generic-title-row-action-click')
    expect(source).toContain('return await genericTitleRowPreviousHandleCommand(cmd, args)')
  })
})
