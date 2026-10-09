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
Start-Process -FilePath $node -ArgumentList ('"'+(Join-Path $appDir 'server.js')+'"') -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') | Out-Null
