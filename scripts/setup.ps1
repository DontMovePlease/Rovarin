param([switch]$CheckOnly, [switch]$RegeneratePin, [switch]$Automatic, [switch]$Hosted)
$ErrorActionPreference = 'Stop'
# Hidden shortcuts must fail visibly without displaying paths or saved secrets.
trap {
    if (-not $CheckOnly) {
        Add-Type -AssemblyName System.Windows.Forms
        [Windows.Forms.MessageBox]::Show('Rovarin could not open local PIN Recovery. Your PIN and settings were not reset. Check that the Rovarin files and local Node runtime are available, then try again.', 'Rovarin PIN Recovery', 'OK', 'Error') | Out-Null
    }
    exit 1
}
function Get-PhoneSetupState($Report, [int]$Port) {
    $availability = $Report.checks | Where-Object id -eq 'tailscale' | Select-Object -First 1
    $status = $Report.checks | Where-Object id -eq 'tailscale-status' | Select-Object -First 1
    $ip = $Report.checks | Where-Object id -eq 'tailscale-ip' | Select-Object -First 1
    $address = $null
    $candidate = [string]$ip.value
    $parsed = $null
    $validIp = $candidate -cmatch '^100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$' -and
        [Net.IPAddress]::TryParse($candidate, [ref]$parsed) -and
        $parsed.AddressFamily -eq [Net.Sockets.AddressFamily]::InterNetwork -and
        $parsed.GetAddressBytes()[1] -ge 64 -and $parsed.GetAddressBytes()[1] -le 127
    if ($status.value -eq 'Running' -and $status.status -eq 'supported' -and $validIp -and $Port -ge 1 -and $Port -le 65535) {
        $address = "http://${candidate}:$Port"
        return @{kind='connected';status='Connected';address=$address;install=$false;instructions="Connect another device`r`n1. Install Tailscale on that device and sign into the same network as this PC.`r`n2. Away from home? Open Tailscale on that device and make sure it shows Connected before opening Rovarin. This PC must also stay online and connected to Tailscale.`r`n3. Open $address in its browser (or scan the QR code).`r`n4. Enter your Rovarin PIN."}
    }
    if ($availability.status -eq 'unavailable' -and -not $candidate -and -not $status.value) {
        return @{kind='missing';status='Not installed';address=$null;install=$true;instructions="Connect another device (optional)`r`nRovarin is installed successfully and works locally.`r`nFor secure remote access, install Tailscale on this PC and your other device, then sign into the same Tailscale network.`r`nYou can finish now and connect later."}
    }
    $explanation = if ($availability.status -eq 'supported') { 'Tailscale is installed but not connected.' } else { 'Tailscale connection status is unconfirmed.' }
    return @{kind='disconnected';status='Not connected / unconfirmed';address=$null;install=$false;instructions="Connect another device (optional)`r`n$explanation`r`nOpen Tailscale and sign in/connect, then choose Re-check Tailscale.`r`nAway from home? Your phone also needs Tailscale open and Connected before opening Rovarin.`r`nYour local Rovarin dashboard remains available."}
}
$appDir = Split-Path -Parent $PSScriptRoot
$installed = Test-Path -LiteralPath (Join-Path $appDir 'installation.json')
$dataDir = if ($installed) { Join-Path (Split-Path -Parent $appDir) 'data' } else { $appDir }
$onboardingLock = $null
function Complete-LocalOnboarding {
    [IO.File]::WriteAllText((Join-Path $dataDir 'onboarding-complete.json'), '{"completed":true}', (New-Object Text.UTF8Encoding($false)))
}
function New-PhoneQrBitmap([string]$Address) {
    if (-not $Address) { return $null }
    $process=New-Object Diagnostics.Process
    $process.StartInfo=New-Object Diagnostics.ProcessStartInfo
    $process.StartInfo.FileName=$node
    $process.StartInfo.Arguments='"'+(Join-Path $PSScriptRoot 'phone-qr.js')+'"'
    $process.StartInfo.UseShellExecute=$false;$process.StartInfo.CreateNoWindow=$true
    $process.StartInfo.RedirectStandardInput=$true;$process.StartInfo.RedirectStandardOutput=$true;$process.StartInfo.RedirectStandardError=$true
    try {
        [void]$process.Start()
        $output=$process.StandardOutput.ReadToEndAsync();$errors=$process.StandardError.ReadToEndAsync()
        $process.StandardInput.Write(($Address | ConvertTo-Json -Compress));$process.StandardInput.Close()
        if(-not $process.WaitForExit(5000)){ $process.Kill();[void]$process.WaitForExit(5000); return $null }
        if($process.ExitCode -ne 0){return $null}
        $matrix=$output.Result | ConvertFrom-Json
        if($matrix.size -lt 21 -or $matrix.size -gt 33 -or $matrix.rows.Count -ne $matrix.size){return $null}
        $scale=4;$border=4
        $bitmap=New-Object Drawing.Bitmap(($matrix.size+2*$border)*$scale),(($matrix.size+2*$border)*$scale)
        $graphics=[Drawing.Graphics]::FromImage($bitmap)
        try {
            $graphics.Clear([Drawing.Color]::White)
            for($y=0;$y -lt $matrix.size;$y++){
                if($matrix.rows[$y] -notmatch ('^[01]{'+$matrix.size+'}$')){ $bitmap.Dispose();return $null }
                for($x=0;$x -lt $matrix.size;$x++){if($matrix.rows[$y][$x] -eq '1'){$graphics.FillRectangle([Drawing.Brushes]::Black,($x+$border)*$scale,($y+$border)*$scale,$scale,$scale)}}
            }
        } finally {$graphics.Dispose()}
        return $bitmap
    } catch {return $null} finally {$process.Dispose()}
}
$node = if ($installed) { Join-Path (Split-Path -Parent $appDir) 'runtime\node.exe' } else {
    $nodeCommand = Get-Command node.exe -ErrorAction SilentlyContinue
    if ($nodeCommand) { $nodeCommand.Source }
    else { Join-Path $env:ProgramFiles 'nodejs\node.exe' }
}
if (-not (Test-Path -LiteralPath $node -PathType Leaf)) { throw 'Local Node runtime unavailable.' }
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
$runtime = Get-DashboardRuntime $appDir
if ($runtime.state -eq 'none') {
    & (Join-Path $PSScriptRoot 'start.ps1') | Out-Null
    $deadline = (Get-Date).AddSeconds(15)
    do { $runtime = Get-DashboardRuntime $appDir; if ($runtime.state -eq 'owned' -and $runtime.healthy) { break }; Start-Sleep -Milliseconds 200 } while ((Get-Date) -lt $deadline)
}
if ($runtime.state -ne 'owned' -or -not $runtime.healthy) { throw 'Rovarin is not healthy.' }
# Resolve through the same fixed local helper as the backend (no client path).
$configFile = & $node (Join-Path $appDir 'pin-manager.js') --config-path
if ($LASTEXITCODE -ne 0 -or -not $configFile) { throw 'Saved configuration is unavailable.' }
$configFile = [string]$configFile
# Recovery is a native user-launched window. No PIN HTTP endpoint or bypass.
if ($RegeneratePin) {
    & $node (Join-Path $appDir 'pin-manager.js') --regenerate | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'PIN regeneration failed.' }
}
$pin = (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).pin
if ($pin -cnotmatch '^(\d{6}|\d{12})$') { throw 'A valid saved PIN is not available.' }
$local = "http://127.0.0.1:$($runtime.port)"
$webSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
function Read-SetupDiagnostics([switch]$Refresh) {
try {
    if($Refresh){$current=Get-DashboardRuntime $appDir;if($current.state -eq 'owned' -and $current.healthy){$script:runtime=$current;$script:local="http://127.0.0.1:$($current.port)"}}
    Invoke-RestMethod "$local/api/login" -Method Post -ContentType 'application/json' -Body (@{pin=$pin} | ConvertTo-Json -Compress) -WebSession $webSession -TimeoutSec 5 | Out-Null
    $query = if ($Refresh) { '?refresh=1' } else { '' }
    return Invoke-RestMethod "$local/api/diagnostics$query" -WebSession $webSession -TimeoutSec 20
} catch {
    # Recovery must remain usable even if login is locked or Diagnostics fails.
    return @{overall=@{title='Diagnostics unavailable. You can still recover your PIN.';status='unavailable'};checks=@()}
} finally {
    try { Invoke-RestMethod "$local/api/logout" -Method Post -WebSession $webSession -TimeoutSec 5 | Out-Null } catch { }
}
}
$report = Read-SetupDiagnostics
$phoneState = Get-PhoneSetupState $report $runtime.port
$firstRun = -not (Test-Path -LiteralPath (Join-Path $dataDir 'onboarding-complete.json'))
if ($CheckOnly) {
    # Test-safe validation: deliberately omit the PIN, cookies and private paths.
    @{pinValid=$true; firstRun=$firstRun; actualPort=$runtime.port; compatible=($report.overall.status -eq 'supported');tailscaleState=$phoneState.kind;phoneAddress=$phoneState.address} | ConvertTo-Json -Compress
    return
}
if ($Automatic) {
    try {$onboardingLock=[IO.File]::Open((Join-Path $dataDir 'onboarding.lock'),[IO.FileMode]::OpenOrCreate,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)}
    catch { if(($_.Exception.HResult -band 65535) -ne 32){throw}; if(-not $Hosted){& (Join-Path $PSScriptRoot 'desktop.ps1')}; return }
    if(Test-Path -LiteralPath (Join-Path $dataDir 'onboarding-complete.json')){$onboardingLock.Dispose();if(-not $Hosted){& (Join-Path $PSScriptRoot 'desktop.ps1')};return}
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object Windows.Forms.Form
$form.Text = 'Rovarin - Setup and PIN Recovery'
$form.ClientSize = New-Object Drawing.Size(640,700)
$form.MinimumSize = New-Object Drawing.Size(560,480)
$form.StartPosition = 'CenterScreen'
$form.Font = New-Object Drawing.Font('Segoe UI',11)
$form.AutoScaleMode = 'Font'
$form.AutoScaleDimensions = New-Object Drawing.SizeF(7,17)
$background = [Drawing.Color]::FromArgb(15,22,34)
$surface = [Drawing.Color]::FromArgb(35,52,71)
$foreground = [Drawing.Color]::FromArgb(232,240,248)
$muted = [Drawing.Color]::FromArgb(180,197,214)
$accent = [Drawing.Color]::FromArgb(38,112,153)
if ([Windows.Forms.SystemInformation]::HighContrast) {
    $background=[Drawing.SystemColors]::Window; $surface=[Drawing.SystemColors]::Control
    $foreground=[Drawing.SystemColors]::WindowText; $muted=$foreground
    $accent=[Drawing.SystemColors]::Highlight
}
$form.BackColor=$background; $form.ForeColor=$foreground
$iconPath=Join-Path $appDir 'Rovarin.ico'
if(Test-Path -LiteralPath $iconPath){$form.Icon=New-Object Drawing.Icon($iconPath)}
$body=New-Object Windows.Forms.Panel
$body.Dock='Fill'; $body.AutoScroll=$true; $body.Padding=New-Object Windows.Forms.Padding(24,20,24,16)
$content=New-Object Windows.Forms.TableLayoutPanel
$content.Dock='Top'; $content.AutoSize=$true; $content.ColumnCount=1
$content.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent',100))) | Out-Null
$body.Controls.Add($content); $form.Controls.Add($body)
function Add-SetupRow($control) {
    $control.Margin=New-Object Windows.Forms.Padding(0,0,0,16)
    $control.Dock='Top'
    $row=$content.RowCount; $content.RowCount++
    $content.RowStyles.Add((New-Object Windows.Forms.RowStyle('AutoSize'))) | Out-Null
    $content.Controls.Add($control,0,$row)
}
function New-SetupLabel($text) {
    $label = New-Object Windows.Forms.Label
    $label.Text=$text; $label.AutoSize=$true; $label.ForeColor=$muted
    $label.MaximumSize=New-Object Drawing.Size(560,0)
    $label.Margin=New-Object Windows.Forms.Padding(0)
    return $label
}
function New-SetupButton($text) {
    $button=New-Object Windows.Forms.Button
    $button.Text=$text; $button.Height=44; $button.Dock='Top'; $button.FlatStyle='Flat'
    $button.BackColor=$surface; $button.ForeColor=$foreground; $button.UseVisualStyleBackColor=$false
    $button.FlatAppearance.BorderSize=0; $button.FlatAppearance.MouseOverBackColor=$accent
    $button.Margin=New-Object Windows.Forms.Padding(0,0,8,0)
    return $button
}
function New-SetupPair {
    $pair=New-Object Windows.Forms.TableLayoutPanel
    $pair.AutoSize=$true; $pair.ColumnCount=2
    $pair.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent',50))) | Out-Null
    $pair.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle('Percent',50))) | Out-Null
    return $pair
}
$title=New-SetupLabel $(if($firstRun){'Welcome to Rovarin'}else{'Setup and PIN Recovery'})
$title.Font=New-Object Drawing.Font('Segoe UI',20,[Drawing.FontStyle]::Bold)
$title.ForeColor=$foreground; Add-SetupRow $title
Add-SetupRow (New-SetupLabel 'Your dashboard is ready on this PC. Connecting another device is optional.')
$pinHint=New-SetupLabel 'Your Rovarin PIN signs you in on this PC and other devices. Keep it private.'
Add-SetupRow $pinHint
$pinRow=New-SetupPair
$pinRow.ColumnStyles[0].Width=100; $pinRow.ColumnStyles[1].SizeType='Absolute'; $pinRow.ColumnStyles[1].Width=150
$pinField = New-Object Windows.Forms.TextBox
$pinField.Text = if ($pin.Length -eq 6) { $pin -replace '(\d{3})(\d{3})','$1 $2' } else { $pin -replace '(\d{4})(\d{4})(\d{4})','$1 $2 $3' }; $pinField.ReadOnly=$true
$pinField.Font=New-Object Drawing.Font('Segoe UI',22)
$pinField.Dock='Top'; $pinField.Margin=New-Object Windows.Forms.Padding(0,0,16,0)
$pinField.BackColor=$surface; $pinField.ForeColor=$foreground; $pinField.BorderStyle='FixedSingle'
$copy = New-SetupButton 'Copy PIN'
$copy.Add_Click({ [Windows.Forms.Clipboard]::SetText($pin); $copy.Text='Copied' })
$pinRow.Controls.Add($pinField,0,0); $pinRow.Controls.Add($copy,1,0); Add-SetupRow $pinRow
$regenerate = New-SetupButton 'Generate New PIN'
$regenerate.Add_Click({
    if ([Windows.Forms.MessageBox]::Show('Generate a new PIN and sign out every device?', 'Generate New PIN', 'YesNo', 'Warning') -ne 'Yes') { return }
    try {
        & $node (Join-Path $appDir 'pin-manager.js') --regenerate | Out-Null
        if ($LASTEXITCODE -ne 0) { throw 'PIN regeneration failed.' }
        $script:pin = (Get-Content -LiteralPath $configFile -Raw | ConvertFrom-Json).pin
        $pinField.Text = $pin -replace '(\d{3})(\d{3})','$1 $2'; $copy.Text='Copy PIN'
    } catch { [Windows.Forms.MessageBox]::Show('Could not update the PIN. Check the local saved configuration.', 'PIN update failed') | Out-Null }
})
$temp = $report.checks | Where-Object id -eq 'cpu-temperature' | Select-Object -First 1
$driver=$report.checks | Where-Object id -eq 'enhanced-driver' | Select-Object -First 1
$installation=$report.checks | Where-Object id -eq 'enhanced-installation' | Select-Object -First 1
$enhancedNote=if($installation.value -eq 'reboot-required' -or $installation.status -eq 'failed'){$installation.summary}else{$driver.summary}
$connectionLabel = New-SetupLabel ''; Add-SetupRow $connectionLabel
$remoteRow=New-SetupPair
$remoteRow.ColumnStyles[0].Width=100; $remoteRow.ColumnStyles[1].SizeType='Absolute'; $remoteRow.ColumnStyles[1].Width=172
$phoneLabel = New-SetupLabel $phoneState.instructions
$phoneLabel.Dock='Top'; $phoneLabel.Margin=New-Object Windows.Forms.Padding(0,0,16,0)
$qrBox=New-Object Windows.Forms.PictureBox
$qrBox.Size=New-Object Drawing.Size(156,156); $qrBox.SizeMode='Zoom'; $qrBox.Margin=New-Object Windows.Forms.Padding(8,0,0,0)
$qrBox.AccessibleName='Scan to open Rovarin on another device'
$remoteRow.Controls.Add($phoneLabel,0,0); $remoteRow.Controls.Add($qrBox,1,0); Add-SetupRow $remoteRow
$tailscale = New-SetupButton 'Install Tailscale'
$tailscale.Add_Click({ Start-Process 'https://tailscale.com/download/windows' })
$recheck = New-SetupButton 'Re-check Tailscale'
$remoteActions=New-SetupPair
$remoteActions.Controls.Add($tailscale,0,0); $remoteActions.Controls.Add($recheck,1,0); Add-SetupRow $remoteActions
$copyPhone = New-SetupButton 'Copy device address'
$copyPhone.Add_Click({ if ($script:phoneState.address) { [Windows.Forms.Clipboard]::SetText($script:phoneState.address); $copyPhone.Text='Copied' } })
$securityActions=New-SetupPair
$securityActions.Controls.Add($copyPhone,0,0); $securityActions.Controls.Add($regenerate,1,0); Add-SetupRow $securityActions
Add-SetupRow (New-SetupLabel "$($report.overall.title)`r`nCPU temperature: $($temp.status)`r`n$enhancedNote")
Add-SetupRow (New-SetupLabel 'Local desktop works without Tailscale. PIN recovery is available only through this local Windows shortcut. Generating a new PIN signs out every device.')
$footer=New-Object Windows.Forms.Panel
$footer.Dock='Bottom'; $footer.Height=72; $footer.Padding=New-Object Windows.Forms.Padding(24,12,24,16)
$footer.BackColor=$background
$open = New-SetupButton 'Finish / Open Rovarin'
$open.Dock='Fill'; $open.BackColor=$accent; $open.ForeColor=[Drawing.Color]::White
$footer.Controls.Add($open); $form.Controls.Add($footer)
$open.Add_Click({
    Complete-LocalOnboarding
    if(-not $Hosted){& (Join-Path $PSScriptRoot 'desktop.ps1')}
    $form.Close()
})
function Update-SetupLayout {
    $width=[Math]::Max(280,$body.ClientSize.Width-$body.Padding.Horizontal-24)
    $content.Width=$width
    foreach($control in $content.Controls){if($control -is [Windows.Forms.Label]){$control.MaximumSize=New-Object Drawing.Size($width,0)}}
    $qrWidth=if($script:phoneState.address){172}else{0}
    $remoteRow.ColumnStyles[1].Width=$qrWidth
    $phoneLabel.MaximumSize=New-Object Drawing.Size(($width-$qrWidth-16),0)
}
function Update-PhoneSetup {
    $connectionLabel.Text = "Local dashboard: $local`r`nTailscale: $($script:phoneState.status)`r`nDevice address: $(if ($script:phoneState.address) {$script:phoneState.address} else {'Available after Tailscale connects.'})"
    $phoneLabel.Text = $script:phoneState.instructions
    $tailscale.Visible = $script:phoneState.install
    $remoteActions.ColumnStyles[0].Width=if($script:phoneState.install){50}else{0}
    $remoteActions.ColumnStyles[1].Width=if($script:phoneState.install){50}else{100}
    $copyPhone.Enabled = [bool]$script:phoneState.address
    $copyPhone.Text='Copy device address'
    if($qrBox.Image){$qrBox.Image.Dispose();$qrBox.Image=$null}
    $qrBox.Image=New-PhoneQrBitmap $script:phoneState.address
    $qrBox.Visible=$null -ne $qrBox.Image
    Update-SetupLayout
}
$recheck.Add_Click({
    $recheck.Enabled=$false; $recheck.Text='Checking...'; $form.Refresh()
    try { $script:report=Read-SetupDiagnostics -Refresh; $phonePort=if($script:report.binding.actualPort){$script:report.binding.actualPort}else{$runtime.port}; $script:phoneState=Get-PhoneSetupState $script:report $phonePort; Update-PhoneSetup }
    finally { $recheck.Text='Re-check Tailscale'; $recheck.Enabled=$true }
})
Update-PhoneSetup
$body.Add_Resize({Update-SetupLayout})
$form.Add_Shown({Update-SetupLayout; $form.BringToFront(); $form.Activate()})
$form.Add_FormClosing({Complete-LocalOnboarding})
try {$form.ShowDialog() | Out-Null}
finally {if($qrBox.Image){$qrBox.Image.Dispose()};$form.Dispose();if($onboardingLock){$onboardingLock.Dispose()}}
