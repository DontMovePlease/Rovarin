$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
try {
    $text = [Console]::In.ReadToEnd()
    if ($text.Length -gt 2048) { throw 'Invalid input' }
    $request = $text | ConvertFrom-Json
    if ($request.mode -notin @('preview','terminate') -or $request.identity.pid -lt 5 -or $request.identity.name.Length -gt 128 -or $request.identity.startedAt -notmatch '^\d{4}-\d{2}-\d{2}T') { throw 'Invalid identity' }
    Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'process-tree.cs') -Raw)
    $time = [DateTime]::Parse($request.identity.startedAt, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind).ToUniversalTime().ToFileTimeUtc()
    [RovarinProcessTree]::Run([int]$request.identity.pid, [string]$request.identity.name, $time, [int[]]$request.protectedPids, ($request.mode -eq 'terminate')) | ConvertTo-Json -Depth 6 -Compress
} catch { @{success=$false;code='tree-unavailable';results=@();remaining=@()} | ConvertTo-Json -Compress }
