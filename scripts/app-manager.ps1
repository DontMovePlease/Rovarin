$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'application-display.ps1')
# Only the fixed server-owned operation and locally re-resolved registration are accepted.
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app-uninstall.cs') -Raw)
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app-metadata.cs') -Raw) -ReferencedAssemblies System.Drawing
$global:cachedSizes = @{}
$global:calculatedSizes = @{}
function Get-DirectorySizeKB($dir) {
    if (-not $dir -or -not [RovarinAppMetadata]::IsSafeDirectory($dir)) { return $null }
    $norm = $dir.ToLowerInvariant().TrimEnd('\')
    try {
        $mtime = (Get-Item -LiteralPath $dir -ErrorAction Stop).LastWriteTimeUtc.Ticks
        if ($global:cachedSizes -and $global:cachedSizes.PSObject.Properties[$norm]) {
            $cached = $global:cachedSizes.$norm
            if ($cached -and $cached.mtime -eq $mtime -and $null -ne $cached.sizeKB) {
                $global:calculatedSizes[$norm] = @{ sizeKB = [double]$cached.sizeKB; mtime = $mtime }
                return [double]$cached.sizeKB
            }
        }
        $bytes = [RovarinAppMetadata]::CalculateDirectorySize($dir, 50000)
        if ($bytes -gt 0) {
            $kb = [Math]::Round($bytes / 1024)
            $global:calculatedSizes[$norm] = @{ sizeKB = $kb; mtime = $mtime }
            return $kb
        }
    } catch {}
    return $null
}
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
function Ensure-LaunchData {
    if ($null -ne $global:launchShortcuts) { return }
    $global:launchShortcuts = New-Object Collections.Generic.List[object]
    $global:shortcutNames = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $global:shortcutDirs = New-Object 'Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    try {
        $startDirs = @([Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'))
        $lnks = Get-ChildItem -LiteralPath $startDirs -Recurse -Filter '*.lnk' -ErrorAction SilentlyContinue
        $sh = New-Object -ComObject WScript.Shell
        foreach ($lnk in $lnks) {
            if ($lnk.BaseName -match '(?i)(updater?|error\s*reporter|crash|uninstall|unins|helper|release\s*notes|readme|documentation|license)') { continue }
            try {
                $sc = $sh.CreateShortcut($lnk.FullName)
                $t = $sc.TargetPath
                if ($t -and $t.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and [IO.File]::Exists($t)) {
                    $targetBase = [IO.Path]::GetFileNameWithoutExtension($t)
                    if ($targetBase -notmatch '(?i)(unins|uninstall|setup|update|updater|crash|helper|reporter)') {
                        $dir = [IO.Path]::GetDirectoryName($t).TrimEnd('\')
                        $global:shortcutNames.Add($lnk.BaseName) | Out-Null
                        $global:shortcutDirs.Add($dir) | Out-Null
                        $global:launchShortcuts.Add(@{
                            name = $lnk.BaseName
                            path = $lnk.FullName
                            exe = $t
                            dir = $dir
                        })
                    }
                }
            } catch {}
        }
    } catch {}

    $global:launchAppPaths = New-Object Collections.Generic.List[object]
    foreach ($hive in @([Microsoft.Win32.RegistryHive]::CurrentUser, [Microsoft.Win32.RegistryHive]::LocalMachine)) {
        try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey($hive, [Microsoft.Win32.RegistryView]::Registry64)
            $apKey = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\App Paths')
            if ($apKey) {
                foreach ($sub in $apKey.GetSubKeyNames()) {
                    $subKey = $apKey.OpenSubKey($sub)
                    if ($subKey) {
                        $def = [string]$subKey.GetValue('')
                        $subKey.Dispose()
                        if ($def) {
                            $cleanExe = [IO.Path]::GetFullPath($def.Trim('"', "'"))
                            if ($cleanExe.EndsWith('.exe', [StringComparison]::OrdinalIgnoreCase) -and [IO.File]::Exists($cleanExe)) {
                                $targetBase = [IO.Path]::GetFileNameWithoutExtension($cleanExe)
                                if ($targetBase -notmatch '(?i)(unins|uninstall|setup|update|updater|crash|helper|reporter)') {
                                    $global:launchAppPaths.Add(@{
                                        key = $sub
                                        name = [IO.Path]::GetFileNameWithoutExtension($sub)
                                        path = $cleanExe
                                        exe = $cleanExe
                                        dir = [IO.Path]::GetDirectoryName($cleanExe).TrimEnd('\')
                                    })
                                }
                            }
                        }
                    }
                }
                $apKey.Dispose()
            }
            $base.Dispose()
        } catch {}
    }
}
function Resolve-LaunchTarget($row) {
    Ensure-LaunchData
    $name = [string]$row.name
    $version = [string]$row.version
    $installLoc = [string]$row.installLocation
    $normLoc = if ($installLoc -and [RovarinAppMetadata]::IsSafeDirectory($installLoc)) { [IO.Path]::GetFullPath($installLoc).TrimEnd('\') } else { $null }

    # 1. Exact shortcut match
    foreach ($s in $global:launchShortcuts) {
        if ($s.name -ieq $name) {
            return @{ type = 'lnk'; path = $s.path; exe = $s.exe }
        }
    }

    # 2. Match stripped of version suffix (e.g. 'OpenCode 2.0.22' -> 'OpenCode')
    $vStripped = if ($version -and $name.EndsWith($version, [StringComparison]::OrdinalIgnoreCase)) {
        $name.Substring(0, $name.Length - $version.Length).Trim().TrimEnd('-', 'v', 'V').Trim()
    } else { $null }
    $cleanName = ($name -replace '\s+v?(?:\d+[\.\-_])*\d+.*$', '').Trim()

    if ($vStripped -and $vStripped.Length -ge 2) {
        foreach ($s in $global:launchShortcuts) {
            if ($s.name -ieq $vStripped) {
                return @{ type = 'lnk'; path = $s.path; exe = $s.exe }
            }
        }
    }
    if ($cleanName -and $cleanName.Length -ge 2 -and $cleanName -cne $name) {
        foreach ($s in $global:launchShortcuts) {
            if ($s.name -ieq $cleanName) {
                return @{ type = 'lnk'; path = $s.path; exe = $s.exe }
            }
        }
    }

    # 3. Shortcut target executable or App Path inside verified InstallLocation
    if ($normLoc) {
        foreach ($s in $global:launchShortcuts) {
            if ($s.exe.StartsWith($normLoc + '\', [StringComparison]::OrdinalIgnoreCase) -or $s.dir -ieq $normLoc) {
                return @{ type = 'lnk'; path = $s.path; exe = $s.exe }
            }
        }
        foreach ($ap in $global:launchAppPaths) {
            if ($ap.exe.StartsWith($normLoc + '\', [StringComparison]::OrdinalIgnoreCase) -or $ap.dir -ieq $normLoc) {
                return @{ type = 'exe'; path = $ap.path; exe = $ap.exe }
            }
        }
    }

    # 4. App Paths exact name match or clean name match
    foreach ($ap in $global:launchAppPaths) {
        if ($ap.name -ieq $name -or $ap.key -ieq ($name + '.exe')) {
            return @{ type = 'exe'; path = $ap.path; exe = $ap.exe }
        }
        if ($cleanName -and ($ap.name -ieq $cleanName -or $ap.key -ieq ($cleanName + '.exe'))) {
            return @{ type = 'exe'; path = $ap.path; exe = $ap.exe }
        }
    }

    # 5. Word-boundary prefix/suffix match against shortcut name (length >= 3)
    if ($name.Length -ge 3) {
        foreach ($s in $global:launchShortcuts) {
            if ($s.name.Length -ge 3) {
                if ($name -imatch ('(^|\s)' + [regex]::Escape($s.name) + '(\s|$|[0-9])') -or $s.name -imatch ('(^|\s)' + [regex]::Escape($name) + '(\s|$)')) {
                    return @{ type = 'lnk'; path = $s.path; exe = $s.exe }
                }
            }
        }
    }

    return $null
}
function Registry-Row($scope,$keyName) {
    $hive=if($scope -eq 'user'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}
    $view=if($scope -eq 'machine32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
    $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$key=$null
    try {
        $key=$root.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$keyName)
        if($null -eq $key){return $null}
        $name=$key.GetValue('DisplayName'); if($name -isnot [string] -or -not $name.Trim() -or $key.GetValue('SystemComponent',0) -eq 1 -or $key.GetValue('ParentKeyName')){return $null}
        $version=[string]$key.GetValue('DisplayVersion','');$publisher=Get-RovarinCleanPublisher ([string]$key.GetValue('Publisher',''));$uninstall=[string]$key.GetValue('UninstallString','');$quiet=[string]$key.GetValue('QuietUninstallString','')
        $location=[string]$key.GetValue('InstallLocation','');$size=$key.GetValue('EstimatedSize',$null);$date=[string]$key.GetValue('InstallDate','')
        $description=[string]$key.GetValue('Comments','');if(-not $description){$description=[string]$key.GetValue('Description','')}
        $numericSize=$null;$sizeEstimated=$false
        if($size -is [int] -or $size -is [long] -or $size -is [double]){
            if($size -gt 0 -and $size -lt 2147483648){$numericSize=[double]$size;$sizeEstimated=$false}
            elseif($size -eq 0){
                $kb = Get-DirectorySizeKB $location
                if($null -ne $kb){$numericSize=$kb;$sizeEstimated=$true}
                else{$numericSize=0;$sizeEstimated=$false}
            }
        }elseif($location){
            $kb = Get-DirectorySizeKB $location
            if($null -ne $kb){$numericSize=$kb;$sizeEstimated=$true}
        }
        $product=$null;$type='manual';$handler=$null;$batch=$false
        if($key.GetValue('WindowsInstaller',0) -eq 1 -and $keyName -match '^\{[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}$'){$product=$keyName;$type='msi';$batch=$true}
        else {$handler=Safe-Executable $uninstall;if($null -ne $handler){$type='exe';$q=Safe-Executable $quiet;if($null -ne $q -and $q.exe -ieq $handler.exe){$batch=$true;$handler.quiet=$q}}}
        $dispIcon=[string]$key.GetValue('DisplayIcon','')
        $icon=$null
        if($dispIcon){$icon=[RovarinAppMetadata]::ExtractIconBase64($dispIcon)}
        if(-not $icon -and $location){$icon=[RovarinAppMetadata]::ResolveInstallLocationIcon($location,$name)}
        if(-not $icon -and $null -ne $handler -and $handler.exe){$icon=[RovarinAppMetadata]::ExtractIconBase64($handler.exe)}
        $protected=($name -match '^(Rovarin|PC Monitor)(\s|$)' -or $keyName -match '^(Rovarin|PCMonitor)' -or $name -match '^Microsoft Windows (?:Operating|Security)')
        if($protected){$type='manual';$batch=$false;$handler=$null;$product=$null}
        if($type -eq 'exe' -and $scope -ne 'user'){
            $roots=@($env:ProgramFiles,${env:ProgramFiles(x86)},$env:SystemRoot) | Where-Object {$_}
            if(-not @($roots | Where-Object {$handler.exe.StartsWith($_.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){$type='manual';$batch=$false;$handler=$null}
        }
        $fingerprint=Fingerprint ($scope+'|'+$keyName+'|'+$name+'|'+$version+'|'+$uninstall+'|'+$quiet)
        $target = Resolve-LaunchTarget @{ name = $name; version = $version; installLocation = $location }
        $launchCapable = ($null -ne $target)
        @{locator=@{scope=$scope;key=$keyName};fingerprint=$fingerprint;name=$name.Substring(0,[Math]::Min(200,$name.Length));version=$version;publisher=$publisher;installLocation=$location;sizeKB=$numericSize;sizeEstimated=$sizeEstimated;icon=$icon;description=$description;installDate=$date;type=$type;batchCapable=$batch;elevationLikely=($scope -ne 'user');product=$product;handler=$handler;protected=$protected;launchCapable=$launchCapable}
    }finally{if($null -ne $key){$key.Dispose()};$root.Dispose()}
}
function Package-Row($package) {
    $manifest=$null;try{$manifest=Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop}catch{}
    $description=Get-RovarinPackageDescription $package $manifest
    $publisher=[string]$manifest.Package.Properties.PublisherDisplayName;if(-not $publisher -or $publisher -match '^ms-resource:'){$publisher=[string]$package.Publisher}
    $publisher=Get-RovarinCleanPublisher $publisher
    $systemComponent=[bool]($package.IsFramework -or $package.IsResourcePackage -or $package.NonRemovable)
    $safe= -not ($package.IsFramework -or $package.IsResourcePackage -or $package.NonRemovable -or $package.Name -match '^(Microsoft\.Windows|Microsoft\.AAD|Microsoft\.SecHealth|windows\.immersivecontrolpanel|MicrosoftWindows\.|Rovarin)')
    $numericSize=$null;$sizeEstimated=$false
    $loc=[string]$package.InstallLocation
    if($loc){
        $kb = Get-DirectorySizeKB $loc
        if($null -ne $kb){$numericSize=$kb;$sizeEstimated=$true}
    }
    $icon=$null
    if($manifest -and $loc){
        $relLogo=$null
        try{
            $relLogo=[string]$manifest.Package.Applications.Application.VisualElements.Square44x44Logo
            if(-not $relLogo){$relLogo=[string]$manifest.Package.Applications.Application.VisualElements.SmallLogo}
            if(-not $relLogo){$relLogo=[string]$manifest.Package.Applications.Application.VisualElements.Square150x150Logo}
            if(-not $relLogo){$relLogo=[string]$manifest.Package.Properties.Logo}
        }catch{}
        if($relLogo){
            $logoFile=[RovarinAppMetadata]::ResolveAppXLogo($loc,$relLogo)
            if($logoFile){$icon=[RovarinAppMetadata]::ExtractIconBase64($logoFile)}
        }
    }
    $launchCapable = -not ($package.IsFramework -or $package.IsResourcePackage)
    @{locator=@{scope='appx';key=$package.PackageFullName};fingerprint=(Fingerprint $package.PackageFullName);name=(Get-RovarinPackageDisplayName $package $manifest);description=$description;systemComponent=$systemComponent;version=[string]$package.Version;publisher=$publisher;installLocation='';sizeKB=$numericSize;sizeEstimated=$sizeEstimated;icon=$icon;installDate='';type='appx';batchCapable=$safe;elevationLikely=$false;protected=(-not $safe);launchCapable=$launchCapable}
}

function Launch-App($request) {
    if ($request.locator.scope -eq 'appx') {
        $package = Get-AppxPackage | Where-Object { $_.PackageFullName -ceq $request.locator.key } | Select-Object -First 1
        if ($null -eq $package) { return @{ success = $false; code = 'not-installed'; error = 'Package is not installed.' } }
        if ($package.IsFramework -or $package.IsResourcePackage) { return @{ success = $false; code = 'unavailable'; error = 'System frameworks cannot be launched.' } }
        $manifest = $null
        try { $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop } catch {}
        if ($null -eq $manifest) { return @{ success = $false; code = 'unavailable'; error = 'Package manifest unavailable.' } }
        $appId = $manifest.Package.Applications.Application.Id
        if ($appId -is [array]) { $appId = $appId[0] }
        if (-not $appId) { return @{ success = $false; code = 'unavailable'; error = 'No launchable application identity found in package.' } }
        $aumid = $package.PackageFamilyName + '!' + $appId
        try {
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = 'explorer.exe'
            $info.Arguments = "shell:AppsFolder\$aumid"
            $info.UseShellExecute = $true
            [Diagnostics.Process]::Start($info) | Out-Null
            return @{ success = $true; code = 'launched' }
        } catch {
            $code = if ($_.Exception.NativeErrorCode -eq 1223) { 'cancelled' } elseif ($_.Exception -is [UnauthorizedAccessException]) { 'access-denied' } else { 'launch-failed' }
            return @{ success = $false; code = $code; error = $_.Exception.Message }
        }
    } else {
        $row = Registry-Row $request.locator.scope $request.locator.key
        if ($null -eq $row) { return @{ success = $false; code = 'not-installed'; error = 'Application is not installed.' } }
        if ($row.fingerprint -cne $request.fingerprint) { return @{ success = $false; code = 'inventory-changed'; error = 'Application identity has changed.' } }
        $target = Resolve-LaunchTarget $row
        if ($null -eq $target) { return @{ success = $false; code = 'unavailable'; error = 'Launch target could not be confidently determined.' } }
        try {
            $info = New-Object Diagnostics.ProcessStartInfo
            $info.FileName = $target.path
            $info.UseShellExecute = $true
            if ($target.exe) { $info.WorkingDirectory = [IO.Path]::GetDirectoryName($target.exe) }
            [Diagnostics.Process]::Start($info) | Out-Null
            return @{ success = $true; code = 'launched' }
        } catch {
            $code = if ($_.Exception.NativeErrorCode -eq 1223) { 'cancelled' } elseif ($_.Exception -is [UnauthorizedAccessException]) { 'access-denied' } else { 'launch-failed' }
            return @{ success = $false; code = $code; error = $_.Exception.Message }
        }
    }
}
function Is-StartupApproved($type, $name, $hivePrefix) {
    try {
        $p = Get-ItemProperty -LiteralPath "${hivePrefix}\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\$type" -Name $name -ErrorAction Stop
        $val = $p.$name
        if ($val -is [byte[]] -and $val.Length -ge 1) { return (($val[0] -band 1) -eq 0) }
    } catch {}
    return $true
}
function Set-StartupApproved($type, $name, $enabled) {
    $keyPath = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\$type"
    if (-not (Test-Path -LiteralPath $keyPath)) { New-Item -Path $keyPath -Force | Out-Null }
    if ($enabled) {
        $bytes = [byte[]]@(2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0)
        Set-ItemProperty -LiteralPath $keyPath -Name $name -Value $bytes -Type Binary
    } else {
        $ft = [BitConverter]::GetBytes([DateTime]::UtcNow.ToFileTime())
        $bytes = [byte[]]@(3, 0, 0, 0, $ft[0], $ft[1], $ft[2], $ft[3], $ft[4], $ft[5], $ft[6], $ft[7])
        Set-ItemProperty -LiteralPath $keyPath -Name $name -Value $bytes -Type Binary
    }
}
function Startup-Inventory {
    $items = New-Object Collections.Generic.List[object]
    $sh = New-Object -ComObject WScript.Shell
    try {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
        if ($key) {
            foreach ($name in $key.GetValueNames()) {
                $cmd = [string]$key.GetValue($name)
                if (-not $cmd) { continue }
                $exe = [RovarinAppMetadata]::ExtractExecutablePath($cmd)
                $icon = if ($exe) { [RovarinAppMetadata]::ExtractIconBase64($exe) } else { $null }
                $desc = $null; $comp = $null
                if ($exe) { [RovarinAppMetadata]::GetExecutableInfo($exe, [ref]$desc, [ref]$comp) | Out-Null }
                $dispName = if ($desc) { $desc } else { $name }
                $enabled = Is-StartupApproved 'Run' $name 'HKCU:'
                $fp = Fingerprint ("registry-user|$name|$cmd")
                $items.Add(@{
                    locator = @{ source = 'registry-user'; key = $name }
                    fingerprint = $fp; name = $name; displayName = $dispName
                    publisher = [string]$comp; command = $cmd; source = 'registry-user'
                    scope = 'user'; enabled = $enabled; readOnly = $false; icon = $icon
                })
            }
            $key.Dispose()
        }
    } catch {}
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
            $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
            if ($key) {
                foreach ($name in $key.GetValueNames()) {
                    if (@($items | Where-Object { $_.locator.source -eq 'registry-machine' -and $_.name -ieq $name }).Count -gt 0) { continue }
                    $cmd = [string]$key.GetValue($name)
                    if (-not $cmd) { continue }
                    $exe = [RovarinAppMetadata]::ExtractExecutablePath($cmd)
                    $icon = if ($exe) { [RovarinAppMetadata]::ExtractIconBase64($exe) } else { $null }
                    $desc = $null; $comp = $null
                    if ($exe) { [RovarinAppMetadata]::GetExecutableInfo($exe, [ref]$desc, [ref]$comp) | Out-Null }
                    $dispName = if ($desc) { $desc } else { $name }
                    $enabled = Is-StartupApproved 'Run' $name 'HKLM:'
                    $fp = Fingerprint ("registry-machine|$name|$cmd")
                    $items.Add(@{
                        locator = @{ source = 'registry-machine'; key = $name }
                        fingerprint = $fp; name = $name; displayName = $dispName
                        publisher = [string]$comp; command = $cmd; source = 'registry-machine'
                        scope = 'machine'; enabled = $enabled; readOnly = $true; icon = $icon
                    })
                }
                $key.Dispose()
            }
            $base.Dispose()
        } catch {}
    }
    try {
        $userStartup = [Environment]::GetFolderPath('Startup')
        if ($userStartup -and (Test-Path -LiteralPath $userStartup)) {
            Get-ChildItem -LiteralPath $userStartup -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
                $file = $_; $lnkPath = $file.FullName; $targetExe = $null
                try { $sc = $sh.CreateShortcut($lnkPath); $targetExe = $sc.TargetPath } catch {}
                $icon = [RovarinAppMetadata]::ExtractIconBase64($lnkPath)
                if (-not $icon -and $targetExe) { $icon = [RovarinAppMetadata]::ExtractIconBase64($targetExe) }
                $desc = $null; $comp = $null
                if ($targetExe) { [RovarinAppMetadata]::GetExecutableInfo($targetExe, [ref]$desc, [ref]$comp) | Out-Null }
                $dispName = if ($desc) { $desc } else { $file.BaseName }
                $enabled = Is-StartupApproved 'StartupFolder' $file.Name 'HKCU:'
                $fp = Fingerprint ("folder-user|$($file.Name)|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
                $items.Add(@{
                    locator = @{ source = 'folder-user'; key = $file.Name }
                    fingerprint = $fp; name = $file.BaseName; displayName = $dispName
                    publisher = [string]$comp; command = [string]$targetExe; source = 'folder-user'
                    scope = 'user'; enabled = $enabled; readOnly = $false; icon = $icon
                })
            }
        }
    } catch {}
    try {
        $commonStartup = [Environment]::GetFolderPath('CommonStartup')
        if ($commonStartup -and (Test-Path -LiteralPath $commonStartup)) {
            Get-ChildItem -LiteralPath $commonStartup -Filter '*.lnk' -ErrorAction SilentlyContinue | ForEach-Object {
                $file = $_; $lnkPath = $file.FullName; $targetExe = $null
                try { $sc = $sh.CreateShortcut($lnkPath); $targetExe = $sc.TargetPath } catch {}
                $icon = [RovarinAppMetadata]::ExtractIconBase64($lnkPath)
                if (-not $icon -and $targetExe) { $icon = [RovarinAppMetadata]::ExtractIconBase64($targetExe) }
                $desc = $null; $comp = $null
                if ($targetExe) { [RovarinAppMetadata]::GetExecutableInfo($targetExe, [ref]$desc, [ref]$comp) | Out-Null }
                $dispName = if ($desc) { $desc } else { $file.BaseName }
                $enabled = Is-StartupApproved 'StartupFolder' $file.Name 'HKLM:'
                $fp = Fingerprint ("folder-machine|$($file.Name)|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
                $items.Add(@{
                    locator = @{ source = 'folder-machine'; key = $file.Name }
                    fingerprint = $fp; name = $file.BaseName; displayName = $dispName
                    publisher = [string]$comp; command = [string]$targetExe; source = 'folder-machine'
                    scope = 'machine'; enabled = $enabled; readOnly = $true; icon = $icon
                })
            }
        }
    } catch {}
    @{ success = $true; code = 'startup-inventory'; items = @($items.ToArray()) }
}
function Startup-Toggle($request) {
    if ($request.locator.source -notin @('registry-user', 'folder-user')) {
        return @{ success = $false; code = 'unsupported'; error = 'Only user-scoped startup entries can be toggled without administrator privileges.' }
    }
    $name = [string]$request.locator.key
    $enabled = [bool]$request.enabled
    if ($request.locator.source -eq 'registry-user') {
        $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
        if ($null -eq $key) { return @{ success = $false; code = 'not-found'; error = 'Startup registry key not accessible.' } }
        $cmd = [string]$key.GetValue($name)
        $key.Dispose()
        if ($null -eq $cmd) { return @{ success = $false; code = 'not-found'; error = 'Startup entry not found.' } }
        $fp = Fingerprint ("registry-user|$name|$cmd")
        if ($fp -cne $request.fingerprint) { return @{ success = $false; code = 'startup-changed'; error = 'Startup entry was modified externally.' } }
        Set-StartupApproved 'Run' $name $enabled
        return @{ success = $true; code = 'completed'; enabled = $enabled }
    } elseif ($request.locator.source -eq 'folder-user') {
        $userStartup = [Environment]::GetFolderPath('Startup')
        $filePath = Join-Path $userStartup $name
        if (-not (Test-Path -LiteralPath $filePath)) { return @{ success = $false; code = 'not-found'; error = 'Startup file not found.' } }
        $file = Get-Item -LiteralPath $filePath
        $fp = Fingerprint ("folder-user|$($file.Name)|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
        if ($fp -cne $request.fingerprint) { return @{ success = $false; code = 'startup-changed'; error = 'Startup file was modified externally.' } }
        Set-StartupApproved 'StartupFolder' $name $enabled
        return @{ success = $true; code = 'completed'; enabled = $enabled }
    }
    return @{ success = $false; code = 'unsupported' }
}
function Inventory {
    Ensure-LaunchData
    $rows=New-Object Collections.Generic.List[object]
    foreach($scope in @('user','machine64','machine32')){
        $hive=if($scope -eq 'user'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}
        $view=if($scope -eq 'machine32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$key=$null
        try{$key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall');if($null -ne $key){foreach($name in $key.GetSubKeyNames()){if($rows.Count -ge 2048){throw 'Inventory bound exceeded'};$row=Registry-Row $scope $name;if($null -ne $row){$rows.Add($row)}}}}finally{if($key){$key.Dispose()};$base.Dispose()}
    }
    $packagesAvailable=$null -ne (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)
    if($packagesAvailable){try{foreach($package in Get-AppxPackage -ErrorAction Stop){if($rows.Count -ge 2048){throw 'Inventory bound exceeded'};$rows.Add((Package-Row $package))}}catch{$packagesAvailable=$false}}
    @{success=$true;code='inventory';apps=@($rows.ToArray());packagesAvailable=$packagesAvailable;calculatedSizes=$global:calculatedSizes}
}
try {
    $text=[Console]::In.ReadToEnd();if($text.Length -gt 262144){throw 'Invalid input'};$request=$text | ConvertFrom-Json
    $global:cachedSizes = if ($request.cachedSizes) { $request.cachedSizes } else { @{} }
    $global:calculatedSizes = @{}
    if($request.action -eq 'inventory'){Inventory | ConvertTo-Json -Depth 8 -Compress;exit}
    if($request.action -eq 'startup-inventory'){Startup-Inventory | ConvertTo-Json -Depth 6 -Compress;exit}
    if($request.action -eq 'startup-toggle'){Startup-Toggle $request | ConvertTo-Json -Compress;exit}
    if($request.action -eq 'launch'){Launch-App $request | ConvertTo-Json -Compress;exit}
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
