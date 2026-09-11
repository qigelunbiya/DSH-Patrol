// @ts-nocheck
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createClosingAwareBrowser,
  isBrowserClosingError,
  refreshBundledExtensionInstall,
} from '../browser-bridge-runtime/managed-browser-controller.js'

const roots: string[] = []
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true })
})

function extensionRoot() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-extension-refresh-'))
  roots.push(root)
  writeFileSync(join(root, 'manifest.json'), JSON.stringify({
    manifest_version: 3,
    name: 'DSH Patrol Browser Bridge',
    version: '0.2.1',
  }))
  return root
}

describe('managed Patrol extension refresh', () => {
  it('reinstalls a persisted Patrol extension by name even when its reported path drifted', async () => {
    const root = extensionRoot()
    const calls: Array<[string, string]> = []
    const browser = {
      async extensions() {
        return new Map([[
          'old-patrol-id',
          {
            name: 'DSH Patrol Browser Bridge',
            version: '0.1.9',
            path: join(root, 'profile-internal-copy'),
          },
        ]])
      },
      async uninstallExtension(id: string) {
        calls.push(['uninstall', id])
      },
      async installExtension(path: string) {
        calls.push(['install', path])
        return 'new-patrol-id'
      },
    }

    expect(await refreshBundledExtensionInstall(browser, root, { info() {} })).toBe(true)
    expect(calls).toEqual([
      ['uninstall', 'old-patrol-id'],
      ['install', resolve(root)],
    ])
  })

  it('does not replace unrelated extensions', async () => {
    const root = extensionRoot()
    const calls: string[] = []
    const browser = {
      async extensions() {
        return new Map([['other-id', { name: 'Some Other Extension', version: '1.0.0', path: join(root, 'other') }]])
      },
      async uninstallExtension() { calls.push('uninstall') },
      async installExtension() { calls.push('install'); return 'new-id' },
    }

    expect(await refreshBundledExtensionInstall(browser, root, { info() {} })).toBe(false)
    expect(calls).toEqual([])
  })

  it('marks a Puppeteer browser handle stale after a Browser is closing protocol error', async () => {
    const warnings: string[] = []
    const closing = createClosingAwareBrowser({
      connected: true,
      async extensions() {
        throw new Error('Protocol error (Extensions.getExtensions): Browser is closing.')
      },
    }, {
      warn(message: string) { warnings.push(message) },
    })

    expect(closing.connected).toBe(true)
    await expect(closing.extensions()).rejects.toThrow(/Browser is closing/i)
    expect(closing.connected).toBe(false)
    expect(warnings).toHaveLength(1)

    // Once stale, reading connected stays false even when the underlying
    // Puppeteer object has not emitted disconnected yet.
    expect(closing.connected).toBe(false)
  })

  it('does not mark the browser stale for ordinary page/extension errors', async () => {
    const ordinary = createClosingAwareBrowser({
      connected: true,
      async extensions() {
        throw new Error('page bridge unavailable')
      },
    }, { warn() { throw new Error('ordinary errors must not mark browser closing') } })

    await expect(ordinary.extensions()).rejects.toThrow(/page bridge unavailable/i)
    expect(ordinary.connected).toBe(true)
    expect(isBrowserClosingError(new Error('Protocol error (Extensions.loadUnpacked): Browser is closing.'))).toBe(true)
    expect(isBrowserClosingError(new Error('Target closed'))).toBe(false)
  })
})
