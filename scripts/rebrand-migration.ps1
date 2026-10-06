param([ValidateSet('Prepare','Commit')][string]$Mode, [string]$Destination)
# Installer-only, current-user migration. No HTTP route or arbitrary command.
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{C51A4180-26D2-4F48-93BD-B40B182B78DA}_is1'
$settings = @('config.json','temperature-settings.json','onboarding-complete.json','desktop-window.json','desktop-trust.bin','enhanced-install.json')
$destinationRoot = [IO.Path]::GetFullPath($Destination.TrimEnd('\'))
$receipt = Join-Path $destinationRoot 'data\rebrand-migration.json'
$stage = 'validation'
Add-Type @'
using System; using System.Runtime.InteropServices; using Microsoft.Win32.SafeHandles;
public static class RovarinMigrationPath {
  [StructLayout(LayoutKind.Sequential)] public struct TagInfo { public uint attributes; public uint tag; }
  [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern SafeFileHandle CreateFile(string n,uint a,uint s,IntPtr p,uint d,uint f,IntPtr t);
  [DllImport("kernel32.dll")] static extern bool GetFileInformationByHandleEx(SafeFileHandle h,int k,out TagInfo i,uint n);
  public static bool IsCloud(string p) { using(var h=CreateFile(p,0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) { TagInfo i; return !h.IsInvalid && GetFileInformationByHandleEx(h,9,out i,8) && (i.tag & 0xffff0fff)==0x9000001a; } }
}
'@
function Assert-Plain([string]$file) {
    $cursor = [IO.Path]::GetFullPath($file)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -and -not [RovarinMigrationPath]::IsCloud($cursor)) { throw 'redirecting-path' }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
}
function Hash([string]$file) { return (Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant() }
function Invoke-Owned([string]$file, [string[]]$Arguments) {
    $process = Start-Process -FilePath $file -ArgumentList $Arguments -WindowStyle Hidden -PassThru
    try {
        # Never terminate an installer/helper on timeout; preserve recovery data.
        if (-not $process.WaitForExit(60000)) { throw 'owned-operation-timeout' }
        if ($process.ExitCode -ne 0) { throw 'owned-operation-failed' }
    } finally { $process.Dispose() }
}
function Remove-LegacyShortcut([string]$file, [string]$legacy) {
    if (-not (Test-Path -LiteralPath $file)) { return }
    Assert-Plain $file
    $shell = New-Object -ComObject WScript.Shell
    try {
        $link = $shell.CreateShortcut($file)
        $owned = $link.TargetPath -ieq (Join-Path $legacy 'app\PCMonitor.exe') -or $link.TargetPath -ieq (Join-Path $legacy 'unins000.exe')
        if (-not $owned) { throw 'legacy-shortcut-not-owned' }
        Remove-Item -LiteralPath $file -Force
    } finally { [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null }
}
try {
    Assert-Plain $destinationRoot; Assert-Plain $receipt
    if ($Mode -eq 'Prepare') {
        # A completed copy survives an interrupted install; never generate a new PIN.
        if (Test-Path -LiteralPath $receipt) {
            $saved=Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
            if ($saved.schema -ne 1) { throw 'migration-record-invalid' }
            Assert-Plain $saved.legacyRoot
            foreach($property in $saved.hashes.PSObject.Properties) {
                if($property.Name -notin $settings -or $property.Value -cnotmatch '^[a-f0-9]{64}$') { throw 'migration-record-invalid' }
                $file=Join-Path $destinationRoot ('data\'+$property.Name); Assert-Plain $file
                if((Hash $file) -cne $property.Value){throw 'migration-copy-changed'}
            }
            if(-not $saved.hashes.'config.json'){throw 'migration-pin-missing'}
            if(-not (Test-Path -LiteralPath $registration)) {
                if(Test-Path -LiteralPath (Join-Path $saved.legacyRoot 'app\server.js')){throw 'legacy-uninstall-incomplete'}
                exit 0
            }
            $existing=Get-ItemProperty -LiteralPath $registration
            if($existing.DisplayName -ceq 'Rovarin' -and $existing.InstallLocation.TrimEnd('\') -ieq $destinationRoot){exit 0}
            if($existing.DisplayName -cne 'PC Monitor' -or $existing.InstallLocation.TrimEnd('\') -ine $saved.legacyRoot){throw 'migration-registration-changed'}
            # Resume the validated old uninstaller below after an interrupted Prepare.
        }
        if (-not (Test-Path -LiteralPath $registration)) { exit 0 }
        $stage='legacy-validation'
        $entry = Get-ItemProperty -LiteralPath $registration
        if ($entry.DisplayName -cne 'PC Monitor') { exit 0 }
        $legacy = [IO.Path]::GetFullPath($entry.InstallLocation.TrimEnd('\'))
        Assert-Plain $legacy
        # A completed old uninstall can leave only Inno's HKCU entry. This is
        # fresh state, not an installation whose ownership checks can be skipped.
        # Accept only the fixed default legacy root when it is entirely absent;
        # no legacy executable/data is executed, copied, removed or regenerated.
        if (-not (Test-Path -LiteralPath $legacy)) {
            $expectedLegacy = [IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'PCMonitor'))
            if ($legacy -ine $expectedLegacy -or $entry.UninstallString -cne ('"'+(Join-Path $legacy 'unins000.exe')+'"')) { throw 'missing-legacy-identity-unverified' }
            # A deleted-on-disk executable could still be alive. Query failure or
            # any legacy-root process reference remains a hard refusal; no kill.
            $stage='missing-legacy-process-validation'
            foreach ($process in @(Get-CimInstance Win32_Process -OperationTimeoutSec 10 -ErrorAction Stop)) {
                $image=[string]$process.ExecutablePath
                $command=[string]$process.CommandLine
                if ($image.StartsWith($legacy+'\',[StringComparison]::OrdinalIgnoreCase) -or $command.IndexOf($legacy+'\',[StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'missing-legacy-process-running' }
            }
            # Inno owns replacement of the same stable uninstall registration.
            Write-Output 'Previous installation is absent; settings migration is not required.'
            exit 0
        }
        if ($destinationRoot.StartsWith($legacy+'\',[StringComparison]::OrdinalIgnoreCase) -or $legacy.StartsWith($destinationRoot+'\',[StringComparison]::OrdinalIgnoreCase)) { throw 'overlapping-installations' }
        $oldApp = Join-Path $legacy 'app'
        $oldData = Join-Path $legacy 'data'
        $marker = Get-Content -LiteralPath (Join-Path $oldApp 'installation.json') -Raw | ConvertFrom-Json
        if ($marker.schema -ne 1 -or $marker.channel -cne 'windows-x64' -or $entry.UninstallString -cne ('"'+(Join-Path $legacy 'unins000.exe')+'"')) { throw 'legacy-identity-unverified' }
        $trustPath = Join-Path $oldApp 'uninstall-trust.json'; Assert-Plain $trustPath
        $trust = Get-Content -LiteralPath $trustPath -Raw | ConvertFrom-Json
        if ($trust.schema -ne 1) { throw 'legacy-trust-invalid' }
        foreach ($name in @('unins000.exe','unins000.dat','runtime\node.exe','app\server.js','app\scripts\installed-uninstall.ps1','app\scripts\stop.ps1','app\scripts\dashboard-runtime.ps1')) {
            $file = Join-Path $legacy $name; Assert-Plain $file
            if ($trust.hashes.$name -cne (Hash $file)) { throw 'legacy-hash-mismatch' }
        }
        # Validate the existing install before executing its fixed lifecycle.
        Invoke-Owned (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $oldApp 'scripts\installed-uninstall.ps1')+'"'),'-Mode','Validate')
        Invoke-Owned (Join-Path $oldApp 'PCMonitor.exe') @('close-desktop')
        Invoke-Owned (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $oldApp 'scripts\stop.ps1')+'"'))
        $stage='copy-settings'
        $hashes = @{}
        foreach ($name in $settings) {
            $source = Join-Path $oldData $name; Assert-Plain $source
            if (-not (Test-Path -LiteralPath $source)) { continue }
            $item = Get-Item -LiteralPath $source
            if ($item.PSIsContainer -or $item.Length -gt 1048576) { throw 'unsafe-settings' }
            $hashes[$name] = Hash $source
            if ($legacy -ine $destinationRoot) {
                $target = Join-Path $destinationRoot ('data\'+$name); Assert-Plain $target
                [IO.Directory]::CreateDirectory((Split-Path -Parent $target)) | Out-Null
                if (Test-Path -LiteralPath $target) { if ((Hash $target) -cne $hashes[$name]) { throw 'conflicting-canonical-settings' } }
                else { [IO.File]::Copy($source,$target,$false) }
                if ((Hash $target) -cne $hashes[$name]) { throw 'settings-copy-mismatch' }
                # Preserve CurrentUser-DPAPI file protection and security ACLs.
                Set-Acl -LiteralPath $target -AclObject (Get-Acl -LiteralPath $source)
            }
        }
        if (-not $hashes.ContainsKey('config.json')) { throw 'legacy-pin-missing' }
        [IO.File]::WriteAllText($receipt,(@{schema=1;legacyRoot=$legacy;hashes=$hashes}|ConvertTo-Json -Depth 4))
        if ($legacy -ine $destinationRoot) {
            # Inno remains the sole owner of file/registry/shortcut removal. Data
            # is preserved in BOTH locations until the replacement is healthy.
            $stage='legacy-uninstall'
            if (Test-Path -LiteralPath $legacy) {
                $items = @(Get-Item -LiteralPath $legacy -Force) + @(Get-ChildItem -LiteralPath $legacy -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer })
                foreach ($item in $items) {
                    if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) {
                        try { $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) } catch {}
                    }
                }
            }
            Invoke-Owned (Join-Path $legacy 'unins000.exe') @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART')
            if ((Test-Path -LiteralPath $registration) -or (Test-Path -LiteralPath (Join-Path $oldApp 'server.js'))) { throw 'legacy-uninstall-incomplete' }
        }
        exit 0
    }
    if (-not (Test-Path -LiteralPath $receipt)) { exit 0 }
    $record = Get-Content -LiteralPath $receipt -Raw | ConvertFrom-Json
    if ($record.schema -ne 1) { throw 'migration-record-invalid' }
    $legacy = [IO.Path]::GetFullPath($record.legacyRoot); Assert-Plain $legacy
    $entry = Get-ItemProperty -LiteralPath $registration
    if ($entry.DisplayName -cne 'Rovarin' -or [IO.Path]::GetFullPath($entry.InstallLocation.TrimEnd('\')) -ine $destinationRoot) { throw 'replacement-registration-unverified' }
    $newApp = Join-Path $destinationRoot 'app'
    $stage='replacement-validation'
    Invoke-Owned (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+(Join-Path $newApp 'scripts\installed-uninstall.ps1')+'"'),'-Mode','Validate')
    . (Join-Path $newApp 'scripts\dashboard-runtime.ps1')
    $configFile = Join-Path $destinationRoot 'data\config.json'
    if (Test-Path -LiteralPath $configFile) {
        $links = & cmd.exe /c "fsutil hardlink list `"$configFile`"" 2>$null
        foreach ($link in $links) {
            $trimmed = [string]$link.Trim()
            if ($trimmed -and $trimmed -match '[\\/]\.tmp\.driveupload[\\/]') {
                $drive = Split-Path -Qualifier $configFile
                $fullPath = if ($trimmed.StartsWith('\')) { $drive + $trimmed } else { $trimmed }
                if (Test-Path -LiteralPath $fullPath) {
                    Remove-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
                }
            }
        }
    }
    $stage='replacement-health'
    & (Join-Path $newApp 'scripts\start.ps1') | Out-Null
    $runtime = Wait-DashboardRuntime $newApp 15
    if (-not $runtime.healthy) {
        Start-Sleep -Seconds 2
        foreach ($record in @('server.pid','server-state.json','server.instance.json','server-start.lock')) {
            $recordPath = Join-Path (Join-Path $destinationRoot 'data') $record
            if (Test-Path -LiteralPath $recordPath) { Remove-Item -LiteralPath $recordPath -Force -ErrorAction SilentlyContinue }
        }
        if (Test-Path -LiteralPath $configFile) {
            $links = & cmd.exe /c "fsutil hardlink list `"$configFile`"" 2>$null
            foreach ($link in $links) {
                $trimmed = [string]$link.Trim()
                if ($trimmed -and $trimmed -match '[\\/]\.tmp\.driveupload[\\/]') {
                    $drive = Split-Path -Qualifier $configFile
                    $fullPath = if ($trimmed.StartsWith('\')) { $drive + $trimmed } else { $trimmed }
                    if (Test-Path -LiteralPath $fullPath) {
                        Remove-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
                    }
                }
            }
        }
        & (Join-Path $newApp 'scripts\start.ps1') | Out-Null
        $runtime = Wait-DashboardRuntime $newApp 15
    }
    if (-not $runtime.healthy) { throw 'replacement-not-healthy' }
    $stage='settings-verification'
    foreach ($property in $record.hashes.PSObject.Properties) {
        if ($property.Name -notin $settings) { throw 'unexpected-migration-setting' }
        $target = Join-Path $destinationRoot ('data\'+$property.Name); Assert-Plain $target
        if ((Hash $target) -cne $property.Value) { throw 'replacement-setting-mismatch' }
    }
    $stage='shortcut-cleanup'
    foreach ($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Startup'))) { Remove-LegacyShortcut (Join-Path $folder 'PC Monitor.lnk') $legacy }
    $group = Join-Path ([Environment]::GetFolderPath('Programs')) 'PC Monitor'; Assert-Plain $group
    if (Test-Path -LiteralPath $group) {
        foreach ($name in @('PC Monitor.lnk','PC Monitor Setup and PIN Recovery.lnk','Disable PC Monitor Startup.lnk','Uninstall PC Monitor.lnk','PC Monitor Web Dashboard.lnk')) { Remove-LegacyShortcut (Join-Path $group $name) $legacy }
        if (@(Get-ChildItem -LiteralPath $group -Force).Count -eq 0) { Remove-Item -LiteralPath $group -Force }
    }
    if ($legacy -ine $destinationRoot) {
        $stage='legacy-data-cleanup'
        foreach ($property in $record.hashes.PSObject.Properties) {
            $source = Join-Path $legacy ('data\'+$property.Name); Assert-Plain $source
            if (Test-Path -LiteralPath $source) {
                if ((Hash $source) -cne $property.Value) { throw 'legacy-setting-changed' }
                Remove-Item -LiteralPath $source -Force
            }
        }
        # Unknown user files are retained. Never recursively remove this root.
        foreach ($folder in @((Join-Path $legacy 'app'),(Join-Path $legacy 'runtime'),(Join-Path $legacy 'data'),$legacy)) { if ((Test-Path -LiteralPath $folder) -and @(Get-ChildItem -LiteralPath $folder -Force).Count -eq 0) { Remove-Item -LiteralPath $folder -Force } }
    } else {
        foreach ($name in @('PCMonitor.exe','PCMonitor.exe.config','PCMonitor.ico')) { $file=Join-Path $newApp $name; Assert-Plain $file; if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force} }
    }
    Remove-Item -LiteralPath $receipt -Force
    Write-Output 'Rovarin migration verified; existing PIN and settings preserved.'
} catch {
    # Do not print paths, PINs, trust bytes or raw exceptions.
    try {
        $result=Join-Path $destinationRoot 'data\rebrand-result.json'; Assert-Plain $result
        if(Test-Path -LiteralPath (Split-Path -Parent $result)) { [IO.File]::WriteAllText($result,(@{success=$false;code='migration-unverified';stage=$stage}|ConvertTo-Json -Compress)) }
    } catch {}
    Write-Output 'Rovarin migration could not be verified. Preserved settings were retained; inspect the installation before retrying.'
    exit 1
}
