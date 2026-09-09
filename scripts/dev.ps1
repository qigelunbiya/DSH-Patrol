param(
    [string]$HarnessRoot = "",
    [string]$Profile = "web",
    [switch]$SkipPull,
    [switch]$NoStart,
    [bool]$InstallCaptchaDemoSolver = $true
)

$ErrorActionPreference = "Stop"
$ProjectRoot = Split-Path -Parent $PSScriptRoot

function Invoke-NativeChecked {
    param(
        [Parameter(Mandatory = $true)][string]$FilePath,
        [Parameter(ValueFromRemainingArguments = $true)][string[]]$Arguments
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$FilePath failed with exit code $LASTEXITCODE"
    }
}

if ([string]::IsNullOrWhiteSpace($HarnessRoot)) {
    $workspaceRoot = Split-Path -Parent $ProjectRoot
    $candidate = Join-Path $workspaceRoot "deepseek-harness"
    if (Test-Path -LiteralPath $candidate) {
        $HarnessRoot = $candidate
    } else {
        throw "HarnessRoot was not provided and the sibling checkout was not found: $candidate"
    }
}

$HarnessRoot = [System.IO.Path]::GetFullPath($HarnessRoot)
if (-not (Test-Path -LiteralPath $HarnessRoot)) {
    throw "Harness checkout does not exist: $HarnessRoot"
}

if (-not $SkipPull) {
    Write-Host "===== Update DSH Patrol main =====" -ForegroundColor Cyan
    Push-Location $ProjectRoot
    try {
        $status = (& git status --porcelain 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "git status failed: $status"
        }
        if (-not [string]::IsNullOrWhiteSpace($status)) {
            throw "DSH Patrol has local changes. Commit/stash them first, or rerun with -SkipPull."
        }

        $branch = (& git branch --show-current 2>&1 | Out-String).Trim()
        if ($LASTEXITCODE -ne 0) {
            throw "git branch --show-current failed: $branch"
        }
        if ($branch -ne "main") {
            Invoke-NativeChecked git checkout main
        }
        Invoke-NativeChecked git pull --ff-only origin main
    } finally {
        Pop-Location
    }
}

Write-Host "===== Build and install DSH Patrol =====" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "install-local.ps1") `
    -HarnessRoot $HarnessRoot `
    -Profile $Profile `
    -InstallCaptchaDemoSolver $InstallCaptchaDemoSolver
if ($LASTEXITCODE -ne 0) {
    throw "install-local.ps1 failed with exit code $LASTEXITCODE"
}

if (-not $NoStart) {
    Write-Host "===== Start DeepSeek Harness =====" -ForegroundColor Cyan
    Push-Location $HarnessRoot
    try {
        Invoke-NativeChecked pnpm dsh web
    } finally {
        Pop-Location
    }
} else {
    Write-Host "DSH Patrol is installed. Harness start was skipped (-NoStart)." -ForegroundColor Green
}
