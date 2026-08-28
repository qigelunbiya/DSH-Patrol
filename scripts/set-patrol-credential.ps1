param(
    [Parameter(Mandatory = $true)][string]$Name,
    [string]$DshHome = ""
)

$ErrorActionPreference = "Stop"

if ($Name -notmatch '^[A-Za-z_][A-Za-z0-9_]*$') {
    throw "Credential name must be a POSIX-style identifier such as IDC_LOGIN_PASSWORD."
}

if (-not $DshHome) {
    $DshHome = if ($env:DSH_HOME) { $env:DSH_HOME } else { Join-Path $HOME ".dsh" }
}
$DshHome = [System.IO.Path]::GetFullPath($DshHome)
$CredentialPath = Join-Path $DshHome ".credentials.yaml"
New-Item -ItemType Directory -Force -Path $DshHome | Out-Null

$secure = Read-Host "Enter value for Harness credential $Name" -AsSecureString
$bstr = [IntPtr]::Zero
$plain = $null
try {
    $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
    $plain = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr)
    if ([string]::IsNullOrEmpty($plain)) {
        throw "Credential value cannot be empty."
    }

    # JSON string quoting is accepted by YAML double-quoted scalars and safely
    # escapes quotes, backslashes, control characters, and non-ASCII text.
    $yamlValue = ConvertTo-Json -InputObject $plain -Compress
    $newline = "`r`n"

    if (-not (Test-Path -LiteralPath $CredentialPath)) {
        $next = "version: 1${newline}${newline}refs:${newline}  ${Name}: ${yamlValue}${newline}"
    } else {
        $text = [System.IO.File]::ReadAllText($CredentialPath)
        if ($text -notmatch '(?m)^version:\s*1\s*$') {
            throw "Unsupported Harness credential document. Expected version: 1 at $CredentialPath"
        }

        $refsMatch = [regex]::Match($text, '(?m)^refs:\s*$')
        if (-not $refsMatch.Success) {
            $recordsMatch = [regex]::Match($text, '(?m)^records:\s*$')
            $block = "refs:${newline}  ${Name}: ${yamlValue}${newline}${newline}"
            if ($recordsMatch.Success) {
                $next = $text.Insert($recordsMatch.Index, $block)
            } else {
                $next = $text.TrimEnd("`r", "`n") + $newline + $newline + $block
            }
        } else {
            $refsStart = $refsMatch.Index
            $contentStart = $refsMatch.Index + $refsMatch.Length
            $tail = $text.Substring($contentStart)
            $nextTopLevel = [regex]::Match($tail, '(?m)^\S[^\r\n]*:\s*(?:#.*)?$')
            $refsEnd = if ($nextTopLevel.Success) { $contentStart + $nextTopLevel.Index } else { $text.Length }
            $refsBlock = $text.Substring($refsStart, $refsEnd - $refsStart)
            $keyPattern = '(?m)^  ' + [regex]::Escape($Name) + '\s*:.*$'
            $replacement = "  ${Name}: ${yamlValue}"
            if ([regex]::IsMatch($refsBlock, $keyPattern)) {
                $updatedBlock = [regex]::Replace($refsBlock, $keyPattern, $replacement, 1)
            } else {
                $updatedBlock = $refsBlock.TrimEnd("`r", "`n") + $newline + $replacement + $newline
            }
            $next = $text.Substring(0, $refsStart) + $updatedBlock + $text.Substring($refsEnd)
        }
    }

    $temp = "$CredentialPath.$PID.$([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()).tmp"
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temp, $next, $encoding)
    Move-Item -LiteralPath $temp -Destination $CredentialPath -Force

    Write-Host "Harness credential configured: $Name" -ForegroundColor Green
    Write-Host "Credential store: $CredentialPath" -ForegroundColor Green
    Write-Host "The secret value was not printed. If Harness is already running, its local credential store should hot-reload this change." -ForegroundColor Cyan
} finally {
    if ($bstr -ne [IntPtr]::Zero) {
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
    }
    $plain = $null
    $secure = $null
}
