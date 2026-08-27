param(
    [string]$Profile = "web",
    [switch]$PurgePatrolData
)

$ErrorActionPreference = "Stop"

function Write-Utf8NoBom {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Remove-ManagedBlock {
    param(
        [Parameter(Mandatory = $true)][string]$PatchPath,
        [Parameter(Mandatory = $true)][string]$Begin,
        [Parameter(Mandatory = $true)][string]$End
    )
    if (-not (Test-Path -LiteralPath $PatchPath)) { return }
    $existing = [System.IO.File]::ReadAllText($PatchPath)
    $pattern = "(?ms)^" + [regex]::Escape($Begin) + "\r?\n.*?^" + [regex]::Escape($End) + "\r?\n?"
    $next = [regex]::Replace($existing, $pattern, "").TrimEnd()
    if ($next.Length -gt 0) { $next += "`r`n" }
    if ($next -ne $existing) { Write-Utf8NoBom -Path $PatchPath -Content $next }
}

function Test-ManifestReferencesPatrol {
    param([Parameter(Mandatory = $true)][string]$PackagePath)
    if (-not (Test-Path -LiteralPath $PackagePath)) { return $false }
    try {
        $manifest = [System.IO.File]::ReadAllText($PackagePath) | ConvertFrom-Json
    } catch {
        return $false
    }

    foreach ($sectionName in @("dependencies", "devDependencies", "optionalDependencies")) {
        $section = $manifest.$sectionName
        if ($null -eq $section) { continue }
        foreach ($property in $section.PSObject.Properties) {
            if ($property.Name -eq "dsh-patrol") { return $true }
            $spec = [string]$property.Value
            if ($spec -match "(?i)qigelunbiya[\\/]DSH-Patrol") { return $true }
            if ($spec -match "(?i)(^|[/:@])dsh-patrol([#@/:]|$)") { return $true }
        }
    }
    return $false
}

function Test-ProfileHasPatrol {
    param([Parameter(Mandatory = $true)][string]$ProfileDir)
    if (Test-ManifestReferencesPatrol -PackagePath (Join-Path $ProfileDir "package.json")) { return $true }
    $patch = Join-Path $ProfileDir "cordis.patch.yml"
    if (Test-Path -LiteralPath $patch) {
        $text = [System.IO.File]::ReadAllText($patch)
        if ($text.Contains("# BEGIN DSH-PATROL MANAGED HOST BRIDGE")) { return $true }
    }
    return $false
}

function Test-AnyProfileHasPatrol {
    param([Parameter(Mandatory = $true)][string]$DshHome)
    $profiles = Join-Path $DshHome "profiles"
    if (-not (Test-Path -LiteralPath $profiles)) { return $false }
    foreach ($dir in Get-ChildItem -LiteralPath $profiles -Directory -ErrorAction SilentlyContinue) {
        if (Test-ProfileHasPatrol -ProfileDir $dir.FullName) { return $true }
    }
    return $false
}

function Stop-ManagedPatrolBrowser {
    param(
        [Parameter(Mandatory = $true)][string]$StatePath,
        [Parameter(Mandatory = $true)][string]$ProfilePath
    )
    if (-not (Test-Path -LiteralPath $StatePath)) { return }
    try {
        $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
        $pidValue = [int]$state.pid
        if ($pidValue -le 0) { return }
        $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
        if ($null -eq $process) { return }

        $safeToStop = $true
        if ($env:OS -eq "Windows_NT") {
            try {
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop
                if ($null -eq $cim.CommandLine -or $cim.CommandLine -notlike "*$ProfilePath*") {
                    $safeToStop = $false
                }
            } catch {
                $safeToStop = $false
            }
        }
        if ($safeToStop) { Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue }
    } catch {
        Write-Warning "Could not validate/stop the managed Patrol browser process: $($_.Exception.Message)"
    }
}

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$PatrolRoot = Join-Path $DshHome "patrol"
$ProfilePath = Join-Path $PatrolRoot "browser-profile"
$StatePath = Join-Path $PatrolRoot "managed-browser.json"
$TrustPath = Join-Path $PatrolRoot "trusted-extension-origin.txt"
$BridgeTempPath = Join-Path $PatrolRoot "browser-bridge"
$CleanupRuntimePath = Join-Path $PatrolRoot "integration-cleanup.mjs"
$PresetDir = Join-Path $DshHome ".agent-presets\patrol"
$PresetMarker = Join-Path $PresetDir ".managed-by-dsh-patrol"
$WebPatch = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"

Remove-ManagedBlock -PatchPath $WebPatch -Begin "# BEGIN DSH-PATROL MANAGED HOST BRIDGE" -End "# END DSH-PATROL MANAGED HOST BRIDGE"
Remove-ManagedBlock -PatchPath $WebPatch -Begin "# BEGIN DSH-PATROL MANAGED CLEANUP" -End "# END DSH-PATROL MANAGED CLEANUP"

$AnotherInstallIsActive = Test-AnyProfileHasPatrol -DshHome $DshHome
if (-not $AnotherInstallIsActive) {
    Stop-ManagedPatrolBrowser -StatePath $StatePath -ProfilePath $ProfilePath

    if (Test-Path -LiteralPath $PresetMarker) {
        Remove-Item -LiteralPath $PresetDir -Recurse -Force -ErrorAction SilentlyContinue
    } elseif (Test-Path -LiteralPath $PresetDir) {
        Write-Warning "Patrol preset has no managed marker and is treated as user-owned; preserving: $PresetDir"
    }

    Remove-Item -LiteralPath $ProfilePath -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $TrustPath -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $BridgeTempPath -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath $CleanupRuntimePath -Force -ErrorAction SilentlyContinue

    if ($PurgePatrolData) {
        Remove-Item -LiteralPath (Join-Path $PatrolRoot "inspections") -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $PatrolRoot "runs") -Recurse -Force -ErrorAction SilentlyContinue
        Remove-Item -LiteralPath (Join-Path $PatrolRoot "resumes") -Recurse -Force -ErrorAction SilentlyContinue
    }
} else {
    Write-Host "Another Harness profile still uses DSH Patrol; shared preset/browser integration was preserved." -ForegroundColor Cyan
    if ($PurgePatrolData) {
        Write-Warning "PurgePatrolData was skipped because another profile still uses the shared Patrol data root."
    }
}

Write-Host "DSH Patrol local integration removed from profile: $Profile" -ForegroundColor Green
if (-not $AnotherInstallIsActive -and -not $PurgePatrolData) {
    Write-Host "Inspection definitions and historical reports were preserved under: $PatrolRoot" -ForegroundColor Cyan
}
