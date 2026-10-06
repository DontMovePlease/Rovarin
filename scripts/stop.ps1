$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location $projectDir
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
$runtime = Get-DashboardRuntime $projectDir
if ($runtime.state -eq 'starting') {
    $runtime = Wait-DashboardRuntime $projectDir 5
}
if ($runtime.state -eq 'owned') {
    $stoppingProcess = $null
    try {
        if (Test-Path -LiteralPath (Join-Path $projectDir 'installation.json')) {
            $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$($runtime.pid)" -ErrorAction Stop
            $expectedNode = Join-Path (Split-Path -Parent $projectDir) 'runtime\node.exe'
            $expectedServer = Join-Path $projectDir 'server.js'
            $nodePattern = '(?:"' + [regex]::Escape($expectedNode) + '"|' + [regex]::Escape($expectedNode) + ')'
            $serverPattern = '(?:"' + [regex]::Escape($expectedServer) + '"|' + [regex]::Escape($expectedServer) + ')'
            if ($candidate.ExecutablePath -ne $expectedNode -or -not $candidate.CommandLine -or $candidate.CommandLine -notmatch ('^\s*' + $nodePattern + '\s+' + $serverPattern + '(?:\s|$)')) { throw 'ownership-unverified' }
        }
        $stoppingProcess = Get-Process -Id $runtime.pid -ErrorAction Stop
        Stop-Process -InputObject $stoppingProcess -Force -ErrorAction Stop
        # Windows can retain a terminated PID while a process handle is open.
        # Confirm the owned process handle is signalled, not merely PID absence.
        if (-not $stoppingProcess.WaitForExit(5000) -or -not $stoppingProcess.HasExited) { throw 'exit-unconfirmed' }
        $stopDeadline = (Get-Date).AddSeconds(5)
        do {
            $check = Get-DashboardRuntime $projectDir
            if ($check.state -eq 'none') { break }
            Start-Sleep -Milliseconds 100
        } while ((Get-Date) -lt $stopDeadline)
        Write-Host "[SUCCESS] Stopped dashboard PID $($runtime.pid) on port $($runtime.port)." -ForegroundColor Green
    } catch {
        $reason = if ($_.Exception.Message -in @('ownership-unverified','exit-unconfirmed')) { $_.Exception.Message } else { [string]$_.CategoryInfo.Category }
        Write-Host "[ERROR] Could not confirm the dashboard stopped ($reason); runtime records retained." -ForegroundColor Red; exit 1
    } finally { if ($stoppingProcess) { $stoppingProcess.Dispose() } }
} elseif ($runtime.state -eq 'none') {
    Write-Host '[INFO] Dashboard server was not running. Stale runtime records recover at the next launch.' -ForegroundColor Yellow
} else {
    Write-Host '[WARNING] Dashboard listener ownership could not be verified; process left untouched.' -ForegroundColor Yellow
    exit 1
}
