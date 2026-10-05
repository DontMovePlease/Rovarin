$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'application-display.ps1')
try {
    $text=[Console]::In.ReadToEnd();if($text.Length -gt 65536){throw 'Invalid metadata input'}
    $requests=ConvertFrom-Json -InputObject $text; $requests=@($requests);if($requests.Count -gt 50){throw 'Metadata bound exceeded'}
    $packages=@();try{$packages=@(foreach($installedPackage in Get-AppxPackage -ErrorAction Stop){$location=[string]$installedPackage.InstallLocation;if($location){[pscustomobject]@{Prefix=$location.TrimEnd('\')+'\';Package=$installedPackage}}})|Sort-Object {$_.Prefix.Length} -Descending}catch{}
    $registrations=@{}
    foreach($source in @(@('CurrentUser','Registry64'),@('LocalMachine','Registry64'),@('LocalMachine','Registry32'))){
        $base=$null;$uninstall=$null
        try {
            $hive=[Microsoft.Win32.RegistryHive]([Enum]::Parse([Microsoft.Win32.RegistryHive],$source[0]));$view=[Microsoft.Win32.RegistryView]([Enum]::Parse([Microsoft.Win32.RegistryView],$source[1]))
            $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$uninstall=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
            if($uninstall){foreach($keyName in $uninstall.GetSubKeyNames()){
                $entry=$null
                try {$entry=$uninstall.OpenSubKey($keyName);if($entry){$name=[string]$entry.GetValue('DisplayName','');$icon=[string]$entry.GetValue('DisplayIcon','');if($name -and $icon -match '^"?([A-Za-z]:\\.+?\.exe)"?(?:,\s*-?\d+)?$'){$file=[IO.Path]::GetFullPath($matches[1]).ToLowerInvariant();$registrations[$file]=@($registrations[$file])+@($name)}}}finally{if($entry){$entry.Dispose()}}
            }}
        }catch{}finally{if($uninstall){$uninstall.Dispose()};if($base){$base.Dispose()}}
    }
    $services=$null;$packageLabels=@{}
    $output=@(foreach($request in $requests){
        $groupSource='';$packageName='';$product='';$description='';$service=''
        try {
            $p=Get-Process -Id ([int]$request.pid) -ErrorAction Stop
            if($p.ProcessName -ine $request.name -or $p.StartTime.ToUniversalTime().Ticks -ne ([DateTimeOffset]::Parse($request.startedAt)).UtcDateTime.Ticks){throw 'Process identity changed'}
            $exe=$null;try{$exe=$p.Path}catch{}
            if($exe -and $exe -ieq $request.path){
                $package=$null;foreach($installed in $packages){if($exe.StartsWith($installed.Prefix,[StringComparison]::OrdinalIgnoreCase)){$package=$installed.Package;break}}
                if($package){if(-not $packageLabels.ContainsKey($package.PackageFullName)){$packageLabels[$package.PackageFullName]=Get-RovarinPackageDisplayName $package};$candidate=$packageLabels[$package.PackageFullName];if($candidate -cne $package.Name){$packageName=$candidate;$groupSource='package|'+$package.PackageFullName}}
                $registered=@($registrations[$exe.ToLowerInvariant()] | Where-Object {$_} | Select-Object -Unique)
                if(-not $packageName -and $registered.Count -eq 1){$packageName=$registered[0]}
                try {$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe);$product=$version.ProductName;$description=$version.FileDescription}catch{}
            }
            if(-not $packageName -and -not $product -and -not $description){
                if($null -eq $services){$services=@(Get-CimInstance Win32_Service -ErrorAction Stop)}
                $names=@($services|Where-Object {$_.ProcessId -eq $p.Id -and $_.DisplayName}|Select-Object -ExpandProperty DisplayName -Unique)
                if($names.Count -eq 1){$service=$names[0]}
            }
        }catch{}
        [pscustomobject]@{key=$request.key;groupSource=$groupSource;packageName=$packageName;productName=$product;fileDescription=$description;serviceName=$service}
    })
    ConvertTo-Json -InputObject $output -Compress
}catch{[Console]::Write('[]')}
