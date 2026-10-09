param([string]$OutputDirectory,[switch]$Installer)
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = Join-Path $env:TEMP ('rovarin-service-build-' + [Guid]::NewGuid().ToString('N'))
}
# Unelevated build only. Never copy into Program Files, register or start a service here.
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if ((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Build this fixture without elevation.' }
$target=[IO.Path]::GetFullPath($OutputDirectory)
$protected=[Environment]::GetFolderPath('ProgramFiles')
if ($target.StartsWith($protected+'\',[StringComparison]::OrdinalIgnoreCase) -or $target -eq $protected) { throw 'Build output must not be a protected deployment.' }
if (Test-Path -LiteralPath $target) { throw 'Use a fresh disposable output directory.' }
$parent=Split-Path -Parent $target
for($dir=[IO.DirectoryInfo]$parent;$null -ne $dir;$dir=$dir.Parent) {if(($dir.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Unsafe build output.'}}
New-Item -ItemType Directory -Path $target | Out-Null
$exe=Join-Path $target 'RovarinMaintenanceService.exe'
$compiler=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
& $compiler /nologo /target:exe /platform:x64 /r:System.ServiceProcess.dll /r:System.Web.Extensions.dll ('/out:'+$exe) (Join-Path $PSScriptRoot '..\scripts\maintenance-service.cs') (Join-Path $PSScriptRoot '..\scripts\maintenance-service-lifecycle.cs')
if($LASTEXITCODE -ne 0){throw 'Foundation compilation failed; output is not deployable.'}
$hash=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($exe+'.sha256',$hash+"`n",[Text.UTF8Encoding]::new($false))
Write-Output 'Built service fixture and checksum. Not installed or registered. Protected bootstrap and VM validation are required.'
if($Installer) {
    $repo=Split-Path -Parent $PSScriptRoot
    $version=(Get-Content (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
    $inno=Join-Path $PSScriptRoot 'cache\inno\ISCC.exe'
    if(-not (Test-Path -LiteralPath $inno)){throw 'Existing Inno compiler unavailable. No bootstrap was built.'}
    & $inno ('/DServicePayload='+$target) ('/DServiceHash='+$hash) ('/DProductVersion='+$version) ('/O'+$target) (Join-Path $PSScriptRoot 'RovarinMaintenance.iss')
    if($LASTEXITCODE -ne 0){throw 'Maintenance bootstrap compilation failed.'}
    $setup=Join-Path $target 'RovarinMaintenanceSetup.exe'
    [IO.File]::WriteAllText($setup+'.sha256',(Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()+"`n",[Text.UTF8Encoding]::new($false))
    Write-Output 'Unsigned alpha maintenance bootstrap built. SHA-256 is integrity metadata, not publisher authentication. Do not run on the development host.'
}