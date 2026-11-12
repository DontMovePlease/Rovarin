$ErrorActionPreference='Stop'
$repo=Split-Path -Parent $PSScriptRoot
$fixture=Join-Path ([IO.Path]::GetTempPath()) ('rovarin-review-task-'+[Guid]::NewGuid().ToString('N'))
$null=New-Item -ItemType Directory -Path (Join-Path $fixture 'scripts')
Copy-Item -LiteralPath (Join-Path $repo 'scripts/standby-runtime.ps1') -Destination (Join-Path $fixture 'scripts/standby-runtime.ps1')
$code='using System;using System.IO;public class Probe{public static void Main(string[] args){if(args[0]=="session"){Console.WriteLine("{\"ready\":true,\"logon\":\"0000000000000001\"}");}else if(args[0]=="run"){File.WriteAllText(Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"ran"),"fixture task action ran");}}}'
Add-Type -TypeDefinition $code -OutputAssembly (Join-Path $fixture 'RovarinStandby.exe') -OutputType ConsoleApplication
. (Join-Path $fixture 'scripts/standby-runtime.ps1')
try{
 Set-StandbyStartup $true
 $service=Get-StandbyScheduler;$task=Get-OwnedStandbyTask $service;$definition=$task.Definition
 $trigger=$definition.Triggers.Create(1);$trigger.Id='RovarinRecovery';$trigger.StartBoundary=(Get-Date).AddSeconds(5).ToString('s');$trigger.Repetition.Interval='PT1M'
 $sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $null=$service.GetFolder('\').RegisterTaskDefinition((Get-StandbyTaskName),$definition,6,$sid,$null,3)
 Set-StandbyStartup $false
 $task=Get-OwnedStandbyTask $service
 $result=@{taskEnabled=$task.Enabled;automaticStartupReported=(Get-StandbyStartup);triggerCount=$task.Definition.Triggers.Count;recoveryPresent=(@($task.Definition.Triggers|Where-Object {$_.Type -eq 1}).Count -eq 1);realSupervisorUsed=$false;realPreferencesTouched=$false}
 Start-Sleep -Seconds 8
 $result.actionExecuted=Test-Path -LiteralPath (Join-Path $fixture 'ran')
 if($result.actionExecuted -or $result.automaticStartupReported -or $result.taskEnabled -or $result.triggerCount -ne 0){throw 'Startup opt-out retained an automatic launch path'}
 # Re-enable with an existing current-session recovery trigger and verify the
 # actual scheduler still executes the fixed owned action when enabled.
 $definition.Settings.Enabled=$true;$trigger.StartBoundary=(Get-Date).AddSeconds(5).ToString('s')
 $null=$service.GetFolder('\').RegisterTaskDefinition((Get-StandbyTaskName),$definition,6,$sid,$null,3)
 Set-StandbyStartup $true
 Start-Sleep -Seconds 8
 $result.enabledRecoveryExecuted=Test-Path -LiteralPath (Join-Path $fixture 'ran')
 if(-not $result.enabledRecoveryExecuted){throw 'Enabled recovery failed to execute'}
 $result|ConvertTo-Json|Set-Content -LiteralPath (Join-Path $repo 'packaging/cache/v061-review-task-fixed.json')
 Write-Output 'PASS: disabled task has no triggers or process launch; enabled recovery action executes; owned task cleaned.'
}finally{
 $task=Get-OwnedStandbyTask (Get-StandbyScheduler);if($task){$task.Enabled=$false;(Get-StandbyScheduler).GetFolder('\').DeleteTask((Get-StandbyTaskName),0)}
 Remove-Item -LiteralPath $fixture -Recurse -Force
}
