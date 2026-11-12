param([Parameter(Mandatory=$true)][string]$AppDirectory,[Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$ConfigurationFile,[int]$Port=7331,[int]$TimeoutSeconds=45)
$ErrorActionPreference='Stop'
$app=[IO.Path]::GetFullPath($AppDirectory);$node=[IO.Path]::GetFullPath($NodePath);$config=[IO.Path]::GetFullPath($ConfigurationFile)
if($Port -lt 1 -or $Port -gt 65535 -or $TimeoutSeconds -lt 20 -or $TimeoutSeconds -gt 60){throw 'Invalid standby configuration'}
if(-not (Test-Path -LiteralPath (Join-Path $app 'server.js')) -or -not (Test-Path -LiteralPath $node)){throw 'Canonical runtime inputs required'}
$exe=Join-Path $app 'RovarinStandby.exe'
& "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe" /nologo /target:winexe /optimize+ /platform:x64 /r:System.Web.Extensions.dll /r:System.Security.dll "/out:$exe" (Join-Path (Split-Path -Parent $PSScriptRoot) 'packaging\StandbySupervisor.cs')
if($LASTEXITCODE -ne 0){throw 'Standby compilation failed'}
$files=[ordered]@{}
foreach($file in Get-ChildItem -LiteralPath $app -File){if($file.Extension -in @('.js') -or $file.Name -in @('package.json','installation.json','Rovarin.exe','RovarinStandby.exe')){$files[$file.Name]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}}
foreach($folder in @('public','scripts')){
 foreach($file in Get-ChildItem -LiteralPath (Join-Path $app $folder) -File -Recurse){$relative=$file.FullName.Substring($app.Length+1).Replace('\','/');$files[$relative]=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$fingerprint=& $node (Join-Path $app 'server-lifecycle.js') --runtime-fingerprint
if($LASTEXITCODE -ne 0 -or $fingerprint -notmatch '^[a-f0-9]{64}$'){throw 'Source fingerprint unavailable'}
# Published builds contain only installation-relative paths, never developer paths.
$installed=Test-Path -LiteralPath (Join-Path $app 'installation.json')
$manifest=[ordered]@{schema=1;root='.';node=$(if($installed){'..\runtime\node.exe'}else{$node});config=$(if($installed){'..\data\config.json'}else{$config});nodeHash=(Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant();port=$Port;timeoutMs=$TimeoutSeconds*1000;files=$files;fingerprint=$fingerprint}
[IO.File]::WriteAllText((Join-Path $app 'standby-runtime.json'),($manifest|ConvertTo-Json -Depth 5),[Text.UTF8Encoding]::new($false))
