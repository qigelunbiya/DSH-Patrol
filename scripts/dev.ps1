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

# pnpm dsh web starts Node with --import tsx and then loads the whole Harness
# workspace graph. A partially populated/stale Harness node_modules can therefore
# fail as a bare ERR_MODULE_NOT_FOUND before Patrol itself starts. Repair the
# frozen workspace dependency closure on every dev launch; pnpm is effectively a
# no-op when the lockfile and node_modules are already current.
Write-Host "===== Verify DeepSeek Harness dependencies =====" -ForegroundColor Cyan
Push-Location $HarnessRoot
try {
    $harnessLock = Join-Path $HarnessRoot "pnpm-lock.yaml"
    if (-not (Test-Path -LiteralPath $harnessLock)) {
        throw "Harness pnpm-lock.yaml is missing: $harnessLock"
    }
    Invoke-NativeChecked pnpm install --frozen-lockfile --prefer-offline
    Invoke-NativeChecked node -e "import('tsx').then(()=>console.log('Harness ESM dependency probe: OK')).catch(error=>{console.error(error);process.exit(1)})"
} finally {
    Pop-Location
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
