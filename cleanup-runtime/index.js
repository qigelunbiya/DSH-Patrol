// Self-contained DSH Patrol integration cleanup coordinator.
//
// This file is copied into $DSH_HOME/patrol and referenced from a managed
// profile patch row. It deliberately depends only on Node built-ins so it can
// still run after the dsh-patrol package itself has been removed.
import { access, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export const name = 'dsh-patrol-integration-cleanup'
export const inject = []

export const CLEANUP_BEGIN = '# BEGIN DSH-PATROL MANAGED CLEANUP'
export const CLEANUP_END = '# END DSH-PATROL MANAGED CLEANUP'
export const HOST_BEGIN = '# BEGIN DSH-PATROL MANAGED HOST BRIDGE'
const PRESET_MARKER = '.managed-by-dsh-patrol'

export async function apply(ctx, config = {}) {
  const profile = typeof config.profile === 'string' ? config.profile.trim() : ''
  if (!/^[A-Za-z0-9._-]+$/.test(profile)) {
    ctx.logger?.warn?.('[dsh-patrol/cleanup] invalid or missing profile name; refusing automatic cleanup')
    return
  }

  await cleanupOrphanedIntegration({
    dshHome: resolveDshHome(),
    profile,
    logger: ctx.logger,
  })
}

export async function cleanupOrphanedIntegration({ dshHome, profile, logger = console }) {
  const home = resolve(dshHome)
  const profileDir = join(home, 'profiles', profile)
  if (await profileHasPatrol(profileDir)) return { active: true, sharedRemoved: false }

  const profilePatch = join(profileDir, 'cordis.patch.yml')
  await removeManagedBlock(profilePatch, CLEANUP_BEGIN, CLEANUP_END)

  if (await anyProfileHasPatrol(home)) {
    logger.info?.(`[dsh-patrol/cleanup] removed stale cleanup row for profile ${profile}; shared Patrol integration is still used by another profile`)
    return { active: false, sharedRemoved: false }
  }

  await removeManagedPreset(home, logger)
  await safeRemove(join(home, 'patrol', 'browser-profile'), { recursive: true }, logger)
  await safeRemove(join(home, 'patrol', 'managed-browser.json'), {}, logger)
  await safeRemove(join(home, 'patrol', 'trusted-extension-origin.txt'), {}, logger)
  await safeRemove(join(home, 'patrol', 'browser-bridge'), { recursive: true }, logger)
  await safeRemove(join(home, 'patrol', 'integration-cleanup.mjs'), {}, logger)
  logger.info?.('[dsh-patrol/cleanup] removed orphaned Patrol preset/browser integration; inspections and historical runs were preserved')
  return { active: false, sharedRemoved: true }
}

export async function profileHasPatrol(profileDir) {
  const manifest = await readJson(join(profileDir, 'package.json'))
  if (manifest !== undefined && manifestReferencesPatrol(manifest)) return true

  const patch = await readText(join(profileDir, 'cordis.patch.yml'))
  return patch?.includes(HOST_BEGIN) === true
}

export async function anyProfileHasPatrol(dshHome) {
  const profilesDir = join(dshHome, 'profiles')
  let children
  try {
    children = await readdir(profilesDir, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw error
  }

  for (const child of children) {
    if (!child.isDirectory()) continue
    if (await profileHasPatrol(join(profilesDir, child.name))) return true
  }
  return false
}

export function manifestReferencesPatrol(manifest) {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = manifest?.[section]
    if (!dependencies || typeof dependencies !== 'object' || Array.isArray(dependencies)) continue
    for (const [packageName, spec] of Object.entries(dependencies)) {
      if (packageName === 'dsh-patrol') return true
      const text = String(spec ?? '')
      if (/qigelunbiya[\\/]DSH-Patrol/i.test(text)) return true
      if (/(?:^|[/:@])dsh-patrol(?:[#@/:]|$)/i.test(text)) return true
    }
  }
  return false
}

export async function removeManagedBlock(path, begin, end) {
  const existing = await readText(path)
  if (existing === undefined || !existing.includes(begin)) return false
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const pattern = new RegExp(`^${escapeRegExp(begin)}\\r?\\n[\\s\\S]*?^${escapeRegExp(end)}\\r?\\n?`, 'gm')
  const stripped = existing.replace(pattern, '').trimEnd()
  const next = stripped.length === 0 ? '' : `${stripped}${eol}`
  if (next === existing) return false
  await writeFile(path, next, { encoding: 'utf8', mode: 0o600 })
  return true
}

async function removeManagedPreset(home, logger) {
  const presetDir = join(home, '.agent-presets', 'patrol')
  const marker = join(presetDir, PRESET_MARKER)
  if (!await pathExists(marker)) {
    if (await pathExists(presetDir)) {
      logger.info?.('[dsh-patrol/cleanup] preserving user-owned patrol preset because the DSH Patrol managed marker is absent')
    }
    return
  }
  await safeRemove(presetDir, { recursive: true }, logger)
}

async function safeRemove(path, options, logger) {
  try {
    await rm(path, { force: true, ...options })
  } catch (error) {
    logger.warn?.(`[dsh-patrol/cleanup] could not remove ${path}: ${errorMessage(error)}`)
  }
}

async function readJson(path) {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

async function readText(path) {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return undefined
    throw error
  }
}

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function resolveDshHome() {
  const configured = String(process.env.DSH_HOME ?? '').trim()
  return resolve(configured.length > 0 ? configured : join(homedir(), '.dsh'))
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}
