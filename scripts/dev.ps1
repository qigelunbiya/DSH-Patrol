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

function Test-HarnessRuntimeDependencies {
    param([Parameter(Mandatory = $true)][string]$HarnessRootPath)

    $probe = @'
const path = require('node:path')
const failures = []
const resolveFrom = (relativeDir, name) => require.resolve(name, { paths: [path.join(process.cwd(), relativeDir)] })
const checks = [
  ['tsx', () => require.resolve('tsx')],
  ['esbuild', () => {
    const esbuild = require(resolveFrom('packages/llm/llm-pi-ai', 'esbuild'))
    esbuild.transformSync('const __dsh_patrol_probe = 1')
  }],
  ['sharp', () => {
    const sharp = require(resolveFrom('packages/attachment/attachment-local', 'sharp'))
    if (!sharp || !sharp.versions || !sharp.versions.sharp) throw new Error('sharp native runtime unavailable')
  }],
  ['koffi', () => {
    require(resolveFrom('packages/subprocess/subprocess-local', 'koffi'))
  }],
]
for (const [name, check] of checks) {
  try {
    check()
  } catch (error) {
    failures.push(name + ': ' + (error && error.message ? error.message : String(error)))
  }
}
if (failures.length > 0) {
  console.error(failures.join('\n'))
  process.exit(1)
}
console.log('Harness runtime dependency probe: OK')
'@

    Push-Location $HarnessRootPath
    try {
        $previousErrorActionPreference = $ErrorActionPreference
        $ErrorActionPreference = "Continue"
        try {
            $probeOutput = (& node -e $probe 2>&1 | Out-String).Trim()
            $ok = $LASTEXITCODE -eq 0
        } finally {
            $ErrorActionPreference = $previousErrorActionPreference
        }
        if ($ok) {
            Write-Host $probeOutput -ForegroundColor Green
        } else {
            Write-Warning "Harness runtime dependency probe failed:"
            if (-not [string]::IsNullOrWhiteSpace($probeOutput)) {
                Write-Warning $probeOutput
            }
        }
        return $ok
    } finally {
        Pop-Location
    }
}

function Repair-HarnessRuntimeDependencies {
    param([Parameter(Mandatory = $true)][string]$HarnessRootPath)

    $manifestPath = Join-Path $HarnessRootPath "package.json"
    if (-not (Test-Path -LiteralPath $manifestPath)) {
        throw "Harness package.json is missing: $manifestPath"
    }
    $manifest = [System.IO.File]::ReadAllText($manifestPath) | ConvertFrom-Json
    if ([string]$manifest.version -ne "0.1.1-rc.2") {
        Write-Host "Harness version $($manifest.version) is not rc2; skipping the rc2-specific runtime repair." -ForegroundColor DarkGray
        return
    }

    if (Test-HarnessRuntimeDependencies -HarnessRootPath $HarnessRootPath) {
        return
    }

    Write-Warning "Harness native/runtime dependencies are incomplete. Running one guarded forced reinstall of the Harness lockfile."
    Write-Warning "This repair runs only after the runtime probe fails; normal Patrol launches never reinstall the Harness workspace."

    Push-Location $HarnessRootPath
    try {
        Invoke-NativeChecked pnpm install --force --frozen-lockfile
    } finally {
        Pop-Location
    }

    if (-not (Test-HarnessRuntimeDependencies -HarnessRootPath $HarnessRootPath)) {
        throw "Harness runtime dependencies are still invalid after the guarded repair. Refusing to start pnpm dsh web."
    }
}

function Get-NodeModulePackagePath {
    param(
        [Parameter(Mandatory = $true)][string]$NodeModulesPath,
        [Parameter(Mandatory = $true)][string]$PackageName
    )

    $path = $NodeModulesPath
    foreach ($segment in $PackageName.Split('/')) {
        if ([string]::IsNullOrWhiteSpace($segment)) { continue }
        $path = Join-Path $path $segment
    }
    return $path
}

function Restore-Rc2ProfileDependencyMirrors {
    param(
        [Parameter(Mandatory = $true)][string]$HarnessRootPath,
        [Parameter(Mandatory = $true)][string]$ProfileName
    )

    $harnessManifestPath = Join-Path $HarnessRootPath "package.json"
    if (-not (Test-Path -LiteralPath $harnessManifestPath)) { return }

    $harnessManifest = [System.IO.File]::ReadAllText($harnessManifestPath) | ConvertFrom-Json
    if ([string]$harnessManifest.version -ne "0.1.1-rc.2") { return }

    $dshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
    $profileDir = Join-Path $dshHome "profiles\$ProfileName"
    $profileManifestPath = Join-Path $profileDir "package.json"
    if (-not (Test-Path -LiteralPath $profileManifestPath)) { return }

    $profileManifest = [System.IO.File]::ReadAllText($profileManifestPath) | ConvertFrom-Json
    $dependencies = $profileManifest.dependencies
    if ($null -eq $dependencies) { return }

    $profileNodeModules = Join-Path $profileDir "node_modules"
    $harnessNodeModules = Join-Path $HarnessRootPath "node_modules"
    if (-not (Test-Path -LiteralPath $harnessNodeModules)) {
        throw "Harness node_modules does not exist after runtime repair: $harnessNodeModules"
    }

    foreach ($dependency in $dependencies.PSObject.Properties) {
        $name = [string]$dependency.Name
        if ([string]::IsNullOrWhiteSpace($name) -or $name -eq "dsh-patrol-client-host") { continue }

        $source = Get-NodeModulePackagePath -NodeModulesPath $profileNodeModules -PackageName $name
        $target = Get-NodeModulePackagePath -NodeModulesPath $harnessNodeModules -PackageName $name

        $existingTarget = Get-Item -LiteralPath $target -Force -ErrorAction SilentlyContinue
        if ($null -ne $existingTarget) {
            continue
        }
        if (-not (Test-Path -LiteralPath $source)) {
            throw "Harness rc2 profile dependency is declared but not installed: $name ($source)"
        }

        $targetParent = Split-Path -Parent $target
        New-Item -ItemType Directory -Force -Path $targetParent | Out-Null
        $resolvedSource = (Resolve-Path -LiteralPath $source).Path
        $linkType = if ($env:OS -eq "Windows_NT") { "Junction" } else { "SymbolicLink" }
        New-Item -ItemType $linkType -Path $target -Target $resolvedSource | Out-Null
        Write-Host "Restored Harness rc2 profile dependency resolver link: $name" -ForegroundColor Yellow
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

Write-Host "===== Verify DeepSeek Harness runtime =====" -ForegroundColor Cyan
Repair-HarnessRuntimeDependencies -HarnessRootPath $HarnessRoot

Write-Host "===== Build and install DSH Patrol =====" -ForegroundColor Cyan
& (Join-Path $PSScriptRoot "install-local.ps1") `
    -HarnessRoot $HarnessRoot `
    -Profile $Profile `
    -InstallCaptchaDemoSolver $InstallCaptchaDemoSolver
if ($LASTEXITCODE -ne 0) {
    throw "install-local.ps1 failed with exit code $LASTEXITCODE"
}

# dsh 0.1.1-rc.2 resolves bare profile package rows from the Harness root.
# A forced repair correctly restores the official workspace but removes
# profile-only resolver links. Recreate only missing profile dependency links;
# never overwrite a package already owned by the Harness workspace.
Restore-Rc2ProfileDependencyMirrors -HarnessRootPath $HarnessRoot -ProfileName $Profile

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
