# Disposable VirtualBox-only regression: actual Run/shortcut inventory and mutation.
param([string]$HelperPath=(Join-Path $PSScriptRoot 'app-manager.ps1'))
$ErrorActionPreference='Stop'
if((Get-CimInstance Win32_ComputerSystem).Model -ne 'VirtualBox'){throw 'Disposable VM required'}
$source=[IO.File]::ReadAllText($HelperPath)
$end=$source.LastIndexOf("try {`n    `$text=")
if($end -lt 0){throw 'Helper dispatcher boundary missing'}
$definitions=$source.Substring(0,$end).Replace('$PSScriptRoot', ("'"+ (Split-Path -Parent $HelperPath).Replace("'","''")+"'"))
Invoke-Expression $definitions
$request=@{packageStartup=@();appLocations=@()}
$name='RovarinStartupFixture-'+[Guid]::NewGuid().ToString('N')
$run='HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
$folder=[Environment]::GetFolderPath('Startup')
$link=Join-Path $folder ($name+'.lnk')
$results=New-Object Collections.Generic.List[string]
try {
 New-Item -Path $run -Force|Out-Null
 New-ItemProperty -LiteralPath $run -Name $name -Value ('"'+$env:SystemRoot+'\System32\notepad.exe"') -PropertyType String|Out-Null
 $shortcut=(New-Object -ComObject WScript.Shell).CreateShortcut($link);$shortcut.TargetPath=Join-Path $env:SystemRoot 'System32\notepad.exe';$shortcut.Save()
 foreach($kind in @('registry-user','folder-user')){
  $key=if($kind -eq 'registry-user'){$name}else{$name+'.lnk'}
  $item=@((Startup-Inventory).items|Where-Object {$_.locator.source -eq $kind -and $_.locator.key -eq $key})
  if($item.Count -ne 1 -or $item[0].readOnly -or $item[0].enabled -ne $true){throw ($kind+' incorrectly read-only or initial state unknown')}
  foreach($enabled in @($false,$true)){
   $result=Startup-Toggle @{locator=$item[0].locator;fingerprint=$item[0].fingerprint;enabled=$enabled}
   if(-not $result.success){throw ($kind+' mutation failed')}
   $item=@((Startup-Inventory).items|Where-Object {$_.locator.source -eq $kind -and $_.locator.key -eq $key})
   if($item[0].enabled -ne $enabled){throw ($kind+' refreshed state incorrect')}
  }
  $results.Add($kind+' ENABLE/DISABLE/REFRESH PASS')
 }
 $inventory=Startup-Inventory
 if(@($inventory.items|Where-Object {$_.scope -eq 'machine' -and -not $_.readOnly}).Count){throw 'Machine entry unexpectedly mutable'}
 $results.Add('PROTECTED MACHINE ENTRIES READ-ONLY PASS')
} finally {
 Remove-ItemProperty -LiteralPath $run -Name $name -ErrorAction Stop
 if(Test-Path -LiteralPath $link){Remove-Item -LiteralPath $link -Force}
 foreach($kind in @('Run','StartupFolder')){
  $approval='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\'+$kind
  $key=if($kind -eq 'Run'){$name}else{$name+'.lnk'}
  if(Get-ItemProperty -LiteralPath $approval -Name $key -ErrorAction SilentlyContinue){Remove-ItemProperty -LiteralPath $approval -Name $key -ErrorAction Stop}
 }
}
$results.Add('OWNED FIXTURES CLEANED PASS')
$results