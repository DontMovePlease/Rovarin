param([switch]$Notify)
$ErrorActionPreference = 'Stop'
$appDir = Split-Path -Parent $PSScriptRoot
$dataDir = if (Test-Path -LiteralPath (Join-Path $appDir 'installation.json')) { Join-Path (Split-Path -Parent $appDir) 'data' } else { $appDir }
$installer = Join-Path $appDir 'vendor\PawnIO\2.2.0\PawnIO_setup.exe'
$expectedHash = '1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032'
$result = @{ exitCode = -1; failureCode='package-unavailable'; completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
$child = $null
$handle = $null
$operationLock = $null
function Test-EnhancedAlreadyInstalled {
    # A duplicate installer exit is not success. Reuse only a verified exact
    # supported installation; ambiguous/old/tampered registrations still install.
    try {
        $entry = Get-ItemProperty -LiteralPath 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PawnIO' -ErrorAction Stop
        $directory = [IO.Path]::GetFullPath(([string]$entry.InstallLocation).TrimEnd('\'))
        if ($entry.DisplayVersion -ne '2.2.0.0' -or $directory -ine (Join-Path $env:ProgramFiles 'PawnIO')) { return $false }
        $service = Get-ItemProperty -LiteralPath 'HKLM:\SYSTEM\CurrentControlSet\Services\PawnIO' -ErrorAction Stop
        if ($service.Type -ne 1 -or $service.Start -ne 3) { return $false }
        $driver = [IO.Path]::GetFullPath(([string]$service.ImagePath -replace '^\\SystemRoot\\',($env:SystemRoot+'\')))
        $driverRoot = Join-Path $env:SystemRoot 'System32\DriverStore\FileRepository'
        if (-not $driver.StartsWith($driverRoot+'\',[StringComparison]::OrdinalIgnoreCase) -or $driver -notmatch '\\pawnio\.inf_[^\\]+\\PawnIO\.sys$') { return $false }
        foreach ($file in @((Join-Path $directory 'PawnIOLib.dll'),$driver)) {
            for ($cursor=$file;$cursor;$cursor=[IO.Path]::GetDirectoryName($cursor)) {
                if ((Get-Item -LiteralPath $cursor -Force -ErrorAction Stop).Attributes -band [IO.FileAttributes]::ReparsePoint) { return $false }
            }
            $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($file)
            if ($version.FileMajorPart -ne 2 -or $version.FileMinorPart -ne 2 -or $version.FileBuildPart -ne 0 -or $version.FilePrivatePart -ne 0) { return $false }
            $signature = Get-AuthenticodeSignature -LiteralPath $file -ErrorAction Stop
            $publisher = if ($file -eq $driver) { 'CN=Microsoft Windows Hardware Compatibility Publisher,' } else { 'CN=namazso.eu,' }
            if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.Subject -notmatch [regex]::Escape($publisher)) { return $false }
        }
        return $true
    } catch { return $false }
}
try {
    [IO.Directory]::CreateDirectory($dataDir) | Out-Null
    $operationLock = [IO.File]::Open((Join-Path $dataDir 'enhanced-install.lock'), [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
    # Hold a read-only sharing handle through UAC/execution: no replacement/writes
    # can occur between validation and launch. Only the signed EXE is elevated.
    $handle = [IO.File]::Open($installer, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $result.failureCode='package-invalid'
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = [BitConverter]::ToString($sha.ComputeHash($handle)).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    $signature = Get-AuthenticodeSignature -LiteralPath $installer
    $version = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer).FileVersion
    if ($hash -ne $expectedHash -or $signature.Status -ne 'Valid' -or $version -ne '2.2.0.0') { throw 'Package verification failed.' }
    $result.failureCode='launch-failed'
    $record = Join-Path $dataDir 'enhanced-install.json'
    if (Test-Path -LiteralPath $record) {
        $previous = Get-Content -LiteralPath $record -Raw | ConvertFrom-Json
        $boot = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).LastBootUpTime
        $bootMilliseconds = ([DateTimeOffset]$boot).ToUnixTimeMilliseconds()
        if ($previous.exitCode -eq 1460 -and $bootMilliseconds -le $previous.completedAt) { $result.exitCode = 1460; throw 'Previous installation unconfirmed; restart Windows before retrying.' }
    }
    if (Test-EnhancedAlreadyInstalled) {
        $result.exitCode=0; $result.failureCode='already-installed'
    } else {
        $result.failureCode='launch-failed'
        # A crash during UAC/install leaves a persistent unconfirmed result instead
        # of permitting repeated privileged installers after a server restart.
        $pending = @{exitCode=1460;completedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}
        [IO.File]::WriteAllText($record, ($pending | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        # These exact flags select the normal signed edition. Never -unrestricted.
        $child = Start-Process -FilePath $installer -ArgumentList '-install', '-silent' -Verb RunAs -PassThru -ErrorAction Stop
        $result.exitCode = 1460
        if (-not $child.WaitForExit(240000)) { $result.exitCode = 1460; throw 'Installation result unconfirmed; inspect Windows before retrying.' }
        $result.exitCode = if ($null -ne $child.ExitCode) { [int]$child.ExitCode } else { 1460 }
        $result.failureCode='install-failed'
    }
} catch {
    $native = $_.Exception
    while ($native.InnerException) { $native = $native.InnerException }
    if ($native.NativeErrorCode -eq 1223) { $result.exitCode = 1223 }
} finally { if ($handle) { $handle.Dispose() }; if ($child) { $child.Dispose() } }
$result.completedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
try {
    if (-not $operationLock) { throw 'Another installation owns the result record.' }
    $record = Join-Path $dataDir 'enhanced-install.json'
    [IO.Directory]::CreateDirectory($dataDir) | Out-Null
    [IO.File]::WriteAllText($record, ($result | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
} catch { } finally { if ($operationLock) { $operationLock.Dispose() } }
function Get-EnhancedInstallMessage($result) {
    $message = if ($result.exitCode -eq 0 -and $result.failureCode -eq 'already-installed') { 'Verified Enhanced hardware support is already installed. CPU sensor availability is checked separately; virtual machines may have no compatible sensor. Rovarin is ready to use.' }
      elseif ($result.exitCode -eq 0) { 'Enhanced hardware support installer completed successfully. CPU sensor availability is checked separately in the dashboard; virtual machines may have no compatible sensor. Rovarin is ready to use.' }
      elseif ($result.exitCode -in @(3010,1641)) { 'Enhanced hardware support was installed. Restart Windows to finish setup. Rovarin remains usable now.' }
      elseif ($result.exitCode -in @(1223,1602)) { 'Enhanced installation was cancelled. Rovarin remains usable without CPU temperature.' }
      elseif ($result.exitCode -eq 1460) { 'The Enhanced installer has not returned a confirmed result. Check Windows; restart Windows before retrying. Rovarin remains usable.' }
      elseif ($result.failureCode -eq 'package-invalid') { 'Enhanced installer signature, hash or version verification failed. Nothing was installed. Rovarin remains usable.' }
      elseif ($result.failureCode -eq 'package-unavailable') { 'The trusted Enhanced installer is unavailable. Rovarin remains usable.' }
      elseif ($result.failureCode -eq 'launch-failed') { 'The trusted Enhanced installer could not launch. Rovarin remains usable.' }
      else { 'Enhanced hardware support installation failed (installer exit ' + $result.exitCode + '). Rovarin remains usable without CPU temperature.' }
    return $message
}
if ($Notify -and $result.failureCode -ne 'already-installed') {
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show((Get-EnhancedInstallMessage $result), 'Rovarin - Enhanced Support') | Out-Null
}
$result | ConvertTo-Json -Compress
