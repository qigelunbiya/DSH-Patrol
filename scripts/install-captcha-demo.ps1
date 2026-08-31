param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot)
)

$ErrorActionPreference = "Stop"
$ProjectRoot = (Resolve-Path $ProjectRoot).Path
$VenvRoot = Join-Path $ProjectRoot ".captcha-demo-venv"
$VenvPython = Join-Path $VenvRoot "Scripts\python.exe"

function Find-Python {
    $py = Get-Command py.exe -ErrorAction SilentlyContinue
    if ($py) {
        return @($py.Source, "-3")
    }
    $python = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($python) {
        return @($python.Source)
    }
    throw "Python 3.10+ is required for the optional ddddocr CAPTCHA demo solver. Install Python and rerun this script."
}

function Invoke-Python {
    param(
        [string[]]$Command,
        [string[]]$ExtraArgs
    )
    $exe = $Command[0]
    $prefix = @()
    if ($Command.Count -gt 1) {
        $prefix = $Command[1..($Command.Count - 1)]
    }
    & $exe @prefix @ExtraArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Python command failed with exit code $LASTEXITCODE"
    }
}

$base = Find-Python
$versionScript = "import sys; assert sys.version_info >= (3,10), 'Python 3.10+ required'; print(sys.version.split()[0])"
Invoke-Python -Command $base -ExtraArgs @("-c", $versionScript)

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
Write-Host "Ordered-click and slider demos prefer explicit data-dsh-patrol-captcha-* markup. Weak unmarked auto-execution is zero-config on localhost/127.0.0.1 test pages; remote weak detections remain handoffs." -ForegroundColor Yellow
