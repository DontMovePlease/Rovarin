param([switch]$Legacy)
$projectDir = Split-Path -Parent $PSScriptRoot
if(-not $Legacy -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'standby-runtime.ps1'))){
    . (Join-Path $PSScriptRoot 'standby-runtime.ps1')
    if(Test-StandbyAvailable){
        $native=Invoke-StandbyCommand status
        if($native){Stop-StandbyRuntime;exit 0}
        . (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
        $existing=Get-DashboardRuntime $projectDir -IgnoreStandby
        if($existing.state -eq 'owned'){$Legacy=$true}else{Stop-StandbyRuntime;exit 0}
    }
}
function Stop-DevWatcherProcess([string]$ProjectDirectory) {
    if (Test-Path -LiteralPath (Join-Path $ProjectDirectory 'installation.json')) { return }
    $dir = try { Get-RovarinDataDirectory $ProjectDirectory } catch { return }
    $pidFile = Join-Path $dir 'dev-watcher.pid'
    if (-not (Test-Path -LiteralPath $pidFile)) { return }
    $watcherPid = 0
    try {
        $text = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction SilentlyContinue).Trim()
        if (-not [int]::TryParse($text, [ref]$watcherPid) -or $watcherPid -le 0) {
            Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
            return
        }
    } catch { return }

    $stopped = $false
    try {
        $procInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$watcherPid" -OperationTimeoutSec 2 -ErrorAction SilentlyContinue
        if ($procInfo) {
            $cmd = [string]$procInfo.CommandLine
            $isNode = $procInfo.ProcessName -ieq 'node.exe' -or $cmd -match '(?i)\bnode(\.exe)?\b'
            $isWatcher = $cmd -match '(?i)dev-watcher\.js'
            if ($isNode -and $isWatcher) {
                $p = Get-Process -Id $watcherPid -ErrorAction SilentlyContinue
                if ($p -and -not $p.HasExited) {
                    Stop-Process -InputObject $p -Force -ErrorAction SilentlyContinue
                    $stopped = $p.WaitForExit(3000)
                    if ($stopped) {
                        Write-Host "[SUCCESS] Stopped dev-watcher PID $watcherPid." -ForegroundColor Green
                    }
                } else {
                    $stopped = $true
                }
            }
        } else {
            $stopped = $true
        }
    } catch {}
    if ($stopped) {
        Remove-Item -LiteralPath $pidFile -Force -ErrorAction SilentlyContinue
    }
}

Set-Location $projectDir
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
Stop-DevWatcherProcess $projectDir
$runtime = Get-DashboardRuntime $projectDir -IgnoreStandby:$Legacy
if ($runtime.state -eq 'starting') {
    $runtime = Wait-DashboardRuntime $projectDir 5 -IgnoreStandby:$Legacy
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
            $check = Get-DashboardRuntime $projectDir -IgnoreStandby:$Legacy
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
