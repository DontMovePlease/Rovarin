$ErrorActionPreference = 'Stop'
# Developer-only, fixed paths. Not bundled or invoked by remote/native web messages.
if ($args.Count -ne 0) { throw 'This migration accepts no arguments.' }
$projectDir = Split-Path -Parent $PSScriptRoot
Set-Location $projectDir
if (Test-Path -LiteralPath (Join-Path $projectDir 'installation.json')) { throw 'Installed configuration already has separate storage.' }
$source = Join-Path $projectDir 'config.json'
$marker = Join-Path $projectDir '.rovarin-development-state.json'
if (Test-Path -LiteralPath $marker) { throw 'Development storage is already selected.' }
. (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
if ((Get-DashboardRuntime $projectDir).state -ne 'none') { throw 'Stop the owned development backend before migration.' }
$node = (Get-Command node.exe -ErrorAction Stop).Source
$target = [string](& $node -e "process.stdout.write(require('./pin-manager').developmentConfigFile())")
if ($LASTEXITCODE -ne 0 -or -not $target) { throw 'Development destination unavailable.' }
$directory = Split-Path -Parent $target
$sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
$item = Get-Item -LiteralPath $source -Force
if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Unsafe source type.' }
if ((Get-Acl -LiteralPath $source).GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid.Value) { throw 'Source ownership is unconfirmed.' }
if (Test-Path -LiteralPath $target) { throw 'Refusing a conflicting existing destination.' }
# Hold the actual source against writes/replacement throughout validation/copy.
$held = [IO.File]::Open($source, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $links = @(& fsutil.exe hardlink list $source)
    if ($LASTEXITCODE -ne 0 -or -not $links.Count) { throw 'Hard-link ownership could not be inspected.' }
    $volume = [IO.Path]::GetPathRoot($source)
    $staging = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $projectDir) '.tmp.driveupload')) + '\'
    foreach ($link in $links) {
        $name = [IO.Path]::GetFullPath((Join-Path $volume ([string]$link).Trim().TrimStart('\')))
        if ($name -ieq $source) { continue }
        if (-not $name.StartsWith($staging, [StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($name) -notmatch '^\d+$') { throw 'Unexpected hard-link alias; source retained.' }
        if ((Get-Item -LiteralPath (Split-Path -Parent $name) -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirecting sync staging directory.' }
    }
    $parent = Split-Path -Parent $directory
    if (Test-Path -LiteralPath $parent) {
        if ((Get-Item -LiteralPath $parent).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Redirecting development storage root.' }
    } else { [void](New-Item -ItemType Directory -Path $parent) }
    if (Test-Path -LiteralPath $directory) { throw 'Destination directory already exists; inspect it locally before retrying.' }
    [void](New-Item -ItemType Directory -Path $directory)
    $acl = New-Object Security.AccessControl.DirectorySecurity
    $acl.SetAccessRuleProtection($true, $false); $acl.SetOwner($sid)
    $inherit = [Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
    foreach ($identity in @($sid, (New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))) {
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($identity, 'FullControl', $inherit, 'None', 'Allow')))
    }
    Set-Acl -LiteralPath $directory -AclObject $acl
    $bytes = [IO.File]::ReadAllBytes($source)
    # Validate recoverable JSON without displaying it; normal readConfig continues
    # to reject the linked source. Migration is an explicit local-only exception.
    try { $saved = [Text.Encoding]::UTF8.GetString($bytes).TrimStart([char]0xFEFF) | ConvertFrom-Json } catch { throw 'Invalid source JSON; original retained.' }
    if ($saved.pin -isnot [string] -or $saved.pin -cnotmatch '^(\d{6}|\d{12})$') { throw 'Invalid saved PIN; original retained.' }
    $backup = Join-Path $directory 'config.before-development-migration.json'
    foreach ($file in @($backup, $target)) {
        $stream = [IO.File]::Open($file, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
        try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
    }
    & $node -e "require('./pin-manager').readConfig(process.argv[1]);process.stdout.write('Safe migrated configuration verified.');" $target
    if ($LASTEXITCODE -ne 0) { throw 'Destination failed the unchanged config safety validator.' }
    if ([Convert]::ToBase64String([IO.File]::ReadAllBytes($target)) -cne [Convert]::ToBase64String($bytes)) { throw 'Copy verification failed.' }
    [IO.File]::WriteAllText($marker, '{"schema":1}', (New-Object Text.UTF8Encoding($false)))
} finally { $held.Dispose() }
# Only retire the exact old product config after the protected copy is verified.
Remove-Item -LiteralPath $source -Force
Write-Output 'Development config migrated without changing PIN/settings. Backup retained privately outside sync.'
