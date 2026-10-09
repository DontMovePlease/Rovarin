$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$preview = Join-Path $projectDir 'packaging\cache\desktop-preview'
$payload = Join-Path $projectDir 'packaging\payload\app'
$compiler = Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
foreach ($file in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WebView2-LICENSE.txt','Rovarin.ico','Rovarin.exe.config')) {
    if (-not (Test-Path -LiteralPath (Join-Path $payload $file))) { throw 'Build the installer payload once before opening the development desktop.' }
}
New-Item -ItemType Directory -Force -Path $preview,(Join-Path $preview 'data') | Out-Null
$exe = Join-Path $preview 'Rovarin.exe'
if (Test-Path -LiteralPath $exe) {
    # IPC acknowledgement precedes shutdown. Wait on only this preview image.
    $previewProcesses = @(Get-Process -Name Rovarin -ErrorAction SilentlyContinue | Where-Object { try { $_.MainModule.FileName -eq $exe } catch { $false } })
    $close = Start-Process -FilePath $exe -ArgumentList 'close-desktop' -WorkingDirectory $preview -WindowStyle Hidden -Wait -PassThru
    try { if ($close.ExitCode -ne 0) { throw 'Development desktop did not confirm closure; refusing to replace its files.' } } finally { $close.Dispose() }
    foreach ($previewProcess in $previewProcesses) {
        try { if (-not $previewProcess.WaitForExit(10000)) { throw 'Development desktop is still closing; preview was not overwritten.' } }
        finally { $previewProcess.Dispose() }
    }
}
foreach ($file in @('Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WebView2-LICENSE.txt','Rovarin.ico','Rovarin.exe.config')) {
    Copy-Item -LiteralPath (Join-Path $payload $file) -Destination (Join-Path $preview $file) -Force
}
# Build the existing unsigned Inno companion without installing anything.
$serviceStage = Join-Path $env:TEMP ('rovarin-preview-service-' + [Guid]::NewGuid().ToString('N'))
try {
    & (Join-Path $projectDir 'packaging\build-maintenance-service.ps1') -OutputDirectory $serviceStage -Installer
    $setup = Join-Path $serviceStage 'RovarinMaintenanceSetup.exe'
    $maintenanceHash = (Get-FileHash -LiteralPath $setup -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($maintenanceHash -ne ([IO.File]::ReadAllText($setup+'.sha256')).Trim()) { throw 'Maintenance companion integrity mismatch.' }
    Copy-Item -LiteralPath $setup,($setup+'.sha256') -Destination $preview -Force
} finally {
    if (Test-Path -LiteralPath $serviceStage) { Remove-Item -LiteralPath $serviceStage -Recurse -Force }
}
# Compile the canonical shell with development storage/lifecycle paths only.
# No backend or public/ files are copied: it serves the live source checkout.
$source = [IO.File]::ReadAllText((Join-Path $projectDir 'packaging\DesktopShell.cs'))
$hashAnchor = 'internal const string MaintenanceSetupHash = "";'
if (-not $source.Contains($hashAnchor)) { throw 'Maintenance installer binding anchor changed.' }
$source = $source.Replace($hashAnchor,('internal const string MaintenanceSetupHash = "'+$maintenanceHash+'";'))
$patches = @(
    @("AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\')", 'Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "..", "..", ".."))'),
    @('Path.GetDirectoryName(AppDirectory)', "AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\')"),
    @('File.Exists(Path.Combine(AppDirectory, "installation.json"))', 'File.Exists(Path.Combine(AppDirectory, "server.js"))'),
    @('"desktop-host.ps1"', '"desktop-preview-host.ps1"'),
    @('Path.Combine(DesktopShell.AppDirectory, "Rovarin.ico")', 'Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "Rovarin.ico")')
)
foreach ($patch in $patches) {
    if (-not $source.Contains($patch[0])) { throw 'Native development adapter anchor changed; refusing an incomplete build.' }
    $source = $source.Replace($patch[0],$patch[1])
}
$generated = Join-Path $preview 'DesktopShell.preview.cs'
[IO.File]::WriteAllText($generated,$source)
& $compiler /nologo /target:winexe /platform:x64 /optimize+ /r:System.Windows.Forms.dll /r:System.Drawing.dll /r:System.Web.Extensions.dll "/r:$(Join-Path $preview 'Microsoft.Web.WebView2.Core.dll')" "/r:$(Join-Path $preview 'Microsoft.Web.WebView2.WinForms.dll')" "/win32manifest:$(Join-Path $projectDir 'packaging\desktop.manifest')" "/win32icon:$(Join-Path $preview 'Rovarin.ico')" "/out:$exe" (Join-Path $projectDir 'packaging\RovarinLauncher.cs') $generated
if ($LASTEXITCODE -ne 0) { throw 'Native development desktop compilation failed.' }
Start-Process -FilePath $exe -WorkingDirectory $preview -WindowStyle Normal
