# Run only in the disposable VirtualBox guest. Not installed with Rovarin.
param([string]$HelperPath=(Join-Path $PSScriptRoot 'startup-tasks.ps1'),[string]$ResultPath=(Join-Path ([IO.Path]::GetTempPath()) 'rovarin-startup-task-result.json'))
if ((Get-CimInstance Win32_ComputerSystem -ErrorAction Stop).Model -ne 'VirtualBox') { throw 'Disposable VirtualBox guest required' }
$ErrorActionPreference='Stop'
function Fingerprint([string]$value){$sha=[Security.Cryptography.SHA256]::Create();try{([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLowerInvariant()}finally{$sha.Dispose()}}
. $HelperPath
$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$tag='FixtureStartupQA-'+[Guid]::NewGuid().ToString('N')
$dir=Join-Path $env:USERPROFILE $tag
$scheduler=New-Object -ComObject Schedule.Service;$scheduler.Connect();$root=$scheduler.GetFolder('\')
$folder=$null
$results=New-Object Collections.Generic.List[string]
try{
 [IO.Directory]::CreateDirectory($dir)|Out-Null
 $exe=Join-Path $dir 'FixtureApplication.exe'
 Add-Type -TypeDefinition 'public class FixtureApplication { public static void Main() {} }' -OutputAssembly $exe -OutputType ConsoleApplication
 $acl=Get-Acl $exe;$acl.SetOwner((New-Object Security.Principal.SecurityIdentifier($sid)));$acl.SetAccessRuleProtection($true,$false)
 foreach($identity in @($sid,'S-1-5-18','S-1-5-32-544')){$acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($identity)),'FullControl','Allow')))}
 Set-Acl -LiteralPath $exe -AclObject $acl
 $sddl='O:'+ $sid +'D:P(A;;FA;;;'+$sid+')(A;;FA;;;SY)(A;;FA;;;BA)'
 $folder=$root.CreateFolder($tag,$sddl)
 $definition=$scheduler.NewTask(0);$definition.Principal.UserId=$sid;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=0
 $trigger=$definition.Triggers.Create(9);$trigger.UserId=$sid
 $action=$definition.Actions.Create(0);$action.Path=$exe
 $task=$folder.RegisterTaskDefinition('Fixture',$definition,6,$sid,$null,3,$sddl)
 $policy=Get-StartupTaskPolicy $task
 if(-not $policy.manageable){throw ('Fixture unexpectedly blocked: '+$policy.reason)}
 $request=@{locator=@{source='scheduled-task';key=[string]$task.Path};fingerprint=(Fingerprint ([string]$task.Path+'|'+[string]$task.Xml));enabled=$false;restore=$false}
 $result=Set-StartupTask $request;if(-not $result.success){throw ('Disable failed: '+$result.error)}
 $task=$folder.GetTask('Fixture');if($task.Enabled){throw 'Disable not observed'};$results.Add('DISABLE PASS')
 $stale=Set-StartupTask $request;if($stale.success -or $stale.code -ne 'startup-changed'){throw 'Stale snapshot accepted'};$results.Add('STALE REJECT PASS')
 $request.fingerprint=Fingerprint ([string]$task.Path+'|'+[string]$task.Xml);$request.restore=$true
 $result=Set-StartupTask $request;if(-not $result.success -or -not $folder.GetTask('Fixture').Enabled){throw ('Restore failed: '+$result.error)};$results.Add('RESTORE PASS')
 if(Get-StartupTaskSaved ([string]$task.Path)){throw 'Restore journal not cleared'}
 $task=$folder.GetTask('Fixture');$request.fingerprint=Fingerprint ([string]$task.Path+'|'+[string]$task.Xml);$request.restore=$false;$request.enabled=$true
 if(-not (Set-StartupTask $request).success){throw 'Enable failed'};$results.Add('ENABLE PASS')
 $definition.Principal.RunLevel=1
 try {
  $elevated=$folder.RegisterTaskDefinition('ElevatedFixture',$definition,6,$sid,$null,3,$sddl)
  if((Get-StartupTaskPolicy $elevated).manageable){throw 'Elevated task accepted'}
  $results.Add('ELEVATED POLICY REJECT PASS')
 } catch [UnauthorizedAccessException] { $results.Add('WINDOWS ELEVATION BOUNDARY PASS') }
 $task=$folder.GetTask('Fixture')
 $script:startupSecurityPaths=@($dir.TrimEnd('\')+'\');$script:startupSecurityKnown=$true
 if((Get-StartupTaskPolicy $task).manageable){throw 'Registered security product directory accepted'};$results.Add('SECURITY PRODUCT REJECT PASS')
 $script:startupSecurityPaths=@();$script:startupSecurityKnown=$false
 if((Get-StartupTaskPolicy $task).manageable){throw 'Unavailable security provider accepted'};$results.Add('SECURITY COVERAGE FAIL CLOSED PASS')
 $script:startupSecurityPaths=$null
 # Change task definition after inventory; it must never inherit a reviewed capability.
 $task=$folder.GetTask('Fixture');$request.fingerprint=Fingerprint ([string]$task.Path+'|'+[string]$task.Xml)
 $changed=$task.Definition;$changed.RegistrationInfo.Description='External change'
 $folder.RegisterTaskDefinition('Fixture',$changed,6,$sid,$null,3,$sddl)|Out-Null
 if((Set-StartupTask $request).success){throw 'Changed task accepted'};$results.Add('IDENTITY CHANGE REJECT PASS')
 $task=$folder.GetTask('Fixture');$policy=Get-StartupTaskPolicy $task;if($policy.canRestore){throw 'Original state incorrectly bound to changed task'};$results.Add('RESTORE IDENTITY REJECT PASS')
}finally{
 if($folder){foreach($name in @('Fixture','ElevatedFixture')){try{$task=$folder.GetTask($name);Set-StartupTaskSaved ([string]$task.Path) $null;$folder.DeleteTask($name,0)}catch{if($_.Exception.HResult -ne -2147024894){throw}}};$root.DeleteFolder($tag,0)}
 if(Test-Path -LiteralPath $exe){Remove-Item -LiteralPath $exe -Force}
 if(Test-Path -LiteralPath $dir){Remove-Item -LiteralPath $dir}
}
$results.Add('OWNED FIXTURES CLEANED PASS')
$results | ConvertTo-Json | Set-Content -LiteralPath $ResultPath -Encoding UTF8
$results
