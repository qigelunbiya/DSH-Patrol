import { access, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'

export const name = 'dsh-patrol-preset-installer'
export const inject: string[] = []

const PRESET_ID = 'patrol'
const MANAGED_MARKER = '.managed-by-dsh-patrol'
const CLEANUP_BEGIN = '# BEGIN DSH-PATROL MANAGED CLEANUP'
const CLEANUP_END = '# END DSH-PATROL MANAGED CLEANUP'

export async function apply(ctx: Context): Promise<void> {
  // Install the self-contained cleanup coordinator first. It lives under
  // $DSH_HOME and therefore remains runnable after pnpm removes dsh-patrol;
  // on the next Harness boot it removes stale Patrol integration and then its
  // own managed patch row. This closes the lifecycle gap in dsh plugin remove,
  // which currently has no third-party uninstall hook.
  await installCleanupCoordinator(ctx)

  const source = fileURLToPath(new URL('../presets/patrol/', import.meta.url))
  const target = dshHomePath('.agent-presets', PRESET_ID)
  const marker = join(target, MANAGED_MARKER)
  const exists = await pathExists(target)
  const managed = await pathExists(marker)

  if (exists && !managed) {
    ctx.logger.warn(`dsh-patrol: preset ${target} already exists and is not managed by DSH Patrol; leaving it untouched`)
    return
  }

  await mkdir(target, { recursive: true, mode: 0o700 })
  for (const file of ['agent.cordis.yml', 'preset.yml']) {
    const content = await readFile(join(source, file), 'utf8')
    await writeFile(join(target, file), content, { encoding: 'utf8', mode: 0o600 })
  }
  await writeFile(marker, 'managed by dsh-patrol; edit the package preset source or remove this marker to take ownership\n', { encoding: 'utf8', mode: 0o600 })
  ctx.logger.info(`dsh-patrol: installed/updated Agent Preset "${PRESET_ID}" at ${target}`)
}

async function installCleanupCoordinator(ctx: Context): Promise<void> {
  const runtimeSource = fileURLToPath(new URL('../cleanup-runtime/index.js', import.meta.url))
  const runtimeTarget = dshHomePath('patrol', 'integration-cleanup.mjs')
  await mkdir(dirname(runtimeTarget), { recursive: true, mode: 0o700 })
  const runtime = await readFile(runtimeSource, 'utf8')
  await writeFile(runtimeTarget, runtime, { encoding: 'utf8', mode: 0o600 })

  const profiles = await findBundleProfiles()
  if (profiles.length === 0) {
    ctx.logger.warn('dsh-patrol: could not find a profile dependency that references dsh-patrol; cleanup coordinator was copied but no profile patch was modified')
    return
  }

  for (const profile of profiles) {
    const changed = await ensureCleanupPatch(profile, runtimeTarget)
    if (changed) ctx.logger.info(`dsh-patrol: installed managed uninstall cleanup row for profile ${profile}`)
  }
}

async function findBundleProfiles(): Promise<string[]> {
  const profilesRoot = dshHomePath('profiles')
  let children
  try {
    children = await readdir(profilesRoot, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }

  const profiles: string[] = []
  for (const child of children) {
    if (!child.isDirectory()) continue
    const manifest = await readJson(join(profilesRoot, child.name, 'package.json'))
    if (manifest !== undefined && manifestReferencesPatrol(manifest)) profiles.push(child.name)
  }
  return profiles.sort()
}

async function ensureCleanupPatch(profile: string, runtimePath: string): Promise<boolean> {
  const patchPath = dshHomePath('profiles', profile, 'cordis.patch.yml')
  await mkdir(dirname(patchPath), { recursive: true, mode: 0o700 })
  const existing = await readText(patchPath) ?? ''
  const eol = existing.includes('\r\n') ? '\r\n' : '\n'
  const clean = stripManagedBlock(existing, CLEANUP_BEGIN, CLEANUP_END).trimEnd()
  const runtimeUri = yamlSingleQuote(pathToFileURL(runtimePath).href)
  const profileName = yamlSingleQuote(profile)
  const block = [
    CLEANUP_BEGIN,
    '- insert:',
    '    - id: dsh-patrol-cleanup',
    `      name: '${runtimeUri}'`,
    '      config:',
    `        profile: '${profileName}'`,
    CLEANUP_END,
  ].join(eol)
  const next = clean.length > 0 ? `${clean}${eol}${eol}${block}${eol}` : `${block}${eol}`
  if (next === existing) return false
  await writeFile(patchPath, next, { encoding: 'utf8', mode: 0o600 })
  return true
}

function stripManagedBlock(content: string, begin: string, end: string): string {
  const pattern = new RegExp(`^${escapeRegExp(begin)}\\r?\\n[\\s\\S]*?^${escapeRegExp(end)}\\r?\\n?`, 'gm')
  return content.replace(pattern, '')
}

function manifestReferencesPatrol(manifest: Record<string, unknown>): boolean {
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies']) {
    const dependencies = manifest[section]
    if (typeof dependencies !== 'object' || dependencies === null || Array.isArray(dependencies)) continue
    for (const [packageName, spec] of Object.entries(dependencies as Record<string, unknown>)) {
      if (packageName === 'dsh-patrol') return true
      const text = String(spec ?? '')
      if (/qigelunbiya[\\/]DSH-Patrol/i.test(text)) return true
      if (/(?:^|[/:@])dsh-patrol(?:[#@/:]|$)/i.test(text)) return true
    }
  }
  return false
}

async function readJson(path: string): Promise<Record<string, unknown> | undefined> {
  const text = await readText(path)
  if (text === undefined) return undefined
  try {
    const value: unknown = JSON.parse(text)
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined
  } catch {
    return undefined
  }
}

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

function yamlSingleQuote(value: string): string {
  return value.replace(/'/g, "''")
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
