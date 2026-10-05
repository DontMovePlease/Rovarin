param([string]$Source = (Join-Path $PSScriptRoot 'setup.ps1'))
$ErrorActionPreference='Stop'
# Render only the UI with synthetic diagnostics/PIN. Never read user config or start a server.
$sourceText=[IO.File]::ReadAllText($Source)
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseInput($sourceText,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Setup syntax is invalid.'}
foreach($name in @('Get-PhoneSetupState','New-PhoneQrBitmap')){
    $definition=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true)
    $definitionText=$definition.Extent.Text.Replace('(Join-Path $PSScriptRoot ''phone-qr.js'')', "'$(Join-Path (Split-Path -Parent $Source) 'phone-qr.js')'")
    Invoke-Expression $definitionText
}
$node=(Get-Command node.exe -ErrorAction Stop).Source
$appDir=Split-Path -Parent $PSScriptRoot
$pin='000000';$firstRun=$true;$local='http://127.0.0.1:7332';$Hosted=$true
function Complete-LocalOnboarding {}
function New-Report($kind){
    $available=if($kind -eq 'missing'){'unavailable'}else{'supported'}
    $state=if($kind -eq 'connected'){'Running'}elseif($kind -eq 'disconnected'){'NeedsLogin'}else{$null}
    return @{overall=@{title='Rovarin is compatible with this PC.'};checks=@(
        @{id='tailscale';status=$available},@{id='tailscale-status';status=$(if($state -eq 'Running'){'supported'}else{'unavailable'});value=$state},
        @{id='tailscale-ip';value=$(if($kind -eq 'connected'){'100.64.1.2'}else{$null})},
        @{id='cpu-temperature';status='unavailable'},@{id='enhanced-driver';summary='Enhanced temperature is optional. Local monitoring remains available.'}
    )}
}
$report=New-Report 'connected';$phoneState=Get-PhoneSetupState $report 7332
$uiStart=$sourceText.IndexOf('Add-Type -AssemblyName System.Windows.Forms', $sourceText.IndexOf('if ($Automatic)'))
$uiEnd=$sourceText.IndexOf('try {$form.ShowDialog() | Out-Null}')
if($uiStart -lt 0 -or $uiEnd -le $uiStart){throw 'Setup UI boundaries changed.'}
Invoke-Expression $sourceText.Substring($uiStart,$uiEnd-$uiStart)
try {
    $form.Opacity=0;$form.Show();[Windows.Forms.Application]::DoEvents()
    foreach($fontSize in @(11,14)){
        $form.Font=New-Object Drawing.Font('Segoe UI',$fontSize)
        foreach($kind in @('missing','disconnected','connected')){
            $script:phoneState=Get-PhoneSetupState (New-Report $kind) 7332
            Update-PhoneSetup
            foreach($size in @((New-Object Drawing.Size(640,700)),(New-Object Drawing.Size(544,440)))){
                $form.ClientSize=$size
                Update-SetupLayout;$form.PerformLayout();$content.PerformLayout();[Windows.Forms.Application]::DoEvents()
                foreach($label in @($title,$pinHint,$connectionLabel,$phoneLabel)){
                    $needed=$label.GetPreferredSize((New-Object Drawing.Size($label.MaximumSize.Width,0)))
                    if($label.Height -lt $needed.Height -or $label.Width -gt $content.Width){throw "Clipped setup label ($kind / $fontSize): $($label.Text.Split([char]10)[0])"}
                }
                if($footer.Bottom -gt $form.ClientSize.Height -or $open.Height -lt 40){throw 'Finish button is not usable.'}
                if($body.Bottom -gt $footer.Top){throw 'Scrollable content overlaps Finish.'}
                if($phoneLabel.Text -match 'iPhone'){throw 'Device-specific recovery instructions remain.'}
                if($copyPhone.Enabled -ne ($kind -eq 'connected')){throw 'Address copy state is incorrect.'}
                if($kind -ne 'connected' -and $qrBox.Visible){throw 'QR visible without a remote address.'}
            }
        }
    }
    $form.Font=New-Object Drawing.Font('Segoe UI',11);$form.ClientSize=New-Object Drawing.Size(640,700)
    $script:phoneState=Get-PhoneSetupState (New-Report 'connected') 7332;Update-PhoneSetup
    $body.AutoScrollPosition=New-Object Drawing.Point(0,0)
    $form.PerformLayout();[Windows.Forms.Application]::DoEvents()
    $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height)
    try{$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)));$bitmap.Save((Join-Path $appDir 'packaging/cache/setup-layout-preview.png'))}finally{$bitmap.Dispose()}
    Write-Output 'PASS Setup UI: three Tailscale states, normal/larger fonts, normal/small windows, wrapping, fixed Finish and dummy-PIN render.'
}finally{
    if($qrBox.Image){$qrBox.Image.Dispose()};$form.Close();$form.Dispose()
}
