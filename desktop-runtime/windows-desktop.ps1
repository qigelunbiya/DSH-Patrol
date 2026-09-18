param(
  [Parameter(Mandatory=$true)][string]$Action,
  [Parameter(Mandatory=$true)][string]$Payload
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

if (-not ('PatrolDesktop.Native' -as [type])) {
  Add-Type @"
using System;
using System.Runtime.InteropServices;
namespace PatrolDesktop {
  public static class Native {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extraInfo);
    [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  }
}
"@
}

function Decode-Payload([string]$value) {
  $bytes = [Convert]::FromBase64String($value)
  $json = [Text.Encoding]::UTF8.GetString($bytes)
  if ([string]::IsNullOrWhiteSpace($json)) { return [pscustomobject]@{} }
  return $json | ConvertFrom-Json
}

function Get-Prop($obj, [string]$name, $default = $null) {
  if ($null -eq $obj) { return $default }
  $prop = $obj.PSObject.Properties[$name]
  if ($null -eq $prop) { return $default }
  return $prop.Value
}

function Window-Record($process) {
  if ($null -eq $process -or $process.MainWindowHandle -eq 0) { return $null }
  $rect = New-Object PatrolDesktop.Native+RECT
  [void][PatrolDesktop.Native]::GetWindowRect([IntPtr]$process.MainWindowHandle, [ref]$rect)
  return [ordered]@{
    processId = [int]$process.Id
    processName = [string]$process.ProcessName
    title = [string]$process.MainWindowTitle
    hwnd = [int64]$process.MainWindowHandle
    rect = [ordered]@{
      x = [int]$rect.Left
      y = [int]$rect.Top
      width = [int]($rect.Right - $rect.Left)
      height = [int]($rect.Bottom - $rect.Top)
    }
  }
}

function Get-Windows {
  $items = @()
  foreach ($process in (Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) })) {
    $record = Window-Record $process
    if ($null -ne $record) { $items += $record }
  }
  return $items
}

function Resolve-Window($request, [bool]$allowForeground = $true) {
  $processId = Get-Prop $request 'processId'
  $hwnd = Get-Prop $request 'hwnd'
  $processName = [string](Get-Prop $request 'processName' '')
  $title = [string](Get-Prop $request 'title' '')
  $titleContains = [string](Get-Prop $request 'titleContains' '')

  if ($null -ne $hwnd -and [int64]$hwnd -ne 0) {
    $p = Get-Process | Where-Object { $_.MainWindowHandle -eq [int64]$hwnd } | Select-Object -First 1
    if ($null -eq $p) { throw "desktop window hwnd=$hwnd not found" }
    return $p
  }
  if ($null -ne $processId) {
    $p = Get-Process -Id ([int]$processId) -ErrorAction SilentlyContinue
    if ($null -eq $p -or $p.MainWindowHandle -eq 0) { throw "desktop processId=$processId has no main window" }
    return $p
  }

  $windows = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and -not [string]::IsNullOrWhiteSpace($_.MainWindowTitle) })
  if (-not [string]::IsNullOrWhiteSpace($processName)) {
    $windows = @($windows | Where-Object { $_.ProcessName -ieq $processName })
  }
  if (-not [string]::IsNullOrWhiteSpace($title)) {
    $windows = @($windows | Where-Object { $_.MainWindowTitle -ieq $title })
  } elseif (-not [string]::IsNullOrWhiteSpace($titleContains)) {
    $windows = @($windows | Where-Object { $_.MainWindowTitle.IndexOf($titleContains, [StringComparison]::OrdinalIgnoreCase) -ge 0 })
  }

  if ($windows.Count -eq 1) { return $windows[0] }
  if ($windows.Count -gt 1) {
    $titles = ($windows | Select-Object -First 6 | ForEach-Object { "$($_.ProcessName):$($_.MainWindowTitle)" }) -join ' | '
    throw "desktop window query is ambiguous ($($windows.Count) matches): $titles"
  }

  if ($allowForeground -and [string]::IsNullOrWhiteSpace($processName) -and [string]::IsNullOrWhiteSpace($title) -and [string]::IsNullOrWhiteSpace($titleContains)) {
    $foreground = [PatrolDesktop.Native]::GetForegroundWindow()
    if ($foreground -eq [IntPtr]::Zero) { throw 'no foreground desktop window is available' }
    $p = Get-Process | Where-Object { $_.MainWindowHandle -eq [int64]$foreground } | Select-Object -First 1
    if ($null -ne $p) { return $p }
  }

  throw 'desktop window not found; call desktop_list_windows and use processName/titleContains'
}

function Activate-Window($process) {
  if ($null -eq $process -or $process.MainWindowHandle -eq 0) { throw 'window has no main handle' }
  $target = [IntPtr]$process.MainWindowHandle
  [void][PatrolDesktop.Native]::ShowWindowAsync($target, 9)
  Start-Sleep -Milliseconds 80
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    [void][PatrolDesktop.Native]::SetForegroundWindow($target)
    Start-Sleep -Milliseconds 120
    $foreground = [PatrolDesktop.Native]::GetForegroundWindow()
    if ($foreground -eq $target) { return }
  }
  $foreground = [PatrolDesktop.Native]::GetForegroundWindow()
  $actual = Get-Process | Where-Object { $_.MainWindowHandle -eq [int64]$foreground } | Select-Object -First 1
  $actualLabel = if ($null -eq $actual) { [string][int64]$foreground } else { "$($actual.ProcessName):$($actual.MainWindowTitle)" }
  throw "failed to verify foreground desktop window $($process.ProcessName):$($process.MainWindowTitle); actual=$actualLabel"
}

function Get-Root($request) {
  $process = Resolve-Window $request $true
  $root = [System.Windows.Automation.AutomationElement]::FromHandle([IntPtr]$process.MainWindowHandle)
  if ($null -eq $root) { throw "UI Automation root unavailable for $($process.MainWindowTitle)" }
  return [pscustomobject]@{ Process = $process; Root = $root }
}

function Element-Record($element) {
  try {
    $current = $element.Current
    $rect = $current.BoundingRectangle
    $control = [string]$current.ControlType.ProgrammaticName
    if ($control.StartsWith('ControlType.')) { $control = $control.Substring(12) }
    $isPassword = [bool]$current.IsPassword
    $value = $null
    if (-not $isPassword) {
      $valuePattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$valuePattern)) {
        try {
          $rawValue = [string]([System.Windows.Automation.ValuePattern]$valuePattern).Current.Value
          $value = if ($rawValue.Length -le 2000) { $rawValue } else { $rawValue.Substring(0, 2000) + '...' }
        } catch {}
      }
    }
    return [ordered]@{
      name = [string]$current.Name
      automationId = [string]$current.AutomationId
      controlType = $control
      className = [string]$current.ClassName
      isPassword = $isPassword
      value = $value
      enabled = [bool]$current.IsEnabled
      offscreen = [bool]$current.IsOffscreen
      rect = [ordered]@{
        x = [int][Math]::Round($rect.X)
        y = [int][Math]::Round($rect.Y)
        width = [int][Math]::Round($rect.Width)
        height = [int][Math]::Round($rect.Height)
      }
    }
  } catch {
    return $null
  }
}

function Get-Snapshot($request) {
  $resolved = Get-Root $request
  $maxElements = [int](Get-Prop $request 'maxElements' 300)
  if ($maxElements -lt 1) { $maxElements = 1 }
  if ($maxElements -gt 1000) { $maxElements = 1000 }
  $includeOffscreen = [bool](Get-Prop $request 'includeOffscreen' $false)
  $all = $resolved.Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $items = @()
  for ($i = 0; $i -lt $all.Count -and $items.Count -lt $maxElements; $i++) {
    $record = Element-Record $all.Item($i)
    if ($null -eq $record) { continue }
    if (-not $includeOffscreen -and $record.offscreen) { continue }
    if ($record.rect.width -le 0 -or $record.rect.height -le 0) { continue }
    if ([string]::IsNullOrWhiteSpace($record.name) -and [string]::IsNullOrWhiteSpace($record.automationId)) {
      $interactiveTypes = @('Button','Edit','ListItem','MenuItem','TabItem','TreeItem','Hyperlink','CheckBox','RadioButton','ComboBox','DataItem')
      if ($interactiveTypes -notcontains $record.controlType) { continue }
    }
    $items += $record
  }
  return [ordered]@{
    ok = $true
    window = Window-Record $resolved.Process
    elements = $items
    truncated = ($all.Count -gt $items.Count)
  }
}

function Find-TargetElement($request) {
  $resolved = Get-Root $request
  $name = [string](Get-Prop $request 'name' '')
  $automationId = [string](Get-Prop $request 'automationId' '')
  $controlType = [string](Get-Prop $request 'controlType' '')
  $className = [string](Get-Prop $request 'className' '')
  $match = [string](Get-Prop $request 'match' 'exact')
  $indexValue = Get-Prop $request 'index' $null
  if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($automationId) -and [string]::IsNullOrWhiteSpace($controlType) -and [string]::IsNullOrWhiteSpace($className)) {
    throw 'desktop target requires at least one of name, automationId, controlType, className'
  }

  $all = $resolved.Root.FindAll([System.Windows.Automation.TreeScope]::Descendants, [System.Windows.Automation.Condition]::TrueCondition)
  $matches = @()
  for ($i = 0; $i -lt $all.Count; $i++) {
    $element = $all.Item($i)
    $record = Element-Record $element
    if ($null -eq $record -or $record.offscreen -or -not $record.enabled) { continue }
    if ($record.rect.width -le 0 -or $record.rect.height -le 0) { continue }
    if (-not [string]::IsNullOrWhiteSpace($automationId) -and $record.automationId -ine $automationId) { continue }
    if (-not [string]::IsNullOrWhiteSpace($controlType) -and $record.controlType -ine $controlType) { continue }
    if (-not [string]::IsNullOrWhiteSpace($className) -and $record.className -ine $className) { continue }
    if (-not [string]::IsNullOrWhiteSpace($name)) {
      $matched = if ($match -ieq 'contains') {
        $record.name.IndexOf($name, [StringComparison]::OrdinalIgnoreCase) -ge 0
      } else {
        $record.name -ieq $name
      }
      if (-not $matched) { continue }
    }
    $matches += [pscustomobject]@{ Element = $element; Record = $record }
  }

  if ($null -ne $indexValue) {
    $index = [int]$indexValue
    if ($index -lt 0 -or $index -ge $matches.Count) { throw "desktop target index $index is out of range; matches=$($matches.Count)" }
    return $matches[$index]
  }
  if ($matches.Count -eq 0) { throw "desktop target not found: name='$name' automationId='$automationId' controlType='$controlType' className='$className'" }
  if ($matches.Count -ne 1) {
    $sample = ($matches | Select-Object -First 6 | ForEach-Object { "$($_.Record.controlType):$($_.Record.name):$($_.Record.automationId)" }) -join ' | '
    throw "desktop target is ambiguous ($($matches.Count) matches): $sample"
  }
  return $matches[0]
}

function Click-Point([int]$x, [int]$y, [int]$button = 0) {
  [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x, $y)
  Start-Sleep -Milliseconds 40
  if ($button -eq 1) {
    [PatrolDesktop.Native]::mouse_event(0x0008, 0, 0, 0, [UIntPtr]::Zero)
    [PatrolDesktop.Native]::mouse_event(0x0010, 0, 0, 0, [UIntPtr]::Zero)
  } else {
    [PatrolDesktop.Native]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    [PatrolDesktop.Native]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  }
}

function Invoke-Target($target) {
  $element = $target.Element
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.InvokePattern]$pattern).Invoke()
    return 'invoke-pattern'
  }
  $pattern = $null
  if ($element.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
    ([System.Windows.Automation.SelectionItemPattern]$pattern).Select()
    return 'selection-item-pattern'
  }
  $rect = $target.Record.rect
  $x = [int]($rect.x + [Math]::Max(1, [Math]::Floor($rect.width / 2)))
  $y = [int]($rect.y + [Math]::Max(1, [Math]::Floor($rect.height / 2)))
  Click-Point $x $y 0
  return 'bounding-rect-click'
}

function Focus-Target($target) {
  try {
    $target.Element.SetFocus()
    Start-Sleep -Milliseconds 80
    return 'uia-set-focus'
  } catch {
    $rect = $target.Record.rect
    $x = [int]($rect.x + [Math]::Max(1, [Math]::Floor($rect.width / 2)))
    $y = [int]($rect.y + [Math]::Max(1, [Math]::Floor($rect.height / 2)))
    Click-Point $x $y 0
    Start-Sleep -Milliseconds 80
    return 'bounding-rect-click'
  }
}

function Activate-RequestedWindow($request) {
  $hasSelector = @('processId','hwnd','processName','title','titleContains') | Where-Object {
    $value = Get-Prop $request $_ $null
    if ($null -eq $value) { return $false }
    if ($value -is [string]) { return -not [string]::IsNullOrWhiteSpace([string]$value) }
    return $true
  }
  if ($hasSelector.Count -eq 0) { return $null }
  $process = Resolve-Window $request $false
  Activate-Window $process
  return Window-Record $process
}

function Send-Key([string]$key) {
  $map = @{
    'ENTER'='{ENTER}'; 'RETURN'='{ENTER}'; 'ESC'='{ESC}'; 'ESCAPE'='{ESC}';
    'TAB'='{TAB}'; 'BACKSPACE'='{BACKSPACE}'; 'BS'='{BACKSPACE}'; 'DELETE'='{DELETE}';
    'DEL'='{DELETE}'; 'UP'='{UP}'; 'DOWN'='{DOWN}'; 'LEFT'='{LEFT}'; 'RIGHT'='{RIGHT}';
    'HOME'='{HOME}'; 'END'='{END}'; 'PGUP'='{PGUP}'; 'PGDN'='{PGDN}'; 'SPACE'=' ';
  }
  $upper = $key.ToUpperInvariant()
  if ($map.ContainsKey($upper)) { [System.Windows.Forms.SendKeys]::SendWait($map[$upper]); return }
  if ($upper -match '^F([1-9]|1[0-2])$') { [System.Windows.Forms.SendKeys]::SendWait("{$upper}"); return }
  if ($key.Length -eq 1) { [System.Windows.Forms.SendKeys]::SendWait($key); return }
  throw "unsupported desktop key '$key'"
}

function Send-Hotkey([string]$combo) {
  $parts = @($combo.Split('+') | ForEach-Object { $_.Trim() } | Where-Object { $_ })
  if ($parts.Count -lt 2) { Send-Key $combo; return }
  $prefix = ''
  for ($i = 0; $i -lt $parts.Count - 1; $i++) {
    switch -Regex ($parts[$i].ToUpperInvariant()) {
      '^CTRL|CONTROL$' { $prefix += '^'; break }
      '^ALT$' { $prefix += '%'; break }
      '^SHIFT$' { $prefix += '+'; break }
      default { throw "unsupported desktop hotkey modifier '$($parts[$i])'; supported: Ctrl, Alt, Shift" }
    }
  }
  $key = $parts[$parts.Count - 1]
  $upper = $key.ToUpperInvariant()
  $special = @{
    'ENTER'='{ENTER}'; 'ESC'='{ESC}'; 'ESCAPE'='{ESC}'; 'TAB'='{TAB}'; 'DELETE'='{DELETE}';
    'UP'='{UP}'; 'DOWN'='{DOWN}'; 'LEFT'='{LEFT}'; 'RIGHT'='{RIGHT}'; 'HOME'='{HOME}'; 'END'='{END}';
  }
  if ($special.ContainsKey($upper)) { $encoded = $special[$upper] }
  elseif ($upper -match '^F([1-9]|1[0-2])$') { $encoded = "{$upper}" }
  elseif ($key.Length -eq 1) { $encoded = $key.ToLowerInvariant() }
  else { throw "unsupported desktop hotkey key '$key'" }
  [System.Windows.Forms.SendKeys]::SendWait("$prefix$encoded")
}

function Capture-Screenshot($request) {
  $path = [string](Get-Prop $request 'path' '')
  if ([string]::IsNullOrWhiteSpace($path)) { throw 'desktop screenshot path is required' }
  $scope = [string](Get-Prop $request 'scope' 'active-window')
  $windowRecord = $null
  if ($scope -ieq 'screen') {
    $bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
    $x = $bounds.X; $y = $bounds.Y; $width = $bounds.Width; $height = $bounds.Height
  } else {
    $scope = 'active-window'
    $process = Resolve-Window $request $true
    # CopyFromScreen captures visible pixels rather than an off-screen window
    # surface. Raise the requested window first so overlapping apps cannot
    # contaminate a window-scoped OCR capture.
    Activate-Window $process
    $windowRecord = Window-Record $process
    $rect = New-Object PatrolDesktop.Native+RECT
    if (-not [PatrolDesktop.Native]::GetWindowRect([IntPtr]$process.MainWindowHandle, [ref]$rect)) { throw 'GetWindowRect failed' }
    $x = $rect.Left; $y = $rect.Top; $width = $rect.Right - $rect.Left; $height = $rect.Bottom - $rect.Top
  }
  if ($width -le 0 -or $height -le 0) { throw "invalid screenshot bounds $width x $height" }
  $directory = [IO.Path]::GetDirectoryName($path)
  if (-not [string]::IsNullOrWhiteSpace($directory)) { [IO.Directory]::CreateDirectory($directory) | Out-Null }
  $bitmap = New-Object System.Drawing.Bitmap($width, $height)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.CopyFromScreen($x, $y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
    $bitmap.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  } finally {
    $graphics.Dispose()
    $bitmap.Dispose()
  }
  return [ordered]@{ ok=$true; path=$path; scope=$scope; window=$windowRecord; x=[int]$x; y=[int]$y; width=[int]$width; height=[int]$height }
}

function Resolve-AppLaunchSpec($request) {
  $file = [string](Get-Prop $request 'file' '')
  if (-not [string]::IsNullOrWhiteSpace($file)) {
    return [ordered]@{ mode='file'; file=$file; resolvedName=$file }
  }

  $app = [string](Get-Prop $request 'app' '')
  if ([string]::IsNullOrWhiteSpace($app)) { throw 'launch-app requires file or app' }

  $commandNames = @($app)
  if (-not $app.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase)) {
    $commandNames += "$app.exe"
  }
  foreach ($name in $commandNames) {
    $command = Get-Command -Name $name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($null -ne $command) {
      $path = [string]$command.Source
      if ([string]::IsNullOrWhiteSpace($path)) { $path = [string]$command.Path }
      if (-not [string]::IsNullOrWhiteSpace($path)) {
        return [ordered]@{ mode='file'; file=$path; resolvedName=[string]$command.Name }
      }
    }
  }

  foreach ($name in $commandNames) {
    foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\App Paths', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\App Paths')) {
      $key = Join-Path $root $name
      try {
        $item = Get-Item -LiteralPath $key -ErrorAction Stop
        $path = [string]$item.GetValue('')
        if (-not [string]::IsNullOrWhiteSpace($path)) {
          return [ordered]@{ mode='file'; file=$path; resolvedName=$name }
        }
      } catch {}
    }
  }

  $shortcutRoots = @(
    [Environment]::GetFolderPath('StartMenu'),
    [Environment]::GetFolderPath('CommonStartMenu')
  ) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) }
  $shortcuts = @()
  foreach ($root in $shortcutRoots) {
    $programs = Join-Path ([string]$root) 'Programs'
    if (-not (Test-Path -LiteralPath $programs)) { continue }
    $shortcuts += @(Get-ChildItem -LiteralPath $programs -Filter '*.lnk' -File -Recurse -ErrorAction SilentlyContinue)
  }
  $shortcutExact = @($shortcuts | Where-Object {
    ([string]$_.BaseName).Equals($app, [StringComparison]::OrdinalIgnoreCase)
  })
  if ($shortcutExact.Count -gt 0) {
    $match = $shortcutExact[0]
    return [ordered]@{ mode='shortcut'; file=[string]$match.FullName; resolvedName=[string]$match.BaseName }
  }
  $shortcutMatches = @($shortcuts | Where-Object {
    ([string]$_.BaseName).IndexOf($app, [StringComparison]::OrdinalIgnoreCase) -ge 0
  })
  if ($shortcutMatches.Count -eq 1) {
    $match = $shortcutMatches[0]
    return [ordered]@{ mode='shortcut'; file=[string]$match.FullName; resolvedName=[string]$match.BaseName }
  }
  if ($shortcutMatches.Count -gt 1) {
    $sample = ($shortcutMatches | Select-Object -First 8 | ForEach-Object { [string]$_.BaseName }) -join ' | '
    throw "launch-app app query is ambiguous ($($shortcutMatches.Count) Start Menu shortcuts): $sample"
  }

  $getStartApps = Get-Command -Name Get-StartApps -ErrorAction SilentlyContinue
  if ($null -ne $getStartApps) {
    $apps = @(Get-StartApps | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_.AppID) })
    $exact = @($apps | Where-Object {
      $nameText = [string]$_.Name
      $appIdText = [string]$_.AppID
      return $nameText.Equals($app, [StringComparison]::OrdinalIgnoreCase) -or $appIdText.Equals($app, [StringComparison]::OrdinalIgnoreCase)
    })
    $matches = if ($exact.Count -gt 0) { $exact } else {
      @($apps | Where-Object {
        $nameText = [string]$_.Name
        $appIdText = [string]$_.AppID
        return $nameText.IndexOf($app, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $appIdText.IndexOf($app, [StringComparison]::OrdinalIgnoreCase) -ge 0
      })
    }
    if ($matches.Count -eq 1) {
      return [ordered]@{
        mode='shell-app'
        file='explorer.exe'
        appId=[string]$matches[0].AppID
        resolvedName=[string]$matches[0].Name
      }
    }
    if ($matches.Count -gt 1) {
      $sample = ($matches | Select-Object -First 8 | ForEach-Object { "$($_.Name) [$($_.AppID)]" }) -join ' | '
      throw "launch-app app query is ambiguous ($($matches.Count) matches): $sample"
    }
  }

  throw "installed desktop app not found for '$app'; call desktop_list_windows for running apps or provide desktop_launch_app file=<executable path>"
}

$request = Decode-Payload $Payload
try {
  $result = switch ($Action) {
    'list-windows' {
      [ordered]@{ ok=$true; windows=@(Get-Windows) }
    }
    'resolve-app' {
      $spec = Resolve-AppLaunchSpec $request
      [ordered]@{ ok=$true; spec=$spec }
    }
    'launch-app' {
      $spec = Resolve-AppLaunchSpec $request
      $argumentList = @(Get-Prop $request 'arguments' @())
      $workingDirectory = [string](Get-Prop $request 'workingDirectory' '')
      if ($spec.mode -eq 'shell-app') {
        if ($argumentList.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($workingDirectory)) {
          throw 'launch-app app=<friendly name> does not support arguments/workingDirectory; provide file=<executable path> for those options'
        }
        $shellTarget = "shell:AppsFolder\$($spec.appId)"
        Start-Process -FilePath $spec.file -ArgumentList @($shellTarget) | Out-Null
        [ordered]@{ ok=$true; mode=$spec.mode; appId=$spec.appId; resolvedName=$spec.resolvedName }
      } elseif ($spec.mode -eq 'shortcut') {
        if ($argumentList.Count -gt 0 -or -not [string]::IsNullOrWhiteSpace($workingDirectory)) {
          throw 'launch-app app=<friendly name> does not support arguments/workingDirectory; provide file=<executable path> for those options'
        }
        Start-Process -FilePath $spec.file | Out-Null
        [ordered]@{ ok=$true; mode=$spec.mode; file=$spec.file; resolvedName=$spec.resolvedName }
      } else {
        $parameters = @{ FilePath=$spec.file; PassThru=$true }
        if ($argumentList.Count -gt 0) { $parameters.ArgumentList = $argumentList }
        if (-not [string]::IsNullOrWhiteSpace($workingDirectory)) { $parameters.WorkingDirectory = $workingDirectory }
        $p = Start-Process @parameters
        [ordered]@{ ok=$true; mode=$spec.mode; processId=[int]$p.Id; file=$spec.file; resolvedName=$spec.resolvedName }
      }
    }
    'open-path' {
      $path = [string](Get-Prop $request 'path' '')
      if ([string]::IsNullOrWhiteSpace($path)) { throw 'open-path requires path' }
      Start-Process -FilePath $path | Out-Null
      [ordered]@{ ok=$true; path=$path }
    }
    'activate-window' {
      $p = Resolve-Window $request $false
      Activate-Window $p
      [ordered]@{ ok=$true; window=(Window-Record $p) }
    }
    'snapshot' {
      Get-Snapshot $request
    }
    'click-target' {
      $process = Resolve-Window $request $true
      Activate-Window $process
      $target = Find-TargetElement $request
      $method = Invoke-Target $target
      Start-Sleep -Milliseconds 100
      [ordered]@{ ok=$true; method=$method; target=$target.Record; window=(Window-Record $process) }
    }
    'click-coordinates' {
      $x = [int](Get-Prop $request 'x' 0); $y = [int](Get-Prop $request 'y' 0)
      $buttonName = [string](Get-Prop $request 'button' 'left')
      Click-Point $x $y ($(if ($buttonName -ieq 'right') { 1 } else { 0 }))
      [ordered]@{ ok=$true; x=$x; y=$y; button=$buttonName }
    }
    'drag' {
      $fromX=[int](Get-Prop $request 'fromX' 0); $fromY=[int](Get-Prop $request 'fromY' 0)
      $toX=[int](Get-Prop $request 'toX' 0); $toY=[int](Get-Prop $request 'toY' 0)
      $durationMs=[int](Get-Prop $request 'durationMs' 350)
      [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($fromX,$fromY)
      [PatrolDesktop.Native]::mouse_event(0x0002,0,0,0,[UIntPtr]::Zero)
      $steps=[Math]::Max(2,[Math]::Min(30,[Math]::Ceiling($durationMs/30)))
      for($i=1;$i -le $steps;$i++){
        $x=[int]($fromX+(($toX-$fromX)*$i/$steps)); $y=[int]($fromY+(($toY-$fromY)*$i/$steps))
        [System.Windows.Forms.Cursor]::Position = New-Object System.Drawing.Point($x,$y)
        Start-Sleep -Milliseconds ([Math]::Max(1,[int]($durationMs/$steps)))
      }
      [PatrolDesktop.Native]::mouse_event(0x0004,0,0,0,[UIntPtr]::Zero)
      [ordered]@{ok=$true;fromX=$fromX;fromY=$fromY;toX=$toX;toY=$toY}
    }
    'type-text' {
      $window = Activate-RequestedWindow $request
      $text = [string](Get-Prop $request 'text' '')
      $clear = [bool](Get-Prop $request 'clear' $false)
      if ($clear) { [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 40 }
      [System.Windows.Forms.Clipboard]::SetText($text)
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      [ordered]@{ ok=$true; chars=$text.Length; window=$window }
    }
    'type-target' {
      $text = [string](Get-Prop $request 'text' '')
      $process = Resolve-Window $request $true
      Activate-Window $process
      $target = Find-TargetElement $request
      $focusMethod = Focus-Target $target
      $clear = [bool](Get-Prop $request 'clear' $false)
      if ($clear) { [System.Windows.Forms.SendKeys]::SendWait('^a'); Start-Sleep -Milliseconds 40 }
      [System.Windows.Forms.Clipboard]::SetText($text)
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 100
      [ordered]@{
        ok=$true
        chars=$text.Length
        focusMethod=$focusMethod
        target=(Element-Record $target.Element)
        window=(Window-Record $process)
      }
    }

    'paste-target' {
      $process = Resolve-Window $request $true
      Activate-Window $process
      $target = Find-TargetElement $request
      $focusMethod = Focus-Target $target
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      Start-Sleep -Milliseconds 100
      [ordered]@{
        ok=$true
        focusMethod=$focusMethod
        target=(Element-Record $target.Element)
        window=(Window-Record $process)
      }
    }
    'press-target' {
      $key=[string](Get-Prop $request 'key' '')
      if ([string]::IsNullOrWhiteSpace($key)) { throw 'press-target requires key' }
      $process = Resolve-Window $request $true
      Activate-Window $process
      $target = Find-TargetElement $request
      $focusMethod = Focus-Target $target
      Send-Key $key
      Start-Sleep -Milliseconds 100
      [ordered]@{
        ok=$true
        key=$key
        focusMethod=$focusMethod
        target=(Element-Record $target.Element)
        window=(Window-Record $process)
      }
    }

    'hotkey' {
      $window = Activate-RequestedWindow $request
      $combo=[string](Get-Prop $request 'combo' '')
      if ([string]::IsNullOrWhiteSpace($combo)) { throw 'hotkey requires combo' }
      Send-Hotkey $combo
      [ordered]@{ok=$true;combo=$combo;window=$window}
    }
    'press' {
      $window = Activate-RequestedWindow $request
      $key=[string](Get-Prop $request 'key' '')
      if ([string]::IsNullOrWhiteSpace($key)) { throw 'press requires key' }
      Send-Key $key
      [ordered]@{ok=$true;key=$key;window=$window}
    }
    'wait' {
      $milliseconds=[int](Get-Prop $request 'milliseconds' 500)
      if($milliseconds -lt 0 -or $milliseconds -gt 600000){throw 'wait milliseconds must be between 0 and 600000'}
      Start-Sleep -Milliseconds $milliseconds
      [ordered]@{ok=$true;milliseconds=$milliseconds}
    }
    'screenshot' {
      Capture-Screenshot $request
    }
    'set-clipboard-text' {
      $text=[string](Get-Prop $request 'text' '')
      [System.Windows.Forms.Clipboard]::SetText($text)
      [ordered]@{ok=$true;chars=$text.Length}
    }
    'set-clipboard-files' {
      $paths=@(Get-Prop $request 'paths' @())
      if($paths.Count -eq 0){throw 'set-clipboard-files requires at least one path'}
      $collection=New-Object System.Collections.Specialized.StringCollection
      foreach($path in $paths){
        $resolved=[IO.Path]::GetFullPath([string]$path)
        if(-not (Test-Path -LiteralPath $resolved)){throw "clipboard file does not exist: $resolved"}
        [void]$collection.Add($resolved)
      }
      [System.Windows.Forms.Clipboard]::SetFileDropList($collection)
      [ordered]@{ok=$true;count=$collection.Count;paths=@($collection)}
    }
    'paste' {
      $window = Activate-RequestedWindow $request
      [System.Windows.Forms.SendKeys]::SendWait('^v')
      [ordered]@{ok=$true;window=$window}
    }
    'close-window' {
      $p=Resolve-Window $request $false
      [void][PatrolDesktop.Native]::PostMessage([IntPtr]$p.MainWindowHandle,0x0010,[IntPtr]::Zero,[IntPtr]::Zero)
      [ordered]@{ok=$true;window=(Window-Record $p)}
    }
    'delete-path' {
      $path=[string](Get-Prop $request 'path' '')
      if([string]::IsNullOrWhiteSpace($path)){throw 'delete-path requires path'}
      $resolved=[IO.Path]::GetFullPath($path)
      if(-not (Test-Path -LiteralPath $resolved)){throw "path does not exist: $resolved"}
      $recursive=[bool](Get-Prop $request 'recursive' $false)
      Remove-Item -LiteralPath $resolved -Force -Recurse:$recursive
      [ordered]@{ok=$true;path=$resolved;recursive=$recursive}
    }
    default { throw "unsupported desktop action '$Action'" }
  }

  $result | ConvertTo-Json -Depth 8 -Compress
  exit 0
} catch {
  [ordered]@{ ok=$false; error=$_.Exception.Message } | ConvertTo-Json -Depth 4 -Compress
  exit 1
}
