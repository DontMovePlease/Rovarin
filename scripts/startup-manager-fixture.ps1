param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][string]$TaskName,[switch]$Cleanup)
$ErrorActionPreference='Stop'
if($TaskName -cnotmatch '^StartupCoverageFixture-[a-f0-9]{32}$'){throw 'Not an owned fixture name'}
$Directory=[IO.Path]::GetFullPath($Directory)
if(-not $Directory.StartsWith([IO.Path]::GetFullPath($env:TEMP).TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($Directory) -notmatch '^rovarin-startup-' -or ((Get-Item -LiteralPath $Directory).Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Not an owned temporary fixture directory'}
$scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$folder=$scheduler.GetFolder('\')
$record=Join-Path $Directory 'task-fixture.json'
function Save-FixtureRecord($task){[IO.File]::WriteAllText($record,(@{name=$TaskName;xml=[string]$task.Xml}|ConvertTo-Json -Compress))}
if($Cleanup){
    if(-not (Test-Path -LiteralPath $record)){exit}
    $saved=Get-Content -LiteralPath $record -Raw|ConvertFrom-Json
    $task=$folder.GetTask('\'+$TaskName)
    if($saved.name -cne $TaskName -or [string]$task.Xml -cne [string]$saved.xml -or [string]$task.Definition.RegistrationInfo.Description -cne ('Disposable startup coverage fixture '+$TaskName)){throw 'Fixture ownership changed; retained'}
    $folder.DeleteTask($TaskName,0)
    if(@($folder.GetTasks(1)|Where-Object{$_.Name -ceq $TaskName}).Count){throw 'Owned fixture was not removed'}
    Remove-Item -LiteralPath $record
    Write-Output 'PASS owned startup task fixture removed'
    exit
}
$source=Join-Path (Split-Path -Parent $PSScriptRoot) 'scripts\startup-elevated.cs'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($source)) -ReferencedAssemblies System.Web.Extensions,System.Management,Microsoft.CSharp,System.Core,System.Xml
$target=@('C:\Program Files (x86)\MSI\MSI NBFoundation Service\OmApSvcBroker.exe','C:\Program Files\Google\Chrome\Application\chrome.exe','C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe')|Where-Object{[IO.File]::Exists($_) -and (Get-AuthenticodeSignature -LiteralPath $_).Status -eq 'Valid'}|Select-Object -First 1
if(-not $target){throw 'No protected signed installed fixture target is available'}
$definition=$scheduler.NewTask(0)
$definition.RegistrationInfo.Description='Disposable startup coverage fixture '+$TaskName
$definition.Principal.UserId=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$definition.Principal.LogonType=3;$definition.Principal.RunLevel=0
$definition.Settings.Enabled=$false;$definition.Settings.Hidden=$true;$definition.Settings.AllowDemandStart=$false
$trigger=$definition.Triggers.Create(9);$trigger.UserId=$definition.Principal.UserId;$trigger.StartBoundary='2099-01-01T00:00:00'
$action=$definition.Actions.Create(0);$action.Path=$target
# TASK_CREATE only: never replace an existing task. The future sign-in trigger
# and disabled demand-start prevent this fixture from executing any application.
$task=$folder.RegisterTaskDefinition($TaskName,$definition,2,$definition.Principal.UserId,$null,3,$null)
Save-FixtureRecord $task
$path='\'+$TaskName
$requestParser=[RovarinStartupApproval].GetMethod('Request',[Reflection.BindingFlags]'Static,NonPublic')
$forged='{"source":"scheduled-task","key":"\\Fixture","fingerprint":"'+('a'*64)+'","enabled":true,"callerSid":"S-1-5-18"}'
$rejected=$false;try{$requestParser.Invoke($null,@($forged,$false))|Out-Null}catch{$rejected=$true};if(-not $rejected){throw 'Public broker request accepted a forged caller SID'}
$policy=[RovarinStartupApproval]::Inspect('scheduled-task',$path)|ConvertFrom-Json
if(-not $policy.manageable -or -not $policy.requiresElevation -or $policy.enabled){throw ('Native fixture policy failed: '+$policy.reason)}
$request=[Collections.Generic.Dictionary[string,object]]::new()
$request.Add('source','scheduled-task');$request.Add('key',$path);$request.Add('fingerprint',('a'*64));$request.Add('enabled',$true)
$flags=[Reflection.BindingFlags]'Static,NonPublic'
$apply=[RovarinStartupApproval].GetMethod('Apply',$flags)
$stale=$apply.Invoke($null,@($request))
if($stale.success -or $stale.code -ne 'startup-changed' -or $folder.GetTask($path).Enabled){throw 'Stale task identity was accepted'}
$flip=Join-Path $Directory 'flip.ps1'
[IO.File]::WriteAllText($flip,@'
param([string]$Source,[string]$TaskPath,[bool]$Desired)
$ErrorActionPreference='Stop'
Add-Type -TypeDefinition ([IO.File]::ReadAllText($Source)) -ReferencedAssemblies System.Web.Extensions,System.Management,Microsoft.CSharp,System.Core,System.Xml
$s=New-Object -ComObject Schedule.Service;$s.Connect();$t=$s.GetFolder('\').GetTask($TaskPath)
$beforeXml=[string]$t.Xml;$beforeSecurity=[string]$t.GetSecurityDescriptor(5)
$r=[Collections.Generic.Dictionary[string,object]]::new();$r.Add('source','scheduled-task');$r.Add('key',$TaskPath);$r.Add('fingerprint',[RovarinStartupApproval]::Hash($TaskPath+'|'+[string]$t.Xml));$r.Add('enabled',$Desired)
$m=[RovarinStartupApproval].GetMethod('Apply',[Reflection.BindingFlags]'Static,NonPublic')
$result=$m.Invoke($null,@($r))
if(-not $result.success -or $result.enabled -ne $Desired -or $s.GetFolder('\').GetTask($TaskPath).Enabled -ne $Desired){[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'before.xml'),$beforeXml);[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'after.xml'),[string]$s.GetFolder('\').GetTask($TaskPath).Xml);[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'security.json'),(@{before=$beforeSecurity;after=[string]$s.GetFolder('\').GetTask($TaskPath).GetSecurityDescriptor(5)}|ConvertTo-Json));Write-Output ($result|ConvertTo-Json -Compress);Write-Output ('Actual state: '+$s.GetFolder('\').GetTask($TaskPath).Enabled);exit 1}
$result|ConvertTo-Json -Compress
'@)
$shell=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
foreach($desired in @($true,$false,$true)){
    # A fresh process compiles the unmodified production implementation and
    # calls only Apply against this ordinary owned task. This does not test UAC.
    $literal=if($desired){'$true'}else{'$false'}
    $call="& '"+$flip.Replace("'","''")+"' -Source '"+$source.Replace("'","''")+"' -TaskPath '"+$path.Replace("'","''")+"' -Desired "+$literal
    $flipOutput=(& $shell -NoProfile -NonInteractive -Command $call 2>&1|Out-String)
    if($LASTEXITCODE -ne 0 -or $folder.GetTask($path).Enabled -ne $desired){throw ('Fresh-helper state did not persist: '+$flipOutput)}
    Save-FixtureRecord ($folder.GetTask($path))
}
$task=$folder.GetTask($path)
$changed=$task.Definition;$changed.Actions.Item(1).Path=Join-Path $env:SystemRoot 'System32\notepad.exe'
$folder.RegisterTaskDefinition($TaskName,$changed,4,$definition.Principal.UserId,$null,3,$null)|Out-Null
Save-FixtureRecord ($folder.GetTask($path))
$blocked=[RovarinStartupApproval]::Inspect('scheduled-task',$path)|ConvertFrom-Json
if($blocked.manageable){throw 'Windows executable protection was bypassed'}
$changed=$folder.GetTask($path).Definition;$changed.Actions.Item(1).Path=$target
$changed.Actions.Item(1).WorkingDirectory=$Directory
$folder.RegisterTaskDefinition($TaskName,$changed,4,$definition.Principal.UserId,$null,3,$null)|Out-Null
Save-FixtureRecord ($folder.GetTask($path))
$working=[RovarinStartupApproval]::Inspect('scheduled-task',$path)|ConvertFrom-Json
if($working.manageable){throw 'User-writable task working directory was accepted'}
$changed=$folder.GetTask($path).Definition;$changed.Actions.Item(1).WorkingDirectory=''
$daily=$changed.Triggers.Create(2);$daily.StartBoundary='2099-01-01T00:00:00';$daily.DaysInterval=1
$folder.RegisterTaskDefinition($TaskName,$changed,4,$definition.Principal.UserId,$null,3,$null)|Out-Null
Save-FixtureRecord ($folder.GetTask($path))
$mixed=[RovarinStartupApproval]::Inspect('scheduled-task',$path)|ConvertFrom-Json
if($mixed.manageable){throw 'Mixed non-startup triggers were accepted'}
Write-Output 'PASS actual owned Task Scheduler enable/disable/enable across fresh production helpers, stale refusal, protected target and mixed-trigger refusal; no task executed, no UAC assertion'
