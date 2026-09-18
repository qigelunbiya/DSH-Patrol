param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$runtime = (Resolve-Path (Join-Path $PSScriptRoot '..\desktop-runtime\windows-desktop.ps1')).Path

function Invoke-PatrolDesktopAction {
  param(
    [Parameter(Mandatory=$true)][string]$Action,
    [Parameter(Mandatory=$true)][hashtable]$Arguments
  )

  $json = $Arguments | ConvertTo-Json -Depth 8 -Compress
  $payload = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
  $output = & powershell.exe -NoProfile -NonInteractive -STA -ExecutionPolicy Bypass -File $runtime -Action $Action -Payload $payload
  if ($LASTEXITCODE -ne 0) {
    throw "desktop runtime action '$Action' exited with $LASTEXITCODE : $($output | Out-String)"
  }

  $line = @($output | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }) | Select-Object -Last 1
  if ($null -eq $line) { throw "desktop runtime action '$Action' returned no JSON output" }
  $value = $line | ConvertFrom-Json
  if ($value.ok -ne $true) {
    throw "desktop runtime action '$Action' returned ok=false: $line"
  }
  return $value
}

function Wait-NotepadWindow {
  param([int]$PreferredProcessId)

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    $preferred = Get-Process -Id $PreferredProcessId -ErrorAction SilentlyContinue
    if ($null -ne $preferred -and $preferred.MainWindowHandle -ne 0) { return $preferred }

    $fallback = Get-Process -Name notepad -ErrorAction SilentlyContinue |
      Where-Object { $_.MainWindowHandle -ne 0 } |
      Sort-Object StartTime -Descending |
      Select-Object -First 1
    if ($null -ne $fallback) { return $fallback }
    Start-Sleep -Milliseconds 250
  }
  throw 'Notepad did not expose a top-level window within 15 seconds.'
}

$started = $null
$windowProcess = $null
try {
  $started = Start-Process notepad.exe -PassThru
  $windowProcess = Wait-NotepadWindow -PreferredProcessId $started.Id

  $snapshot = $null
  $editors = @()
  $editorDeadline = [DateTime]::UtcNow.AddSeconds(12)
  while ([DateTime]::UtcNow -lt $editorDeadline) {
    $snapshot = Invoke-PatrolDesktopAction -Action 'snapshot' -Arguments @{
      processId = [int]$windowProcess.Id
      maxElements = 1000
      includeOffscreen = $false
    }

    $editors = @($snapshot.elements | Where-Object {
      $_.enabled -eq $true -and
      $_.offscreen -ne $true -and
      $_.isPassword -ne $true -and
      @('Edit', 'Document') -contains [string]$_.controlType -and
      [int]$_.rect.width -gt 0 -and
      [int]$_.rect.height -gt 0
    })
    if ($editors.Count -gt 0) { break }
    Start-Sleep -Milliseconds 300
  }

  if ($editors.Count -eq 0) {
    $observed = @($snapshot.elements | Select-Object -First 20 | ForEach-Object {
      "$($_.controlType):$($_.name):$($_.automationId):$($_.className):$($_.valueSource)"
    }) -join ' | '
    throw "Notepad snapshot exposed no editable UIA Edit/Document control after waiting for the app content. observed=$observed"
  }

  $target = $editors |
    Sort-Object @{ Expression = { [int64]$_.rect.width * [int64]$_.rect.height }; Descending = $true } |
    Select-Object -First 1

  $typeArgs = @{
    processId = [int]$windowProcess.Id
    controlType = [string]$target.controlType
    text = "DSH Patrol desktop UI smoke $([Guid]::NewGuid().ToString('N').Substring(0, 8))"
    clear = $true
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$target.automationId)) {
    $typeArgs.automationId = [string]$target.automationId
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$target.className)) {
    $typeArgs.className = [string]$target.className
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$target.name)) {
    $typeArgs.name = [string]$target.name
  } else {
    $same = @($editors | Where-Object { [string]$_.controlType -eq [string]$target.controlType })
    $index = [Array]::IndexOf($same, $target)
    if ($index -lt 0) { throw 'Could not calculate UIA target index for Notepad editor.' }
    $typeArgs.index = $index
  }

  $typed = Invoke-PatrolDesktopAction -Action 'type-target' -Arguments $typeArgs
  if ([int]$typed.chars -ne $typeArgs.text.Length) {
    throw "type-target reported chars=$($typed.chars), expected=$($typeArgs.text.Length)"
  }

  $verified = $false
  $lastSnapshot = $null
  $deadline = [DateTime]::UtcNow.AddSeconds(10)
  while ([DateTime]::UtcNow -lt $deadline) {
    $lastSnapshot = Invoke-PatrolDesktopAction -Action 'snapshot' -Arguments @{
      processId = [int]$windowProcess.Id
      maxElements = 1000
      includeOffscreen = $false
    }
    $matching = @($lastSnapshot.elements | Where-Object {
      $_.isPassword -ne $true -and
      $null -ne $_.value -and
      ([string]$_.value).Contains([string]$typeArgs.text)
    })
    if ($matching.Count -gt 0) {
      $verified = $true
      $source = [string]$matching[0].valueSource
      Write-Host "Desktop UI smoke verified typed text via UIA $source on controlType=$($matching[0].controlType)."
      break
    }
    Start-Sleep -Milliseconds 250
  }

  if (-not $verified) {
    $observed = @($lastSnapshot.elements |
      Where-Object { $null -ne $_.valueSource } |
      Select-Object -First 12 |
      ForEach-Object { "$($_.controlType):$($_.className):$($_.valueSource):$([string]$_.value)" }) -join ' | '
    throw "Notepad type-target completed but CURRENT UIA snapshot did not expose the typed text through ValuePattern/TextPattern. observed=$observed"
  }
}
finally {
  if ($null -ne $windowProcess) {
    Stop-Process -Id $windowProcess.Id -Force -ErrorAction SilentlyContinue
  }
  if ($null -ne $started -and ($null -eq $windowProcess -or $started.Id -ne $windowProcess.Id)) {
    Stop-Process -Id $started.Id -Force -ErrorAction SilentlyContinue
  }
}
