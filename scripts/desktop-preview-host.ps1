$ErrorActionPreference = 'Stop'
# Development-only native client: reuse the source checkout's safe lifecycle.
$projectDir = Split-Path -Parent $PSScriptRoot
try {
    . (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
    $runtime = Get-DashboardRuntime $projectDir
    # Reuse one complete ownership/freshness/HTTP check on the warm path.
    # Cold, stale or unhealthy starts still use the existing guarded lifecycle.
    if ($runtime.state -ne 'owned' -or -not $runtime.healthy -or $runtime.stale) {
        & (Join-Path $PSScriptRoot 'start.ps1') *>&1 | Out-Null
        $runtime = Get-DashboardRuntime $projectDir
    }
    if ($runtime.state -ne 'owned' -or -not $runtime.healthy) { throw 'not-ready' }
    @{ ready=$true; port=[int]$runtime.port } | ConvertTo-Json -Compress
} catch { @{ ready=$false; port=0 } | ConvertTo-Json -Compress; exit 1 }
