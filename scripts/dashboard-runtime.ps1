function Get-RovarinDataDirectory([string]$ApplicationDir) {
    if (Test-Path -LiteralPath (Join-Path $ApplicationDir 'installation.json')) { return (Join-Path (Split-Path -Parent $ApplicationDir) 'data') }
    $node = (Get-Command node.exe -ErrorAction Stop).Source
    $result = & $node (Join-Path $ApplicationDir 'pin-manager.js') --data-path
    if ($LASTEXITCODE -ne 0 -or -not $result -or -not [IO.Path]::IsPathRooted([string]$result)) { throw 'Canonical development storage unavailable.' }
    return [string]$result
}

function Get-DashboardListener([int]$Port, [int]$ServerPid) {
    # Ask Windows for listeners only. Human-readable netstat state text can
    # incorrectly omit this PC's healthy listener; HTTP alone is not ownership.
    if (-not ('Rovarin.RuntimeListener' -as [type])) {
        Add-Type -TypeDefinition @"
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
namespace Rovarin {
    public static class RuntimeListener {
        [DllImport("iphlpapi.dll")]
        private static extern uint GetExtendedTcpTable(IntPtr table, ref int size,
            [MarshalAs(UnmanagedType.Bool)] bool sorted, int family, int tableClass, uint reserved);
        public static bool IsOwned(int port, int processId) {
            if (port < 1 || port > 65535 || processId < 1) return false;
            // AF_INET + TCP_TABLE_OWNER_PID_LISTENER: each returned row is a
            // listener, independent of the row's human-readable state label.
            int size = 0;
            uint result = GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 3, 0);
            if (result != 122) throw new Win32Exception((int)result);
            for (int attempt = 0; attempt < 3; attempt++) {
                if (size < 4 || size > 16 * 1024 * 1024) throw new InvalidOperationException("Invalid TCP table size.");
                int capacity = size;
                IntPtr table = Marshal.AllocHGlobal(capacity);
                try {
                    result = GetExtendedTcpTable(table, ref size, false, 2, 3, 0);
                    if (result == 122) continue; // Table grew between the two API calls.
                    if (result != 0) throw new Win32Exception((int)result);
                    int count = Marshal.ReadInt32(table);
                    // MIB_TCPTABLE_OWNER_PID: DWORD count, then six-DWORD rows.
                    if (count < 0 || 4L + 24L * count > capacity) throw new InvalidOperationException("Invalid TCP table rows.");
                    for (int index = 0; index < count; index++) {
                        int row = 4 + index * 24;
                        int rawPort = Marshal.ReadInt32(table, row + 8);
                        int localPort = ((rawPort & 255) << 8) | ((rawPort >> 8) & 255);
                        if (localPort == port && Marshal.ReadInt32(table, row + 20) == processId) return true;
                    }
                    return false;
                } finally { Marshal.FreeHGlobal(table); }
            }
            throw new InvalidOperationException("TCP table did not settle.");
        }
    }
}
"@
    }
    return [Rovarin.RuntimeListener]::IsOwned($Port, $ServerPid)
}

function Test-DashboardHttpResponsive([int]$Port) {
    $request = [System.Net.HttpWebRequest]::Create("http://127.0.0.1:$Port/api/metrics")
    $request.Method = 'GET'
    $request.Timeout = 2000
    $request.ReadWriteTimeout = 2000
    $request.Proxy = $null
    try {
        $response = $request.GetResponse()
        $code = [int]$response.StatusCode
        $response.Close()
        return $code -eq 401
    } catch [System.Net.WebException] {
        if ($_.Exception.Response) {
            $code = [int]$_.Exception.Response.StatusCode
            $_.Exception.Response.Close()
            return $code -eq 401
        }
        return $false
    } catch { return $false }
}

function Get-DashboardRuntime([string]$ProjectDir) {
    $applicationDir = $ProjectDir
    $candidate = $null
    try { $ProjectDir = Get-RovarinDataDirectory $ProjectDir }
    catch { return @{ state='unsafe'; reason='Canonical runtime storage unavailable.' } }
    $serverPid = 0
    $port = 7331
    $pidFile = Join-Path $ProjectDir 'server.pid'
    $stateFile = Join-Path $ProjectDir 'server-state.json'
    $lockFile = Join-Path $ProjectDir 'server.instance.json'
    try {
        if (Test-Path -LiteralPath $pidFile) {
            $text = (Get-Content -LiteralPath $pidFile -Raw -ErrorAction Stop).Trim()
            if (-not [int]::TryParse($text, [ref]$serverPid) -or $serverPid -lt 1) { return @{ state='unsafe'; reason='Invalid PID file.' } }
        }
        if (Test-Path -LiteralPath $stateFile) {
            $data = Get-Content -LiteralPath $stateFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            if ($data.pid -notmatch '^[1-9]\d*$') { return @{ state='unsafe'; reason='Invalid runtime PID.' } }
            if ($serverPid -and $serverPid -ne $data.pid) {
                # Interrupted generations can disagree after both owners exited.
                # Recover only dead records; never choose between live processes.
                $owners = @()
                try {
                    $owners = @(Get-Process -Id $serverPid,([int]$data.pid) -ErrorAction SilentlyContinue)
                    if (-not @($owners | Where-Object { -not $_.HasExited }).Count) { return @{ state='none' } }
                } finally { foreach ($ownerProcess in $owners) { $ownerProcess.Dispose() } }
                return @{ state='unsafe'; reason='Runtime/PID ownership mismatch.' }
            }
            $serverPid = [int]$data.pid
            $port = if ($data.actualPort) { [int]$data.actualPort } else { [int]$data.preferredPort }
            if ($port -lt 1 -or $port -gt 65535) { return @{ state='unsafe'; reason='Invalid runtime port.' } }
        }
        if (-not $serverPid -and (Test-Path -LiteralPath $lockFile)) {
            $owner = Get-Content -LiteralPath $lockFile -Raw -ErrorAction Stop | ConvertFrom-Json -ErrorAction Stop
            if ($owner.pid -notmatch '^[1-9]\d*$') { return @{ state='unsafe'; reason='Invalid startup owner.' } }
            $serverPid = [int]$owner.pid
        }
        if (-not $serverPid) { return @{ state='none' } }
        $candidate = Get-Process -Id $serverPid -ErrorAction SilentlyContinue
        if (-not $candidate) { return @{ state='none' } }
        if ($candidate.HasExited) { return @{ state='none' } }
        if ($candidate.ProcessName -ne 'node') { return @{ state='unsafe'; reason='Recorded PID is not Node.' } }
        if (Test-Path -LiteralPath (Join-Path $applicationDir 'installation.json')) {
            $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -OperationTimeoutSec 2 -ErrorAction SilentlyContinue
            if (-not $processInfo) {
                $candidate.Refresh()
                if ($candidate.HasExited -or -not (Get-Process -Id $serverPid -ErrorAction SilentlyContinue)) { return @{ state='none' } }
                return @{ state='unsafe'; reason='Installed server process query failed.' }
            }
            $expectedNode = Join-Path (Split-Path -Parent $applicationDir) 'runtime\node.exe'
            $expectedServer = Join-Path $applicationDir 'server.js'
            if (-not $processInfo.ExecutablePath -or [IO.Path]::GetFullPath($processInfo.ExecutablePath) -ine [IO.Path]::GetFullPath($expectedNode) -or
                $processInfo.CommandLine -notmatch ('^"?' + [regex]::Escape($expectedNode) + '"?\s+"' + [regex]::Escape($expectedServer) + '"\s*$')) {
                return @{ state='unsafe'; reason='Installed server executable/script ownership mismatch.' }
            }
        }
        if (-not (Get-DashboardListener $port $serverPid)) { return @{ state='starting'; pid=$serverPid; port=$port } }
        $processInfo = Get-CimInstance Win32_Process -Filter "ProcessId=$serverPid" -OperationTimeoutSec 2 -ErrorAction Stop
        $expectedServer = Join-Path $applicationDir 'server.js'
        if (-not $processInfo.CommandLine -or $processInfo.CommandLine -notmatch ('(?:^|\s)"?' + [regex]::Escape($expectedServer) + '"?\s*$')) { return @{ state='unsafe'; reason='Server script ownership mismatch.' } }
        $node = if (Test-Path -LiteralPath (Join-Path $applicationDir 'installation.json')) { Join-Path (Split-Path -Parent $applicationDir) 'runtime\node.exe' } else { (Get-Command node.exe -ErrorAction Stop).Source }
        $fingerprint = & $node (Join-Path $applicationDir 'server-lifecycle.js') --runtime-fingerprint
        if ($LASTEXITCODE -ne 0 -or [string]$fingerprint -notmatch '^[a-f0-9]{64}$') { return @{ state='unsafe'; reason='Backend identity unavailable.' } }
        return @{ state='owned'; pid=$serverPid; port=$port; healthy=(Test-DashboardHttpResponsive $port); stale=($data.sourceFingerprint -cne [string]$fingerprint) }
    } catch { return @{ state='unsafe'; reason='Runtime ownership could not be verified.' } }
    finally { if ($candidate) { $candidate.Dispose() } }
}

function Wait-DashboardRuntime([string]$ProjectDir, [int]$TimeoutSeconds = 12) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    do {
        $runtime = Get-DashboardRuntime $ProjectDir
        if ($runtime.state -eq 'owned' -and $runtime.healthy) { return $runtime }
        if ((Get-Date) -ge $deadline) { return $runtime }
        Start-Sleep -Milliseconds 300
    } while ($true)
}
