param()

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$runtime = (Resolve-Path (Join-Path $PSScriptRoot '..\desktop-runtime\windows-desktop.ps1')).Path
$token = [Guid]::NewGuid().ToString('N').Substring(0, 8)
$windowTitle = "DSH Patrol UI Smoke $token"
$tempRoot = Join-Path ([IO.Path]::GetTempPath()) "dsh-patrol-ui-smoke-$token"
$screenshotPath = Join-Path $tempRoot 'smoke.png'
[IO.Directory]::CreateDirectory($tempRoot) | Out-Null

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

function Wait-SmokeWindow {
  param([int]$ProcessId)

  $deadline = [DateTime]::UtcNow.AddSeconds(15)
  while ([DateTime]::UtcNow -lt $deadline) {
    $process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
    if ($null -ne $process -and $process.MainWindowHandle -ne 0 -and $process.MainWindowTitle -eq $windowTitle) {
      return $process
    }
    Start-Sleep -Milliseconds 200
  }
  $current = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
  throw "Smoke WinForms host did not expose window '$windowTitle' within 15 seconds. mainWindowTitle='$($current.MainWindowTitle)' handle=$($current.MainWindowHandle)"
}

$hostSource = @'
param([string]$Title)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Name = 'PatrolSmokeWindow'
$form.Width = 640
$form.Height = 360
$form.StartPosition = 'CenterScreen'

$input = New-Object System.Windows.Forms.TextBox
$input.Name = 'PatrolSmokeInput'
$input.AccessibleName = 'PatrolSmokeInput'
$input.Multiline = $true
$input.Location = New-Object System.Drawing.Point(20, 20)
$input.Size = New-Object System.Drawing.Size(580, 180)

$button = New-Object System.Windows.Forms.Button
$button.Name = 'PatrolSmokeButton'
$button.AccessibleName = 'PatrolSmokeButton'
$button.Text = 'Apply'
$button.Location = New-Object System.Drawing.Point(20, 220)
$button.Size = New-Object System.Drawing.Size(100, 36)

$status = New-Object System.Windows.Forms.Label
$status.Name = 'PatrolSmokeStatus'
$status.AccessibleName = 'PatrolSmokeStatus'
$status.Text = 'waiting'
$status.Location = New-Object System.Drawing.Point(150, 228)
$status.AutoSize = $true

$button.Add_Click({
  $status.Text = 'clicked'
  $status.AccessibleName = 'PatrolSmokeStatus clicked'
})

$form.Controls.Add($input)
$form.Controls.Add($button)
$form.Controls.Add($status)
$form.Add_Shown({ $input.Focus() })
[void]$form.ShowDialog()
'@

$hostRunspace = $null
$hostPowerShell = $null
$hostAsync = $null
try {
  $hostRunspace = [System.Management.Automation.Runspaces.RunspaceFactory]::CreateRunspace()
  $hostRunspace.ApartmentState = [System.Threading.ApartmentState]::STA
  $hostRunspace.ThreadOptions = [System.Management.Automation.Runspaces.PSThreadOptions]::ReuseThread
  $hostRunspace.Open()

  $hostPowerShell = [PowerShell]::Create()
  $hostPowerShell.Runspace = $hostRunspace
  [void]$hostPowerShell.AddScript($hostSource).AddArgument($windowTitle)
  $hostAsync = $hostPowerShell.BeginInvoke()

  $windowProcess = Wait-SmokeWindow -ProcessId $PID
  $processId = [int]$windowProcess.Id

  $snapshot = Invoke-PatrolDesktopAction -Action 'snapshot' -Arguments @{
    processId = $processId
    maxElements = 1000
    includeOffscreen = $false
  }

  $input = @($snapshot.elements | Where-Object {
    $_.enabled -eq $true -and
    $_.offscreen -ne $true -and
    $_.isPassword -ne $true -and
    [string]$_.controlType -eq 'Edit'
  }) | Sort-Object @{ Expression = { [int64]$_.rect.width * [int64]$_.rect.height }; Descending = $true } | Select-Object -First 1
  if ($null -eq $input) {
    $observed = @($snapshot.elements | Select-Object -First 20 | ForEach-Object {
      "$($_.controlType):$($_.name):$($_.automationId):$($_.className)"
    }) -join ' | '
    throw "Smoke form exposed no UIA Edit control. observed=$observed"
  }

  $message = "DSH Patrol desktop UI smoke $token"
  $typeArgs = @{
    processId = $processId
    controlType = 'Edit'
    text = $message
    clear = $true
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$input.automationId)) {
    $typeArgs.automationId = [string]$input.automationId
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$input.name)) {
    $typeArgs.name = [string]$input.name
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$input.className)) {
    $typeArgs.className = [string]$input.className
  } else {
    $typeArgs.index = 0
  }

  $typed = Invoke-PatrolDesktopAction -Action 'type-target' -Arguments $typeArgs
  if ([int]$typed.chars -ne $message.Length) {
    throw "type-target reported chars=$($typed.chars), expected=$($message.Length)"
  }

  $verifiedInput = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(8)
  while ([DateTime]::UtcNow -lt $deadline) {
    $snapshot = Invoke-PatrolDesktopAction -Action 'snapshot' -Arguments @{
      processId = $processId
      maxElements = 1000
      includeOffscreen = $false
    }
    $matching = @($snapshot.elements | Where-Object {
      $_.isPassword -ne $true -and
      $null -ne $_.value -and
      ([string]$_.value).Contains($message)
    })
    if ($matching.Count -gt 0) {
      $verifiedInput = $true
      Write-Host "Desktop UI smoke verified type-target via $($matching[0].valueSource)."
      break
    }
    Start-Sleep -Milliseconds 200
  }
  if (-not $verifiedInput) {
    $observed = @($snapshot.elements |
      Where-Object { $null -ne $_.valueSource } |
      Select-Object -First 12 |
      ForEach-Object { "$($_.controlType):$($_.className):$($_.valueSource):$([string]$_.value)" }) -join ' | '
    throw "type-target completed but CURRENT UIA snapshot did not expose typed text. observed=$observed"
  }

  $button = @($snapshot.elements | Where-Object {
    $_.enabled -eq $true -and
    $_.offscreen -ne $true -and
    [string]$_.controlType -eq 'Button'
  }) | Select-Object -First 1
  if ($null -eq $button) {
    throw 'Smoke form exposed no UIA Button control.'
  }

  $clickArgs = @{
    processId = $processId
    controlType = 'Button'
  }
  if (-not [string]::IsNullOrWhiteSpace([string]$button.automationId)) {
    $clickArgs.automationId = [string]$button.automationId
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$button.name)) {
    $clickArgs.name = [string]$button.name
  } elseif (-not [string]::IsNullOrWhiteSpace([string]$button.className)) {
    $clickArgs.className = [string]$button.className
  } else {
    $clickArgs.index = 0
  }

  $clicked = Invoke-PatrolDesktopAction -Action 'click-target' -Arguments $clickArgs
  if ([string]::IsNullOrWhiteSpace([string]$clicked.method)) {
    throw 'click-target returned no invocation method.'
  }

  $verifiedClick = $false
  $deadline = [DateTime]::UtcNow.AddSeconds(5)
  while ([DateTime]::UtcNow -lt $deadline) {
    $snapshot = Invoke-PatrolDesktopAction -Action 'snapshot' -Arguments @{
      processId = $processId
      maxElements = 1000
      includeOffscreen = $false
    }
    if (@($snapshot.elements | Where-Object {
      ([string]$_.name).IndexOf('clicked', [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
      ($null -ne $_.value -and ([string]$_.value).IndexOf('clicked', [StringComparison]::OrdinalIgnoreCase) -ge 0)
    }).Count -gt 0) {
      $verifiedClick = $true
      Write-Host "Desktop UI smoke verified click-target state change."
      break
    }
    Start-Sleep -Milliseconds 150
  }
  if (-not $verifiedClick) {
    throw 'click-target completed but CURRENT UIA snapshot never exposed the clicked status.'
  }

  $shot = Invoke-PatrolDesktopAction -Action 'screenshot' -Arguments @{
    processId = $processId
    scope = 'active-window'
    path = $screenshotPath
  }
  if (-not (Test-Path -LiteralPath $shot.path)) {
    throw "desktop screenshot did not create $($shot.path)"
  }
  if ((Get-Item -LiteralPath $shot.path).Length -le 0) {
    throw "desktop screenshot is empty: $($shot.path)"
  }

  Write-Host "Desktop UI Automation smoke passed: snapshot + targeted type + value verification + click + screenshot."
}
finally {
  if ($null -ne $hostPowerShell) {
    try { $hostPowerShell.Stop() } catch {}
    $hostPowerShell.Dispose()
  }
  if ($null -ne $hostRunspace) {
    try { $hostRunspace.Close() } catch {}
    $hostRunspace.Dispose()
  }
  Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue
}
