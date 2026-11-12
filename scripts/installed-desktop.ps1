param([switch]$Setup)
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path (Split-Path -Parent $appDir) 'data'
$legacy=$false;$native=$null
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'standby-runtime.ps1')){
    . (Join-Path $PSScriptRoot 'standby-runtime.ps1')
    if(Test-StandbyAvailable){$native=Start-StandbyRuntime -Wake;$legacy=[bool]$native.legacyFallback}
}
if(-not $native -or $legacy){& (Join-Path $PSScriptRoot 'start.ps1') -Legacy:$legacy | Out-Null}
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
$runtime = Get-DashboardRuntime $appDir -IgnoreStandby:$legacy
if ($runtime.state -ne 'owned' -or -not $runtime.healthy) {
    try { [IO.File]::AppendAllText((Join-Path $dataDir 'launcher-error.log'), "[Launcher] Dashboard was not ready: $($runtime.state); $($runtime.reason)`r`n") } catch { }
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show('Rovarin could not start safely. An existing instance may still be starting, or ports 7331-7335 may be unavailable. Try again shortly; no other process was stopped.', 'Rovarin') | Out-Null
    exit 1
}
if ($Setup) { & (Join-Path $PSScriptRoot 'setup.ps1') -Hosted; Start-Process -FilePath (Join-Path $appDir 'Rovarin.exe') -WorkingDirectory $appDir; return }
if (-not (Test-Path -LiteralPath (Join-Path $dataDir 'onboarding-complete.json'))) { & (Join-Path $PSScriptRoot 'setup.ps1') -Automatic; return }
& (Join-Path $PSScriptRoot 'desktop.ps1')
