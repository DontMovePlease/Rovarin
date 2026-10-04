$ErrorActionPreference = 'Stop'
function Initialize-RecycleApi {
    if ('RovarinRecycleBinNative' -as [type]) { return }
    try {
        Add-Type -ErrorAction Stop -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RovarinRecycleBinNative {
    [StructLayout(LayoutKind.Sequential)] public struct Info {
        public uint cbSize; public long size; public long count;
    }
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, EntryPoint="SHQueryRecycleBinW")]
    public static extern int Query(string root, ref Info info);
    [DllImport("shell32.dll", CharSet=CharSet.Unicode, EntryPoint="SHEmptyRecycleBinW")]
    public static extern int Empty(IntPtr owner, string root, uint flags);
}
'@
    } catch { throw [PlatformNotSupportedException]::new('Windows Recycle Bin API binding unavailable.') }
}
function Invoke-RecycleClear {
    Initialize-RecycleApi
    # NULL root means the current user's normal all-drive Recycle Bin operation.
    # Fixed flags: no confirmation, no progress dialog, no sound. No file access.
    $hr=[RovarinRecycleBinNative]::Empty([IntPtr]::Zero,$null,7)
    if ($hr -ne 0) { [Runtime.InteropServices.Marshal]::ThrowExceptionForHR($hr); throw 'Windows Recycle Bin operation failed.' }
}
function Read-RecycleCount {
    try {
        Initialize-RecycleApi
        $info=New-Object RovarinRecycleBinNative+Info
        $info.cbSize=[Runtime.InteropServices.Marshal]::SizeOf($info)
        $hr=[RovarinRecycleBinNative]::Query($null,[ref]$info)
        if ($hr -eq 0 -and $info.count -ge 0) { return $info.count }
    } catch { }
    # Independently guarded Shell view when native query is unavailable.
    $shell=$null; $folder=$null; $items=$null
    try {
        $shell=New-Object -ComObject Shell.Application
        $folder=$shell.Namespace(10)
        if ($null -eq $folder) { return $null }
        $items=$folder.Items()
        if ($null -eq $items -or $null -eq $items.Count) { return $null }
        $count=0
        if ([int]::TryParse([string]$items.Count,[ref]$count) -and $count -ge 0) { return $count }
        return $null
    } catch { return $null }
    finally {
        foreach($object in @($items,$folder,$shell)) {
            if ($null -ne $object -and [Runtime.InteropServices.Marshal]::IsComObject($object)) {
                try { [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($object) } catch { }
            }
        }
    }
}
$before=Read-RecycleCount
$result=@{success=$false;code='clear-failed';before=$before;remaining=$null;verified=$false}
try {
    if ($null -ne $before -and $before -eq 0) {
        $result.success=$true; $result.code='already-empty'; $result.remaining=0; $result.verified=$true
    } else {
        # Supported current-user/all-drive operation; no client paths/arguments.
        Invoke-RecycleClear
        foreach($delay in @(0,300,700,1500)) {
            if($delay){Start-Sleep -Milliseconds $delay}
            # Fresh native query/Shell view; never retain a stale snapshot.
            $remaining=Read-RecycleCount
            if($null -ne $remaining){$result.remaining=$remaining}
            if($null -ne $remaining -and $remaining -eq 0){break}
        }
        if($null -eq $remaining){$result.success=$true;$result.code='verification-unavailable'}
        elseif($remaining -eq 0){$result.success=$true;$result.code='emptied';$result.verified=$true}
        else {$result.code='items-remain';$result.verified=$true}
    }
} catch {
    $exception=$_.Exception
    while($exception.InnerException){$exception=$exception.InnerException}
    $result.code=if($exception -is [UnauthorizedAccessException] -or $exception.HResult -eq -2147024891){'permission-denied'}elseif($exception -is [DllNotFoundException] -or $exception -is [EntryPointNotFoundException] -or $exception -is [PlatformNotSupportedException]){'tool-unavailable'}else{'clear-failed'}
    # Do not convert a confirmed command failure into success based on COM.
}
$result | ConvertTo-Json -Compress
if(-not $result.success){exit 1}
