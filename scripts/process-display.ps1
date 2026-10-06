$ErrorActionPreference='Stop'
$env:PSModulePath=Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'application-display.ps1')
try {
    $text=[Console]::In.ReadToEnd();if($text.Length -gt 65536){throw 'Invalid metadata input'}
    $requests=ConvertFrom-Json -InputObject $text; $requests=@($requests);if($requests.Count -gt 50){throw 'Metadata bound exceeded'}
    $packages=@();try{$packages=@(foreach($installedPackage in Get-AppxPackage -ErrorAction Stop){$location=[string]$installedPackage.InstallLocation;if($location){[pscustomobject]@{Prefix=$location.TrimEnd('\')+'\';Package=$installedPackage}}})|Sort-Object {$_.Prefix.Length} -Descending}catch{}
    $registrations=@{}
    $dirRegistrations=@{}
    $excludedDirs=[System.Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    @('c:\','d:\','c:\program files\','c:\program files (x86)\','c:\windows\','c:\windows\system32\','c:\users\',
      ([IO.Path]::GetFullPath($env:LOCALAPPDATA).TrimEnd('\')+'\'),
      ([IO.Path]::GetFullPath($env:APPDATA).TrimEnd('\')+'\'),
      ([IO.Path]::GetFullPath($env:ProgramData).TrimEnd('\')+'\')
    ) | ForEach-Object { [void]$excludedDirs.Add($_) }

    foreach($source in @(@('CurrentUser','Registry64'),@('LocalMachine','Registry64'),@('LocalMachine','Registry32'))){
        $base=$null;$uninstall=$null
        try {
            $hive=[Microsoft.Win32.RegistryHive]([Enum]::Parse([Microsoft.Win32.RegistryHive],$source[0]));$view=[Microsoft.Win32.RegistryView]([Enum]::Parse([Microsoft.Win32.RegistryView],$source[1]))
            $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$uninstall=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall')
            if($uninstall){foreach($keyName in $uninstall.GetSubKeyNames()){
                $entry=$null
                try {
                    $entry=$uninstall.OpenSubKey($keyName)
                    if($entry){
                        $name=[string]$entry.GetValue('DisplayName','')
                        $icon=[string]$entry.GetValue('DisplayIcon','')
                        $loc=[string]$entry.GetValue('InstallLocation','')
                        if($name){
                            if($icon -match '^"?([A-Za-z]:\\.+?\.exe)"?(?:,\s*-?\d+)?$'){
                                $file=[IO.Path]::GetFullPath($matches[1]).ToLowerInvariant()
                                if(-not $registrations.ContainsKey($file)){$registrations[$file]=[System.Collections.Generic.List[string]]::new()}
                                $registrations[$file].Add($name)
                            }
                            if($loc){
                                try {
                                    $locClean=$loc.Trim('"').Trim()
                                    if($locClean.EndsWith('.exe',[StringComparison]::OrdinalIgnoreCase)){
                                        $file=[IO.Path]::GetFullPath($locClean).ToLowerInvariant()
                                        if(-not $registrations.ContainsKey($file)){$registrations[$file]=[System.Collections.Generic.List[string]]::new()}
                                        $registrations[$file].Add($name)
                                        $locClean=[IO.Path]::GetDirectoryName($locClean)
                                    }
                                    $locNorm=[IO.Path]::GetFullPath($locClean).TrimEnd('\')+'\'
                                    if(-not $excludedDirs.Contains($locNorm) -and $locNorm.Length -gt 10){
                                        $k=$locNorm.ToLowerInvariant()
                                        if(-not $dirRegistrations.ContainsKey($k)){$dirRegistrations[$k]=[System.Collections.Generic.List[string]]::new()}
                                        $dirRegistrations[$k].Add($name)
                                    }
                                }catch{}
                            }
                        }
                    }
                }finally{if($entry){$entry.Dispose()}}
            }}
        }catch{}finally{if($uninstall){$uninstall.Dispose()};if($base){$base.Dispose()}}
    }
    $servicesByPid=@{}
    $servicesByExe=@{}
    try{
        foreach($svc in Get-CimInstance Win32_Service -ErrorAction SilentlyContinue){
            if($svc.DisplayName){
                if($svc.ProcessId -gt 0){$servicesByPid[$svc.ProcessId]=$svc.DisplayName}
                if($svc.PathName -and $svc.PathName -match '^"?([A-Za-z]:\\.+?\.exe)"?'){$servicesByExe[[IO.Path]::GetFullPath($matches[1]).ToLowerInvariant()]=$svc.DisplayName}
            }
        }
    }catch{}

    $packageLabels=@{}
    $sortedPrefixes=@($dirRegistrations.Keys | Sort-Object { $_.Length } -Descending)
    $output=@(foreach($request in $requests){
        $groupSource='';$packageName='';$product='';$description='';$service=''
        try {
            $p=Get-Process -Id ([int]$request.pid) -ErrorAction Stop
            if($p.ProcessName -ine $request.name -or $p.StartTime.ToUniversalTime().Ticks -ne ([DateTimeOffset]::Parse($request.startedAt)).UtcDateTime.Ticks){throw 'Process identity changed'}
            $exe=$null;try{$exe=$p.Path}catch{}
            if(-not $exe -and $request.path -and [IO.File]::Exists($request.path)){$exe=$request.path}
            if($exe){
                $exeLower=$exe.ToLowerInvariant()
                # 1. Package display name
                foreach($installed in $packages){if($exe.StartsWith($installed.Prefix,[StringComparison]::OrdinalIgnoreCase)){
                    $package=$installed.Package
                    if(-not $packageLabels.ContainsKey($package.PackageFullName)){$packageLabels[$package.PackageFullName]=Get-RovarinPackageDisplayName $package}
                    $candidate=$packageLabels[$package.PackageFullName]
                    if($candidate -cne $package.Name){$packageName=$candidate;$groupSource='package|'+$package.PackageFullName}
                    break
                }}
                # 1b. Registered Win32 application
                if(-not $packageName){
                    if($registrations.ContainsKey($exeLower)){
                        $registered=@($registrations[$exeLower] | Where-Object {$_} | Select-Object -Unique)
                        if($registered.Count -ge 1){$packageName=$registered[0];$groupSource='app|'+$registered[0]}
                    }
                    if(-not $packageName -and $sortedPrefixes){
                        foreach($prefix in $sortedPrefixes){
                            if($exeLower.StartsWith($prefix)){
                                $matched=@($dirRegistrations[$prefix] | Where-Object {$_} | Select-Object -Unique)
                                if($matched.Count -ge 1){$packageName=$matched[0];$groupSource='app|'+$matched[0]}
                                break
                            }
                        }
                    }
                }
                # 2 & 3. FileVersionInfo
                try{$version=[Diagnostics.FileVersionInfo]::GetVersionInfo($exe);$product=$version.ProductName;$description=$version.FileDescription}catch{}
            }
            # 4. Service DisplayName
            if(-not $packageName -and -not $product -and -not $description){
                if($servicesByPid.ContainsKey($p.Id)){$service=$servicesByPid[$p.Id]}
                elseif($exe -and $servicesByExe.ContainsKey($exeLower)){$service=$servicesByExe[$exeLower]}
            }
        }catch{}
        [pscustomobject]@{key=$request.key;groupSource=$groupSource;packageName=$packageName;productName=$product;fileDescription=$description;serviceName=$service}
    })
    ConvertTo-Json -InputObject $output -Compress
}catch{[Console]::Write('[]')}
