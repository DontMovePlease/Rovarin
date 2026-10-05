$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'application-display.ps1')
# Only the fixed server-owned operation and locally re-resolved registration are accepted.
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app-uninstall.cs') -Raw)
function Safe-Executable($command) {
    if ($command -isnot [string] -or $command.Length -gt 4096 -or $command -match '[&|<>`;$%!\r\n]') { return $null }
    try{$args = [RovarinUninstallArguments]::Parse($command)}catch{return $null};$exe = $args[0]
    if ($exe -notmatch '^[A-Za-z]:\\' -or [IO.Path]::GetExtension($exe) -ine '.exe' -or -not [IO.File]::Exists($exe)) { return $null }
    $base = [IO.Path]::GetFileNameWithoutExtension($exe)
    if ($base -match '^(cmd|powershell|pwsh|mshta|wscript|cscript|rundll32|regsvr32|reg|schtasks|wmic|node|python.*|ruby|perl|java.*|msiexec|rovarin|pcmonitor)$') { return $null }
    $current=Get-Item -LiteralPath $exe
    if($current -is [IO.FileInfo]){if(($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){return $null};$current=$current.Directory}
    while($null -ne $current){if(($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){return $null};$current=$current.Parent}
    @{exe=[IO.Path]::GetFullPath($exe);args=@($args | Select-Object -Skip 1)}
}
function Fingerprint($value) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Registry-Row($scope,$keyName) {
    $hive=if($scope -eq 'user'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}
    $view=if($scope -eq 'machine32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
    $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$key=$null
    try {
        $key=$root.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$keyName)
        if($null -eq $key){return $null}
        $name=$key.GetValue('DisplayName'); if($name -isnot [string] -or -not $name.Trim() -or $key.GetValue('SystemComponent',0) -eq 1 -or $key.GetValue('ParentKeyName')){return $null}
        $version=[string]$key.GetValue('DisplayVersion','');$publisher=[string]$key.GetValue('Publisher','');$uninstall=[string]$key.GetValue('UninstallString','');$quiet=[string]$key.GetValue('QuietUninstallString','')
        $location=[string]$key.GetValue('InstallLocation','');$size=$key.GetValue('EstimatedSize',$null);$date=[string]$key.GetValue('InstallDate','')
        $description=[string]$key.GetValue('Comments','');if(-not $description){$description=[string]$key.GetValue('Description','')};$numericSize=$null;if($size -is [int] -or $size -is [long] -or $size -is [double]){if($size -ge 0){$numericSize=[double]$size}}
        $product=$null;$type='manual';$handler=$null;$batch=$false
        if($key.GetValue('WindowsInstaller',0) -eq 1 -and $keyName -match '^\{[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}$'){$product=$keyName;$type='msi';$batch=$true}
        else {$handler=Safe-Executable $uninstall;if($null -ne $handler){$type='exe';$q=Safe-Executable $quiet;if($null -ne $q -and $q.exe -ieq $handler.exe){$batch=$true;$handler.quiet=$q}}}
        $protected=($name -match '^(Rovarin|PC Monitor)(\s|$)' -or $keyName -match '^(Rovarin|PCMonitor)' -or $name -match '^Microsoft Windows (?:Operating|Security)')
        if($protected){$type='manual';$batch=$false;$handler=$null;$product=$null}
        if($type -eq 'exe' -and $scope -ne 'user'){
            $roots=@($env:ProgramFiles,${env:ProgramFiles(x86)},$env:SystemRoot) | Where-Object {$_}
            if(-not @($roots | Where-Object {$handler.exe.StartsWith($_.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){$type='manual';$batch=$false;$handler=$null}
        }
        $fingerprint=Fingerprint ($scope+'|'+$keyName+'|'+$name+'|'+$version+'|'+$uninstall+'|'+$quiet)
        @{locator=@{scope=$scope;key=$keyName};fingerprint=$fingerprint;name=$name.Substring(0,[Math]::Min(200,$name.Length));version=$version;publisher=$publisher;installLocation=$location;sizeKB=$numericSize;description=$description;installDate=$date;type=$type;batchCapable=$batch;elevationLikely=($scope -ne 'user');product=$product;handler=$handler;protected=$protected}
    }finally{if($null -ne $key){$key.Dispose()};$root.Dispose()}
}
function Package-Row($package) {
    $manifest=$null;try{$manifest=Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop}catch{}
    $description=Get-RovarinPackageDescription $package $manifest
    $publisher=[string]$manifest.Package.Properties.PublisherDisplayName;if(-not $publisher -or $publisher -match '^ms-resource:'){$publisher=[string]$package.Publisher}
    $systemComponent=[bool]($package.IsFramework -or $package.IsResourcePackage -or $package.NonRemovable)
    $safe= -not ($package.IsFramework -or $package.IsResourcePackage -or $package.NonRemovable -or $package.Name -match '^(Microsoft\.Windows|Microsoft\.AAD|Microsoft\.SecHealth|windows\.immersivecontrolpanel|MicrosoftWindows\.|Rovarin)')
    @{locator=@{scope='appx';key=$package.PackageFullName};fingerprint=(Fingerprint $package.PackageFullName);name=(Get-RovarinPackageDisplayName $package $manifest);description=$description;systemComponent=$systemComponent;version=[string]$package.Version;publisher=$publisher;installLocation='';sizeKB=$null;installDate='';type='appx';batchCapable=$safe;elevationLikely=$false;protected=(-not $safe)}
}
function Inventory {
    $rows=New-Object Collections.Generic.List[object]
    foreach($scope in @('user','machine64','machine32')){
        $hive=if($scope -eq 'user'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}
        $view=if($scope -eq 'machine32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$key=$null
        try{$key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall');if($null -ne $key){foreach($name in $key.GetSubKeyNames()){if($rows.Count -ge 2048){throw 'Inventory bound exceeded'};$row=Registry-Row $scope $name;if($null -ne $row){$rows.Add($row)}}}}finally{if($key){$key.Dispose()};$base.Dispose()}
    }
    $packagesAvailable=$null -ne (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)
    if($packagesAvailable){try{foreach($package in Get-AppxPackage -ErrorAction Stop){if($rows.Count -ge 2048){throw 'Inventory bound exceeded'};$rows.Add((Package-Row $package))}}catch{$packagesAvailable=$false}}
    @{success=$true;code='inventory';apps=@($rows.ToArray());packagesAvailable=$packagesAvailable}
}
try {
    $text=[Console]::In.ReadToEnd();if($text.Length -gt 8192){throw 'Invalid input'};$request=$text | ConvertFrom-Json
    if($request.action -eq 'inventory'){Inventory | ConvertTo-Json -Depth 8 -Compress;exit}
    if($request.action -ne 'uninstall' -or $request.locator.scope -notin @('user','machine64','machine32','appx') -or $request.locator.key -match '[\\/\r\n]' -or $request.locator.key.Length -gt 300){throw 'Invalid operation'}
    if($request.locator.scope -eq 'appx'){
        $package=Get-AppxPackage | Where-Object {$_.PackageFullName -ceq $request.locator.key} | Select-Object -First 1
        if($null -eq $package){@{success=$false;code='not-installed'} | ConvertTo-Json -Compress;exit}
        $row=Package-Row $package
    }else{$row=Registry-Row $request.locator.scope $request.locator.key}
    if($null -eq $row){@{success=$false;code='not-installed'} | ConvertTo-Json -Compress;exit}
    if($row.fingerprint -cne $request.fingerprint){@{success=$false;code='inventory-changed'} | ConvertTo-Json -Compress;exit}
    if($row.protected -or $row.type -eq 'manual' -or ($request.batch -eq $true -and -not $row.batchCapable)){@{success=$false;code='unsupported'} | ConvertTo-Json -Compress;exit}
    if($row.type -eq 'appx'){
        Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
        @{success=$true;code='completed'} | ConvertTo-Json -Compress;exit
    }
    $stream=$null;$process=$null
    try {
        $info=New-Object Diagnostics.ProcessStartInfo
        if($row.type -eq 'msi'){$info.FileName=Join-Path $env:SystemRoot 'System32\msiexec.exe';$args=@('/x',$row.product,'/qn','/norestart')}
        else {$handler=$row.handler;if($request.batch -eq $true){$handler=$handler.quiet};$info.FileName=$handler.exe;$args=$handler.args;$stream=[IO.File]::Open($info.FileName,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)}
        $info.Arguments=(@($args | ForEach-Object {[RovarinUninstallArguments]::Quote([string]$_)}) -join ' ')
        $info.UseShellExecute=$row.elevationLikely;$info.CreateNoWindow= -not $row.elevationLikely
        if($row.elevationLikely){$info.Verb='runas'}
        $process=[Diagnostics.Process]::Start($info)
        if($stream){$stream.Dispose();$stream=$null}
        if(-not $process.WaitForExit(90000)){@{success=$false;code='still-running'} | ConvertTo-Json -Compress;exit}
        $exitCode=$process.ExitCode
        $code=if($row.type -ne 'msi'){if($exitCode -eq 0){'completed'}else{'uninstall-failed'}}else{switch($exitCode){0{'completed'}3010{'reboot-required'}1641{'reboot-required'}1605{'not-installed'}1614{'not-installed'}1602{'cancelled'}default{'uninstall-failed'}}}
        @{success=($code -in @('completed','reboot-required'));code=$code;exitCode=$exitCode} | ConvertTo-Json -Compress
    }finally{if($stream){$stream.Dispose()};if($process){$process.Dispose()}}
}catch{
    $code=if($_.Exception.NativeErrorCode -eq 1223){'cancelled'}elseif($_.Exception -is [UnauthorizedAccessException]){'access-denied'}else{'operation-failed'}
    @{success=$false;code=$code} | ConvertTo-Json -Compress
}
