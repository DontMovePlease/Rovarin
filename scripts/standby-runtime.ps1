# Fixed local runtime interface. Never accepts an HTTP path, command or PIN.
$script:StandbyApp = Split-Path -Parent $PSScriptRoot
$script:StandbyExe = Join-Path $script:StandbyApp 'RovarinStandby.exe'
function Test-StandbyAvailable { (Test-Path -LiteralPath $script:StandbyExe -PathType Leaf) -and (Test-Path -LiteralPath (Join-Path $script:StandbyApp 'standby-runtime.json') -PathType Leaf) }
function Get-StandbyTaskName {
 $hash=[Security.Cryptography.SHA256]::Create()
 try{$bytes=$hash.ComputeHash([Text.Encoding]::UTF8.GetBytes($script:StandbyApp.ToLowerInvariant()+[Security.Principal.WindowsIdentity]::GetCurrent().User.Value));return 'Rovarin Smart Standby '+([BitConverter]::ToString($bytes).Replace('-','').Substring(0,16))}finally{$hash.Dispose()}
}
function Get-StandbyScheduler {
 $service=New-Object -ComObject Schedule.Service;$service.Connect();return $service
}
function Get-OwnedStandbyTask($service) {
 try{$task=$service.GetFolder('\').GetTask((Get-StandbyTaskName))}catch{return $null}
 $definition=$task.Definition;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $principal=$definition.Principal.UserId;if($principal -notmatch '^S-1-'){$principal=([Security.Principal.NTAccount]$principal).Translate([Security.Principal.SecurityIdentifier]).Value}
 if($definition.Actions.Count -ne 1 -or $definition.Actions.Item(1).Path -ine $script:StandbyExe -or $definition.Actions.Item(1).Arguments -cne 'run' -or $definition.Actions.Item(1).WorkingDirectory -ine $script:StandbyApp -or $principal -cne $sid -or $definition.Principal.RunLevel -ne 0 -or $definition.Principal.LogonType -ne 3 -or $definition.Triggers.Count -gt 2){throw 'Standby task ownership is not verified.'}
 $logons=0;$requests=0
 foreach($trigger in $definition.Triggers){
  if($trigger.Type -eq 1){$requests++;if($trigger.Id -cne 'RovarinRecovery' -or $trigger.Repetition.Interval -cne 'PT1M' -or $trigger.Repetition.Duration -or -not $trigger.StartBoundary){throw 'Unexpected standby recovery trigger'};continue}
  if($trigger.Type -ne 9){throw 'Unexpected standby trigger'};$logons++;$user=$trigger.UserId;if($user -notmatch '^S-1-'){$user=([Security.Principal.NTAccount]$user).Translate([Security.Principal.SecurityIdentifier]).Value};if($user -cne $sid){throw 'Wrong standby trigger owner'}
 }
 if($requests -gt 1 -or $logons -gt 1){throw 'Duplicate standby trigger'}
 return $task
}
function Set-StandbyStartup([bool]$Enabled) {
 $service=Get-StandbyScheduler;$task=Get-OwnedStandbyTask $service
 $definition=$service.NewTask(0);$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
 $session=Invoke-StandbyCommand session;if(-not $session -or $session.logon -notmatch '^[a-f0-9]{16}$'){throw 'Current logon identity unavailable'};$definition.Data='RovarinLogon:'+$session.logon
 $definition.RegistrationInfo.Description='Rovarin per-user Smart Standby. Fixed app runtime; no administrator privileges.'
 $definition.Principal.UserId=$sid;$definition.Principal.LogonType=3;$definition.Principal.RunLevel=0
 $definition.Settings.Enabled=$Enabled;$definition.Settings.AllowDemandStart=$true;$definition.Settings.Hidden=$true
 $definition.Settings.DisallowStartIfOnBatteries=$false;$definition.Settings.StopIfGoingOnBatteries=$false;$definition.Settings.ExecutionTimeLimit='PT0S'
 $definition.Settings.MultipleInstances=2;$definition.Settings.RestartCount=3;$definition.Settings.RestartInterval='PT1M'
 if($Enabled){$trigger=$definition.Triggers.Create(9);$trigger.UserId=$sid;$trigger.Enabled=$true}
 if($Enabled -and $task){foreach($old in $task.Definition.Triggers){if($old.Type -eq 1){$trigger=$definition.Triggers.Create(1);$trigger.Id='RovarinRecovery';$trigger.StartBoundary=$old.StartBoundary;$trigger.Enabled=$old.Enabled;$trigger.Repetition.Interval='PT1M'}}}
 $action=$definition.Actions.Create(0);$action.Path=$script:StandbyExe;$action.Arguments='run';$action.WorkingDirectory=$script:StandbyApp
 $sddl='O:'+$sid+'D:P(A;;FA;;;'+$sid+')(A;;FA;;;SY)'
 $null=$service.GetFolder('\').RegisterTaskDefinition((Get-StandbyTaskName),$definition,($(if($task){6}else{2})),$sid,$null,3,$sddl)
}
function Get-StandbyStartup {
 $task=Get-OwnedStandbyTask (Get-StandbyScheduler)
 if(-not $task){return $false}
 foreach($trigger in $task.Definition.Triggers){if($trigger.Type -eq 9 -and $trigger.Enabled){return $true}}
 return $false
}
function Invoke-StandbyCommand([ValidateSet('status','wake','stop','verify','session')][string]$Action) {
 $info=New-Object Diagnostics.ProcessStartInfo
 $info.FileName=$script:StandbyExe;$info.Arguments=$Action;$info.WorkingDirectory=$script:StandbyApp
 $info.UseShellExecute=$false;$info.CreateNoWindow=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 $process=[Diagnostics.Process]::Start($info)
 try{
  $text=$process.StandardOutput.ReadToEnd();$null=$process.StandardError.ReadToEnd()
  if(-not $process.WaitForExit(20000)){throw 'Standby control timed out.'}
  if($process.ExitCode -ne 0){return $null}
  return ($text|ConvertFrom-Json)
 }finally{$process.Dispose()}
}
function Start-StandbyRuntime([switch]$Wake) {
 if(-not (Test-StandbyAvailable)){throw 'Smart Standby runtime is not installed.'}
 $status=Invoke-StandbyCommand status
 if(-not $status){
  try{$service=Get-StandbyScheduler}catch{
   if(-not (Invoke-StandbyCommand verify)){throw 'Runtime integrity unavailable; no fallback was started.'}
   $running=@(Get-CimInstance Win32_Process -Filter "Name='RovarinStandby.exe'" -ErrorAction Stop|Where-Object {$_.ExecutablePath -ieq $script:StandbyExe})
   if($running.Count -gt 0){throw 'Existing supervisor is not confirmed stopped.'}
   return @{ready=$false;legacyFallback=$true}
  }
  $task=Get-OwnedStandbyTask $service
  if(-not $task){
   # Preserve an existing owned startup choice. Never remove another installation's shortcut.
   $enabled=$false;$link=Join-Path ([Environment]::GetFolderPath('Startup')) 'Rovarin.lnk'
   if(Test-Path -LiteralPath $link){
    $entry=(New-Object -ComObject WScript.Shell).CreateShortcut($link)
    if($entry.TargetPath -ieq (Join-Path $script:StandbyApp 'Rovarin.exe') -and $entry.Arguments -ceq 'startup' -and $entry.WorkingDirectory -ieq $script:StandbyApp){
     if((Get-Item -LiteralPath $link).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected startup link'}
     $approved=Get-ItemPropertyValue -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder' -Name 'Rovarin.lnk' -ErrorAction SilentlyContinue
     if($approved -and ($approved -isnot [byte[]] -or $approved.Length -ne 12 -or $approved[0] -notin @(2,3))){throw 'Unrecognized startup preference'}
     $enabled=(-not $approved -or $approved[0] -ne 3)
     Set-StandbyStartup $enabled
     Remove-Item -LiteralPath $link
    }
   }
   if(-not (Get-OwnedStandbyTask $service)){Set-StandbyStartup $enabled}
   $task=Get-OwnedStandbyTask $service
  }
  # An upgrade may recreate the historical link. Keep the task's existing
  # startup choice authoritative and remove only this installation's duplicate.
  $duplicate=Join-Path ([Environment]::GetFolderPath('Startup')) 'Rovarin.lnk'
  if(Test-Path -LiteralPath $duplicate){
   $entry=(New-Object -ComObject WScript.Shell).CreateShortcut($duplicate)
   if($entry.TargetPath -ieq (Join-Path $script:StandbyApp 'Rovarin.exe') -and $entry.Arguments -ceq 'startup' -and $entry.WorkingDirectory -ieq $script:StandbyApp){
    if((Get-Item -LiteralPath $duplicate).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirected startup link'}
    Remove-Item -LiteralPath $duplicate
   }
  }
  # RestartOnFailure does not reliably cover a running action's exit. Repeating
  # the fixed action skips a live task (IgnoreNew), with no second resident host.
  # Native logon identity disables recovery in a new session if startup is off.
  $definition=$task.Definition
  for($i=$definition.Triggers.Count;$i -ge 1;$i--){if($definition.Triggers.Item($i).Type -eq 1){$definition.Triggers.Remove($i)}}
  $trigger=$definition.Triggers.Create(1);$trigger.Id='RovarinRecovery';$trigger.StartBoundary=(Get-Date).AddSeconds(2).ToString('s');$trigger.Enabled=$true;$trigger.Repetition.Interval='PT1M'
  $session=Invoke-StandbyCommand session;if(-not $session -or $session.logon -notmatch '^[a-f0-9]{16}$'){throw 'Current logon identity unavailable'};$definition.Data='RovarinLogon:'+$session.logon
  $definition.Settings.Enabled=$true;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
  $sddl='O:'+$sid+'D:P(A;;FA;;;'+$sid+')(A;;FA;;;SY)'
  $null=$service.GetFolder('\').RegisterTaskDefinition((Get-StandbyTaskName),$definition,6,$sid,$null,3,$sddl)
  for($i=0;$i -lt 20;$i++){Start-Sleep -Milliseconds 250;$status=Invoke-StandbyCommand status;if($status){break}}
 }
 if(-not $status){throw 'Smart Standby could not start safely. Try reopening Rovarin shortly; your PIN has not changed.'}
 if($Wake){$status=Invoke-StandbyCommand wake;if(-not $status){throw 'Rovarin could not wake safely. Try again shortly.'}}
 return $status
}
function Stop-StandbyRuntime([switch]$RemoveStartup) {
 $service=Get-StandbyScheduler;$task=Get-OwnedStandbyTask $service
 if($task){$task.Enabled=$false}
 $confirmed=$false
 try{
 # Preserve active operations and active authenticated clients. A caller may retry.
 for($i=0;$i -lt 30;$i++){
  $status=Invoke-StandbyCommand status
  if(-not $status){
   $remaining=@(Get-CimInstance Win32_Process -Filter "Name='RovarinStandby.exe'" -ErrorAction Stop|Where-Object {$_.ExecutablePath -ieq $script:StandbyExe})
   if($remaining.Count -gt 0){throw 'A supervisor is still running but its ownership/status could not be verified.'}
   $metadata=Get-Content -LiteralPath (Join-Path $script:StandbyApp 'standby-runtime.json') -Raw|ConvertFrom-Json
   $configuration=[IO.Path]::GetFullPath($(if([IO.Path]::IsPathRooted($metadata.config)){$metadata.config}else{Join-Path $script:StandbyApp $metadata.config}))
   $instance=Join-Path (Split-Path -Parent $configuration) 'server.instance.json'
   if(Test-Path -LiteralPath $instance){
    $item=Get-Item -LiteralPath $instance;if($item.Length -gt 65536 -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe backend ownership record.'}
    $record=Get-Content -LiteralPath $instance -Raw|ConvertFrom-Json
    $owner=Get-Process -Id ([int]$record.pid) -ErrorAction SilentlyContinue
    if($owner){try{if(-not $owner.HasExited){throw 'A backend is still running. Reopen Rovarin to recover its supervisor before retrying.'}}finally{$owner.Dispose()}}
   }
   break
  }
  $stopped=Invoke-StandbyCommand stop
  if($stopped){break}
  if($i -eq 29){throw 'Rovarin is still in use. Close its other clients and finish active operations before retrying.'}
  Start-Sleep -Seconds 2
 }
 $confirmed=$true
 if($task){if($RemoveStartup){$service.GetFolder('\').DeleteTask((Get-StandbyTaskName),0)}else{$task.Enabled=$false}}
 }finally{if(-not $confirmed -and $task){$task.Enabled=$true}}
}
