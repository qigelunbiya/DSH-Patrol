param(
  [string]$Title = 'DSH Patrol Desktop Smoke'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase

$window = New-Object System.Windows.Window
$window.Title = $Title
$window.Width = 560
$window.Height = 260
$window.WindowStartupLocation = 'CenterScreen'
$window.Topmost = $false

$panel = New-Object System.Windows.Controls.StackPanel
$panel.Margin = '20'

$label = New-Object System.Windows.Controls.TextBlock
$label.Text = 'Smoke input'
$label.Margin = '0,0,0,8'

$input = New-Object System.Windows.Controls.TextBox
$input.Name = 'SmokeInput'
$input.Height = 30
$input.Margin = '0,0,0,12'
[System.Windows.Automation.AutomationProperties]::SetAutomationId($input, 'SmokeInput')
[System.Windows.Automation.AutomationProperties]::SetName($input, 'Smoke Input')

$button = New-Object System.Windows.Controls.Button
$button.Name = 'SmokeButton'
$button.Content = 'Apply'
$button.Width = 100
$button.Height = 32
$button.HorizontalAlignment = 'Left'
$button.Margin = '0,0,0,12'
[System.Windows.Automation.AutomationProperties]::SetAutomationId($button, 'SmokeButton')
[System.Windows.Automation.AutomationProperties]::SetName($button, 'Apply Smoke')

$status = New-Object System.Windows.Controls.TextBlock
$status.Name = 'SmokeStatus'
$status.Text = 'idle'
[System.Windows.Automation.AutomationProperties]::SetAutomationId($status, 'SmokeStatus')
[System.Windows.Automation.AutomationProperties]::SetName($status, 'idle')

$button.Add_Click({
  $next = "applied:$($input.Text)"
  $status.Text = $next
  [System.Windows.Automation.AutomationProperties]::SetName($status, $next)
}.GetNewClosure())

[void]$panel.Children.Add($label)
[void]$panel.Children.Add($input)
[void]$panel.Children.Add($button)
[void]$panel.Children.Add($status)
$window.Content = $panel

$window.Add_ContentRendered({
  [void]$input.Focus()
}.GetNewClosure())

try {
  [void]$window.ShowDialog()
} finally {
  $window.Close()
}
