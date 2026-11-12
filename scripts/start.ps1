param([switch]$Legacy)
$projectDir = Split-Path -Parent $PSScriptRoot
if(-not $Legacy -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'standby-runtime.ps1'))){
    . (Join-Path $PSScriptRoot 'standby-runtime.ps1')
    if(Test-StandbyAvailable){$native=Start-StandbyRuntime;if(-not $native.legacyFallback){return};$Legacy=$true}
}
Set-Location $projectDir
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
$runtime = Get-DashboardRuntime $projectDir -IgnoreStandby:$Legacy
if ($runtime.state -eq 'starting' -or ($runtime.state -eq 'owned' -and -not $runtime.healthy)) {
    $runtime = Wait-DashboardRuntime $projectDir -IgnoreStandby:$Legacy
}
# Reopening the native app must not reuse Node modules from an older build.
if ($runtime.state -eq 'owned' -and $runtime.stale) {
    Write-Host '[ACTION] Restarting the verified Rovarin backend after a code update.'
    & (Join-Path $PSScriptRoot 'stop.ps1') -Legacy:$Legacy
    if ($LASTEXITCODE -ne 0) { throw 'Owned backend shutdown failed; no replacement started.' }
    $runtime = Get-DashboardRuntime $projectDir -IgnoreStandby:$Legacy
    if ($runtime.state -ne 'none') { throw 'Previous backend still owns its runtime; no replacement started.' }
}
if ($runtime.state -eq 'owned') {
    if ($runtime.healthy) { Write-Host "[STATUS] Dashboard is already running (PID $($runtime.pid)); http://127.0.0.1:$($runtime.port)" -ForegroundColor Yellow }
    else { Write-Host "[ERROR] Dashboard PID $($runtime.pid) owns port $($runtime.port), but the HTTP health check failed. No second server started." -ForegroundColor Red }
    return
}
if ($runtime.state -ne 'none') {
    Write-Host "[ERROR] Existing server ownership is $($runtime.state). No second server started." -ForegroundColor Red
    return
}
Write-Host '[ACTION] Launching Rovarin Dashboard in background...' -ForegroundColor Cyan
$vbsPath = Join-Path $projectDir 'run_hidden.vbs'
if($Legacy -and (Test-Path -LiteralPath (Join-Path $projectDir 'installation.json'))){& (Join-Path $PSScriptRoot 'installed-start.ps1') -Legacy}
else{Start-Process -FilePath wscript.exe -ArgumentList "`"$vbsPath`"" -WorkingDirectory $projectDir -WindowStyle Hidden}
$runtime = Wait-DashboardRuntime $projectDir -IgnoreStandby:$Legacy
if ($runtime.state -eq 'owned' -and $runtime.healthy) {
    Write-Host "[SUCCESS] Dashboard PID $($runtime.pid); http://127.0.0.1:$($runtime.port)" -ForegroundColor Green
} else {
    Write-Host "[ERROR] Server did not become healthy (state: $($runtime.state); $($runtime.reason)). Check the canonical runtime directory for server.log and server-state.json." -ForegroundColor Red
}
