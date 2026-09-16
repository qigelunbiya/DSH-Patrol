import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readBrowserVisibility,
  writeBrowserVisibility,
} from '../browser-bridge-runtime/browser-visibility.js'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function preferencePath(): string {
  const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-browser-visibility-'))
  roots.push(root)
  return join(root, 'nested', 'browser-visibility.json')
}

describe('Patrol browser visibility preference', () => {
  it('falls back to the existing environment policy before a preference is saved', () => {
    const path = preferencePath()
    expect(readBrowserVisibility(path, { DSH_PATROL_BROWSER_BACKGROUND: '1' })).toBe(false)
    expect(readBrowserVisibility(path, { DSH_PATROL_BROWSER_VISIBLE: '1' })).toBe(true)
  })

  it('persists an explicit UI choice and lets it override environment defaults', () => {
    const path = preferencePath()
    expect(writeBrowserVisibility(false, path)).toBe(false)
    expect(readBrowserVisibility(path, { DSH_PATROL_BROWSER_VISIBLE: '1' })).toBe(false)

    expect(writeBrowserVisibility(true, path)).toBe(true)
    expect(readBrowserVisibility(path, { DSH_PATROL_BROWSER_BACKGROUND: '1' })).toBe(true)
  })

  it('treats a corrupt preference as non-fatal and falls back to the launch policy', () => {
    const path = preferencePath()
    writeFileSync(path, '{not-json', { encoding: 'utf8' })
    expect(readBrowserVisibility(path, { DSH_PATROL_BROWSER_BACKGROUND: '1' })).toBe(false)
  })
})
