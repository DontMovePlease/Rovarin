param([switch]$Legacy)
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
if(-not $Legacy -and (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'standby-runtime.ps1'))){
    . (Join-Path $PSScriptRoot 'standby-runtime.ps1')
    if(Test-StandbyAvailable){$native=Start-StandbyRuntime;if(-not $native.legacyFallback){exit 0};$legacy=$true}
}
$installDir = Split-Path -Parent $appDir
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
$runtime = Get-DashboardRuntime $appDir -IgnoreStandby:$legacy
if ($runtime.state -eq 'owned' -and $runtime.healthy) { exit 0 }
if ($runtime.state -ne 'none') { exit 1 }
$dataDir = Join-Path $installDir 'data'
[IO.Directory]::CreateDirectory($dataDir) | Out-Null
$node = Join-Path $installDir 'runtime\node.exe'
$server = Join-Path $appDir 'server.js'
# Hardening inherited Node flags is specific to packaged launch, not dev.
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue
Remove-Item Env:NODE_PATH -ErrorAction SilentlyContinue
Remove-Item Env:PC_MONITOR_PIN -ErrorAction SilentlyContinue
Remove-Item Env:PORT -ErrorAction SilentlyContinue
Remove-Item Env:ROVARIN_STANDBY_PIPE -ErrorAction SilentlyContinue
Remove-Item Env:ROVARIN_STANDBY_SECRET -ErrorAction SilentlyContinue
if($Legacy -and (Test-Path -LiteralPath (Join-Path $appDir 'standby-runtime.json'))){$env:PORT=[string](Get-Content -LiteralPath (Join-Path $appDir 'standby-runtime.json') -Raw|ConvertFrom-Json).port}
Start-Process -FilePath $node -ArgumentList "`"$server`"" -WorkingDirectory $appDir -WindowStyle Hidden -RedirectStandardOutput (Join-Path $dataDir 'server.log') -RedirectStandardError (Join-Path $dataDir 'server-error.log') | Out-Null
