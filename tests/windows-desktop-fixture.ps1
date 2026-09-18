param(
  [string]$Title = 'DSH Patrol Desktop Smoke'
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

$form = New-Object System.Windows.Forms.Form
$form.Text = $Title
$form.Width = 560
$form.Height = 260
$form.StartPosition = 'CenterScreen'
$form.TopMost = $false

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Smoke input'
$label.Left = 20
$label.Top = 25
$label.Width = 120
$label.Height = 24

$input = New-Object System.Windows.Forms.TextBox
$input.Name = 'SmokeInput'
$input.AccessibleName = 'Smoke Input'
$input.Left = 20
$input.Top = 55
$input.Width = 480
$input.Height = 28

$button = New-Object System.Windows.Forms.Button
$button.Name = 'SmokeButton'
$button.AccessibleName = 'Apply Smoke'
$button.Text = 'Apply'
$button.Left = 20
$button.Top = 100
$button.Width = 100
$button.Height = 32

$status = New-Object System.Windows.Forms.Label
$status.Name = 'SmokeStatus'
$status.AccessibleName = 'Smoke Status'
$status.Text = 'idle'
$status.Left = 145
$status.Top = 105
$status.Width = 350
$status.Height = 24

$button.Add_Click({
  $status.Text = "applied:$($input.Text)"
})

$form.Controls.AddRange(@($label, $input, $button, $status))
$form.Add_Shown({
  $form.Activate()
  $input.Focus()
})

try {
  [void]$form.ShowDialog()
} finally {
  $form.Dispose()
}
