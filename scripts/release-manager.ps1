param(
    [ValidateSet('Gui','Status','History','Checkpoint','Save','Publish','Restore','DryRun','Tools','ToolUpdates')][string]$Mode = 'Gui',
    [ValidateSet('Checkpoint','Save','Publish','Restore')][string]$Action = 'Publish',
    [string]$Version, [string]$Message, [string]$Commit, [string]$Title, [string]$Note,
    [switch]$Confirm, [switch]$Approve, [switch]$UiSmoke
)
$ErrorActionPreference = 'Stop'
$project = Split-Path -Parent $PSScriptRoot
if ($Mode -eq 'Gui') {
    & (Join-Path $PSScriptRoot 'release-manager-ui.ps1') -UiSmoke:$UiSmoke
    return
}
$node = (Get-Command node.exe -ErrorAction Stop).Source
$request = @{ mode=$Mode; action=$Action; confirm=[bool]$Confirm }
foreach ($name in @('Version','Message','Commit','Title','Note')) {
    $value = Get-Variable -Name $name -ValueOnly
    if ($value) { $request[$name.ToLowerInvariant()] = $value }
}
if ($Mode -eq 'Publish') {
    # CLI fallback uses the same approval protocol, never bypasses the GUI gate.
    $info=New-Object Diagnostics.ProcessStartInfo
    $info.FileName=$node; $info.Arguments='"'+(Join-Path $PSScriptRoot 'release-manager.js')+'"'
    $info.WorkingDirectory=$project; $info.UseShellExecute=$false; $info.CreateNoWindow=$true
    $info.RedirectStandardInput=$true; $info.RedirectStandardOutput=$true
    $child=[Diagnostics.Process]::Start($info)
    try {
        $child.StandardInput.WriteLine(($request | ConvertTo-Json -Compress))
        while($null -ne ($line=$child.StandardOutput.ReadLine())) {
            $entry = $null
            try { $entry = $line | ConvertFrom-Json -ErrorAction Stop } catch {}
            if($entry -and $entry.type -eq 'approval') {
                $entry.summary | ConvertTo-Json -Depth 6 | Write-Host
                $required='Publish '+$entry.summary.tag
                $answer=if ($Approve) { $required } else { Read-Host "Public GitHub release: type '$required' to approve, or press Enter to cancel" }
                $child.StandardInput.WriteLine((@{publish=($answer -ceq $required)} | ConvertTo-Json -Compress))
                $child.StandardInput.Close()
            } elseif($entry -and $entry.type -eq 'result') {
                $entry.result | ConvertTo-Json -Depth 6 | Write-Output
            } elseif($entry -and $entry.message) {
                Write-Host $entry.message
            } else {
                Write-Host $line
            }
        }
        $child.WaitForExit()
        if($child.ExitCode -ne 0){throw 'Release Manager stopped safely. See the message above.'}
    } finally {$child.Dispose()}
    return
}
# JSON is passed through stdin, never evaluated as a shell command.
$request | ConvertTo-Json -Compress | & $node (Join-Path $PSScriptRoot 'release-manager.js')
if ($LASTEXITCODE -ne 0) { throw 'Release Manager stopped safely. See its message above.' }
