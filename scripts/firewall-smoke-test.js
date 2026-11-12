'use strict';
// Typed policy doubles plus read-only OS inspection. Elevated execution may
// exercise real rules for this disposable path only; never elevates the test.
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert'),{execFileSync,spawnSync}=require('child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'rovarin-firewall-'));
const app=path.join(temp,'app'),scripts=path.join(app,'scripts'),helper=path.join(scripts,'firewall.ps1');
const q=s=>"'"+s.replace(/'/g,"''")+"'";
try{
 fs.mkdirSync(scripts,{recursive:true});fs.mkdirSync(path.join(temp,'runtime'));
 fs.copyFileSync(path.join(root,'scripts/firewall.ps1'),helper);
 fs.writeFileSync(path.join(app,'installation.json'),JSON.stringify({schema:1,channel:'windows-x64'}));
 for(const file of [path.join(temp,'runtime/node.exe'),path.join(app,'RovarinStandby.exe')])fs.writeFileSync(file,'disposable non-executed firewall identity');
 const test=path.join(temp,'test.ps1');
 fs.writeFileSync(test,`$ErrorActionPreference='Stop'
$source=${q(helper)};$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile($source,[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Firewall PowerShell syntax failed'}
foreach($file in @(${q(path.join(root,'scripts/installed-uninstall.ps1'))},${q(path.join(root,'packaging/build.ps1'))})){$null=[Management.Automation.Language.Parser]::ParseFile($file,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Affected packaging/helper PowerShell syntax failed'}}
foreach($f in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $f.Extent.Text}
$plan=@(Get-FirewallPlan ${q(scripts)})
if($plan.Count -ne 2 -or $plan[0].Program -ne ${q(path.join(temp,'runtime/node.exe'))}){throw 'Wrong executable plan'}
foreach($row in $plan){if($row.Description.Contains('|')){throw 'Windows firewall rejects pipe-delimited descriptions'}}
$script:rules=@{};$script:mutations=0;$script:failSecond=$false;$script:adapter='Tailscale';$script:newCalls=0;$script:windowsAddressReadback=$false
function Get-NetFirewallRule { [CmdletBinding()]param($PolicyStore) $script:rules.Values }
function Get-NetFirewallApplicationFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject) process { @{Program=$InputObject.Program} } }
function Get-NetFirewallPortFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject) process { @{Protocol=$InputObject.Protocol;LocalPort=$InputObject.LocalPort;RemotePort='Any'} } }
function Get-NetFirewallAddressFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject) process { $remote=@($InputObject.RemoteAddress|ForEach-Object{if($script:windowsAddressReadback -and $_ -ceq '100.64.0.0/10'){'100.64.0.0/255.192.0.0'}else{$_}});@{RemoteAddress=$remote;LocalAddress='Any'} } }
function Get-NetFirewallInterfaceFilter { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject) process { @{InterfaceAlias=$InputObject.InterfaceAlias} } }
function Get-NetAdapter { [CmdletBinding()]param([switch]$IncludeHidden) if($script:adapter){@{Name=$script:adapter;InterfaceDescription='Tailscale Tunnel'}} }
function New-NetFirewallRule {
 [CmdletBinding()]param($PolicyStore,$Name,$DisplayName,$Description,$Group,$Program,$Direction,$Action,$Enabled,$Profile,$Protocol,$LocalPort,$RemoteAddress,$InterfaceAlias,$EdgeTraversalPolicy)
 if($Description.Contains('|')){throw 'The description contains invalid characters, or is an invalid length.'}
 $script:newCalls++;if($script:failSecond -and $script:newCalls -eq 2){throw 'Injected firewall denial'}
 $script:mutations++;$script:rules[$Name]=[pscustomobject]@{Name=$Name;DisplayName=$DisplayName;Description=$Description;Group=$Group;Program=$Program;Direction=$Direction;Action=$Action;Enabled=$Enabled;Profile=$Profile;Protocol=$Protocol;LocalPort=$LocalPort;RemoteAddress=$RemoteAddress;InterfaceAlias=$InterfaceAlias;EdgeTraversalPolicy=$EdgeTraversalPolicy}
}
function Set-NetFirewallRule { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject,$Enabled,$InterfaceAlias) process {$script:mutations++;$InputObject.Enabled=$Enabled;$InputObject.InterfaceAlias=$InterfaceAlias} }
function Remove-NetFirewallRule { [CmdletBinding()]param([Parameter(ValueFromPipeline)]$InputObject) process {$script:mutations++;$script:rules.Remove($InputObject.Name)} }
$script:rules['Unrelated Node']=[pscustomobject]@{Name='Unrelated Node';Group='Not Rovarin'}
Set-RovarinFirewall $plan Install
if(@(Get-FirewallOwned $plan).Count -ne 2 -or $script:rules.Count -ne 3){throw 'Create/scope verification failed'}
$script:windowsAddressReadback=$true
if(@(Get-FirewallOwned $plan).Count -ne 2){throw 'Exact Windows dotted-netmask readback rejected'}
$script:rules[$plan[0].Name].RemoteAddress=@('100.64.0.0/255.128.0.0','fd7a:115c:a1e0::/48');$rejected=$false
try{Get-FirewallOwned $plan}catch{$rejected=$true}
if(-not $rejected){throw 'Wider dotted-netmask accepted'}
$script:rules[$plan[0].Name].RemoteAddress=@('100.64.0.0/10','fd7a:115c:a1e0::/48')
if(-not (Test-FirewallReady $plan @(Get-FirewallOwned $plan) 'Tailscale')){throw 'Configured install should need no new elevation'}
if(Test-FirewallReady $plan @(Get-FirewallOwned $plan) 'Other'){throw 'Changed interface silently accepted'}
$script:rules[$plan[0].Name].Enabled='False';Set-RovarinFirewall $plan Install
if($script:newCalls -ne 2 -or $script:rules[$plan[0].Name].Enabled -ne 'True'){throw 'Upgrade must reuse stable rules'}
$before=$script:mutations;$script:rules[$plan[1].Name].Group='Foreign';$rejected=$false
try{Set-RovarinFirewall $plan Remove}catch{$rejected=$true}
if(-not $rejected -or $script:mutations -ne $before){throw 'Foreign collision changed policy'}
$script:rules[$plan[1].Name].Group=$plan[1].Group
$script:rules[$plan[0].Name].RemoteAddress='Any';$rejected=$false
try{Set-RovarinFirewall $plan Install}catch{$rejected=$true}
if(-not $rejected -or $script:mutations -ne $before){throw 'Broadened rule accepted'}
$script:rules[$plan[0].Name].RemoteAddress=@('100.64.0.0/10','fd7a:115c:a1e0::/48')
Set-RovarinFirewall $plan Remove;Set-RovarinFirewall $plan Remove
if($script:rules.Count -ne 1 -or -not $script:rules.ContainsKey('Unrelated Node')){throw 'Unrelated rule removed'}
$script:adapter=$null;$before=$script:mutations;$rejected=$false
try{Set-RovarinFirewall $plan Install}catch{$rejected=$true}
if(-not $rejected -or $before -ne $script:mutations){throw 'Missing Tailscale broadened access'}
$script:adapter='*';$rejected=$false;try{Set-RovarinFirewall $plan Install}catch{$rejected=$true};if(-not $rejected){throw 'Wildcard interface accepted'}
$script:adapter='Any';$rejected=$false;try{Set-RovarinFirewall $plan Install}catch{$rejected=$true};if(-not $rejected){throw 'Any interface accepted'}
$script:adapter='Tailscale';$script:rules['Prior block']=[pscustomobject]@{Name='Prior block';Enabled='True';Direction='Inbound';Action='Block';Program=$plan[0].Program;Protocol='TCP';LocalPort='Any';InterfaceAlias='Any'}
$before=$script:mutations;$rejected=$false;try{Set-RovarinFirewall $plan Install}catch{$rejected=$true};if(-not $rejected -or $script:mutations -ne $before -or -not $script:rules.ContainsKey('Prior block')){throw 'Prior block bypassed/deleted'};$script:rules.Remove('Prior block')
$script:adapter='Tailscale';$script:newCalls=0;$script:failSecond=$true;$rejected=$false
try{Set-RovarinFirewall $plan Install}catch{$rejected=$true}
if(-not $rejected -or $script:rules.Count -ne 1){throw 'Partial create rollback failed'}
Write-Output 'PASS typed firewall lifecycle: exact programs/ports/interface/CIDRs, stable upgrade, disabled-rule repair, foreign/scope refusal, missing adapter, rollback, owned-only idempotent removal'
`);
 console.log(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',test],{windowsHide:true,encoding:'utf8',timeout:30000}).trim());
 const junction=path.join(temp,'redirected');fs.symlinkSync(app,junction,'junction');
 const negative=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$t=$null;$e=$null;$a=[Management.Automation.Language.Parser]::ParseFile(${q(helper)},[ref]$t,[ref]$e);foreach($f in $a.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst]},$true)){Invoke-Expression $f.Extent.Text};try{Get-FirewallPlan ${q(path.join(junction,'scripts'))};exit 5}catch{exit 0}`],{windowsHide:true,encoding:'utf8',timeout:15000});assert.equal(negative.status,0,negative.stderr);
 const iss=fs.readFileSync(path.join(root,'packaging/Rovarin.iss'),'utf8'),build=fs.readFileSync(path.join(root,'packaging/build.ps1'),'utf8'),uninstall=fs.readFileSync(path.join(root,'scripts/installed-uninstall.ps1'),'utf8');
 assert(build.includes("@('firewall.ps1','standby-runtime.ps1'"));assert(iss.includes("WizardIsTaskSelected('firewall') and not WizardSilent"));assert(iss.includes('if UninstallSilent then Extra := Extra + \' -NoFirewallElevation\''));
 assert(fs.readFileSync(path.join(root,'scripts/packaging-smoke-test.js'),'utf8').includes("path.join(__dirname,'firewall-smoke-test.js')"),'existing packaging gate invokes firewall regression');
 assert(uninstall.includes("$trustedFiles+='app\\scripts\\firewall.ps1'"));assert(uninstall.indexOf("'Owned firewall rule cleanup requires")<uninstall.indexOf("$updates = Join-Path"));
 const policy=JSON.parse(fs.readFileSync(path.join(root,'scripts/release-public-files.json')));assert(policy.includes('scripts/firewall.ps1')&&policy.includes('scripts/firewall-smoke-test.js'));
 for(const file of ['scripts/start.ps1','scripts/installed-start.ps1','scripts/standby-runtime.ps1','packaging/StandbySupervisor.cs','server.js'])assert(!fs.readFileSync(path.join(root,file),'utf8').includes('firewall.ps1'),'no startup/wake elevation');
 console.log('PASS redirected installation rejection, installer task/silent behavior, trusted cleanup before deletion, packaging/source inclusion; no startup/wake firewall mutation');
 const osTest=path.join(temp,'os.ps1');
 fs.writeFileSync(osTest,`$ErrorActionPreference='Stop';$env:PSModulePath=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules'
$p=[Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
$profiles=@(Get-NetFirewallProfile);if($profiles.Count -ne 3){throw 'Profile inspection failed'}
& ${q(helper)} -Action Status;if($LASTEXITCODE){throw 'Real read-only status failed'}
if(-not $p.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){
 $probe=Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\powershell.exe') -ArgumentList ('-NoProfile -NonInteractive -ExecutionPolicy Bypass -File "'+${q(helper)}+'" -Action Install -NoElevation') -WindowStyle Hidden -Wait -PassThru -RedirectStandardError ${q(path.join(temp,'denied.log'))} -RedirectStandardOutput ${q(path.join(temp,'denied-output.log'))}
 if($probe.ExitCode -ne 1){throw 'Non-elevated write did not fail closed'}
 & ${q(helper)} -Action Status;if($LASTEXITCODE){throw 'Post-refusal policy read failed'}
 Write-Output 'PASS real Windows policy read/status and non-elevated mutation refusal; SKIP actual rule write/remove and prompt suppression: administrator token required';exit 0
}
if(@(Get-NetAdapter -IncludeHidden | Where-Object {$_.InterfaceDescription -ceq 'Tailscale Tunnel'}).Count -ne 1){Write-Output 'SKIP real disposable rule writes: Tailscale adapter unavailable; typed policy tests still passed';exit 0}
try{& ${q(helper)} -Action Install -NoElevation;if($LASTEXITCODE){throw 'Real install failed'};& ${q(helper)} -Action Install -NoElevation;if($LASTEXITCODE){throw 'Real idempotence failed'}}finally{& ${q(helper)} -Action Remove -NoElevation;if($LASTEXITCODE){throw 'Real disposable rule cleanup failed'}}
Write-Output 'PASS real Windows disposable firewall create/verify/reuse/remove (not remote packet or UI prompt acceptance)'
`);
 console.log(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',osTest],{windowsHide:true,encoding:'utf8',timeout:60000}).trim());
}finally{const absolute=path.resolve(temp);assert(absolute.startsWith(fs.realpathSync.native(os.tmpdir())+path.sep)&&path.basename(absolute).startsWith('rovarin-firewall-'));fs.rmSync(absolute,{recursive:true,force:true});}
