param(
    [string]$HarnessRoot = "",
    [string]$Profile = "web",
    [bool]$InstallCaptchaDemoSolver = $true
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function ConvertTo-YamlSingleQuoted {
    param([Parameter(Mandatory = $true)][string]$Value)
    return $Value.Replace("'", "''")
}

function Install-ClientHostDependency {
    param(
        [Parameter(Mandatory = $true)][string]$ProfileDir,
        [Parameter(Mandatory = $true)][string]$ClientHostRoot
    )

    $profileManifestPath = Join-Path $ProfileDir "package.json"
    if (-not (Test-Path -LiteralPath $profileManifestPath)) {
        throw "Harness profile is not initialized: $ProfileDir. Start the profile once before installing DSH Patrol."
    }

    Push-Location $ProfileDir
    try {
        pnpm add --save-prod $ClientHostRoot
        if ($LASTEXITCODE -ne 0) { throw "failed to install dsh-patrol-client-host into Harness profile $ProfileDir" }
    } finally {
        Pop-Location
    }

    $profileManifest = [System.IO.File]::ReadAllText($profileManifestPath) | ConvertFrom-Json
    $dependency = $profileManifest.dependencies.'dsh-patrol-client-host'
    if ([string]::IsNullOrWhiteSpace([string]$dependency)) {
        throw "Harness profile dependency dsh-patrol-client-host was not recorded in $profileManifestPath"
    }

    $installedManifestPath = Join-Path $ProfileDir "node_modules\dsh-patrol-client-host\package.json"
    if (-not (Test-Path -LiteralPath $installedManifestPath)) {
        throw "Harness profile cannot resolve installed dsh-patrol-client-host: $installedManifestPath"
    }
    $installedManifest = [System.IO.File]::ReadAllText($installedManifestPath) | ConvertFrom-Json
    if ($installedManifest.name -ne "dsh-patrol-client-host" -or $installedManifest.dsh.client.platform -ne "web") {
        throw "Installed dsh-patrol-client-host manifest is missing its web client declaration: $installedManifestPath"
    }
}

function Install-HarnessClientHostCompatMirror {
    param(
        [Parameter(Mandatory = $true)][string]$HarnessRootPath,
        [Parameter(Mandatory = $true)][string]$ClientHostRoot
    )

    $resolvedHarnessRoot = [System.IO.Path]::GetFullPath($HarnessRootPath)
    $nodeModules = Join-Path $resolvedHarnessRoot "node_modules"
    if (-not (Test-Path -LiteralPath $nodeModules)) {
        throw "Harness node_modules does not exist: $nodeModules. Run pnpm install in the Harness checkout first."
    }

    $target = Join-Path $nodeModules "dsh-patrol-client-host"
    $marker = Join-Path $target ".managed-by-dsh-patrol"
    if (Test-Path -LiteralPath $target) {
        if (-not (Test-Path -LiteralPath $marker)) {
            throw "Refusing to replace unmanaged Harness package path: $target"
        }
        Remove-Item -LiteralPath $target -Recurse -Force
    }

    New-Item -ItemType Directory -Force -Path $target | Out-Null
    foreach ($name in @("package.json", "index.js", "client.js")) {
        $source = Join-Path $ClientHostRoot $name
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Patrol client host source file is missing: $source"
        }
        Copy-Item -LiteralPath $source -Destination (Join-Path $target $name) -Force
    }
    Write-Utf8NoBom -Path $marker -Content "managed by dsh-patrol local installer`n"

    $targetManifestPath = Join-Path $target "package.json"
    $targetManifest = [System.IO.File]::ReadAllText($targetManifestPath) | ConvertFrom-Json
    if ($targetManifest.name -ne "dsh-patrol-client-host" -or $targetManifest.dsh.client.platform -ne "web") {
        throw "Harness compatibility mirror has an invalid Patrol client manifest: $targetManifestPath"
    }

    Push-Location $resolvedHarnessRoot
    try {
        $resolvedManifest = (& node -e "console.log(require.resolve('dsh-patrol-client-host/package.json'))" 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($resolvedManifest)) {
            throw "Harness root cannot resolve dsh-patrol-client-host/package.json after compatibility install"
        }
        $expectedManifest = [System.IO.Path]::GetFullPath($targetManifestPath)
        $actualManifest = [System.IO.Path]::GetFullPath($resolvedManifest)
        if ($actualManifest -ne $expectedManifest) {
            throw "Harness root resolves dsh-patrol-client-host from an unexpected location: $actualManifest (expected $expectedManifest)"
        }
    } finally {
        Pop-Location
    }

    return $target
}

function Install-ManagedHostBridgePatch {
    param(
        [Parameter(Mandatory = $true)][string]$PatchPath,
        [Parameter(Mandatory = $true)][string]$BridgeHostUri,
        [Parameter(Mandatory = $true)][string]$ScreenshotDir,
        [Parameter(Mandatory = $true)][string]$WorkerRoot
    )

    $patchDir = Split-Path -Parent $PatchPath
    New-Item -ItemType Directory -Force -Path $patchDir | Out-Null

    $begin = "# BEGIN DSH-PATROL MANAGED HOST BRIDGE"
    $end = "# END DSH-PATROL MANAGED HOST BRIDGE"
    $existing = if (Test-Path $PatchPath) { [System.IO.File]::ReadAllText($PatchPath) } else { "" }
    $pattern = "(?ms)^" + [regex]::Escape($begin) + "\r?\n.*?^" + [regex]::Escape($end) + "\r?\n?"
    $clean = [regex]::Replace($existing, $pattern, "").TrimEnd()
    $safeBridgeHostUri = ConvertTo-YamlSingleQuoted -Value $BridgeHostUri
    $safeScreenshotDir = ConvertTo-YamlSingleQuoted -Value $ScreenshotDir
    $safeWorkerRoot = ConvertTo-YamlSingleQuoted -Value $WorkerRoot

    $block = @"
$begin
- insert:
    - id: dsh-patrol-browser-host
      name: '$safeBridgeHostUri'
      config:
        path: /patrol-browser-bridge
        commandTimeoutMs: 60000
        maxMessageBytes: 8388608
        managedBrowser: true
        browserStartTimeoutMs: 30000
        browserConnectTimeoutMs: 15000
        screenshotDir: '$safeScreenshotDir'
        workerRoot: '$safeWorkerRoot'

    - id: dsh-patrol-client-host
      name: 'dsh-patrol-client-host'
$end
"@

    $next = if ($clean.Length -gt 0) { "$clean`r`n`r`n$block`r`n" } else { "$block`r`n" }
    Write-Utf8NoBom -Path $PatchPath -Content $next
}

function Install-ManagedCleanupPatch {
    param(
        [Parameter(Mandatory = $true)][string]$PatchPath,
        [Parameter(Mandatory = $true)][string]$CleanupUri,
        [Parameter(Mandatory = $true)][string]$ProfileName
    )

    $patchDir = Split-Path -Parent $PatchPath
    New-Item -ItemType Directory -Force -Path $patchDir | Out-Null

    $begin = "# BEGIN DSH-PATROL MANAGED CLEANUP"
    $end = "# END DSH-PATROL MANAGED CLEANUP"
    $existing = if (Test-Path $PatchPath) { [System.IO.File]::ReadAllText($PatchPath) } else { "" }
    $pattern = "(?ms)^" + [regex]::Escape($begin) + "\r?\n.*?^" + [regex]::Escape($end) + "\r?\n?"
    $clean = [regex]::Replace($existing, $pattern, "").TrimEnd()
    $safeUri = ConvertTo-YamlSingleQuoted -Value $CleanupUri
    $safeProfile = ConvertTo-YamlSingleQuoted -Value $ProfileName

    $block = @"
$begin
- insert:
    - id: dsh-patrol-cleanup
      name: '$safeUri'
      config:
        profile: '$safeProfile'
$end
"@

    $next = if ($clean.Length -gt 0) { "$clean`r`n`r`n$block`r`n" } else { "$block`r`n" }
    Write-Utf8NoBom -Path $PatchPath -Content $next
}

function Copy-LegacyPatrolData {
    param(
        [Parameter(Mandatory = $true)][string]$LegacyRoot,
        [Parameter(Mandatory = $true)][string]$WorkspaceRoot
    )

    if (-not (Test-Path -LiteralPath $LegacyRoot)) { return }
    New-Item -ItemType Directory -Force -Path $WorkspaceRoot | Out-Null
    foreach ($name in @("inspections", "runs", "resumes")) {
        $source = Join-Path $LegacyRoot $name
        $target = Join-Path $WorkspaceRoot $name
        if ((Test-Path -LiteralPath $source) -and -not (Test-Path -LiteralPath $target)) {
            Copy-Item -LiteralPath $source -Destination $target -Recurse -Force
            Write-Host "Migrated legacy Patrol $name into workspace storage." -ForegroundColor Yellow
        }
    }
}

function Remove-LegacyManagedWorkerPreset {
    param(
        [Parameter(Mandatory = $true)][string]$DshHomePath,
        [Parameter(Mandatory = $true)][string]$PresetId
    )
    $legacyDir = Join-Path $DshHomePath ".agent-presets\$PresetId"
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

function Install-LazyPreset {
    param(
        [Parameter(Mandatory = $true)][string]$PresetId,
        [Parameter(Mandatory = $true)][string]$AgentYaml,
        [Parameter(Mandatory = $true)][string]$DshHomePath,
        [Parameter(Mandatory = $true)][string]$ProjectRootPath
    )

    $presetDir = Join-Path $DshHomePath ".agent-presets\$PresetId"
    New-Item -ItemType Directory -Force -Path $presetDir | Out-Null
    $metadataSource = Join-Path $ProjectRootPath "presets\$PresetId\preset.yml"
    $metadataTarget = Join-Path $presetDir "preset.yml"
    Copy-Item -LiteralPath $metadataSource -Destination $metadataTarget -Force
    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $metadataSource).Hash
    $targetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $metadataTarget).Hash
    if ($sourceHash -ne $targetHash) {
        throw "$PresetId preset.yml copy verification failed"
    }
    Write-Utf8NoBom -Path (Join-Path $presetDir "agent.cordis.yml") -Content $AgentYaml
    Write-Utf8NoBom -Path (Join-Path $presetDir ".managed-by-dsh-patrol") -Content "managed by dsh-patrol local installer`n"
    return $presetDir
}

Write-Host "===== Build and verify DSH Patrol =====" -ForegroundColor Cyan
Push-Location $ProjectRoot
try {
    pnpm install
    if ($LASTEXITCODE -ne 0) { throw "pnpm install failed" }
    pnpm typecheck
    if ($LASTEXITCODE -ne 0) { throw "typecheck failed" }
    pnpm test
    if ($LASTEXITCODE -ne 0) { throw "tests failed" }
    pnpm check:extension
    if ($LASTEXITCODE -ne 0) { throw "extension checks failed" }
    pnpm check:encoding
    if ($LASTEXITCODE -ne 0) { throw "encoding checks failed" }
    pnpm build
    if ($LASTEXITCODE -ne 0) { throw "build failed" }
} finally {
    Pop-Location
}

if ($InstallCaptchaDemoSolver) {
    try {
        & (Join-Path $PSScriptRoot "install-captcha-demo.ps1") -ProjectRoot $ProjectRoot
    } catch {
        Write-Warning "Optional owned-site CAPTCHA demo solver was not installed: $($_.Exception.Message)"
        Write-Warning "Core Patrol remains installed. After fixing Python/network prerequisites, run scripts\install-captcha-demo.ps1 manually."
    }
}

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$ProfileDir = Join-Path $DshHome "profiles\$Profile"

$WorkspaceRoot = if ($HarnessRoot) { [System.IO.Path]::GetFullPath($HarnessRoot) } else { [System.IO.Path]::GetFullPath((Get-Location).Path) }
if (-not (Test-Path -LiteralPath $WorkspaceRoot)) {
    throw "Harness workspace does not exist: $WorkspaceRoot"
}
$PatrolStorage = Join-Path $WorkspaceRoot ".dsh-patrol"
$PatrolScreenshotDir = Join-Path $PatrolStorage "browser-tmp"
$InternalWorkerRoot = Join-Path $DshHome "patrol\internal-workers"
New-Item -ItemType Directory -Force -Path $PatrolStorage | Out-Null
New-Item -ItemType Directory -Force -Path $PatrolScreenshotDir | Out-Null
Copy-LegacyPatrolData -LegacyRoot (Join-Path $DshHome "patrol") -WorkspaceRoot $PatrolStorage

$CredentialHelperSource = Join-Path $ProjectRoot "scripts\set-patrol-credential.ps1"
$CredentialHelperTarget = Join-Path $PatrolStorage "set-patrol-credential.ps1"
Copy-Item -LiteralPath $CredentialHelperSource -Destination $CredentialHelperTarget -Force
$CredentialHelperSourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CredentialHelperSource).Hash
$CredentialHelperTargetHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $CredentialHelperTarget).Hash
if ($CredentialHelperSourceHash -ne $CredentialHelperTargetHash) {
    throw "credential helper copy verification failed"
}

$PatrolIndex = (New-Object System.Uri((Resolve-Path (Join-Path $ProjectRoot "lib\index.js")))).AbsoluteUri
$BridgeHostIndex = (New-Object System.Uri((Resolve-Path (Join-Path $ProjectRoot "browser-bridge-runtime\index.js")))).AbsoluteUri
$ClientHostRoot = [System.IO.Path]::GetFullPath((Join-Path $ProjectRoot "client-host-runtime"))
$BrowserToolsIndex = (New-Object System.Uri((Resolve-Path (Join-Path $ProjectRoot "browser-bridge-runtime\tools-plugin.js")))).AbsoluteUri
$SafeStoragePath = ConvertTo-YamlSingleQuoted -Value $PatrolStorage
$SafeWorkerRoot = ConvertTo-YamlSingleQuoted -Value $InternalWorkerRoot

# Newer Harness versions resolve client rows from the profile's dependency
# closure, while dsh@0.1.1-rc.2 (b150a55) resolves them from the Harness config
# tree's ctx.baseUrl. Install both surfaces so the same Patrol checkout works on
# either loader implementation without asking the user to upgrade Harness.
Install-ClientHostDependency -ProfileDir $ProfileDir -ClientHostRoot $ClientHostRoot
$HarnessClientHostMirror = $null
if ($HarnessRoot) {
    $HarnessClientHostMirror = Install-HarnessClientHostCompatMirror -HarnessRootPath $HarnessRoot -ClientHostRoot $ClientHostRoot
}

# Keep this PowerShell source ASCII-only for Windows PowerShell 5.1 compatibility.
# Agent persona text uses YAML unicode escapes; preset metadata is copied as raw
# UTF-8 bytes from the source tree.
$ShellAgentYaml = @"
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: "\u4f60\u662f DSH Patrol \u8f7b\u91cf\u5de1\u68c0\u5165\u53e3 Agent\u3002\u8fd0\u884c\u5df2\u6709\u6d41\u7a0b\u65f6\u8c03\u7528 patrol_run_flow\uff1b\u521b\u5efa\u3001\u91cd\u6559\u6216\u4fee\u6539\u6d41\u7a0b\u65f6\u8c03\u7528 patrol_start_teaching\u3002\u4e0d\u8981\u4e3a\u666e\u901a\u5bf9\u8bdd\u52a0\u8f7d\u6d4f\u89c8\u5668\u3001\u6587\u4ef6\u3001SSH \u6216 Excel \u91cd\u80fd\u529b\u3002"

- id: dsh-patrol-shell
  name: '$PatrolIndex'
  config:
    profile: shell
    storagePath: '$SafeStoragePath'
    maxSteps: 50
    reportMaxChars: 10000
    workerRoot: '$SafeWorkerRoot'
"@

$TeachingAgentYaml = @"
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: "\u4f60\u662f DSH Patrol Teaching Worker\u3002\u53ea\u8d1f\u8d23\u521b\u5efa\u3001\u91cd\u6559\u6216\u4fee\u6539 Runbook\uff0c\u4e0d\u8981\u628a\u660e\u6587\u51ed\u636e\u3001OTP \u6216\u9a8c\u8bc1\u7801\u7b54\u6848\u5199\u5165 Runbook\u3002"

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'

- id: browser-tools
  name: '$BrowserToolsIndex'
  config:
    profile: teaching
    commandTimeoutMs: 60000

- id: dsh-patrol
  name: '$PatrolIndex'
  config:
    profile: teaching
    storagePath: '$SafeStoragePath'
    maxSteps: 200
    reportMaxChars: 30000
"@

$ReplayAgentYaml = @"
- id: browser-tools
  name: '$BrowserToolsIndex'
  config:
    profile: replay
    commandTimeoutMs: 60000

- id: dsh-patrol
  name: '$PatrolIndex'
  config:
    profile: replay
    storagePath: '$SafeStoragePath'
    maxSteps: 200
    reportMaxChars: 30000
"@

$RecoveryAgentYaml = @"
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    text: "\u4f60\u662f DSH Patrol \u5f02\u5e38\u6062\u590d Worker\u3002\u53ea\u5904\u7406 deterministic runner \u5f53\u524d\u6682\u505c\u7684\u4e00\u4e2a\u5f02\u5e38\uff0c\u4e0d\u4ece\u5934\u91cd\u8dd1\u3001\u4e0d\u4fee\u6539 Runbook\u3002\u89e3\u9664\u963b\u585e\u540e\u8c03\u7528 patrol_resume_after_recovery \u4ea4\u8fd8 Runner\u3002"

- id: browser-tools
  name: '$BrowserToolsIndex'
  config:
    profile: recovery
    commandTimeoutMs: 60000

- id: dsh-patrol
  name: '$PatrolIndex'
  config:
    profile: recovery
    storagePath: '$SafeStoragePath'
    maxSteps: 50
    reportMaxChars: 10000
"@

$PresetDir = Install-LazyPreset -PresetId "patrol" -AgentYaml $ShellAgentYaml -DshHomePath $DshHome -ProjectRootPath $ProjectRoot
foreach ($legacyWorkerId in @("patrol-teaching", "patrol-replay", "patrol-recovery")) {
    Remove-LegacyManagedWorkerPreset -DshHomePath $DshHome -PresetId $legacyWorkerId
}
$TeachingWorkerPath = Install-InternalWorkerComposition -WorkerRoot $InternalWorkerRoot -WorkerId "teaching" -AgentYaml $TeachingAgentYaml
$ReplayWorkerPath = Install-InternalWorkerComposition -WorkerRoot $InternalWorkerRoot -WorkerId "replay" -AgentYaml $ReplayAgentYaml
$RecoveryWorkerPath = Install-InternalWorkerComposition -WorkerRoot $InternalWorkerRoot -WorkerId "recovery" -AgentYaml $RecoveryAgentYaml

# Copy a self-contained cleanup plugin outside the source checkout. If the
# local Patrol source is later uninstalled, this small Node-only plugin can
# remove stale preset/browser integration on the next Harness boot.
$PatrolRuntimeDir = Join-Path $DshHome "patrol"
New-Item -ItemType Directory -Force -Path $PatrolRuntimeDir | Out-Null
$CleanupSource = Join-Path $ProjectRoot "cleanup-runtime\index.js"
$CleanupTarget = Join-Path $PatrolRuntimeDir "integration-cleanup.mjs"
Copy-Item -LiteralPath $CleanupSource -Destination $CleanupTarget -Force
$CleanupUri = (New-Object System.Uri((Resolve-Path $CleanupTarget))).AbsoluteUri

$WebPatch = Join-Path $ProfileDir "cordis.patch.yml"
Install-ManagedHostBridgePatch -PatchPath $WebPatch -BridgeHostUri $BridgeHostIndex -ScreenshotDir $PatrolScreenshotDir -WorkerRoot $InternalWorkerRoot
Install-ManagedCleanupPatch -PatchPath $WebPatch -CleanupUri $CleanupUri -ProfileName $Profile

if (Test-Path $WebPatch) {
    $patchText = [System.IO.File]::ReadAllText($WebPatch)
    if (-not $patchText.Contains("id: dsh-patrol-client-host") -or -not $patchText.Contains("name: 'dsh-patrol-client-host'")) {
        throw "Patrol web client host package row was not written to profile patch: $WebPatch"
    }
    $oldGlobal = Select-String -Path $WebPatch -Pattern "^\s*-?\s*id:\s*dsh-patrol\s*$|DSH-Patrol/lib/index" -Quiet
    if ($oldGlobal) {
        Write-Warning "The profile patch still appears to contain an old global DSH Patrol row: $WebPatch. Remove that old row so Patrol orchestration is available only in the dedicated Patrol preset."
    }
}

Write-Host ""
Write-Host "Local Patrol shell preset installed and UTF-8 verified: $PresetDir" -ForegroundColor Green
Write-Host "Internal Patrol teaching worker installed (hidden from preset picker): $TeachingWorkerPath" -ForegroundColor Green
Write-Host "Internal Patrol replay worker installed (hidden from preset picker): $ReplayWorkerPath" -ForegroundColor Green
Write-Host "Internal Patrol recovery worker installed (hidden from preset picker): $RecoveryWorkerPath" -ForegroundColor Green
Write-Host "Host browser bridge patch installed: $WebPatch" -ForegroundColor Green
Write-Host "Patrol web client package installed into profile: $ProfileDir" -ForegroundColor Green
if ($HarnessClientHostMirror) {
    Write-Host "Patrol web client compatibility mirror installed: $HarnessClientHostMirror" -ForegroundColor Green
}
Write-Host "Lifecycle cleanup coordinator installed: $CleanupTarget" -ForegroundColor Green
Write-Host "Patrol workspace storage: $PatrolStorage" -ForegroundColor Green
Write-Host "Patrol screenshot temp storage: $PatrolScreenshotDir" -ForegroundColor Green
Write-Host "Patrol credential helper: $CredentialHelperTarget" -ForegroundColor Green
Write-Host "Browser provisioning: lazy; Chromium starts only when teaching, replay, or recovery needs browser capabilities." -ForegroundColor Green
if ($HarnessRoot) {
    Write-Host "Start Harness with:" -ForegroundColor Cyan
    Write-Host "  cd $HarnessRoot"
    Write-Host "  pnpm dsh web"
} else {
    Write-Host "Start your Harness normally with: pnpm dsh web" -ForegroundColor Cyan
}
Write-Host "Then open a NEW session and choose the Patrol preset. Normal Patrol chat stays lightweight; browser workers are created only on demand." -ForegroundColor Cyan
