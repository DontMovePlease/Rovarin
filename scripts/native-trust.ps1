# Fixed native/backend-only helper. No client arguments, commands or paths.
# Output goes only to the owning process's captured pipe, never a UI/log.
$ErrorActionPreference = 'Stop'
try {
    if ($args.Count -ne 0) { throw 'Invalid invocation' }
    Add-Type -AssemblyName System.Security
    $appRoot = Split-Path -Parent $PSScriptRoot
    . (Join-Path $PSScriptRoot 'dashboard-runtime.ps1')
    $stateRoot = Get-RovarinDataDirectory $appRoot
    $file = Join-Path $stateRoot 'desktop-trust.bin'
    # Compatibility-only DPAPI entropy: preserves existing desktop credentials.
    $entropy = [Text.Encoding]::UTF8.GetBytes('PCMonitor.NativeDesktop.v1')
    if (-not (Test-Path -LiteralPath $file)) {
        $key = New-Object byte[] 32
        $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
        try { $rng.GetBytes($key) } finally { $rng.Dispose() }
        $blob = [Security.Cryptography.ProtectedData]::Protect($key, $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        $acl = New-Object Security.AccessControl.FileSecurity
        $acl.SetAccessRuleProtection($true, $false)
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        $acl.SetOwner($sid)
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
        $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule('SYSTEM', 'FullControl', 'Allow')))
        try {
            $stream = New-Object IO.FileStream($file, [IO.FileMode]::CreateNew, [Security.AccessControl.FileSystemRights]::Write, [IO.FileShare]::None, 4096, [IO.FileOptions]::None, $acl)
            try { $stream.Write($blob, 0, $blob.Length); $stream.Flush($true) } finally { $stream.Dispose() }
        } catch [IO.IOException] { if (-not (Test-Path -LiteralPath $file)) { throw } }
    }
    $item = Get-Item -LiteralPath $file -Force
    if ($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $item.Length -gt 4096) { throw 'Unsafe credential' }
    $key = [Security.Cryptography.ProtectedData]::Unprotect([IO.File]::ReadAllBytes($file), $entropy, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    if ($key.Length -ne 32) { throw 'Invalid credential' }
    [Console]::Out.Write([Convert]::ToBase64String($key))
} catch { [Console]::Error.Write('Native desktop trust unavailable.'); exit 1 }
