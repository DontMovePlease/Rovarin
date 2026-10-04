param([switch]$Worker)
$ErrorActionPreference = 'Stop'
$app = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$root = Split-Path -Parent $app
$cache = Join-Path $root 'updates'
$installer = Join-Path $cache 'RovarinSetup.exe'
$metadata = Join-Path $cache 'verified.json'
$result = Join-Path $cache 'handoff.json'
function Assert-Plain([string]$target) {
    $cursor = [IO.Path]::GetFullPath($target)
    while ($cursor) {
        if (Test-Path -LiteralPath $cursor) {
            if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'redirected-path' }
        }
        $parent = Split-Path -Parent $cursor
        if ($parent -eq $cursor) { break }; $cursor = $parent
    }
}
$held = $null; $mutex = $null; $ownsMutex = $false
try {
    Assert-Plain $root; Assert-Plain $installer; Assert-Plain $metadata; Assert-Plain $result
    $marker = Get-Content -LiteralPath (Join-Path $app 'installation.json') -Raw | ConvertFrom-Json
    $entry = Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{C51A4180-26D2-4F48-93BD-B40B182B78DA}_is1'
    if ($marker.schema -ne 1 -or $marker.channel -ne 'windows-x64' -or [IO.Path]::GetFullPath($entry.InstallLocation.TrimEnd('\')) -ne $root) { throw 'not-installed' }
    if (-not $Worker) {
        # Child detaches from the desktop/backend; no arguments from the web client.
        $nonce = [Guid]::NewGuid().ToString('N')
        [IO.File]::WriteAllText($result, (@{phase='preparing';nonce=$nonce;expires=[DateTime]::UtcNow.AddSeconds(15).ToString('o')}|ConvertTo-Json -Compress))
        $powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $child = Start-Process -FilePath $powershell -ArgumentList @('-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',('"'+$PSCommandPath+'"'),'-Worker') -WindowStyle Hidden -PassThru
        try {
            $deadline = [DateTime]::UtcNow.AddSeconds(15)
            do {
                Start-Sleep -Milliseconds 100
                $state = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
                if ($state.nonce -ne $nonce -or $state.phase -eq 'failed' -or [DateTime]::UtcNow -ge $deadline) { throw 'handoff-unavailable' }
                $child.Refresh()
                if ($child.HasExited -and $state.phase -ne 'launched') { throw 'handoff-unavailable' }
            } while ($state.phase -ne 'launched')
            '{"launched":true}'
            exit 0
        } finally { $child.Dispose() }
    }
    $identity = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())).Replace('/','_').Replace('+','_')
    $shaIdentity = [Security.Cryptography.SHA256]::Create()
    try { $identity = ([BitConverter]::ToString($shaIdentity.ComputeHash([Text.Encoding]::UTF8.GetBytes($identity)))).Replace('-','') } finally { $shaIdentity.Dispose() }
    $mutex = New-Object Threading.Mutex($false, ('Local\Rovarin.Update.'+$identity))
    $ownsMutex = $mutex.WaitOne(0)
    if (-not $ownsMutex) { throw 'update-in-progress' }
    $state = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
    if ($state.phase -ne 'preparing' -or $state.nonce -cnotmatch '^[a-f0-9]{32}$') { throw 'handoff-invalid' }
    $verified = Get-Content -LiteralPath $metadata -Raw | ConvertFrom-Json
    $current = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
    if (@($verified.PSObject.Properties).Count -ne 6 -or $verified.schema -ne 1 -or $verified.repository -cne 'DontMovePlease/Rovarin' -or $verified.filename -cne 'RovarinSetup.exe' -or
        $verified.version -cnotmatch '^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$' -or $verified.sha256 -cnotmatch '^[a-f0-9]{64}$' -or
        $verified.size -lt 1 -or $verified.size -gt 314572800 -or [Version]$verified.version -le [Version]$current.version) { throw 'verification-invalid' }
    # Keep a read-only handle through execution: the verified EXE cannot be
    # replaced or modified between hashing and CreateProcess / installation.
    $held = [IO.File]::Open($installer,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $digest = ([BitConverter]::ToString($sha.ComputeHash($held))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
    if ($held.Length -ne $verified.size -or $digest -cne $verified.sha256) { throw 'checksum-mismatch' }
    $fileVersion = [Diagnostics.FileVersionInfo]::GetVersionInfo($installer)
    # Compare the binary resource, not Inno's padded display text.
    $binaryVersion = New-Object Version($fileVersion.FileMajorPart,$fileVersion.FileMinorPart,$fileVersion.FileBuildPart,$fileVersion.FilePrivatePart)
    if ($binaryVersion -ne [Version]($verified.version + '.0')) { throw 'version-mismatch' }
    . (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
    $runtime = Get-DashboardRuntime $app
    if ($runtime.state -ne 'owned' -or -not $runtime.healthy) { throw 'backend-unverified' }
    # Inno owns bounded close-desktop IPC, verified backend stop and upgrade.
    # Normal interactive installer/UAC; no silent install or manual file replacement.
    $commit = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
    if ($commit.nonce -cne $state.nonce -or $commit.phase -ne 'preparing' -or [DateTime]::Parse($commit.expires).ToUniversalTime() -le [DateTime]::UtcNow) { throw 'handoff-expired' }
    $process = Start-Process -FilePath $installer -ArgumentList @('/NORESTART',('/DIR="'+$root+'"')) -WorkingDirectory $cache -PassThru
    $state.phase = 'launched'; [IO.File]::WriteAllText($result, ($state|ConvertTo-Json -Compress))
    try {
        if (-not $process.WaitForExit(1800000)) { throw 'installer-timeout' }
        $reopen = $process.ExitCode -eq 0 -or $process.ExitCode -eq 3010
    } finally { $process.Dispose() }
    $state.phase = 'cancelled'; [IO.File]::WriteAllText($result, ($state|ConvertTo-Json -Compress))
    if ($reopen) {
        # Reopen only when the installed product actually reached the expected version.
        $updated = Get-Content -LiteralPath (Join-Path $app 'package.json') -Raw | ConvertFrom-Json
        if ($updated.version -ne $verified.version) { throw 'upgrade-unconfirmed' }
        $state.phase = 'complete'; [IO.File]::WriteAllText($result, ($state|ConvertTo-Json -Compress))
        Assert-Plain (Join-Path $app 'Rovarin.exe')
        Start-Process -FilePath (Join-Path $app 'Rovarin.exe') -WorkingDirectory $app -WindowStyle Normal
    }
} catch {
    try {
        if (-not $Worker -and $nonce) {
            $aborted = Get-Content -LiteralPath $result -Raw | ConvertFrom-Json
            if ($aborted.nonce -ceq $nonce -and $aborted.phase -eq 'preparing') { $aborted.phase='aborted'; [IO.File]::WriteAllText($result, ($aborted|ConvertTo-Json -Compress)) }
        }
        if ($Worker -and $state -and $ownsMutex) { $state.phase='failed'; [IO.File]::WriteAllText($result, ($state|ConvertTo-Json -Compress)) }
    } catch {}
    Write-Output 'Update handoff could not be confirmed. Your current installation was not removed.'
    exit 1
} finally {
    if ($held) { $held.Dispose() }
    if ($mutex) { if ($ownsMutex) { $mutex.ReleaseMutex() }; $mutex.Dispose() }
}