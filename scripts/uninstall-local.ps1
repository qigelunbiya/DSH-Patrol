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

function Remove-ManagedHostBridgePatch {
    param([Parameter(Mandatory = $true)][string]$PatchPath)
    if (-not (Test-Path -LiteralPath $PatchPath)) { return }
    $begin = "# BEGIN DSH-PATROL MANAGED HOST BRIDGE"
    $end = "# END DSH-PATROL MANAGED HOST BRIDGE"
    $existing = [System.IO.File]::ReadAllText($PatchPath)
    $pattern = "(?ms)^" + [regex]::Escape($begin) + "\r?\n.*?^" + [regex]::Escape($end) + "\r?\n?"
    $next = [regex]::Replace($existing, $pattern, "").TrimEnd()
    if ($next.Length -gt 0) { $next += "`r`n" }
    Write-Utf8NoBom -Path $PatchPath -Content $next
}

$DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
$PatrolRoot = Join-Path $DshHome "patrol"
$ProfilePath = Join-Path $PatrolRoot "browser-profile"
$StatePath = Join-Path $PatrolRoot "managed-browser.json"
$TrustPath = Join-Path $PatrolRoot "trusted-extension-origin.txt"
$PresetDir = Join-Path $DshHome ".agent-presets\patrol"
$WebPatch = Join-Path $DshHome "profiles\$Profile\cordis.patch.yml"

if (Test-Path -LiteralPath $StatePath) {
    try {
        $state = Get-Content -Raw -LiteralPath $StatePath | ConvertFrom-Json
        $pidValue = [int]$state.pid
        if ($pidValue -gt 0) {
            $process = Get-Process -Id $pidValue -ErrorAction SilentlyContinue
            if ($null -ne $process) {
                $safeToStop = $true
                if ($IsWindows -or $env:OS -eq "Windows_NT") {
                    try {
                        $cim = Get-CimInstance Win32_Process -Filter "ProcessId = $pidValue" -ErrorAction Stop
                        if ($null -ne $cim.CommandLine -and $cim.CommandLine -notlike "*$ProfilePath*") {
                            $safeToStop = $false
                        }
                    } catch {
                        $safeToStop = $false
                    }
                }
                if ($safeToStop) {
                    Stop-Process -Id $pidValue -Force -ErrorAction SilentlyContinue
                }
            }
        }
    } catch {
        Write-Warning "Could not validate/stop the managed Patrol browser process: $($_.Exception.Message)"
    }
}

Remove-ManagedHostBridgePatch -PatchPath $WebPatch
Remove-Item -LiteralPath $PresetDir -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $ProfilePath -Recurse -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $StatePath -Force -ErrorAction SilentlyContinue
Remove-Item -LiteralPath $TrustPath -Force -ErrorAction SilentlyContinue

if ($PurgePatrolData) {
    Remove-Item -LiteralPath (Join-Path $PatrolRoot "inspections") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $PatrolRoot "runs") -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath (Join-Path $PatrolRoot "resumes") -Recurse -Force -ErrorAction SilentlyContinue
}

Write-Host "DSH Patrol local integration removed." -ForegroundColor Green
Write-Host "Managed browser profile and bundled-extension registration removed: $ProfilePath" -ForegroundColor Green
if (-not $PurgePatrolData) {
    Write-Host "Inspection definitions and reports were preserved under: $PatrolRoot" -ForegroundColor Cyan
}
