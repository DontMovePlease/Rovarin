param([ValidateSet('Status','Install','Remove')][string]$Action='Status',[switch]$NoElevation)
# Explicit local installer/repair tool only. Never invoked by startup or HTTP.
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
function Assert-FirewallPath([string]$Path) {
    for($p=[IO.Path]::GetFullPath($Path);$p;$p=Split-Path -Parent $p) {
        if(Test-Path -LiteralPath $p) {
            if((Get-Item -LiteralPath $p -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected firewall installation path'}
        }
    }
}
function Get-FirewallPlan([string]$ScriptDirectory) {
    $app=[IO.Path]::GetFullPath((Split-Path -Parent $ScriptDirectory));$root=Split-Path -Parent $app
    if((Split-Path -Leaf $app) -cne 'app'){throw 'Installed Rovarin layout required'}
    Assert-FirewallPath $app
    $marker=Get-Content -LiteralPath (Join-Path $app 'installation.json') -Raw | ConvertFrom-Json
    if($marker.schema -ne 1 -or $marker.channel -cne 'windows-x64'){throw 'Installed Rovarin marker required'}
    $sha=[Security.Cryptography.SHA256]::Create()
    try{$id=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($root.ToLowerInvariant())))).Replace('-','').Substring(0,24)}finally{$sha.Dispose()}
    $rows=@();foreach($item in @(@('Backend',(Join-Path $root 'runtime\node.exe')),@('Standby',(Join-Path $app 'RovarinStandby.exe')))) {
        Assert-FirewallPath $item[1]
        # NetSecurity rejects a pipe in Description. Keep the ownership marker
        # literal and compatible with the Windows firewall policy provider.
        $rows+= [pscustomobject]@{Name=('Rovarin.Remote.'+$id+'.'+$item[0]);Program=$item[1];Group='Rovarin managed Tailscale access v1';Description=('Rovarin fixed TCP listener v1 - '+$root);DisplayName=('Rovarin '+$item[0]+' (Tailscale only)')}
    }
    return $rows
}
function Get-FirewallOwned($Plan) {
    # Query a fixed private namespace, then compare exact names: no display-name
    # deletion, no removal of Windows-generated Node rules or another install.
    $all=@(Get-NetFirewallRule -PolicyStore PersistentStore -ErrorAction Stop | Where-Object {$_.Name -clike 'Rovarin.Remote.*'})
    $owned=@()
    foreach($p in $Plan){
        $matches=@($all | Where-Object {$_.Name -ceq $p.Name})
        if($matches.Count -gt 1){throw 'Ambiguous firewall rule'}
        foreach($rule in $matches){
            $app=$rule | Get-NetFirewallApplicationFilter;$port=$rule | Get-NetFirewallPortFilter
            $address=$rule | Get-NetFirewallAddressFilter;$iface=$rule | Get-NetFirewallInterfaceFilter
            # Windows reads IPv4 CIDRs back as address/dotted netmask. Accept
            # only this equivalent spelling of our exact /10, never a wider
            # range or an arbitrary normalized address expression.
            $remote=@($address.RemoteAddress | ForEach-Object {if($_ -ceq '100.64.0.0/255.192.0.0'){'100.64.0.0/10'}else{$_}} | Sort-Object)
            if($rule.Group -cne $p.Group -or $rule.Description -cne $p.Description -or $rule.DisplayName -cne $p.DisplayName -or
                $app.Program -ine $p.Program -or [string]$rule.Direction -ne 'Inbound' -or [string]$rule.Action -ne 'Allow' -or
                [string]$rule.Profile -ne 'Any' -or [string]$rule.EdgeTraversalPolicy -ne 'Block' -or
                [string]$port.Protocol -notin @('TCP','6') -or (@($port.LocalPort) -join ',') -ne '7331-7335' -or
                (@($port.RemotePort) -join ',') -ne 'Any' -or (@($address.LocalAddress) -join ',') -ne 'Any' -or
                ($remote -join ',') -ne '100.64.0.0/10,fd7a:115c:a1e0::/48' -or @($iface.InterfaceAlias).Count -ne 1 -or
                [string]$iface.InterfaceAlias -ieq 'Any' -or [string]$iface.InterfaceAlias -match '[*?\[\]]' -or -not [string]$iface.InterfaceAlias){throw 'Firewall rule ownership/scope changed; inspect it manually'}
            $owned+=$rule
        }
    }
    return $owned
}
function Get-TailscaleFirewallInterface {
    # Address ranges alone are not interface provenance. Require the native
    # Tailscale adapter and scope the actual Windows Firewall interface filter.
    $adapters=@(Get-NetAdapter -IncludeHidden -ErrorAction Stop | Where-Object {$_.InterfaceDescription -ceq 'Tailscale Tunnel'})
    if($adapters.Count -ne 1 -or [string]$adapters[0].Name -ieq 'Any' -or [string]$adapters[0].Name -match '[*?\[\]\x00-\x1f]' -or -not $adapters[0].Name){throw 'One unambiguous Tailscale Tunnel adapter is required; install Tailscale first'}
    return [string]$adapters[0].Name
}
function Assert-NoListenerFirewallBlock($Plan,[string]$Alias) {
    # An explicit block overrides an allow. Never erase a prior administrator/
    # Windows decision and then incorrectly report remote access repaired.
    $blocks=@(Get-NetFirewallRule -PolicyStore ActiveStore -ErrorAction Stop | Where-Object {[string]$_.Enabled -eq 'True' -and [string]$_.Direction -eq 'Inbound' -and [string]$_.Action -eq 'Block'})
    foreach($rule in $blocks){
        if([string]($rule | Get-NetFirewallApplicationFilter).Program -notin @($Plan.Program)){continue}
        $ports=$rule | Get-NetFirewallPortFilter;$interfaces=@(($rule | Get-NetFirewallInterfaceFilter).InterfaceAlias)
        if([string]$ports.Protocol -notin @('Any','256','TCP','6') -or ('Any' -notin $interfaces -and $Alias -notin $interfaces)){continue}
        foreach($port in @($ports.LocalPort)){
            if($port -eq 'Any' -or ($port -match '^(\d+)(?:-(\d+))?$' -and [int]$Matches[1] -le 7335 -and ($(if($Matches[2]){[int]$Matches[2]}else{[int]$Matches[1]})) -ge 7331)){throw ('Existing inbound block may override Rovarin: '+$rule.Name+'. Administrator review required; no unrelated rule is removed.')}
        }
    }
}
function Set-RovarinFirewall($Plan,[ValidateSet('Install','Remove')][string]$Mode) {
    $existing=@(Get-FirewallOwned $Plan) # preflight every rule before mutation
    if($Mode -eq 'Remove'){
        foreach($rule in $existing){$rule | Remove-NetFirewallRule -ErrorAction Stop}
        if(@(Get-FirewallOwned $Plan).Count){throw 'Firewall cleanup incomplete'}
        return
    }
    $alias=Get-TailscaleFirewallInterface
    Assert-NoListenerFirewallBlock $Plan $alias
    foreach($p in $Plan){if(-not (Test-Path -LiteralPath $p.Program -PathType Leaf)){throw 'Installed listener executable missing'}}
    $created=@()
    try {
        foreach($p in $Plan){
            $old=@($existing | Where-Object {$_.Name -ceq $p.Name})
            if($old.Count){
                $old[0] | Set-NetFirewallRule -Enabled True -InterfaceAlias $alias -ErrorAction Stop
            } else {
                $null=New-NetFirewallRule -PolicyStore PersistentStore -Name $p.Name -DisplayName $p.DisplayName -Description $p.Description -Group $p.Group -Program $p.Program -Direction Inbound -Action Allow -Enabled True -Profile Any -Protocol TCP -LocalPort '7331-7335' -RemoteAddress @('100.64.0.0/10','fd7a:115c:a1e0::/48') -InterfaceAlias $alias -EdgeTraversalPolicy Block -ErrorAction Stop
                $created+=$p.Name
            }
        }
        $verified=@(Get-FirewallOwned $Plan)
        if($verified.Count -ne $Plan.Count -or @($verified | Where-Object {[string]$_.Enabled -ne 'True'}).Count){throw 'Firewall setup not verified'}
        foreach($r in $verified){if([string]($r | Get-NetFirewallInterfaceFilter).InterfaceAlias -cne $alias){throw 'Firewall interface mismatch'}}
    } catch {
        # Roll back only exact rules created here, after revalidating ownership.
        foreach($rule in @(Get-FirewallOwned $Plan)){if($rule.Name -cin $created){$rule | Remove-NetFirewallRule -ErrorAction Stop}}
        throw
    }
}
function Test-FirewallReady($Plan,$Owned,[string]$Alias) {
    if(@($Owned).Count -ne @($Plan).Count){return $false}
    foreach($rule in $Owned){if([string]$rule.Enabled -ne 'True' -or [string]($rule | Get-NetFirewallInterfaceFilter).InterfaceAlias -cne $Alias){return $false}}
    return $true
}
try {
    $plan=@(Get-FirewallPlan $PSScriptRoot);$owned=@(Get-FirewallOwned $plan)
    if($Action -eq 'Status'){
        [pscustomobject]@{managedRules=$owned.Count;expectedRules=$plan.Count;enabledRules=@($owned | Where-Object {[string]$_.Enabled -eq 'True'}).Count} | ConvertTo-Json -Compress
        exit 0
    }
    if($Action -eq 'Remove' -and $owned.Count -eq 0){exit 0}
    if($Action -eq 'Install'){
        $alias=Get-TailscaleFirewallInterface
        Assert-NoListenerFirewallBlock $plan $alias
        foreach($p in $plan){if(-not (Test-Path -LiteralPath $p.Program -PathType Leaf)){throw 'Installed listener executable missing'}}
        if(Test-FirewallReady $plan $owned $alias){Write-Output 'Rovarin firewall is already configured; no elevation or changes needed.';exit 0}
    }
    $principal=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
    if(-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
        if($NoElevation){throw 'Administrator approval is required for firewall setup/removal'}
        # Consent is requested only by this explicit installer/local action.
        $process=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe') -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+$PSCommandPath+'" -Action '+$Action+' -NoElevation')
        exit $process.ExitCode
    }
    Set-RovarinFirewall $plan $Action
    Write-Output ('Rovarin firewall '+$Action+' verified. No unrelated rules changed.')
    exit 0
} catch {Write-Error ('Rovarin firewall action failed: '+$_.Exception.Message) -ErrorAction Continue;exit 1}
