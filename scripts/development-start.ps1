$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
if (Test-Path -LiteralPath (Join-Path $appDir 'installation.json')) { throw 'Development launcher cannot own an installation.' }
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
$runtime = Get-DashboardRuntime $appDir
if ($runtime.state -eq 'owned' -and $runtime.healthy) { exit 0 }
if ($runtime.state -ne 'none') { exit 1 }
$dataDir = Get-RovarinDataDirectory $appDir
$node = (Get-Command node.exe -ErrorAction Stop).Source
# The normal launcher always uses the saved PIN; test overrides are not inherited.
Remove-Item Env:PC_MONITOR_PIN -ErrorAction SilentlyContinue
Remove-Item Env:PORT -ErrorAction SilentlyContinue
# Each normal launch replaces these bounded startup logs; watcher output stays in its terminal.
foreach ($name in @('server.log','server-error.log')) {
    $file = Join-Path $dataDir $name
    if (Test-Path -LiteralPath $file) {
        if ((Get-Item -LiteralPath $file).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirecting runtime log.' }
        Remove-Item -LiteralPath $file -Force
    }
}
$watcherScript = Join-Path $appDir 'scripts\dev-watcher.js'
$serverScript = Join-Path $appDir 'server.js'

if (Test-Path -LiteralPath $watcherScript) {
    try {
        $proc = Start-Process -FilePath $node -ArgumentList ('"'+$watcherScript+'"') -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') -PassThru
        Start-Sleep -Milliseconds 400
        if ($proc.HasExited -and $proc.ExitCode -ne 0) {
            Write-Warning "[dev] Development watcher failed to start (exit code $($proc.ExitCode)); falling back to direct server launch."
            Start-Process -FilePath $node -ArgumentList ('"'+$serverScript+'"') -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') | Out-Null
        }
    } catch {
        Write-Warning "[dev] Could not launch dev-watcher.js ($($_.Exception.Message)); falling back to direct server launch."
        Start-Process -FilePath $node -ArgumentList ('"'+$serverScript+'"') -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') | Out-Null
    }
} else {
    Write-Warning '[dev] scripts\dev-watcher.js was not found; falling back to direct server launch.'
    Start-Process -FilePath $node -ArgumentList ('"'+$serverScript+'"') -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') | Out-Null
}
