$ErrorActionPreference = 'Stop'
# Fixed local shell handoff. Never returns PINs, sessions or arbitrary paths.
$appDir = Split-Path -Parent $PSScriptRoot
$dataDir = Join-Path (Split-Path -Parent $appDir) 'data'
try {
    $legacy=$false;
    if(Test-Path -LiteralPath (Join-Path $PSScriptRoot 'standby-runtime.ps1')){
        . (Join-Path $PSScriptRoot 'standby-runtime.ps1')
        if(Test-StandbyAvailable){$native=Start-StandbyRuntime -Wake;if(-not $native.legacyFallback){$native|ConvertTo-Json -Compress;exit 0};$legacy=$true}
    }
    & (Join-Path $PSScriptRoot 'start.ps1') -Legacy:$legacy *>&1 | Out-Null
    . (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
    $runtime = Get-DashboardRuntime $appDir -IgnoreStandby:$legacy
    if ($runtime.state -ne 'owned' -or -not $runtime.healthy) { throw 'not-ready' }
    # PIN enrollment belongs to the canonical native Glass UI. The local
    # Recovery utility remains explicitly available from the Start menu.
    # Setup can take arbitrarily long. Revalidate after the user dismisses it.
    $runtime = Get-DashboardRuntime $appDir -IgnoreStandby:$legacy
    if ($runtime.state -ne 'owned' -or -not $runtime.healthy) { throw 'not-ready' }
    @{ ready=$true; port=[int]$runtime.port } | ConvertTo-Json -Compress
} catch { @{ ready=$false; port=0 } | ConvertTo-Json -Compress; exit 1 }
