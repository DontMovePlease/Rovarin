param([switch]$PayloadOnly)
$ErrorActionPreference = 'Stop'
# npm may inherit PowerShell 7's module path; use Windows PowerShell's own
# built-in modules for the Windows-only packaging toolchain.
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$repo = Split-Path -Parent $PSScriptRoot
$cache = Join-Path $PSScriptRoot 'cache'
$payload = Join-Path $PSScriptRoot 'payload'
[IO.Directory]::CreateDirectory($cache) | Out-Null
function Verified-Binary($name,$url,$hash,$publisher) {
    $file = Join-Path $cache $name
    if (-not (Test-Path -LiteralPath $file)) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file }
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() -ne $hash) { throw "$name hash mismatch; refusing to build." }
    $sig = Get-AuthenticodeSignature -LiteralPath $file
    if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch $publisher) { throw "$name publisher verification failed." }
    return $file
}
$node = Verified-Binary 'node.exe' 'https://nodejs.org/dist/v24.21.0/win-x64/node.exe' 'ba4e6d110e8c1592a1ecd390f6b05f3da124b13871a5be62b341a07a853c6c32' 'OpenJS Foundation'
$pawn = Verified-Binary 'PawnIO_setup.exe' 'https://github.com/namazso/PawnIO.Setup/releases/download/2.2.0/PawnIO_setup.exe' '1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032' 'namazso.eu'
if ([Diagnostics.FileVersionInfo]::GetVersionInfo($pawn).FileVersion -ne '2.2.0.0') { throw 'Unexpected PawnIO version.' }
if (-not (Test-Path -LiteralPath (Join-Path $cache 'Node-LICENSE'))) { Invoke-WebRequest 'https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE' -OutFile (Join-Path $cache 'Node-LICENSE') }
# Rebuild only this fixed generated payload; never copy the repository wholesale.
$resolvedPayload = [IO.Path]::GetFullPath($payload)
if ($resolvedPayload -ne [IO.Path]::GetFullPath((Join-Path $repo 'packaging\payload'))) { throw 'Unsafe payload path.' }
foreach ($localState in @('data','desktop-profile')) {
    if (Test-Path -LiteralPath (Join-Path $payload $localState)) { throw 'Generated payload contains local application data. Close its owned app/backend and preserve that data outside the payload before rebuilding. Use the installed Rovarin for normal desktop access.' }
}
if (Test-Path -LiteralPath $payload) { Remove-Item -LiteralPath $payload -Recurse -Force }
$app = Join-Path $payload 'app'
$runtime = Join-Path $payload 'runtime'
New-Item -ItemType Directory -Force -Path $app,$runtime,(Join-Path $app 'scripts'),(Join-Path $app 'public'),(Join-Path $app 'vendor\PawnIO\2.2.0') | Out-Null
$rootFiles = @('server.js','server-lifecycle.js','pin-manager.js','process-termination.js','enhanced-support.js','uninstall-manager.js','update-manager.js','process-stats.js','maintenance.js','temperature-manager.js','cpu-temperature-provider.js','package.json','run_hidden.vbs','LICENSE')
foreach ($name in $rootFiles) { Copy-Item -LiteralPath (Join-Path $repo $name) -Destination $app }
$scripts = @('start.ps1','stop.ps1','desktop.ps1','desktop-host.ps1','native-trust.ps1','dashboard-runtime.ps1','installed-start.ps1','installed-desktop.ps1','setup.ps1','phone-qr.js','empty-recycle-bin.ps1','install-enhanced.ps1','installed-uninstall.ps1','installed-update.ps1','rebrand-migration.ps1','cpu-temperature-provider.ps1','terminate-process.ps1')
foreach ($name in $scripts) { Copy-Item -LiteralPath (Join-Path $repo "scripts\$name") -Destination (Join-Path $app 'scripts') }
Copy-Item -LiteralPath (Join-Path $repo 'public') -Destination $app -Recurse -Force
Copy-Item -LiteralPath (Join-Path $repo 'vendor\LibreHardwareMonitor') -Destination (Join-Path $app 'vendor') -Recurse -Force
$qrSource = Join-Path $repo 'vendor\QRCode\1.8.0\qrcodegen.js'
if ((Get-FileHash -LiteralPath $qrSource -Algorithm SHA256).Hash.ToLowerInvariant() -ne '6a1116192ed1dd67fa1bf31e77f5817103d71c23bbac24c382e698b7668bdd01') { throw 'Vendored QR encoder hash mismatch.' }
Copy-Item -LiteralPath (Join-Path $repo 'vendor\QRCode') -Destination (Join-Path $app 'vendor') -Recurse -Force
foreach ($name in @('desktop.vbs','startup.vbs','startup-disable.vbs')) { Copy-Item -LiteralPath (Join-Path $PSScriptRoot $name) -Destination $app }
$launcherCompiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path -LiteralPath $launcherCompiler)) { throw 'Windows .NET Framework launcher compiler is unavailable.' }
$webViewPackage = Join-Path $cache 'webview2-1.0.4258.31.nupkg'
if (-not (Test-Path -LiteralPath $webViewPackage)) { Invoke-WebRequest -UseBasicParsing 'https://api.nuget.org/v3-flatcontainer/microsoft.web.webview2/1.0.4258.31/microsoft.web.webview2.1.0.4258.31.nupkg' -OutFile $webViewPackage }
if ((Get-FileHash -LiteralPath $webViewPackage).Hash.ToLowerInvariant() -ne '56f7f4b8bf9aee4b8efefbbdd4f67d5f74ebd1b100ed0806da71bf76af481aa9') { throw 'Microsoft WebView2 SDK hash mismatch.' }
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [IO.Compression.ZipFile]::OpenRead($webViewPackage)
try {
    foreach ($entry in @('lib/net462/Microsoft.Web.WebView2.Core.dll','lib/net462/Microsoft.Web.WebView2.WinForms.dll','runtimes/win-x64/native/WebView2Loader.dll','LICENSE.txt')) {
        $destination = Join-Path $app $(if ($entry -eq 'LICENSE.txt') {'WebView2-LICENSE.txt'} else {Split-Path -Leaf $entry})
        [IO.Compression.ZipFileExtensions]::ExtractToFile($zip.GetEntry($entry),$destination,$true)
    }
} finally { $zip.Dispose() }
foreach ($name in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll')) {
    $signature = Get-AuthenticodeSignature -LiteralPath (Join-Path $app $name)
    if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch 'Microsoft Corporation') { throw 'WebView2 binary signature invalid.' }
}
& (Join-Path $PSScriptRoot 'create-icon.ps1') -Output (Join-Path $app 'Rovarin.ico')
& $launcherCompiler /nologo /target:winexe /platform:x64 /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/r:$(Join-Path $app 'Microsoft.Web.WebView2.Core.dll')" "/r:$(Join-Path $app 'Microsoft.Web.WebView2.WinForms.dll')" "/win32manifest:$(Join-Path $PSScriptRoot 'desktop.manifest')" "/win32icon:$(Join-Path $app 'Rovarin.ico')" "/out:$(Join-Path $app 'Rovarin.exe')" (Join-Path $PSScriptRoot 'RovarinLauncher.cs') (Join-Path $PSScriptRoot 'DesktopShell.cs')
if ($LASTEXITCODE -ne 0) { throw 'Rovarin launcher compilation failed.' }
[IO.File]::WriteAllText((Join-Path $app 'Rovarin.exe.config'), '<configuration><startup><supportedRuntime version="v4.0" sku=".NETFramework,Version=v4.8" /></startup></configuration>')
[IO.File]::WriteAllText((Join-Path $app 'installation.json'), '{"schema":1,"channel":"windows-x64","data":"../data"}')
Copy-Item -LiteralPath $node -Destination (Join-Path $runtime 'node.exe')
Copy-Item -LiteralPath (Join-Path $cache 'Node-LICENSE') -Destination (Join-Path $runtime 'LICENSE')
Copy-Item -LiteralPath $pawn -Destination (Join-Path $app 'vendor\PawnIO\2.2.0\PawnIO_setup.exe')
# The official binary's terms are proprietary and explicitly permit unchanged
# installer redistribution. Do not mislabel it as the GPL source edition.
$pawnNotice = @'
PawnIO Official installer 2.2.0.0, unmodified.
Copyright namazso. All rights reserved.
PawnIO is provided "as is" without warranty of any kind, either express or implied.
Use at your own risk. The authors are not liable for damages arising from use.
This installer can be redistributed unmodified.

Official binary terms and redistribution statement are embedded in the installer.
https://github.com/namazso/PawnIO.Setup/releases/tag/2.2.0
https://github.com/namazso/PawnIO.Modules/wiki/Using-PawnIO-Modules#licensing-considerations
The GPL-2 source edition is separate from the proprietary Official signed binary.
Only -install -silent is used. Never select developer/unrestricted/debug variants.
2.2.0 is the current official production release, matches LHM's 2.2-era modules,
supports 2.1 upgrades, and reports reboot-required CLI exit 3010.
The untouched upstream installer internally contains edition choices; Rovarin
never invokes those choices and does not extract/distribute unsigned drivers.
'@
[IO.File]::WriteAllText((Join-Path $app 'vendor\PawnIO\2.2.0\NOTICE.txt'), $pawnNotice)
$manifest = @{nodeVersion='24.21.0'; innoVersion='7.1.0'; pawnIoVersion='2.2.0.0'; files=@()}
Get-ChildItem -LiteralPath $payload -File -Recurse | Sort-Object FullName | ForEach-Object {
    $manifest.files += @{path=$_.FullName.Substring($payload.Length+1).Replace('\','/'); sha256=(Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'payload-manifest.json'), ($manifest | ConvertTo-Json -Depth 5))
if ($PayloadOnly) { Write-Output 'Verified install payload built.'; return }
$compiler = Join-Path $cache 'inno\ISCC.exe'
if (-not (Test-Path -LiteralPath $compiler)) {
    $inno = Verified-Binary 'inno-setup.exe' 'https://github.com/jrsoftware/issrc/releases/download/is-7_1_0/innosetup-7.1.0-x64.exe' '0362a383ed217d4c4239b5933866dd96d3eb2102737da92f80f6057a4b40df2f' 'Pyrsys B.V.'
    $destination = Join-Path $cache 'inno'
    $process = Start-Process -FilePath $inno -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/CURRENTUSER',"/DIR=`"$destination`"",'/TASKS=' -WindowStyle Hidden -PassThru -Wait
    if ($process.ExitCode -ne 0) { throw 'Inno Setup installation failed.' }
}
if ((Get-AuthenticodeSignature -LiteralPath $compiler).Status -ne 'Valid') { throw 'Compiler signature invalid.' }
& $compiler (Join-Path $PSScriptRoot 'Rovarin.iss')
if ($LASTEXITCODE -ne 0) { throw 'Installer compilation failed.' }
$exe = Join-Path $repo 'dist\RovarinSetup.exe'
$hash = (Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant()
[IO.File]::WriteAllText((Join-Path $repo 'dist\RovarinSetup.sha256'), "$hash  RovarinSetup.exe`r`n")
$buildInfo = @{version=(Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version; builtAt=[DateTime]::UtcNow.ToString('o'); sha256=$hash; payloadManifestSha256=(Get-FileHash -LiteralPath (Join-Path $PSScriptRoot 'payload-manifest.json')).Hash.ToLowerInvariant(); inputs=@()}
foreach ($relative in @('packaging/build.ps1','packaging/Rovarin.iss','packaging/RovarinLauncher.cs','packaging/DesktopShell.cs','packaging/desktop.manifest','packaging/create-icon.ps1')) {
    $buildInfo.inputs += @{path=$relative;sha256=(Get-FileHash -LiteralPath (Join-Path $repo $relative)).Hash.ToLowerInvariant()}
}
[IO.File]::WriteAllText((Join-Path $repo 'dist\build.json'),($buildInfo | ConvertTo-Json -Depth 4))
Write-Output "Installer SHA-256: $hash"
