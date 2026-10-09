$ErrorActionPreference = 'Stop'
# Explicit, fixed developer-state migration. No CLI/client paths or secrets.
if ($args.Count -ne 0) { throw 'This migration accepts no arguments.' }
$appDir = Split-Path -Parent $PSScriptRoot
if ((Test-Path -LiteralPath (Join-Path $appDir 'installation.json')) -or -not (Test-Path -LiteralPath (Join-Path $appDir '.rovarin-development-state.json'))) { throw 'Only marked development checkouts may migrate runtime state.' }
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
if ((Get-DashboardRuntime $appDir).state -ne 'none') { throw 'Stop the owned backend before migration.' }
foreach ($name in @('server.pid','server-state.json','server.instance.json')) {
    $file = Join-Path $appDir $name
    if (Test-Path -LiteralPath $file) {
        $record = [IO.File]::ReadAllText($file)
        $owner = if ($name -eq 'server.pid') { $record.Trim() } else { ($record | ConvertFrom-Json).pid }
        if ($owner -notmatch '^[1-9]\d*$') { throw 'Unverified old runtime ownership.' }
        $process = Get-Process -Id ([int]$owner) -ErrorAction SilentlyContinue
        if ($process) { try { if (-not $process.HasExited) { throw 'Old runtime is still running; no state moved.' } } finally {$process.Dispose()} }
    }
}
$destination = Get-RovarinDataDirectory $appDir
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
if ((Get-Acl -LiteralPath $destination).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Development storage ownership unconfirmed.' }
$entries = @('desktop-trust.bin','quick-launch.json','temperature-settings.json','onboarding-complete.json') | ForEach-Object { @{source=(Join-Path $appDir $_);target=(Join-Path $destination $_)} }
$entries += @{source=(Join-Path $appDir 'packaging\cache\desktop-preview\data\desktop-window.json');target=(Join-Path $destination 'desktop-window.json')}
$held = @()
try {
    # Validate every source/conflict before changing anything. Hold against replacement.
    foreach ($entry in $entries) {
        if (-not (Test-Path -LiteralPath $entry.source)) { continue }
        $item = Get-Item -LiteralPath $entry.source -Force
        if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 65536) { throw 'Unsafe development state source.' }
        $owner = (Get-Acl -LiteralPath $entry.source).GetOwner([Security.Principal.SecurityIdentifier]).Value
        # Prior elevated development tools may own non-secret preferences as Administrators.
        # Trust must remain owned by the current user; no ACLs are broadened.
        if ($owner -ne $sid.Value -and ($owner -ne 'S-1-5-32-544' -or [IO.Path]::GetFileName($entry.source) -eq 'desktop-trust.bin')) { throw 'State source ownership unconfirmed.' }
        $node = (Get-Command node.exe -ErrorAction Stop).Source
        & $node -e "const s=require('fs').lstatSync(process.argv[1]);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)process.exit(1)" $entry.source
        if ($LASTEXITCODE -ne 0) { throw 'Linked/unsafe state source; retained.' }
        $stream = [IO.File]::Open($entry.source,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $entry.stream=$stream;$held += $entry
        $entry.bytes=[IO.File]::ReadAllBytes($entry.source)
        if (Test-Path -LiteralPath $entry.target) {
            & $node -e "const s=require('fs').lstatSync(process.argv[1]);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1)process.exit(1)" $entry.target
            if ($LASTEXITCODE -ne 0) { throw 'Linked/unsafe state destination; source retained.' }
            $target=Get-Item -LiteralPath $entry.target -Force
            if ($target.PSIsContainer -or ($target.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Redirecting state destination.' }
            if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($entry.target)) -cne [Convert]::ToBase64String($entry.bytes)) { throw 'Conflicting development state; both copies retained.' }
        }
    }
    foreach ($entry in $held) {
        if (-not (Test-Path -LiteralPath $entry.target)) {
            $output=[IO.File]::Open($entry.target,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
            try {$output.Write($entry.bytes,0,$entry.bytes.Length);$output.Flush($true)} finally {$output.Dispose()}
        }
        if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($entry.target)) -cne [Convert]::ToBase64String($entry.bytes)) { throw 'State persistence verification failed; source retained.' }
        $entry.stream.Dispose();$entry.stream=$null
        Remove-Item -LiteralPath $entry.source -Force
        Write-Output ('Moved '+[IO.Path]::GetFileName($entry.source)+'; original state preserved.')
    }
} finally {foreach($entry in $held){if($entry.stream){$entry.stream.Dispose()}}}
# Only exact obsolete runtime/log links, after confirmed backend/native shutdown.
foreach ($name in @('server.pid','server-state.json','server.instance.json','auth-debug.log','server.log','dev-watcher.log','dev-watcher-error.log')) {
    $file=Join-Path $appDir $name
    if(Test-Path -LiteralPath $file){$item=Get-Item -LiteralPath $file -Force;if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe old runtime file.'};Remove-Item -LiteralPath $file -Force}
}
Write-Output 'Development runtime migration complete. Canonical config was not copied or changed.'