// @ts-nocheck
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { apply, CLEANUP_BEGIN, CLEANUP_END } from '../cleanup-runtime/index.js'

const cleanup = []
const previousDshHome = process.env.DSH_HOME
const runtimeSource = join(dirname(dirname(fileURLToPath(import.meta.url))), 'cleanup-runtime', 'index.js')

afterEach(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true })
})

describe('persistent Patrol cleanup coordinator', () => {
  it('loads from an isolated temp directory without the dsh-patrol package', async () => {
    const root = makeHome()
    const isolated = join(root, 'standalone-cleanup.mjs')
    copyFileSync(runtimeSource, isolated)

    const module = await import(`${pathToFileURL(isolated).href}?isolated=${Date.now()}`)
    expect(module.name).toBe('dsh-patrol-integration-cleanup')
    expect(typeof module.cleanupOrphanedIntegration).toBe('function')
  })

  it('does nothing while the target profile still depends on dsh-patrol', async () => {
    const root = makeHome()
    writeProfile(root, 'web', { 'dsh-patrol': 'github:qigelunbiya/DSH-Patrol#main' }, cleanupBlock('web'))
    seedManagedIntegration(root)

    await apply(fakeContext(), { profile: 'web' })

    expect(readFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).toContain(CLEANUP_BEGIN)
    expect(existsSync(join(root, '.agent-presets', 'patrol', '.managed-by-dsh-patrol'))).toBe(true)
    expect(existsSync(join(root, 'patrol', 'browser-profile'))).toBe(true)
  })

  it('removes a stale profile row and shared managed integration after the last install disappears', async () => {
    const root = makeHome()
    writeProfile(root, 'web', {}, `# user config\n${cleanupBlock('web')}`)
    seedManagedIntegration(root)
    mkdirSync(join(root, 'patrol', 'runs'), { recursive: true })
    mkdirSync(join(root, 'patrol', 'inspections'), { recursive: true })
    writeFileSync(join(root, 'patrol', 'runs', 'keep.txt'), 'historical run')
    writeFileSync(join(root, 'patrol', 'inspections', 'keep.txt'), 'definition')

    await apply(fakeContext(), { profile: 'web' })

    const patch = readFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')
    expect(patch).toContain('# user config')
    expect(patch).not.toContain(CLEANUP_BEGIN)
    expect(existsSync(join(root, '.agent-presets', 'patrol'))).toBe(false)
    expect(existsSync(join(root, 'patrol', 'browser-profile'))).toBe(false)
    expect(existsSync(join(root, 'patrol', 'managed-browser.json'))).toBe(false)
    expect(existsSync(join(root, 'patrol', 'trusted-extension-origin.txt'))).toBe(false)
    expect(existsSync(join(root, 'patrol', 'integration-cleanup.mjs'))).toBe(false)
    expect(readFileSync(join(root, 'patrol', 'runs', 'keep.txt'), 'utf8')).toBe('historical run')
    expect(readFileSync(join(root, 'patrol', 'inspections', 'keep.txt'), 'utf8')).toBe('definition')
  })

  it('removes only the stale profile row when another profile still uses Patrol', async () => {
    const root = makeHome()
    writeProfile(root, 'web', {}, cleanupBlock('web'))
    writeProfile(root, 'ops', { 'dsh-patrol': 'file:../../../DSH-Patrol' }, cleanupBlock('ops'))
    seedManagedIntegration(root)

    await apply(fakeContext(), { profile: 'web' })

    expect(readFileSync(join(root, 'profiles', 'web', 'cordis.patch.yml'), 'utf8')).not.toContain(CLEANUP_BEGIN)
    expect(readFileSync(join(root, 'profiles', 'ops', 'cordis.patch.yml'), 'utf8')).toContain(CLEANUP_BEGIN)
    expect(existsSync(join(root, '.agent-presets', 'patrol', '.managed-by-dsh-patrol'))).toBe(true)
    expect(existsSync(join(root, 'patrol', 'browser-profile'))).toBe(true)
    expect(existsSync(join(root, 'patrol', 'integration-cleanup.mjs'))).toBe(true)
  })

  it('preserves a user-owned patrol preset when the managed marker is absent', async () => {
    const root = makeHome()
    writeProfile(root, 'web', {}, cleanupBlock('web'))
    const preset = join(root, '.agent-presets', 'patrol')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, 'agent.cordis.yml'), '- name: user/plugin\n')
    mkdirSync(join(root, 'patrol'), { recursive: true })
    writeFileSync(join(root, 'patrol', 'integration-cleanup.mjs'), 'runtime')

    await apply(fakeContext(), { profile: 'web' })

    expect(existsSync(preset)).toBe(true)
    expect(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')).toContain('user/plugin')
  })
})

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-cleanup-'))
  cleanup.push(root)
  process.env.DSH_HOME = root
  return root
}

function writeProfile(root, name, dependencies, patch) {
  const dir = join(root, 'profiles', name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify({ dependencies }, null, 2)}\n`)
  writeFileSync(join(dir, 'cordis.patch.yml'), patch)
}

function cleanupBlock(profile) {
  return `${CLEANUP_BEGIN}\n- insert:\n    - id: dsh-patrol-cleanup\n      name: 'file:///tmp/integration-cleanup.mjs'\n      config:\n        profile: '${profile}'\n${CLEANUP_END}\n`
}

function seedManagedIntegration(root) {
  const preset = join(root, '.agent-presets', 'patrol')
  mkdirSync(preset, { recursive: true })
  writeFileSync(join(preset, '.managed-by-dsh-patrol'), 'managed\n')
  writeFileSync(join(preset, 'agent.cordis.yml'), '- name: dsh-patrol\n')

  mkdirSync(join(root, 'patrol', 'browser-profile'), { recursive: true })
  mkdirSync(join(root, 'patrol', 'browser-bridge'), { recursive: true })
  writeFileSync(join(root, 'patrol', 'managed-browser.json'), '{}\n')
  writeFileSync(join(root, 'patrol', 'trusted-extension-origin.txt'), 'chrome-extension://abcdefghijklmnopabcdefghijklmnop\n')
  writeFileSync(join(root, 'patrol', 'integration-cleanup.mjs'), 'runtime')
}

function fakeContext() {
  return { logger: { info() {}, warn() {} } }
}
