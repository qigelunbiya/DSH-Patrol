import { readFile, writeFile } from 'node:fs/promises'

async function edit(path, transform) {
  const before = await readFile(path, 'utf8')
  const after = transform(before)
  if (after === before) throw new Error(`${path}: transform made no change`)
  await writeFile(path, after, 'utf8')
}
function once(text, from, to, label) {
  const i = text.indexOf(from)
  if (i < 0) throw new Error(`missing ${label}`)
  if (text.indexOf(from, i + from.length) >= 0) throw new Error(`duplicate ${label}`)
  return text.slice(0, i) + to + text.slice(i + from.length)
}

await writeFile('src/internal-worker.ts', `import { access } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export type PatrolInternalWorkerKind = 'teaching' | 'replay' | 'recovery'

type LoaderLike = {
  config?: { baseUrl?: string }
  internal?: {
    import(name: string, baseUrl: string, options: Record<string, never>): unknown
  }
}

type AgentPresetsModuleLike = {
  mountPreset?: (
    agentCtx: Context,
    preset: { id: string; trust: 'user'; path: string },
  ) => Promise<void>
}

/** Resolve a Patrol-owned worker composition that deliberately lives outside
 * Harness's discoverable agent-preset roots. */
export function internalPatrolWorkerPath(root: string, kind: PatrolInternalWorkerKind): string {
  const value = root.trim()
  if (!value) throw new Error('DSH Patrol internal worker root is not configured; reinstall the local Patrol integration')
  if (!isAbsolute(value)) throw new Error(\`DSH Patrol internal worker root must be absolute: \${value}\`)
  return join(value, \`\${kind}.cordis.yml\`)
}

/** Mount one hidden worker composition into an ephemeral scoped Agent.
 *
 * Do not resolve this through agentPresets: discoverable presets are user-facing
 * by design and therefore appear in Harness's mode picker. The low-level
 * mountPreset implementation is loaded from Harness itself through its Loader,
 * guaranteeing the same dsh-scope/Cordis package identities as the host. */
export async function mountInternalPatrolWorker(
  agentCtx: Context,
  compositionPath: string,
  kind: PatrolInternalWorkerKind,
): Promise<void> {
  if (!isAbsolute(compositionPath)) throw new Error(\`internal Patrol worker composition must be absolute: \${compositionPath}\`)
  await access(compositionPath)
  const loader = (agentCtx as unknown as { get(name: string): unknown }).get('loader') as LoaderLike | undefined
  const baseUrl = loader?.config?.baseUrl
  const importer = loader?.internal?.import
  if (!baseUrl || typeof importer !== 'function') {
    throw new Error('Harness Loader is unavailable; cannot mount a hidden Patrol worker composition')
  }
  const loaded = await Promise.resolve(importer.call(loader.internal, '@deepseek-ai/dsh-agent-presets', baseUrl, {})) as AgentPresetsModuleLike
  if (typeof loaded?.mountPreset !== 'function') {
    throw new Error('Harness @deepseek-ai/dsh-agent-presets does not export mountPreset; update Harness before using hidden Patrol workers')
  }
  await loaded.mountPreset(agentCtx, {
    id: \`dsh-patrol-internal-\${kind}\`,
    trust: 'user',
    path: compositionPath,
  })
}
`, 'utf8')

await edit('src/index.ts', text => {
  text = once(text,
`  /** Deprecated v0.1 compatibility; Patrol v0.2 uses an exact safe-browser allowlist. */
  allowedToolPrefixes?: string[]
}`,
`  /** Absolute directory containing Patrol-owned hidden worker compositions. */
  workerRoot?: string
  /** Deprecated v0.1 compatibility; Patrol v0.2 uses an exact safe-browser allowlist. */
  allowedToolPrefixes?: string[]
}`,'Config workerRoot')
  text = once(text,
`  profile: z.union(['full', 'shell', 'teaching', 'replay', 'recovery'] as const).default('full'),
  allowedToolPrefixes: z.array(z.string()).default(['browser_']),`,
`  profile: z.union(['full', 'shell', 'teaching', 'replay', 'recovery'] as const).default('full'),
  workerRoot: z.string().default(''),
  allowedToolPrefixes: z.array(z.string()).default(['browser_']),`,'Config schema workerRoot')
  text = once(text,
`  reportMaxChars: number
  profile: PatrolProfile
}`,
`  reportMaxChars: number
  profile: PatrolProfile
  workerRoot: string
}`,'ResolvedConfig workerRoot')
  text = once(text,
`    reportMaxChars: config.reportMaxChars ?? DEFAULT_REPORT_MAX_CHARS,
    profile: config.profile ?? 'full',
  }`,
`    reportMaxChars: config.reportMaxChars ?? DEFAULT_REPORT_MAX_CHARS,
    profile: config.profile ?? 'full',
    workerRoot: config.workerRoot?.trim() ? resolve(config.workerRoot) : '',
  }`,'resolve workerRoot')
  text = once(text,
`    ctx.effect(() => registerPatrolShellTools(ctx, store), 'dsh-patrol/shell: four orchestration tools')`,
`    ctx.effect(() => registerPatrolShellTools(ctx, store, { workerRoot: resolved.workerRoot }), 'dsh-patrol/shell: four orchestration tools')`,'shell workerRoot plumbing')
  return text
})

await edit('src/shell-tools.ts', text => {
  text = once(text,
`import { resolveFlowReference, type FlowReferenceResult } from './flow-reference-tools.js'
import { PatrolStore } from './store.js'`,
`import { resolveFlowReference, type FlowReferenceResult } from './flow-reference-tools.js'
import { internalPatrolWorkerPath, mountInternalPatrolWorker, type PatrolInternalWorkerKind } from './internal-worker.js'
import { PatrolStore } from './store.js'`,'shell internal worker import')
  text = once(text,
`interface AgentPresetsLike {
  resolve(id?: string): Promise<{ id: string }>
  mount(agentCtx: Context, id?: string): Promise<unknown>
}

`, '', 'remove AgentPresetsLike')
  text = once(text,
`export interface PatrolShellOptions {
  replayPresetId?: string
  teachingPresetId?: string
  recoveryPresetId?: string
}`,
`export interface PatrolShellOptions {
  workerRoot?: string
}`,'shell options')
  text = once(text,
`  const replayPresetId = options.replayPresetId ?? 'patrol-replay'
  const teachingPresetId = options.teachingPresetId ?? 'patrol-teaching'
  const recoveryPresetId = options.recoveryPresetId ?? 'patrol-recovery'`,
`  const workerRoot = options.workerRoot ?? ''`,'shell worker root const')
  text = text.replace(`        teachingPresetId,`, `        workerRoot,\n        'teaching',`)
  text = text.replace(`      const replayText = await executeReplayWorker(ctx, replayPresetId, workspace, definition.id, replayTool)`, `      const replayText = await executeReplayWorker(ctx, workerRoot, workspace, definition.id, replayTool)`)
  text = text.replace(`        recoveryPresetId,`, `        workerRoot,\n        'recovery',`)
  text = once(text,
`  presetId: string,
  workspace: string,`,
`  workerRoot: string,
  workspace: string,`,'replay signature')
  text = once(text,
`  const { agents, presets } = workerServices(ctx)
  const resolved = (await presets.resolve(presetId)).id
  const sessionId = \`patrol-replay-\${randomUUID()}\`
  const handle = await agents.create({
    sessionId,
    meta: { cwd: workspace, agentPreset: resolved },
    setup: async agentCtx => { await presets.mount(agentCtx, resolved) },
  })`,
`  const { agents } = workerServices(ctx)
  const compositionPath = internalPatrolWorkerPath(workerRoot, 'replay')
  const sessionId = \`patrol-replay-\${randomUUID()}\`
  const handle = await agents.create({
    sessionId,
    meta: { cwd: workspace },
    setup: async agentCtx => { await mountInternalPatrolWorker(agentCtx, compositionPath, 'replay') },
  })`,'replay mount')
  text = once(text,
`  presetId: string,
  workspace: string,
  inheritedOptions: AgentOptionsLike | undefined,`,
`  workerRoot: string,
  kind: Extract<PatrolInternalWorkerKind, 'teaching' | 'recovery'>,
  workspace: string,
  inheritedOptions: AgentOptionsLike | undefined,`,'launch signature')
  text = once(text,
`  const { agents, presets } = workerServices(ctx)
  const resolved = (await presets.resolve(presetId)).id
  const sessionId = \`session-\${randomUUID()}\`
  const handle = await agents.create({
    sessionId,
    meta: { cwd: workspace, agentPreset: resolved },
    agentOptions: resolveAgentOptions(ctx, inheritedOptions),
    setup: async agentCtx => { await presets.mount(agentCtx, resolved) },
  })`,
`  const { agents } = workerServices(ctx)
  const compositionPath = internalPatrolWorkerPath(workerRoot, kind)
  const sessionId = \`session-\${randomUUID()}\`
  const handle = await agents.create({
    sessionId,
    meta: { cwd: workspace },
    agentOptions: resolveAgentOptions(ctx, inheritedOptions),
    setup: async agentCtx => { await mountInternalPatrolWorker(agentCtx, compositionPath, kind) },
  })`,'launch mount')
  text = once(text,
`function workerServices(ctx: Context): { agents: AgentRegistryLike; presets: AgentPresetsLike } {
  const agents = lookupService<AgentRegistryLike>(ctx, 'agents')
  const presets = lookupService<AgentPresetsLike>(ctx, 'agentPresets')
  if (agents === undefined) throw new Error('Harness Agent registry is unavailable; cannot launch a lazy Patrol worker')
  if (presets === undefined) throw new Error('Harness Agent Presets service is unavailable; cannot launch a lazy Patrol worker')
  return { agents, presets }
}`,
`function workerServices(ctx: Context): { agents: AgentRegistryLike } {
  const agents = lookupService<AgentRegistryLike>(ctx, 'agents')
  if (agents === undefined) throw new Error('Harness Agent registry is unavailable; cannot launch a lazy Patrol worker')
  return { agents }
}`,'worker services')
  if (text.includes('PresetId') || text.includes('presets.resolve') || text.includes('presets.mount')) throw new Error('shell still references discoverable worker presets')
  return text
})

await edit('browser-bridge-runtime/dashboard-management.js', text => {
  text = once(text,
`import { compactFlowConservatively } from './safe-flow-cleanup.js'`,
`import { internalPatrolWorkerPath, mountInternalPatrolWorker } from '../lib/internal-worker.js'
import { compactFlowConservatively } from './safe-flow-cleanup.js'`,'dashboard helper import')
  text = text.replace("const REPLAY_PRESET = 'patrol-replay'\nconst RECOVERY_PRESET = 'patrol-recovery'\n", '')
  text = text.replace(`executeReplayWorker(ctx, workspace, inspectionId, replayTool)`, `executeReplayWorker(ctx, config.workerRoot, workspace, inspectionId, replayTool)`)
  text = text.replace(`launchRecoveryWorker(ctx, workspace, definition, report, failure)`, `launchRecoveryWorker(ctx, config.workerRoot, workspace, definition, report, failure)`)
  text = once(text,
`async function executeReplayWorker(ctx, workspace, inspectionId, replayTool) {
  const agents = ctx.get('agents')
  const presets = ctx.get('agentPresets')
  if (!agents || !presets) throw new Error('Harness Agent services are unavailable for direct Dashboard replay')
  const resolvedPreset = (await presets.resolve(REPLAY_PRESET)).id
  const handle = await agents.create({
    sessionId: \`patrol-dashboard-replay-\${randomUUID()}\`,
    meta: { cwd: workspace, agentPreset: resolvedPreset },
    setup: async agentCtx => { await presets.mount(agentCtx, resolvedPreset) },
  })`,
`async function executeReplayWorker(ctx, workerRoot, workspace, inspectionId, replayTool) {
  const agents = ctx.get('agents')
  if (!agents) throw new Error('Harness Agent registry is unavailable for direct Dashboard replay')
  const compositionPath = internalPatrolWorkerPath(String(workerRoot || ''), 'replay')
  const handle = await agents.create({
    sessionId: \`patrol-dashboard-replay-\${randomUUID()}\`,
    meta: { cwd: workspace },
    setup: async agentCtx => { await mountInternalPatrolWorker(agentCtx, compositionPath, 'replay') },
  })`,'dashboard replay mount')
  text = once(text,
`async function launchRecoveryWorker(ctx, workspace, definition, report, failure) {
  const agents = ctx.get('agents')
  const presets = ctx.get('agentPresets')
  if (!agents || !presets) throw new Error('Harness Agent services are unavailable for Recovery')
  const resolvedPreset = (await presets.resolve(RECOVERY_PRESET)).id`,
`async function launchRecoveryWorker(ctx, workerRoot, workspace, definition, report, failure) {
  const agents = ctx.get('agents')
  if (!agents) throw new Error('Harness Agent registry is unavailable for Recovery')
  const compositionPath = internalPatrolWorkerPath(String(workerRoot || ''), 'recovery')`,'dashboard recovery head')
  text = once(text,
`    meta: { cwd: workspace, agentPreset: resolvedPreset },
    ...(agentOptions === undefined ? {} : { agentOptions }),
    setup: async agentCtx => { await presets.mount(agentCtx, resolvedPreset) },`,
`    meta: { cwd: workspace },
    ...(agentOptions === undefined ? {} : { agentOptions }),
    setup: async agentCtx => { await mountInternalPatrolWorker(agentCtx, compositionPath, 'recovery') },`,'dashboard recovery mount')
  if (text.includes('REPLAY_PRESET') || text.includes('RECOVERY_PRESET') || text.includes("ctx.get('agentPresets')")) throw new Error('dashboard still references discoverable worker presets')
  return text
})

await edit('scripts/install-local.ps1', text => {
  text = once(text,
`        [Parameter(Mandatory = $true)][string]$BridgeHostUri,
        [Parameter(Mandatory = $true)][string]$ScreenshotDir
    )`,
`        [Parameter(Mandatory = $true)][string]$BridgeHostUri,
        [Parameter(Mandatory = $true)][string]$ScreenshotDir,
        [Parameter(Mandatory = $true)][string]$WorkerRoot
    )`,'host patch worker param')
  text = once(text,
`    $safeScreenshotDir = ConvertTo-YamlSingleQuoted -Value $ScreenshotDir`,
`    $safeScreenshotDir = ConvertTo-YamlSingleQuoted -Value $ScreenshotDir
    $safeWorkerRoot = ConvertTo-YamlSingleQuoted -Value $WorkerRoot`,'host patch safe worker')
  text = once(text,
`        screenshotDir: '$safeScreenshotDir'`,
`        screenshotDir: '$safeScreenshotDir'
        workerRoot: '$safeWorkerRoot'`,'host worker config')
  const helperAnchor = `function Install-LazyPreset {`
  const helpers = `function Remove-LegacyManagedWorkerPreset {
    param(
        [Parameter(Mandatory = $true)][string]$DshHomePath,
        [Parameter(Mandatory = $true)][string]$PresetId
    )
    $legacyDir = Join-Path $DshHomePath ".agent-presets\\$PresetId"
    if (-not (Test-Path -LiteralPath $legacyDir)) { return }
    $marker = Join-Path $legacyDir ".managed-by-dsh-patrol"
    if (Test-Path -LiteralPath $marker) {
        Remove-Item -LiteralPath $legacyDir -Recurse -Force
        Write-Host "Removed legacy user-visible Patrol worker preset: $PresetId" -ForegroundColor Yellow
    } else {
        Write-Warning "Legacy Patrol worker preset is not managed by DSH Patrol and was preserved: $legacyDir"
    }
}

function Install-InternalWorkerComposition {
    param(
        [Parameter(Mandatory = $true)][string]$WorkerRoot,
        [Parameter(Mandatory = $true)][string]$WorkerId,
        [Parameter(Mandatory = $true)][string]$AgentYaml
    )
    New-Item -ItemType Directory -Force -Path $WorkerRoot | Out-Null
    $target = Join-Path $WorkerRoot "$WorkerId.cordis.yml"
    Write-Utf8NoBom -Path $target -Content $AgentYaml
    return $target
}

`
  if (!text.includes(helperAnchor)) throw new Error('install helper anchor missing')
  text = text.replace(helperAnchor, helpers + helperAnchor)
  text = once(text,
`$PatrolScreenshotDir = Join-Path $PatrolStorage "browser-tmp"
New-Item -ItemType Directory -Force -Path $PatrolStorage | Out-Null`,
`$PatrolScreenshotDir = Join-Path $PatrolStorage "browser-tmp"
$InternalWorkerRoot = Join-Path $DshHome "patrol\\internal-workers"
New-Item -ItemType Directory -Force -Path $PatrolStorage | Out-Null`,'worker root path')
  text = once(text,
`$SafeStoragePath = ConvertTo-YamlSingleQuoted -Value $PatrolStorage`,
`$SafeStoragePath = ConvertTo-YamlSingleQuoted -Value $PatrolStorage
$SafeWorkerRoot = ConvertTo-YamlSingleQuoted -Value $InternalWorkerRoot`,'safe worker root')
  text = once(text,
`    reportMaxChars: 10000
"@`,
`    reportMaxChars: 10000
    workerRoot: '$SafeWorkerRoot'
"@`,'shell yaml workerRoot')
  text = once(text,
`$PresetDir = Install-LazyPreset -PresetId "patrol" -AgentYaml $ShellAgentYaml -DshHomePath $DshHome -ProjectRootPath $ProjectRoot
$TeachingPresetDir = Install-LazyPreset -PresetId "patrol-teaching" -AgentYaml $TeachingAgentYaml -DshHomePath $DshHome -ProjectRootPath $ProjectRoot
$ReplayPresetDir = Install-LazyPreset -PresetId "patrol-replay" -AgentYaml $ReplayAgentYaml -DshHomePath $DshHome -ProjectRootPath $ProjectRoot
$RecoveryPresetDir = Install-LazyPreset -PresetId "patrol-recovery" -AgentYaml $RecoveryAgentYaml -DshHomePath $DshHome -ProjectRootPath $ProjectRoot`,
`$PresetDir = Install-LazyPreset -PresetId "patrol" -AgentYaml $ShellAgentYaml -DshHomePath $DshHome -ProjectRootPath $ProjectRoot
foreach ($legacyWorkerId in @("patrol-teaching", "patrol-replay", "patrol-recovery")) {
    Remove-LegacyManagedWorkerPreset -DshHomePath $DshHome -PresetId $legacyWorkerId
}
$TeachingWorkerPath = Install-InternalWorkerComposition -WorkerRoot $InternalWorkerRoot -WorkerId "teaching" -AgentYaml $TeachingAgentYaml
$ReplayWorkerPath = Install-InternalWorkerComposition -WorkerRoot $InternalWorkerRoot -WorkerId "replay" -AgentYaml $ReplayAgentYaml
$RecoveryWorkerPath = Install-InternalWorkerComposition -WorkerRoot $InternalWorkerRoot -WorkerId "recovery" -AgentYaml $RecoveryAgentYaml`,'install worker compositions')
  text = once(text,
`Install-ManagedHostBridgePatch -PatchPath $WebPatch -BridgeHostUri $BridgeHostIndex -ScreenshotDir $PatrolScreenshotDir`,
`Install-ManagedHostBridgePatch -PatchPath $WebPatch -BridgeHostUri $BridgeHostIndex -ScreenshotDir $PatrolScreenshotDir -WorkerRoot $InternalWorkerRoot`,'host patch call')
  text = once(text,
`Write-Host "Lazy Patrol teaching worker preset installed: $TeachingPresetDir" -ForegroundColor Green
Write-Host "Lazy Patrol replay worker preset installed: $ReplayPresetDir" -ForegroundColor Green
Write-Host "Lazy Patrol recovery worker preset installed: $RecoveryPresetDir" -ForegroundColor Green`,
`Write-Host "Internal Patrol teaching worker installed (hidden from preset picker): $TeachingWorkerPath" -ForegroundColor Green
Write-Host "Internal Patrol replay worker installed (hidden from preset picker): $ReplayWorkerPath" -ForegroundColor Green
Write-Host "Internal Patrol recovery worker installed (hidden from preset picker): $RecoveryWorkerPath" -ForegroundColor Green`,'output worker paths')
  return text
})

await edit('scripts/uninstall-local.ps1', text => {
  text = once(text,
`$PresetMarker = Join-Path $PresetDir ".managed-by-dsh-patrol"
$ProfileDir = Join-Path $DshHome "profiles\\$Profile"`,
`$PresetMarker = Join-Path $PresetDir ".managed-by-dsh-patrol"
$InternalWorkerRoot = Join-Path $PatrolRoot "internal-workers"
$ProfileDir = Join-Path $DshHome "profiles\\$Profile"`,'uninstall worker root')
  text = once(text,
`    Remove-Item -LiteralPath $ProfilePath -Recurse -Force -ErrorAction SilentlyContinue`,
`    foreach ($legacyWorkerId in @("patrol-teaching", "patrol-replay", "patrol-recovery")) {
        $legacyWorkerDir = Join-Path $DshHome ".agent-presets\\$legacyWorkerId"
        if (Test-Path -LiteralPath (Join-Path $legacyWorkerDir ".managed-by-dsh-patrol")) {
            Remove-Item -LiteralPath $legacyWorkerDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
    Remove-Item -LiteralPath $InternalWorkerRoot -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $ProfilePath -Recurse -Force -ErrorAction SilentlyContinue`,'uninstall hidden and legacy workers')
  return text
})

await edit('cleanup-runtime/index.js', text => {
  text = once(text,
`    removeManagedPresets(home, logger),
    safeRemove(join(home, 'patrol', 'browser-profile'), { recursive: true }, logger),`,
`    removeManagedPresets(home, logger),
    safeRemove(join(home, 'patrol', 'internal-workers'), { recursive: true }, logger),
    safeRemove(join(home, 'patrol', 'browser-profile'), { recursive: true }, logger),`,'cleanup hidden workers')
  return text
})

await edit('tests/lazy-patrol-architecture.spec.ts', text => {
  text = once(text,
`const browserPlugin = read('browser-bridge-runtime/tools-plugin.js')`,
`const browserPlugin = read('browser-bridge-runtime/tools-plugin.js')
const installer = read('scripts/install-local.ps1')
const internalWorker = read('src/internal-worker.ts')`,'test fixtures')
  const insert = `
  it('keeps internal workers out of the Harness preset roster', () => {
    expect(installer).toContain('Install-LazyPreset -PresetId "patrol"')
    expect(installer).not.toContain('Install-LazyPreset -PresetId "patrol-teaching"')
    expect(installer).not.toContain('Install-LazyPreset -PresetId "patrol-replay"')
    expect(installer).not.toContain('Install-LazyPreset -PresetId "patrol-recovery"')
    expect(installer).toContain('patrol\\internal-workers')
    expect(installer).toContain('Remove-LegacyManagedWorkerPreset')
    expect(internalWorker).toContain("'@deepseek-ai/dsh-agent-presets'")
    expect(internalWorker).toContain('mountPreset')
  })
`
  text = once(text, `  it('isolates heavy teaching, deterministic replay, and exception recovery', () => {`, insert + `\n  it('isolates heavy teaching, deterministic replay, and exception recovery', () => {`, 'add hidden worker test')
  return text
})

await edit('scripts/check-extension.mjs', text => {
  text = once(text,
`const hostPatch = readFileSync(join(projectRoot, 'cordis.patch.yml'), 'utf8')`,
`const internalWorker = readFileSync(join(projectRoot, 'src', 'internal-worker.ts'), 'utf8')
if (!internalWorker.includes("'@deepseek-ai/dsh-agent-presets'")) throw new Error('hidden Patrol workers must load Harness own agent-presets mount implementation')
if (!internalWorker.includes('mountPreset')) throw new Error('hidden Patrol workers must use low-level scoped preset mounting')
const installer = readFileSync(join(projectRoot, 'scripts', 'install-local.ps1'), 'utf8')
if (installer.includes('Install-LazyPreset -PresetId "patrol-teaching"') || installer.includes('Install-LazyPreset -PresetId "patrol-replay"') || installer.includes('Install-LazyPreset -PresetId "patrol-recovery"')) throw new Error('internal Patrol workers must not be installed into Harness user preset discovery')
if (!installer.includes('patrol\\\\internal-workers') || !installer.includes('Remove-LegacyManagedWorkerPreset')) throw new Error('installer must use a non-discoverable internal worker root and remove legacy visible worker presets')

const hostPatch = readFileSync(join(projectRoot, 'cordis.patch.yml'), 'utf8')`,'extension hidden worker checks')
  return text
})

console.log('Applied internal Patrol worker visibility refactor')
