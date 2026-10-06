param(
    [ValidateSet('Register','Validate','Cleanup','Launch','Handoff')][string]$Mode = 'Validate',
    [switch]$FullRemoval,
    [switch]$RemoveStartup
)
$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$app = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$installRoot = Split-Path -Parent $app
$data = Join-Path $installRoot 'data'
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{C51A4180-26D2-4F48-93BD-B40B182B78DA}_is1'
$trustFile = Join-Path $app 'uninstall-trust.json'
$handoffFile = Join-Path $data 'uninstall-handoff.json'
$held = @()
$owned = $null
$stage = 'validation'
Add-Type @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class RovarinReparse {
    [StructLayout(LayoutKind.Sequential)] public struct TagInfo { public uint attributes; public uint tag; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int kind, out TagInfo info, uint size);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool MoveFileEx(string source, string destination, uint flags);
    public static bool IsCloud(string path) {
        using (var handle = CreateFile(path, 0, 7, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero)) {
            TagInfo info;
            if (handle.IsInvalid || !GetFileInformationByHandleEx(handle, 9, out info, 8)) return false;
            // Documented IO_REPARSE_TAG_CLOUD and CLOUD_1..F; not name surrogates.
            return (info.tag & 0xffff0fff) == 0x9000001a;
        }
    }
}
'@
function Assert-PlainPath([string]$target) {
    $cursor = [IO.Path]::GetFullPath($target)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            $item = Get-Item -LiteralPath $cursor -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -and -not [RovarinReparse]::IsCloud($cursor)) { throw 'reparse-point' }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
}
function Assert-Installation {
    Assert-PlainPath $installRoot
    Assert-PlainPath $app
    Assert-PlainPath $data
    $marker = Get-Content -LiteralPath (Join-Path $app 'installation.json') -Raw | ConvertFrom-Json
    if ($marker.schema -ne 1 -or $marker.channel -ne 'windows-x64') { throw 'not-installed' }
    $entry = Get-ItemProperty -LiteralPath $registration
    if ([IO.Path]::GetFullPath($entry.InstallLocation.TrimEnd('\')) -ne $installRoot) { throw 'registration-mismatch' }
}
function Assert-Data {
    # Rovarin creates only leaf files here. Never traverse a user junction.
    if (Test-Path -LiteralPath $data) {
        foreach ($item in @(Get-ChildItem -LiteralPath $data -Force)) {
            if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'unsafe-data-entry' }
        }
    }
}
function Assert-DesktopProfile {
    # Only this fixed application-owned WebView2 cache is traversed. Never follow
    # junctions/symlinks; validate the entire tree before removing a single entry.
    $profile = Join-Path $installRoot 'desktop-profile'
    Assert-PlainPath $profile
    if (Test-Path -LiteralPath $profile) {
        $pending = New-Object 'Collections.Generic.Queue[string]'
        $pending.Enqueue($profile)
        while ($pending.Count -gt 0) {
            foreach ($item in @(Get-ChildItem -LiteralPath $pending.Dequeue() -Force)) {
                if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'unsafe-desktop-profile' }
                if ($item.PSIsContainer) { $pending.Enqueue($item.FullName) }
            }
        }
    }
}
function Save-HandoffState([string]$phase) {
    $file=Join-Path $data 'uninstall-result.json'
    Assert-PlainPath $file
    [IO.File]::WriteAllText($file,(@{success=$false;code='handoff-pending';stage=$phase}|ConvertTo-Json -Compress))
}
function Read-Handoff {
    Assert-PlainPath $handoffFile
    $record=Get-Content -LiteralPath $handoffFile -Raw | ConvertFrom-Json
    if (@($record.PSObject.Properties).Count -ne 5 -or $record.schema -ne 1 -or $record.ownerPid -notmatch '^[1-9]\d*$' -or
        $record.nonce -cnotmatch '^[a-f0-9]{64}$' -or $record.removeData -isnot [bool] -or $record.phase -notin @('preparing','ready','committed','aborted','failed')) { throw 'invalid-handoff' }
    return $record
}
function Set-HandoffPhase($record,[string]$phase) {
    $temporary=$handoffFile+'.'+$record.nonce+'.tmp'
    Assert-PlainPath $temporary;Assert-PlainPath $handoffFile
    $record.phase=$phase
    $stream=[IO.File]::Open($temporary,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $bytes=[Text.Encoding]::UTF8.GetBytes(($record|ConvertTo-Json -Compress))
        $stream.Write($bytes,0,$bytes.Length);$stream.Flush()
    } finally { $stream.Dispose() }
    try { if (-not [RovarinReparse]::MoveFileEx($temporary,$handoffFile,9)) { throw 'record-publication-failed' } }
    finally { if(Test-Path -LiteralPath $temporary){Remove-Item -LiteralPath $temporary -Force} }
}
$trustedFiles = @('unins000.exe','unins000.dat','runtime\node.exe','app\server.js','app\scripts\installed-uninstall.ps1','app\scripts\stop.ps1','app\scripts\dashboard-runtime.ps1')
function Read-TrustedHashes {
    $result = @{}
    foreach ($relative in $trustedFiles) {
        # Inno already owns its uninstall log exclusively during normal cleanup.
        # Remote handoff validates it before Inno starts; Inno owns local removal.
        if ($relative -eq 'unins000.dat' -and $Mode -in @('Validate','Cleanup')) { continue }
        $file = Join-Path $installRoot $relative
        Assert-PlainPath $file
        $stream = [IO.File]::Open($file,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $script:held += $stream
        $sha = [Security.Cryptography.SHA256]::Create()
        try { $result[$relative] = ([BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-','').ToLowerInvariant() }
        finally { $sha.Dispose() }
    }
    return $result
}
function Validate-Trust {
    Assert-Installation
    Assert-Data
    Assert-PlainPath $trustFile
    $trust = Get-Content -LiteralPath $trustFile -Raw | ConvertFrom-Json
    if ($trust.schema -ne 1) { throw 'invalid-trust' }
    $actual = Read-TrustedHashes
    foreach ($relative in $actual.Keys) {
        if ($trust.hashes.$relative -cne $actual[$relative]) { throw 'hash-mismatch' }
    }
}
try {
    if ($Mode -eq 'Register') {
        Assert-Installation
        $record = @{schema=1;hashes=(Read-TrustedHashes)}
        [IO.File]::WriteAllText($trustFile,($record | ConvertTo-Json -Depth 4))
        if ($RemoveStartup) {
            $shortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Rovarin.lnk'
            if (Test-Path -LiteralPath $shortcut) {
                Assert-PlainPath $shortcut
                $shell = New-Object -ComObject WScript.Shell
                $link = $shell.CreateShortcut($shortcut)
                if (($link.TargetPath -ieq (Join-Path $app 'Rovarin.exe') -and $link.Arguments -ceq 'startup') -or
                    ($link.TargetPath -like '*\wscript.exe' -and $link.Arguments -ceq ('"' + (Join-Path $app 'startup.vbs') + '"'))) { Remove-Item -LiteralPath $shortcut }
                [Runtime.InteropServices.Marshal]::ReleaseComObject($shell) | Out-Null
            }
        }
        exit 0
    }
    Validate-Trust
    if ($Mode -eq 'Validate') { Assert-DesktopProfile; exit 0 }
    if ($Mode -eq 'Launch') {
        $record=Read-Handoff
        if ($record.phase -ne 'preparing') { throw 'invalid-handoff' }
        $worker=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Mode Handoff') -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru
        $worker.Dispose(); exit 0
    }
    if ($Mode -eq 'Cleanup') {
        # Inno calls this only after StopInstalledServer confirms exit.
        . (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
        $cleanupDeadline = (Get-Date).AddSeconds(10)
        do {
            $runtime = Get-DashboardRuntime $app
            if ($runtime.state -eq 'none') { break }
            Start-Sleep -Milliseconds 250
        } while ((Get-Date) -lt $cleanupDeadline)
        if ($runtime.state -ne 'none') { throw 'server-still-running' }
        $updates = Join-Path $installRoot 'updates'
        Assert-PlainPath $updates
        if (Test-Path -LiteralPath $updates) {
            $files = @(Get-ChildItem -LiteralPath $updates -Force)
            foreach ($file in $files) {
                if ($file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Name -notin @('RovarinSetup.exe','RovarinSetup.partial','verified.json','handoff.json')) { throw 'unsafe-update-cache' }
            }
            foreach ($file in $files) { Remove-Item -LiteralPath $file.FullName -Force }
            Remove-Item -LiteralPath $updates
        }
        Assert-DesktopProfile
        $profile = Join-Path $installRoot 'desktop-profile'
        if (Test-Path -LiteralPath $profile) { Remove-Item -LiteralPath $profile -Recurse -Force }
        $settings = @('config.json','temperature-settings.json','onboarding-complete.json','desktop-window.json','desktop-trust.bin')
        $operational = @('server.pid','server-state.json','server.instance.json','server-start.lock','server.log','server-error.log','launcher-error.log','enhanced-install.json','enhanced-install.lock','onboarding.lock','uninstall-result.json','uninstall-handoff.json','rebrand-migration.json','rebrand-result.json')
        foreach ($item in @(Get-ChildItem -LiteralPath $data -Force -ErrorAction SilentlyContinue)) {
            $ownedFile = $item.Name -in $operational -or $item.Name -match '^server-start\.[a-f0-9]{32,64}\.(tmp|lock)$' -or $item.Name -match '^config\.json\.[a-f0-9]{24}\.tmp$' -or $item.Name -match '^temperature-settings\.json\.[0-9]+\.tmp$' -or $item.Name -match '^uninstall-handoff\.json\.[a-f0-9]{64}\.tmp$' -or $item.Name -match '^desktop-window\.json\.[a-f0-9]{32}\.tmp$'
            if ($ownedFile -or ($FullRemoval -and $item.Name -in $settings)) { Remove-Item -LiteralPath $item.FullName -Force }
        }
        if ((Test-Path -LiteralPath $data) -and @(Get-ChildItem -LiteralPath $data -Force).Count -eq 0) { Remove-Item -LiteralPath $data -Force }
        exit 0
    }
    # Capture the exact living process before acknowledging readiness. Holding its
    # handle prevents PID reuse from turning this wait into a different target.
    $stage = 'ownership'
    $record=Read-Handoff
    if ($record.phase -ne 'preparing') { throw 'invalid-handoff' }
    $OwnerPid=[int]$record.ownerPid;$nonce=$record.nonce;$FullRemoval=$record.removeData
    if ($OwnerPid -lt 1) { throw 'invalid-owner' }
    $candidate = Get-CimInstance Win32_Process -Filter "ProcessId=$OwnerPid"
    $expectedNode = Join-Path $installRoot 'runtime\node.exe'
    $expectedServer = Join-Path $app 'server.js'
    $nodePattern = '(?:"' + [regex]::Escape($expectedNode) + '"|' + [regex]::Escape($expectedNode) + ')'
    $serverPattern = '(?:"' + [regex]::Escape($expectedServer) + '"|' + [regex]::Escape($expectedServer) + ')'
    if ($candidate.ExecutablePath -ne (Join-Path $installRoot 'runtime\node.exe') -or
        -not $candidate.CommandLine -or $candidate.CommandLine -notmatch ('^\s*' + $nodePattern + '\s+' + $serverPattern + '(?:\s|$)')) { throw 'ownership-unverified' }
    $owned = Get-Process -Id $OwnerPid
    $owned.Handle | Out-Null
    if ($owned.HasExited) { throw 'owner-exited' }
    $stage = 'acknowledgement'
    Save-HandoffState 'ready'
    Set-HandoffPhase $record 'ready'
    # A bounded, operation-only rendezvous, never a background telemetry loop.
    # PIN/session data never enters this fixed leaf record or the helper args.
    $stage = 'commit'
    $deadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 100
        $record=Read-Handoff
        if ($record.ownerPid -ne $OwnerPid -or $record.nonce -cne $nonce -or $record.removeData -ne $FullRemoval) { throw 'handoff-mismatch' }
        if ($record.phase -eq 'aborted' -or [DateTime]::UtcNow -ge $deadline) { Save-HandoffState 'aborted'; exit 0 }
    } while ($record.phase -ne 'committed')
    Save-HandoffState 'committed'
    $stage = 'exit'
    if (-not $owned.WaitForExit(30000) -or -not $owned.HasExited) { throw 'exit-unconfirmed' }
    # The server is gone. This helper never kills anything, uses no shell, and
    # starts only the held, installer-generated uninstaller with fixed flags.
    $arguments = @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART')
    if ($FullRemoval) { $arguments += '/FULLREMOVAL' }
    # Inno needs exclusive write access to its own log. Release held read locks
    foreach ($stream in $held) { $stream.Dispose() }; $held = @()
    $stage = 'launch'
    if (Test-Path -LiteralPath $installRoot) {
        $items = @(Get-Item -LiteralPath $installRoot -Force) + @(Get-ChildItem -LiteralPath $installRoot -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer })
        foreach ($item in $items) {
            if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) {
                try { $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) } catch {}
            }
        }
    }
    $uninstaller = Start-Process -FilePath (Join-Path $installRoot 'unins000.exe') -ArgumentList $arguments -WorkingDirectory $env:TEMP -WindowStyle Hidden -PassThru
    Save-HandoffState 'launched'
    $uninstaller.Dispose()
} catch {
    # Fixed diagnostic only; never print exception paths, commands or secrets.
    if ($Mode -in @('Launch','Handoff') -and (Test-Path -LiteralPath $data)) {
        try { $record=Read-Handoff;Set-HandoffPhase $record 'failed' } catch {}
        try { Assert-PlainPath (Join-Path $data 'uninstall-result.json'); [IO.File]::WriteAllText((Join-Path $data 'uninstall-result.json'),(@{success=$false;code='handoff-failed';stage=$stage}|ConvertTo-Json -Compress)) } catch {}
    }
    Write-Output 'Uninstall safety validation failed. No unrelated process or file was changed.'
    exit 1
} finally {
    foreach ($stream in $held) { $stream.Dispose() }
    if ($owned) { $owned.Dispose() }
}
