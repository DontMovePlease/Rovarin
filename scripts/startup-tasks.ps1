# Fixed, unelevated Task Scheduler operations. No task creation or command execution.
function Get-StartupTaskIdentity($task) {
    [xml]$xml = [string]$task.Xml
    $node = $xml.SelectSingleNode("//*[local-name()='Settings']/*[local-name()='Enabled']")
    if ($node) { $node.ParentNode.RemoveChild($node) | Out-Null }
    Fingerprint ([string]$task.Path+'|'+$xml.OuterXml+'|'+[string]$task.GetSecurityDescriptor(5))
}
function Test-StartupSecurityExecutable([string]$exe) {
    # Windows Security Center registrations supplement principal/path/ACL protections;
    # a publisher label alone never grants permission. Unavailable coverage fails closed.
    if ($null -eq $script:startupSecurityPaths) {
        $script:startupSecurityPaths=@(); $script:startupSecurityKnown=$false
        try {
            foreach ($class in @('AntiVirusProduct','FirewallProduct')) {
                $products=@(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName $class -OperationTimeoutSec 2 -ErrorAction Stop)
                foreach ($product in $products) {
                    $resolved=0
                    foreach ($value in @($product.pathToSignedProductExe,$product.pathToSignedReportingExe)) {
                        if (-not $value) { continue }
                        $candidate=[Environment]::ExpandEnvironmentVariables([string]$value).Trim()
                        if ($candidate -match '^(?:"(?<exe>[A-Za-z]:\\[^"]+\.exe)"|(?<exe>[A-Za-z]:\\.+?\.exe))(?:\s+.*)?$') { $script:startupSecurityPaths += [IO.Path]::GetDirectoryName($Matches.exe).TrimEnd('\')+'\';$resolved++ }
                    }
                    if (-not $resolved) { throw 'Unverified security product registration' }
                }
            }
            $script:startupSecurityKnown=$true
        } catch { $script:startupSecurityKnown=$false }
    }
    if (-not $script:startupSecurityKnown) { return $false }
    foreach ($directory in $script:startupSecurityPaths) { if ($exe.StartsWith($directory,[StringComparison]::OrdinalIgnoreCase)) { return $false } }
    return $true
}
function Get-StartupTaskPolicy($task) {
    $blocked = @{ manageable=$false; reason='Cannot safely manage this task'; identity=''; canRestore=$false }
    try {
        $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
        $definition = $task.Definition
        if ([string]$task.Path -match '(?i)^\\Microsoft(?:\\|$)|rovarin|defender|antivirus|security|endpoint|firewall|malware|antimalware') { $blocked.reason='Protected Windows or security task'; return $blocked }
        $principal = $definition.Principal
        $owner = [string]$principal.UserId
        if ($owner -notmatch '^S-1-') { $owner=(New-Object Security.Principal.NTAccount($owner)).Translate([Security.Principal.SecurityIdentifier]).Value }
        if ($owner -ne $sid -or $principal.RunLevel -ne 0 -or $principal.LogonType -ne 3) { $blocked.reason='Requires a separately reviewed administrator task handler'; return $blocked }
        $acl=New-Object Security.AccessControl.RawSecurityDescriptor([string]$task.GetSecurityDescriptor(5))
        if ($null -eq $acl.DiscretionaryAcl -or $acl.Owner.Value -ne $sid) { return $blocked }
        foreach ($ace in $acl.DiscretionaryAcl) {
            if ($ace.AceType -ne [Security.AccessControl.AceType]::AccessAllowed) { continue }
            if ($ace.SecurityIdentifier.Value -notin @($sid,'S-1-5-18','S-1-5-32-544') -and ($ace.AccessMask -band 0x500d0116)) { return $blocked }
        }
        $triggers=@($definition.Triggers)
        if (-not $triggers.Count) { return $blocked }
        foreach ($trigger in $triggers) {
            if ($trigger.Type -ne 9 -or -not [string]$trigger.UserId) { return $blocked }
            $triggerOwner=[string]$trigger.UserId
            if ($triggerOwner -notmatch '^S-1-') { $triggerOwner=(New-Object Security.Principal.NTAccount($triggerOwner)).Translate([Security.Principal.SecurityIdentifier]).Value }
            if ($triggerOwner -ne $sid) { return $blocked }
        }
        $actions=@($definition.Actions)
        if ($actions.Count -ne 1 -or $actions[0].Type -ne 0) { return $blocked }
        $exe=[Environment]::ExpandEnvironmentVariables([string]$actions[0].Path)
        # Restrict this first handler to private, user-owned application executables.
        # System/Program Files tasks and shell/script hosts remain read-only.
        if (-not [IO.Path]::IsPathRooted($exe) -or [IO.Path]::GetExtension($exe) -ine '.exe' -or
            -not $exe.StartsWith($env:USERPROFILE.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or
            [IO.Path]::GetFileName($exe) -match '(?i)^(powershell|pwsh|cmd|wscript|cscript|rundll32|regsvr32|mshta|msiexec|rovarin).*\.exe$' -or
            $exe -match '(?i)defender|antivirus|security|endpoint|firewall|malware|antimalware') { return $blocked }
        $cursor=[IO.Path]::GetFullPath($exe)
        while ($cursor -and $cursor.Length -gt 3) {
            $file=Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
            if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { return $blocked }
            $cursor=[IO.Path]::GetDirectoryName($cursor)
        }
        $file=Get-Item -LiteralPath $exe -ErrorAction Stop
        $fileAcl=Get-Acl -LiteralPath $exe
        if ($fileAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $sid) { return $blocked }
        foreach ($rule in $fileAcl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
            if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin @($sid,'S-1-5-18','S-1-5-32-544') -and
                ($rule.FileSystemRights -band [Security.AccessControl.FileSystemRights]::Write)) { return $blocked }
        }
        if ($file.VersionInfo.CompanyName -match '(?i)Microsoft|security|antivirus|antimalware') { $blocked.reason='Protected Windows or security task'; return $blocked }
        if (-not (Test-StartupSecurityExecutable $exe)) { $blocked.reason='Security software protection could not be safely ruled out'; return $blocked }
        $identity=Fingerprint ((Get-StartupTaskIdentity $task)+'|'+$file.Length+'|'+$file.LastWriteTimeUtc.Ticks)
        $saved=Get-StartupTaskSaved ([string]$task.Path)
        @{manageable=$true;reason='';identity=$identity;canRestore=($null -ne $saved -and $saved.identity -ceq $identity -and $saved.last -eq [bool]$task.Enabled)}
    } catch { $blocked }
}
function Get-StartupTaskSaved([string]$taskPath) {
    $key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Rovarin\StartupTaskRestore')
    try { if ($key) { $value=$key.GetValue((Fingerprint $taskPath)); if ($value) { $saved=$value | ConvertFrom-Json -ErrorAction Stop; if ($saved.identity -notmatch '^[a-f0-9]{64}$' -or $saved.original -isnot [bool] -or $saved.last -isnot [bool]) { throw 'Invalid saved task state' }; return $saved } } } finally { if ($key) { $key.Dispose() } }
    return $null
}
function Set-StartupTaskSaved([string]$taskPath,$value) {
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Software\Rovarin\StartupTaskRestore')
    try { $name=Fingerprint $taskPath; if ($null -eq $value) { $key.DeleteValue($name,$false) } else { $key.SetValue($name,($value | ConvertTo-Json -Compress),[Microsoft.Win32.RegistryValueKind]::String) } } finally { $key.Dispose() }
}
function Set-StartupTask($request) {
    try {
        $taskPath=[string]$request.locator.key
        if ($taskPath.Length -gt 1024 -or -not $taskPath.StartsWith('\') -or $taskPath -match '[\x00-\x1f]') { return @{success=$false;code='unsupported'} }
        $scheduler=New-Object -ComObject Schedule.Service
        $scheduler.Connect()
        $task=$scheduler.GetFolder('\').GetTask($taskPath)
        if ((Fingerprint ($taskPath+'|'+[string]$task.Xml)) -cne $request.fingerprint) { return @{success=$false;code='startup-changed';error='Task changed. Refresh and review it again.'} }
        $policy=Get-StartupTaskPolicy $task
        if (-not $policy.manageable) { return @{success=$false;code='unsupported';error=$policy.reason} }
        $saved=Get-StartupTaskSaved $taskPath
        if ($saved -and ($saved.identity -cne $policy.identity -or $saved.last -ne [bool]$task.Enabled)) { return @{success=$false;code='startup-changed';error='Task changed outside Rovarin. Its saved state was retained; no change was made.'} }
        if ($request.restore) {
            if (-not $policy.canRestore) { return @{success=$false;code='unsupported';error='No matching original state can be safely restored.'} }
            $desired=[bool]$saved.original
        } else { $desired=[bool]$request.enabled }
        if (-not $saved) { $saved=@{identity=$policy.identity;original=[bool]$task.Enabled;last=[bool]$task.Enabled} }
        # Persist the original state before the only mutation. Interrupted writes fail closed.
        $saved.last=$desired
        Set-StartupTaskSaved $taskPath $saved
        $task.Enabled=$desired
        $current=$scheduler.GetFolder('\').GetTask($taskPath)
        $after=Get-StartupTaskPolicy $current
        if ($current.Enabled -ne $desired -or -not $after.manageable -or $after.identity -cne $policy.identity) { return @{success=$false;code='startup-changed';error='Task state could not be verified. Refresh before trying again.'} }
        if ($request.restore) { Set-StartupTaskSaved $taskPath $null }
        @{success=$true;code='completed';enabled=$desired;canRestore=(-not [bool]$request.restore)}
    } catch {
        @{success=$false;code=$(if($_.Exception.HResult -eq -2147024891){'access-denied'}else{'operation-failed'});error='The task change could not be completed. Refresh its state before retrying; the original state was retained where available.'}
    }
}
