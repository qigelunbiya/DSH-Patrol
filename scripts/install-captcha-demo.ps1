param(
    [string]$ProjectRoot = ""
)

$ErrorActionPreference = "Stop"
if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent $PSScriptRoot
}
$ProjectRoot = [System.IO.Path]::GetFullPath($ProjectRoot)
$VenvRoot = Join-Path $ProjectRoot ".captcha-demo-venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"

function Resolve-BasePython {
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        return @{ File = $py.Source; PrefixArgs = @("-3") }
    }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        return @{ File = $python.Source; PrefixArgs = @() }
    }
    throw "Python 3.10+ was not found. Install Python for Windows, then rerun scripts\install-captcha-demo.ps1."
}

function Invoke-Python {
    param(
        [Parameter(Mandatory = $true)]$Command,
        [Parameter(Mandatory = $true)][string[]]$ExtraArgs
    )
    $file = [string]$Command.File
    $prefixArgs = @($Command.PrefixArgs)
    & $file @prefixArgs @ExtraArgs
    if ($LASTEXITCODE -ne 0) { throw "Python command failed with exit code $LASTEXITCODE" }
}

$base = Resolve-BasePython
$versionCode = "import sys; ok=(sys.version_info.major==3 and sys.version_info.minor>=10); print(sys.version.split()[0]); raise SystemExit(0 if ok else 2)"
Invoke-Python -Command $base -ExtraArgs @("-c", $versionCode)

if (-not (Test-Path -LiteralPath $VenvPython)) {
    Write-Host "Creating CAPTCHA demo Python environment: $VenvRoot" -ForegroundColor Cyan
    Invoke-Python -Command $base -ExtraArgs @("-m", "venv", $VenvRoot)
}

Write-Host "Installing ddddocr 1.6.1 into the CAPTCHA demo environment..." -ForegroundColor Cyan
& $VenvPython -m pip install --disable-pip-version-check --upgrade "ddddocr==1.6.1"
if ($LASTEXITCODE -ne 0) { throw "pip install ddddocr==1.6.1 failed" }

& $VenvPython -c "import ddddocr; print('ddddocr import ok')"
if ($LASTEXITCODE -ne 0) { throw "ddddocr verification failed" }

Write-Host "CAPTCHA demo solver ready: $VenvPython" -ForegroundColor Green
Write-Host "Ordered-click and slider demos are enabled when the page exposes explicit data-dsh-patrol-captcha-* markup." -ForegroundColor Yellow
