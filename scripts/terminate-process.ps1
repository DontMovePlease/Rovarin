$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
# The only input is a bounded JSON identity on stdin, never a shell expression.
try {
    $inputText = [Console]::In.ReadToEnd()
    if ($inputText.Length -gt 1024) { throw 'Invalid identity' }
    $identity = $inputText | ConvertFrom-Json
    if (@($identity.PSObject.Properties).Count -ne 4 -or @($identity.protectedPids).Count -gt 16 -or $identity.pid -lt 5 -or $identity.pid -gt 4194304 -or
        $identity.name -isnot [string] -or $identity.name.Length -gt 128 -or
        $identity.startedAt -notmatch '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,7})?(Z|[+-]\d{2}:\d{2})$') { throw 'Invalid identity' }
    Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'process-tree.cs') -Raw)
    if ([RovarinProcessTree]::IsOwnedTarget([int]$identity.pid,[int[]]$identity.protectedPids)) { @{success=$false;code='access-denied';verified=$false} | ConvertTo-Json -Compress; exit }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class RovarinTermination {
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr h, out long creation, out long exit, out long kernel, out long user);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool IsProcessCritical(IntPtr h, out bool critical);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr h, uint code);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint milliseconds);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    public static string Run(int pid, string name, long creationTime) {
        // One handle pins the object even if the PID is later reused.
        IntPtr h = OpenProcess(0x100000 | 0x1000 | 1, false, pid);
        if (h == IntPtr.Zero) return Marshal.GetLastWin32Error() == 87 ? "already-exited" : "access-denied";
        try {
            if (WaitForSingleObject(h, 0) == 0) return "already-exited";
            long creation, exit, kernel, user;
            if (!GetProcessTimes(h, out creation, out exit, out kernel, out user)) return "access-denied";
            var image = new StringBuilder(32768); uint size = 32768;
            if (!QueryFullProcessImageName(h, 0, image, ref size)) return "access-denied";
            string actual = System.IO.Path.GetFileNameWithoutExtension(image.ToString());
            if (creation != creationTime || !String.Equals(actual, name, StringComparison.OrdinalIgnoreCase)) return "stale-process";
            string[] critical = {"idle","system","smss","csrss","wininit","winlogon","lsass","services","rovarin","pcmonitor"};
            foreach (string c in critical) if (String.Equals(actual,c,StringComparison.OrdinalIgnoreCase)) return "access-denied";
            bool criticalProcess; if (!IsProcessCritical(h,out criticalProcess) || criticalProcess) return "access-denied";
            if (!TerminateProcess(h, 1)) return WaitForSingleObject(h,0) == 0 ? "already-exited" : "access-denied";
            return WaitForSingleObject(h, 2000) == 0 ? "terminated" : "termination-unconfirmed";
        } finally { CloseHandle(h); }
    }
}
'@
    $time = [DateTime]::Parse($identity.startedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().ToFileTimeUtc()
    $code = [RovarinTermination]::Run([int]$identity.pid, $identity.name, $time)
    @{success=($code -eq 'terminated'); code=$code; verified=($code -eq 'terminated')} | ConvertTo-Json -Compress
} catch { @{success=$false;code='server-error';verified=$false} | ConvertTo-Json -Compress }
