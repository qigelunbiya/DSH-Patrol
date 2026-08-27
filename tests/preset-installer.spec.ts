// @ts-nocheck
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { apply } from '../src/preset-installer.js'

const cleanup = []
const previousDshHome = process.env.DSH_HOME

afterEach(() => {
  if (previousDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = previousDshHome
  while (cleanup.length > 0) rmSync(cleanup.pop(), { recursive: true, force: true })
})

describe('Patrol preset installer lifecycle', () => {
  it('installs the preset and an idempotent persistent cleanup row for bundle profiles', async () => {
    const root = makeHome()
    const profileDir = join(root, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ dependencies: { 'dsh-patrol': 'github:qigelunbiya/DSH-Patrol#main' } }, null, 2)}\n`)
    writeFileSync(join(profileDir, 'cordis.patch.yml'), '# user row\n')

    const ctx = fakeContext()
    await apply(ctx)

    const preset = join(root, '.agent-presets', 'patrol')
    const runtime = join(root, 'patrol', 'integration-cleanup.mjs')
    const firstPatch = readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')
    expect(existsSync(join(preset, '.managed-by-dsh-patrol'))).toBe(true)
    expect(readFileSync(join(preset, 'preset.yml'), 'utf8')).toContain('巡检模式')
    expect(readFileSync(runtime, 'utf8')).toContain('dsh-patrol-integration-cleanup')
    expect(firstPatch).toContain('# user row')
    expect(firstPatch).toContain('# BEGIN DSH-PATROL MANAGED CLEANUP')
    expect(firstPatch).toContain("profile: 'web'")

    await apply(ctx)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toBe(firstPatch)
  })

  it('preserves an unmanaged patrol preset while still installing the cleanup coordinator', async () => {
    const root = makeHome()
    const profileDir = join(root, 'profiles', 'web')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), `${JSON.stringify({ dependencies: { 'dsh-patrol': 'file:../../../DSH-Patrol' } }, null, 2)}\n`)

    const preset = join(root, '.agent-presets', 'patrol')
    mkdirSync(preset, { recursive: true })
    writeFileSync(join(preset, 'agent.cordis.yml'), '- name: user-owned/plugin\n')

    await apply(fakeContext())

    expect(readFileSync(join(preset, 'agent.cordis.yml'), 'utf8')).toContain('user-owned/plugin')
    expect(existsSync(join(preset, '.managed-by-dsh-patrol'))).toBe(false)
    expect(existsSync(join(root, 'patrol', 'integration-cleanup.mjs'))).toBe(true)
    expect(readFileSync(join(profileDir, 'cordis.patch.yml'), 'utf8')).toContain('# BEGIN DSH-PATROL MANAGED CLEANUP')
  })
})

function makeHome() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-patrol-installer-'))
  cleanup.push(root)
  process.env.DSH_HOME = root
  return root
}

function fakeContext() {
  return { logger: { info() {}, warn() {} } }
}
