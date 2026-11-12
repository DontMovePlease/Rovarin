$projectDir = Split-Path -Parent $PSScriptRoot
$legacy=$false;$native=$null
if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'standby-runtime.ps1')){
    . (Join-Path $PSScriptRoot 'standby-runtime.ps1')
    if(Test-StandbyAvailable){$native=Start-StandbyRuntime -Wake;$legacy=[bool]$native.legacyFallback}
}
if(-not $native -or $legacy){& (Join-Path $PSScriptRoot 'start.ps1') -Legacy:$legacy}
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
$runtime = Get-DashboardRuntime $projectDir -IgnoreStandby:$legacy
if ($runtime.state -ne 'owned' -or -not $runtime.healthy) { Write-Host '[ERROR] Dashboard is not responding; no desktop window opened.'; exit 1 }
$url = "http://127.0.0.1:$($runtime.port)"
if (Test-Path -LiteralPath (Join-Path $projectDir 'installation.json')) { Start-Process $url; return }
# Browser access is retained only for source-checkout development/diagnostics.
Start-Process $url
