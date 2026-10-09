param([switch]$PostReboot,[switch]$UpgradeExisting)
$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$computer=Get-CimInstance Win32_ComputerSystem
if($computer.Model -notmatch 'VirtualBox' -and $computer.Manufacturer -notmatch 'innotek'){throw 'VM ONLY: physical host refused.'}
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
if((New-Object Security.Principal.WindowsPrincipal($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)){throw 'Start this test in NON-elevated VM PowerShell. Approve only installer UAC.'}
$root=Join-Path ([Environment]::GetFolderPath('ProgramFiles')) 'RovarinMaintenance'
$image=Join-Path $root 'RovarinMaintenanceService.exe'
$owner=$identity.User.Value
if($owner -notmatch '^S-1-5-21-\d+-\d+-\d+-\d+$'){throw 'Unsupported test owner identity.'}
function Probe($argument,$expected){$output=(& $image $argument | Out-String).Trim();if($LASTEXITCODE -ne 0 -or $output -ne $expected){throw "Probe failed: $argument (no private output printed)."}}
function DenyWrite($path){try{$file=[IO.File]::Open($path,'Open','Write','Read');$file.Close();throw 'Unsafe: ordinary user can write privileged binary.'}catch [UnauthorizedAccessException]{}}
$report=Join-Path $env:TEMP 'rovarin-service-vm-result.json'
if(!$PostReboot){
 if((Get-Service RovarinMaintenanceFoundation -ErrorAction SilentlyContinue) -and !$UpgradeExisting){throw 'Use a clean VM snapshot or explicitly test the protected upgrade path; existing service retained.'}
 $setup=Join-Path $PSScriptRoot 'RovarinMaintenanceSetup.exe'
 $expected=(Get-Content ($setup+'.sha256') -Raw).Trim()
 if((Get-FileHash $setup -Algorithm SHA256).Hash.ToLowerInvariant() -ne $expected){throw 'Fixture integrity mismatch (not a publisher signature).'}
 Write-Host 'Approve Windows UAC, then complete the maintenance installer. Do not change its installation directory.'
 $install=Start-Process -FilePath $setup -ArgumentList ('/OWNER='+$owner) -Verb RunAs -Wait -PassThru
 if($install.ExitCode -ne 0){throw 'Installer did not complete; approval cancellation must be tested separately.'}
 if((Get-Service RovarinMaintenanceFoundation).Status -ne 'Running'){throw 'Service not running.'}
 Probe '--status' 'enabled';DenyWrite $image
 Probe '--revoke' 'disabled';Probe '--status' 'disabled'
 [IO.File]::WriteAllText($report,'{"installation":true,"running":true,"ownerStatus":true,"ordinaryWriteDenied":true,"revoked":true,"reboot":false,"uninstalled":false}')
 Write-Host 'INITIAL VM CHECKS PASS. Reboot the VM, then rerun this same script with -PostReboot. No reboot was performed automatically.'
}else{
 if(!(Test-Path $report)){throw 'Initial VM phase evidence missing.'}
 if((Get-Service RovarinMaintenanceFoundation).Status -ne 'Running'){throw 'Service unavailable after reboot.'}
 Probe '--status' 'disabled';DenyWrite $image
 Write-Host 'Revocation survived reboot. Approve UAC for the protected companion uninstaller.'
 $uninstall=Join-Path $root 'unins000.exe'
 $remove=Start-Process -FilePath $uninstall -Verb RunAs -Wait -PassThru
 if($remove.ExitCode -ne 0){throw 'Uninstall failed.'}
 if(Get-Service RovarinMaintenanceFoundation -ErrorAction SilentlyContinue){throw 'Service registration remains.'}
 if(Test-Path $image){throw 'Service binary remains.'}
 if(Get-Process RovarinMaintenanceService -ErrorAction SilentlyContinue){throw 'Service process remains.'}
 [IO.File]::WriteAllText($report,'{"installation":true,"running":true,"ownerStatus":true,"ordinaryWriteDenied":true,"revoked":true,"reboot":true,"uninstalled":true}')
 Write-Host 'VM INSTALL/REVOCATION/REBOOT/REMOVAL PASS. UAC cancellation and separate-administrator approval still require distinct runs.'
}