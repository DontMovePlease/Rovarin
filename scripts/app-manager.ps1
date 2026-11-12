$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
. (Join-Path $PSScriptRoot 'application-display.ps1')
. (Join-Path $PSScriptRoot 'startup-tasks.ps1')
# Only the fixed server-owned operation and locally re-resolved registration are accepted.
$nativeSources=@('app-uninstall.cs','app-metadata.cs','startup-elevated.cs') | ForEach-Object { [IO.File]::ReadAllText((Join-Path $PSScriptRoot $_)) }
$imports=@([regex]::Matches(($nativeSources -join "
"),'(?m)^using [^;]+;') | ForEach-Object { $_.Value } | Select-Object -Unique)
$nativeBodies=$nativeSources | ForEach-Object { [regex]::Replace($_,'(?m)^using [^;]+;','') }
$nativeCode=(($imports -join "`n")+"`n"+($nativeBodies -join "`n"))
# Executable cache files are never a trust input. Compile only the bundled source
# in this fresh helper process; retain normal inventory/icon/size caches elsewhere.
# In particular, do not probe, load, clean or call methods from old native-*.dll files.
if (-not ('RovarinAppMetadata' -as [type])) {
    Add-Type -TypeDefinition $nativeCode -ReferencedAssemblies System.Drawing,System.Management,System.Web.Extensions,Microsoft.CSharp,System.Core,System.Xml -ErrorAction Stop
}
$global:cachedSizes = @{}
$global:cachedFingerprints = @{}
$global:calculatedSizes = @{}
$global:sizeBudget = [Diagnostics.Stopwatch]::StartNew()
$global:packageStartup = New-Object Collections.Generic.List[object]
# Private, bounded evidence for Store removals. No PINs, sessions, command
# lines or raw Windows messages are retained. The client cannot choose a log path.
$script:appxDiagnosticStream = $null
function Start-AppxDiagnostic($request) {
    if ($request.action -ne 'uninstall' -or $request.locator.scope -ne 'appx') { return }
    $directory = Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'Rovarin\Diagnostics'
    for ($cursor=$directory; $cursor; $cursor=[IO.Path]::GetDirectoryName($cursor)) {
        if ([IO.Directory]::Exists($cursor) -and (([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Unsafe diagnostics ancestor' }
    }
    [IO.Directory]::CreateDirectory($directory) | Out-Null
    if (-not [RovarinAppMetadata]::IsSafeDirectory($directory)) { throw 'Unsafe diagnostics directory' }
    # At most 64 closed operation logs (32 KiB each). Never follow a redirected
    # file or delete another writer's active, non-delete-shared log.
    $old=@(Get-ChildItem -LiteralPath $directory -Filter 'appx-uninstall-*.jsonl' -File |
        Where-Object {$_.Name -cmatch '^appx-uninstall-[a-f0-9]{32}\.jsonl$' -and ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0} |
        Sort-Object LastWriteTimeUtc -Descending | Select-Object -Skip 63)
    foreach ($log in $old) {
        try { [IO.File]::Delete($log.FullName) }
        catch [IO.IOException] { } # Another owned helper may still hold it open.
    }
    # CreateNew and a held, non-write-shared stream prevent redirected log-file writes.
    $file = Join-Path $directory ('appx-uninstall-'+[Guid]::NewGuid().ToString('N')+'.jsonl')
    $script:appxDiagnosticStream = [IO.File]::Open($file,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::Read)
    Write-AppxDiagnostic 'request' @{package=[string]$request.locator.key;ownerSid=[string]$request.ownerSid;account=[Security.Principal.WindowsIdentity]::GetCurrent().Name;executionSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;pid=$PID}
}
function Write-AppxDiagnostic([string]$stage,$details) {
    if (-not $script:appxDiagnosticStream) { return }
    if ($script:appxDiagnosticStream.Length -ge 32768) { throw 'Diagnostics bound exceeded' }
    $line=@{time=[DateTime]::UtcNow.ToString('o');stage=$stage;details=$details} | ConvertTo-Json -Depth 5 -Compress
    $bytes=[Text.Encoding]::UTF8.GetBytes($line+"`n")
    $script:appxDiagnosticStream.Write($bytes,0,$bytes.Length)
    $script:appxDiagnosticStream.Flush()
}
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
        # Unknown is preferable to blocking inventory or publishing a partial size.
        if ($global:sizeBudget.ElapsedMilliseconds -gt 1500) { return $null }
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
    if ($base -match '^(cmd|powershell|pwsh|mshta|wscript|cscript|rundll32|regsvr32|reg|schtasks|wmic|node|pythonw?(?:\d[\d.]*)?|ruby|perl|javaw?s?|msiexec|rovarin|pcmonitor)$') { return $null }
    $current=Get-Item -LiteralPath $exe
    if($current -is [IO.FileInfo]){if(($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){return $null};$current=$current.Directory}
    while($null -ne $current){if(($current.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0){return $null};$current=$current.Parent}
    @{exe=[IO.Path]::GetFullPath($exe);args=@($args | Select-Object -Skip 1)}
}
function Fingerprint($value) {
    $sha=[Security.Cryptography.SHA256]::Create()
    try { ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($value)))).Replace('-','').ToLowerInvariant() } finally { $sha.Dispose() }
}
function Test-RegistryEntryPresent($scope,$keyName) {
    $hive=if($scope -eq 'user'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}
    $view=if($scope -eq 'machine32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
    $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$key=$null
    try {
        $key=$root.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$keyName)
        if($null -eq $key){return $false}
        $name=$key.GetValue('DisplayName')
        if($name -isnot [string] -or -not $name.Trim() -or $key.GetValue('SystemComponent',0) -eq 1 -or $key.GetValue('ParentKeyName')){return $false}
        return $true
    }finally{if($null -ne $key){$key.Dispose()};$root.Dispose()}
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
function Registry-Row($scope,$keyName,[bool]$allowUnchanged=$false) {
    $hive=if($scope -eq 'user'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}
    $view=if($scope -eq 'machine32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
    $root=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$key=$null
    try {
        $key=$root.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall\'+$keyName)
        if($null -eq $key){return $null}
        $name=$key.GetValue('DisplayName'); if($name -isnot [string] -or -not $name.Trim() -or $key.GetValue('SystemComponent',0) -eq 1 -or $key.GetValue('ParentKeyName')){return $null}
        $version=[string]$key.GetValue('DisplayVersion','');$uninstall=[string]$key.GetValue('UninstallString','');$quiet=[string]$key.GetValue('QuietUninstallString','')
        $fingerprint=Fingerprint ($scope+'|'+$keyName+'|'+$name+'|'+$version+'|'+$uninstall+'|'+$quiet)
        if ($allowUnchanged -and $global:cachedFingerprints) {
            $locId = "$scope|$keyName"
            $cachedFp = if ($global:cachedFingerprints -is [Collections.IDictionary]) { $global:cachedFingerprints[$locId] } else { $global:cachedFingerprints.PSObject.Properties[$locId].Value }
            if ($cachedFp -and $cachedFp -ceq $fingerprint) {
                return @{ unchanged = $true; locator = @{ scope = $scope; key = $keyName }; fingerprint = $fingerprint }
            }
        }
        $publisher=Get-RovarinCleanPublisher ([string]$key.GetValue('Publisher',''))
        $location=[string]$key.GetValue('InstallLocation','');$size=$key.GetValue('EstimatedSize',$null);$date=[string]$key.GetValue('InstallDate','')
        $description=[string]$key.GetValue('Comments','');if(-not $description){$description=[string]$key.GetValue('Description','')}
        $numericSize=$null;$sizeEstimated=$false
        if($size -is [int] -or $size -is [long] -or $size -is [double]){
            if($size -gt 0 -and $size -lt 2147483648){$numericSize=[double]$size;$sizeEstimated=$true}
            elseif($size -eq 0){
                $kb = Get-DirectorySizeKB $location
                if($null -ne $kb){$numericSize=$kb;$sizeEstimated=$true}
                else{$numericSize=$null;$sizeEstimated=$false}
            }
        }elseif($location){
            $kb = Get-DirectorySizeKB $location
            if($null -ne $kb){$numericSize=$kb;$sizeEstimated=$true}
        }
        $manualReason=$null
        $product=$null;$type='manual';$handler=$null;$batch=$false
        if($key.GetValue('WindowsInstaller',0) -eq 1 -and $keyName -match '^\{[0-9A-Fa-f]{8}(-[0-9A-Fa-f]{4}){3}-[0-9A-Fa-f]{12}\}$'){$product=$keyName;$type='msi';$batch=$true}
        else {
            $handler=Safe-Executable $uninstall
            if($null -ne $handler){
                $type='exe'
                $q=Safe-Executable $quiet
                if($null -ne $q -and $q.exe -ieq $handler.exe){$batch=$true;$handler.quiet=$q}
            } else {
                if (-not $uninstall) { $manualReason = 'no-uninstall-string' }
                elseif ($uninstall -match '[&|<>`;$%!\r\n]') { $manualReason = 'unsupported-syntax' }
                else { $manualReason = 'missing-executable' }
            }
        }
        $dispIcon=[string]$key.GetValue('DisplayIcon','')
        $icon=$null
        if($dispIcon){$icon=[RovarinAppMetadata]::ExtractIconBase64($dispIcon)}
        if(-not $icon -and $location){$icon=[RovarinAppMetadata]::ResolveInstallLocationIcon($location,$name)}
        if(-not $icon -and $null -ne $handler -and $handler.exe){$icon=[RovarinAppMetadata]::ExtractIconBase64($handler.exe)}
        $protected=($name -match '^(Rovarin|PC Monitor|Tailscale)(\s|$)' -or $keyName -match '^(Rovarin|PCMonitor|Tailscale)' -or $name -match '^Microsoft Windows (?:Operating|Security)')
        if($protected){$type='manual';$batch=$false;$handler=$null;$product=$null;$manualReason='protected-application'}
        if($type -eq 'exe' -and $scope -ne 'user'){
            $roots=New-Object Collections.Generic.List[string]
            foreach($r in @($env:ProgramFiles,${env:ProgramFiles(x86)},$env:SystemRoot,$env:ProgramData)){if($r){$roots.Add($r)}}
            if($location){
                try {
                    $cleanLoc=[IO.Path]::GetFullPath($location.Trim().Trim('"',"'")).TrimEnd('\')
                    $userProf=if($env:USERPROFILE){[IO.Path]::GetFullPath($env:USERPROFILE).TrimEnd('\')+'\'}else{$null}
                    if($cleanLoc.Length -gt 3 -and [RovarinAppMetadata]::IsSafeDirectory($cleanLoc) -and (-not $userProf -or -not $cleanLoc.StartsWith($userProf,[StringComparison]::OrdinalIgnoreCase))){
                        $roots.Add($cleanLoc)
                    }
                } catch {}
            }
            if(-not @($roots | Where-Object {$handler.exe.StartsWith($_.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)}).Count){$type='manual';$batch=$false;$handler=$null;$manualReason='outside-system-roots'}
        }
        $target = Resolve-LaunchTarget @{ name = $name; version = $version; installLocation = $location }
        $launchCapable = ($null -ne $target)
        $cleanupVerified=$false;$cleanupAliases=@()
        if($target -and $target.exe -and $location -and $target.exe.StartsWith($location.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)) {
            try {$meta=[Diagnostics.FileVersionInfo]::GetVersionInfo($target.exe);$n=($name -replace '[\s._()-]','').ToLowerInvariant();$pn=($meta.ProductName -replace '[\s._()-]','').ToLowerInvariant();$pc=($publisher -replace '[\s._()-]','').ToLowerInvariant();$mc=($meta.CompanyName -replace '[\s._()-]','').ToLowerInvariant();if($n -and $pn -eq $n -and $pc -and $pc -eq $mc){$cleanupVerified=$true;$cleanupAliases=@($meta.ProductName,[IO.Path]::GetFileNameWithoutExtension($target.exe))}}catch{}
        }

        @{locator=@{scope=$scope;key=$keyName};fingerprint=$fingerprint;name=$name.Substring(0,[Math]::Min(200,$name.Length));version=$version;publisher=$publisher;installLocation=$location;sizeKB=$numericSize;sizeEstimated=$sizeEstimated;icon=$icon;description=$description;installDate=$date;type=$type;batchCapable=$batch;elevationLikely=($scope -ne 'user');product=$product;handler=$handler;protected=$protected;manualReason=$manualReason;launchCapable=$launchCapable;cleanupVerified=$cleanupVerified;cleanupAliases=$cleanupAliases}
    }finally{if($null -ne $key){$key.Dispose()};$root.Dispose()}
}
function Collect-PackageStartup($package,$manifest,$pkgIcon=$null) {
    $pkgDisp=Get-RovarinPackageDisplayName $package $manifest
    $pkgPub=Get-RovarinCleanPublisher ([string]$manifest.Package.Properties.PublisherDisplayName)
    if(-not $pkgPub){$pkgPub=Get-RovarinCleanPublisher ([string]$package.Publisher)}
    if(Test-IsOpaqueIdentifier $pkgPub){$pkgPub=''}
    $allTasks=@($manifest.SelectNodes("//*[local-name()='Extension' and @Category='windows.startupTask']//*[local-name()='StartupTask']"))
    foreach ($task in $allTasks) {
        $taskId=[string]$task.TaskId
        if (-not $taskId) { continue }
        $key=[string]$package.PackageFamilyName+'|'+$taskId
        $enabled=$null;$policyControlled=$false
        try {
            $statePath="HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\$([string]$package.PackageFamilyName)\$taskId"
            $stProp=Get-ItemProperty -LiteralPath $statePath -Name 'State' -ErrorAction Stop
            if ($null -ne $stProp.State) {
                $stVal=[int]$stProp.State
                $policyControlled=$stVal -in @(3,4)
                if ($stVal -in @(2,4)) { $enabled=$true }
                elseif ($stVal -in @(0,1,3)) { $enabled=$false }
            }
        } catch {}
        $taskDisp=[string]$task.DisplayName
        if($taskDisp -match '^ms-resource:' -and ('RovarinDisplayResources' -as [type])){
            $resource=$taskDisp
            if($resource -notmatch '^ms-resource://'){$resource='ms-resource://'+$package.Name+'/resources/'+($resource -replace '^ms-resource:(/*)','')}
            $resolved=[RovarinDisplayResources]::Resolve('@{'+$package.PackageFullName+'?'+$resource+'}')
            if($resolved -and -not(Test-IsOpaqueIdentifier $resolved)){$taskDisp=$resolved}
        }
        $disp=$pkgDisp
        if ($allTasks.Count -gt 1) {
            if ($taskDisp -and $taskDisp -notmatch '^ms-resource:') { $disp=$taskDisp }
            elseif ($taskId -ine $pkgDisp) { $disp="$pkgDisp ($taskId)" }
        }
        $exeAttr=[string]$task.ParentNode.GetAttribute('Executable')
        $global:packageStartup.Add(@{locator=@{source='packaged-startup';key=$key};fingerprint=(Fingerprint $key);name=$taskId;displayName=$disp;publisher=$pkgPub;command=$exeAttr;source='packaged-startup';scope='user';enabled=$enabled;readOnly=$true;policyControlled=$policyControlled;icon=$pkgIcon;method='Packaged app startup'})
    }
}
function Package-Row($package, [bool]$identityOnly=$false, [bool]$allowUnchanged=$false) {
    $safe= -not ($package.IsFramework -or $package.IsResourcePackage -or $package.NonRemovable -or $package.Name -match '^(Microsoft\.Windows|Microsoft\.AAD|Microsoft\.SecHealth|windows\.immersivecontrolpanel|MicrosoftWindows\.|Rovarin)')
    $ownerSid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $fp=Fingerprint $package.PackageFullName
    # Uninstall authorization does not need icons, resource strings or directory-size traversal.
    if($identityOnly){return @{fingerprint=$fp;protected=(-not $safe);type='appx';batchCapable=$safe;ownerSid=$ownerSid}}
    if ($allowUnchanged -and $global:cachedFingerprints) {
        $locId = 'appx|' + [string]$package.PackageFullName
        $cachedFp = if ($global:cachedFingerprints -is [Collections.IDictionary]) { $global:cachedFingerprints[$locId] } else { $global:cachedFingerprints.PSObject.Properties[$locId].Value }
        if ($cachedFp -and $cachedFp -ceq $fp) {
            return @{ unchanged = $true; locator = @{ scope = 'appx'; key = [string]$package.PackageFullName }; fingerprint = $fp }
        }
    }
    $systemComponent=[bool]($package.IsFramework -or $package.IsResourcePackage -or $package.NonRemovable)
    if ($package.IsFramework -or $package.IsResourcePackage) {
        return @{locator=@{scope='appx';key=$package.PackageFullName};cleanupPackageFamily=[string]$package.PackageFamilyName;ownerSid=$ownerSid;fingerprint=$fp;name=[string]$package.Name;description='';systemComponent=$true;version=[string]$package.Version;publisher=(Get-RovarinCleanPublisher ([string]$package.Publisher));installLocation='';sizeKB=$null;sizeEstimated=$false;icon=$null;installDate='';type='appx';batchCapable=$false;elevationLikely=$false;protected=$true;launchCapable=$false}
    }

    $manifest=$null;try{$manifest=Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop}catch{}
    $description=Get-RovarinPackageDescription $package $manifest
    $publisher=if($manifest){[string]$manifest.Package.Properties.PublisherDisplayName}else{''}
    if(-not $publisher -or $publisher -match '^ms-resource:'){$publisher=[string]$package.Publisher}
    $publisher=Get-RovarinCleanPublisher $publisher
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
    if($manifest){Collect-PackageStartup $package $manifest $icon}
    $launchCapable = -not ($package.IsFramework -or $package.IsResourcePackage)
    @{locator=@{scope='appx';key=$package.PackageFullName};cleanupPackageFamily=[string]$package.PackageFamilyName;ownerSid=$ownerSid;fingerprint=$fp;name=(Get-RovarinPackageDisplayName $package $manifest);description=$description;systemComponent=$systemComponent;version=[string]$package.Version;publisher=$publisher;installLocation='';sizeKB=$numericSize;sizeEstimated=$sizeEstimated;icon=$icon;installDate='';type='appx';batchCapable=$safe;elevationLikely=$false;protected=(-not $safe);launchCapable=$launchCapable}
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
        if ($val -is [byte[]] -and $val.Length -ge 12) {
            if ($val[0] -in @(2,6)) { return $true }
            if ($val[0] -in @(3,7)) { return $false }
            return $null
        }
        return $null
    } catch {
        # Missing approval means Windows' default enabled state. Access failures
        # and malformed data do not establish that state.
        if($_.FullyQualifiedErrorId -in @('PathNotFound,Microsoft.PowerShell.Commands.GetItemPropertyCommand','System.Management.Automation.PSArgumentException,Microsoft.PowerShell.Commands.GetItemPropertyCommand')){return $true}
        return $null
    }
}
function Set-StartupApproved($type, $name, $enabled) {
    if($type -notin @('Run','Run32','StartupFolder')){throw 'Unsupported startup approval source'}
    if($null -eq (Is-StartupApproved $type $name 'HKCU:')){throw 'Windows startup approval state is unavailable'}
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
    $actual=(Get-ItemProperty -LiteralPath $keyPath -Name $name -ErrorAction Stop).$name
    if($actual -isnot [byte[]] -or ($actual -join ',') -cne ($bytes -join ',')){throw 'Windows did not confirm startup approval'}
}
function Startup-Inventory {
    $warnings = New-Object Collections.Generic.List[string]
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
                    method = 'User registry Run'
                })
            }
            $key.Dispose()
        }
    } catch {}
    # Some user software registers in the 32-bit view. Shared identical values dedupe,
    # while differing registrations remain distinct, read-only identities.
    try {
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,[Microsoft.Win32.RegistryView]::Registry32)
        $key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
        if ($key) {
            foreach ($name in $key.GetValueNames()) {
                $cmd=[string]$key.GetValue($name)
                if (-not $cmd -or @($items | Where-Object {$_.source -eq 'registry-user' -and $_.name -ceq $name -and $_.command -ceq $cmd}).Count) { continue }
                $exe=[RovarinAppMetadata]::ExtractExecutablePath($cmd); $desc=$null; $comp=$null
                $icon = if ($exe) { [RovarinAppMetadata]::ExtractIconBase64($exe) } else { $null }
                if ($exe) { [RovarinAppMetadata]::GetExecutableInfo($exe,[ref]$desc,[ref]$comp) | Out-Null }
                $items.Add(@{locator=@{source='registry-user32';key=$name};fingerprint=(Fingerprint ("registry-user32|$name|$cmd"));name=$name;displayName=$(if($desc){$desc}else{$name});publisher=[string]$comp;command=$cmd;source='registry-user32';scope='user';enabled=(Is-StartupApproved 'Run32' $name 'HKCU:');readOnly=$false;icon=$icon;method='User registry Run (32-bit)'})
            }
            $key.Dispose()
        }
        $base.Dispose()
    } catch { $warnings.Add('user-run32-unavailable') }
    foreach ($view in @([Microsoft.Win32.RegistryView]::Registry64, [Microsoft.Win32.RegistryView]::Registry32)) {
        try {
            $base = [Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::LocalMachine, $view)
            $key = $base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')
            if ($key) {
                foreach ($name in $key.GetValueNames()) {
                    $source = if ($view -eq [Microsoft.Win32.RegistryView]::Registry32) { 'registry-machine32' } else { 'registry-machine' }
                    $cmd = [string]$key.GetValue($name)
                    if (-not $cmd) { continue }
                    $exe = [RovarinAppMetadata]::ExtractExecutablePath($cmd)
                    $icon = if ($exe) { [RovarinAppMetadata]::ExtractIconBase64($exe) } else { $null }
                    $desc = $null; $comp = $null
                    if ($exe) { [RovarinAppMetadata]::GetExecutableInfo($exe, [ref]$desc, [ref]$comp) | Out-Null }
                    $dispName = if ($desc) { $desc } else { $name }
                    $approvedType = if ($view -eq [Microsoft.Win32.RegistryView]::Registry32) { 'Run32' } else { 'Run' }
                    $enabled = Is-StartupApproved $approvedType $name 'HKLM:'
                    $fp = Fingerprint ("$source|$name|$cmd")
                    $items.Add(@{
                        locator = @{ source = $source; key = $name }
                        fingerprint = $fp; name = $name; displayName = $dispName
                        publisher = [string]$comp; command = $cmd; source = $source
                        scope = 'machine'; enabled = $enabled; readOnly = $true; icon = $icon
                        method = $(if ($view -eq [Microsoft.Win32.RegistryView]::Registry32) { 'Machine registry Run (32-bit)' } else { 'Machine registry Run' })
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
            Get-ChildItem -LiteralPath $userStartup -File -ErrorAction SilentlyContinue | ForEach-Object {
                $file = $_; if ($file.Name -ieq 'desktop.ini') { return }; $lnkPath = $file.FullName; $targetExe = $null
                try { $sc = $sh.CreateShortcut($lnkPath); $targetExe = $sc.TargetPath } catch {}
                $icon = [RovarinAppMetadata]::ExtractIconBase64($lnkPath)
                if (-not $icon -and $targetExe) { $icon = [RovarinAppMetadata]::ExtractIconBase64($targetExe) }
                $desc = $null; $comp = $null
                if ($targetExe) { [RovarinAppMetadata]::GetExecutableInfo($targetExe, [ref]$desc, [ref]$comp) | Out-Null }
                $dispName = $file.BaseName # The shortcut names its startup purpose; the target may be a generic host.
                $enabled = Is-StartupApproved 'StartupFolder' $file.Name 'HKCU:'
                $fp = Fingerprint ("folder-user|$($file.Name)|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
                $items.Add(@{
                    locator = @{ source = 'folder-user'; key = $file.Name }
                    fingerprint = $fp; name = $file.BaseName; displayName = $dispName
                    publisher = [string]$comp; command = [string]$targetExe; source = 'folder-user'
                    scope = 'user'; enabled = $enabled; readOnly = ($file.Extension -ine '.lnk'); icon = $icon
                    method = 'User Startup folder'
                })
            }
        }
    } catch {}
    try {
        $commonStartup = [Environment]::GetFolderPath('CommonStartup')
        if ($commonStartup -and (Test-Path -LiteralPath $commonStartup)) {
            Get-ChildItem -LiteralPath $commonStartup -File -ErrorAction SilentlyContinue | ForEach-Object {
                $file = $_; if ($file.Name -ieq 'desktop.ini') { return }; $lnkPath = $file.FullName; $targetExe = $null
                try { $sc = $sh.CreateShortcut($lnkPath); $targetExe = $sc.TargetPath } catch {}
                $icon = [RovarinAppMetadata]::ExtractIconBase64($lnkPath)
                if (-not $icon -and $targetExe) { $icon = [RovarinAppMetadata]::ExtractIconBase64($targetExe) }
                $desc = $null; $comp = $null
                if ($targetExe) { [RovarinAppMetadata]::GetExecutableInfo($targetExe, [ref]$desc, [ref]$comp) | Out-Null }
                $dispName = $file.BaseName # The shortcut names its startup purpose; the target may be a generic host.
                $enabled = Is-StartupApproved 'StartupFolder' $file.Name 'HKLM:'
                $fp = Fingerprint ("folder-machine|$($file.Name)|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
                $items.Add(@{
                    locator = @{ source = 'folder-machine'; key = $file.Name }
                    fingerprint = $fp; name = $file.BaseName; displayName = $dispName
                    publisher = [string]$comp; command = [string]$targetExe; source = 'folder-machine'
                    scope = 'machine'; enabled = $enabled; readOnly = $true; icon = $icon
                    method = 'Common Startup folder'
                })
            }
        }
    } catch {}
    # Reuse the exact native policy that the one-shot administrator worker
    # independently repeats. Never advertise a protected/unknown target as writable.
    foreach($entry in $items){
        if($entry.source -in @('registry-machine','registry-machine32','folder-machine')){
            $policy=[RovarinStartupApproval]::Inspect([string]$entry.source,[string]$entry.locator.key)|ConvertFrom-Json
            $entry.readOnly=-not $policy.manageable;$entry.requiresElevation=[bool]$policy.requiresElevation;$entry.blockedReason=[string]$policy.reason
            if($policy.manageable){$entry.enabled=[bool]$policy.enabled}
        }
    }
    # Optional providers fail independently from normal Run/folder entries.
    $watch = [Diagnostics.Stopwatch]::StartNew()
    try {
        $scheduler = New-Object -ComObject Schedule.Service
        $scheduler.Connect()
        $folders = New-Object 'Collections.Generic.Queue[object]'
        $folders.Enqueue($scheduler.GetFolder('\'))
        $visited = 0
        while ($folders.Count -gt 0) {
            if ($watch.ElapsedMilliseconds -gt 3000 -or $visited -ge 2000) { $warnings.Add('scheduled-tasks-incomplete'); break }
            $folder = $folders.Dequeue()
            try { $tasks = $folder.GetTasks(1) } catch { $warnings.Add('scheduled-tasks-incomplete'); continue }
            foreach ($task in $tasks) {
                try {
                $visited++
                if ($watch.ElapsedMilliseconds -gt 3000 -or $visited -gt 2000) { break }
                $definition = $task.Definition
                $startupTriggers = @($definition.Triggers | Where-Object { $_.Type -in @(8,9) })
                $actions = @($definition.Actions | Where-Object { $_.Type -eq 0 })
                if (-not $startupTriggers.Count -or -not $actions.Count) { continue }
                $taskKey = [string]$task.Path
                $fp = Fingerprint ($taskKey+'|'+[string]$task.Xml)
                $rawActionPath = [Environment]::ExpandEnvironmentVariables([string]$actions[0].Path).Trim().Trim('"', "'")
                $exe = [RovarinAppMetadata]::ExtractExecutablePath($rawActionPath)
                if (-not $exe) { $exe = $rawActionPath }
                $desc=$null; $comp=$null; $taskIcon=$null
                try {
                    if ($exe -and [IO.Path]::IsPathRooted($exe)) {
                        [RovarinAppMetadata]::GetExecutableInfo($exe,[ref]$desc,[ref]$comp) | Out-Null
                        $taskIcon = [RovarinAppMetadata]::ExtractIconBase64($exe)
                    }
                } catch {}
                $policy=Get-StartupTaskPolicy $task
                $taskScope='machine'
                try{
                    $principalUser=[string]$definition.Principal.UserId
                    if($principalUser -and $principalUser -notmatch '^S-1-'){$principalUser=([Security.Principal.NTAccount]::new($principalUser)).Translate([Security.Principal.SecurityIdentifier]).Value}
                    if($definition.Principal.LogonType -eq 3 -and $principalUser -eq [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){$taskScope='user'}
                }catch{}
                if(-not $policy.manageable){
                    $native=[RovarinStartupApproval]::Inspect('scheduled-task',$taskKey)|ConvertFrom-Json
                    $policy=@{manageable=[bool]$native.manageable;requiresElevation=[bool]$native.requiresElevation;scope=[string]$native.scope;reason=[string]$native.reason;canRestore=$false}
                }
                $items.Add(@{ locator=@{source='scheduled-task';key=$taskKey}; fingerprint=$fp; name=[string]$task.Name; displayName=([string]$task.Name); publisher=[string]$comp; command=$exe; source='scheduled-task'; scope=$(if($policy.scope){$policy.scope}else{$taskScope}); enabled=[bool]$task.Enabled; readOnly=(-not $policy.manageable); requiresElevation=[bool]$policy.requiresElevation; taskManageable=$policy.manageable; canRestore=$policy.canRestore; blockedReason=$policy.reason; icon=$taskIcon; method= $(if (@($startupTriggers | Where-Object {$_.Type -eq 9}).Count) {'Scheduled task at sign-in'} else {'Scheduled task at boot'}) })
                } catch { $warnings.Add('scheduled-tasks-incomplete') }
            }
            try { $children = $folder.GetFolders(0) } catch { $warnings.Add('scheduled-tasks-incomplete'); continue }
            foreach ($sub in $children) {
                # Windows servicing/system tasks are not consumer startup apps.
                if (-not ([string]$sub.Path).StartsWith('\Microsoft',[StringComparison]::OrdinalIgnoreCase)) { $folders.Enqueue($sub) }
            }
        }
    } catch { $warnings.Add('scheduled-tasks-unavailable') }
    if ($null -ne $request.packageStartup) {
        foreach ($entry in $request.packageStartup) {
            if ($entry -is [Collections.IDictionary] -or $entry.PSObject.Properties['locator']) {
                try {
                    $keyParts = ([string]$entry.locator.key) -split '\|', 2
                    $entry.enabled=$null
                    if($entry -is [Collections.IDictionary]){$entry.policyControlled=$false}else{$entry|Add-Member -NotePropertyName policyControlled -NotePropertyValue $false -Force}
                    if ($keyParts.Count -eq 2) {
                        $statePath = "HKCU:\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\SystemAppData\$($keyParts[0])\$($keyParts[1])"
                        $stProp = Get-ItemProperty -LiteralPath $statePath -Name 'State' -ErrorAction Stop
                        if ($null -ne $stProp.State) {
                            $stVal = [int]$stProp.State
                            $entry.policyControlled=$stVal -in @(3,4)
                            $en = if ($stVal -in @(2,4)) { $true } elseif ($stVal -in @(0,1,3)) { $false } else { $null }
                            if ($entry -is [Collections.IDictionary]) { $entry.enabled = $en } else { $entry | Add-Member -NotePropertyName enabled -NotePropertyValue $en -Force }
                        }
                    }
                } catch {}
            }
            $items.Add($entry)
        }
    } else {
        try {
            $watch.Restart()
            foreach ($package in Get-AppxPackage -ErrorAction Stop) {
                if ($watch.ElapsedMilliseconds -gt 4000) { $warnings.Add('packaged-startup-incomplete'); break }
                if ($package.IsFramework -or $package.IsResourcePackage) { continue }
                $manifest = $null
                try { $manifest = Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop } catch {}
                if ($manifest) {
                    $pkgIcon = $null
                    $loc = [string]$package.InstallLocation
                    if ($loc) {
                        try {
                            $relLogo = [string]$manifest.Package.Applications.Application.VisualElements.Square44x44Logo
                            if (-not $relLogo) { $relLogo = [string]$manifest.Package.Applications.Application.VisualElements.SmallLogo }
                            if (-not $relLogo) { $relLogo = [string]$manifest.Package.Applications.Application.VisualElements.Square150x150Logo }
                            if (-not $relLogo) { $relLogo = [string]$manifest.Package.Properties.Logo }
                            if ($relLogo) {
                                $logoFile = [RovarinAppMetadata]::ResolveAppXLogo($loc, $relLogo)
                                if ($logoFile) { $pkgIcon = [RovarinAppMetadata]::ExtractIconBase64($logoFile) }
                            }
                        } catch {}
                    }
                    Collect-PackageStartup $package $manifest $pkgIcon
                }
            }
            foreach ($entry in $global:packageStartup) { $items.Add($entry) }
        } catch { $warnings.Add('packaged-startup-unavailable') }
    }
    # App-associated services are a distinct, read-only source, not startup toggles.
    # Match the locally registered installation directory, never a vendor-specific name.
    if ($request.appLocations) {
        try {
            $watch.Restart()
            $locations=@($request.appLocations | Where-Object { [string]$_.location -and [RovarinAppMetadata]::IsSafeDirectory([string]$_.location) })
            $services=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\CurrentControlSet\Services')
            try {
                foreach ($serviceName in $services.GetSubKeyNames()) {
                    if ($watch.ElapsedMilliseconds -gt 1500) { $warnings.Add('app-services-incomplete'); break }
                    $key=$services.OpenSubKey($serviceName)
                    if (-not $key) { continue }
                    try {
                        $type=$key.GetValue('Type',0)
                        if (($type -band 0x30) -eq 0) { continue } # Exclude drivers.
                        $image=[Environment]::ExpandEnvironmentVariables([string]$key.GetValue('ImagePath',''))
                        $exe=[RovarinAppMetadata]::ExtractExecutablePath($image)
                        if (-not $exe) { continue }
                        $app=$locations | Where-Object {
                            $location=[string]$_.location
                            $location.Length -gt 3 -and $exe.StartsWith($location.TrimEnd('\')+'\',[StringComparison]::OrdinalIgnoreCase)
                        } | Sort-Object { ([string]$_.location).Length } -Descending | Select-Object -First 1
                        $serviceDisplay=[string]$key.GetValue('DisplayName',$serviceName)
                        if (-not $app) {
                            # Exact Windows display-name association is presentation only. Keep the
                            # service's own name visible when its path differs from the installed app.
                            $app=$request.appLocations | Where-Object {
                                $serviceDisplay -ieq ([string]$_.name+' Service') -or $serviceDisplay -ieq [string]$_.name
                            } | Select-Object -First 1
                        }
                        if (-not $app) { continue }
                        $mode=$key.GetValue('Start',3)
                        $enabled=if($mode -eq 2){$true}elseif($mode -eq 4){$false}else{$null}
                        $method=if($mode -eq 2){'Automatic background service'}elseif($mode -eq 4){'Disabled background service'}else{'Manual / trigger-start service'}
                        $runningState='Unknown'
                        try { Add-Type -AssemblyName System.ServiceProcess; $controller=New-Object System.ServiceProcess.ServiceController($serviceName); try {$runningState=[string]$controller.Status}finally{$controller.Dispose()} } catch {}
                        $svcDesc=$null;$svcComp=$null;$svcIcon=$null
                        try {
                            [RovarinAppMetadata]::GetExecutableInfo($exe,[ref]$svcDesc,[ref]$svcComp) | Out-Null
                            $svcIcon=[RovarinAppMetadata]::ExtractIconBase64($exe)
                        } catch {}
                        $items.Add(@{locator=@{source='app-service';key=$serviceName};fingerprint=(Fingerprint ($serviceName+'|'+$image+'|'+$mode));name=$serviceName;displayName=$serviceDisplay;publisher=[string]$svcComp;command=$exe;source='app-service';scope='machine';serviceState=$runningState;startupMode=$(switch($mode){2 {'Automatic'} 3 {'Manual'} 4 {'Disabled'} default {'Unknown'}});enabled=$enabled;readOnly=$true;icon=$svcIcon;method=$method})
                    } finally { $key.Dispose() }
                }
            } finally { if($services){$services.Dispose()} }
        } catch { $warnings.Add('app-services-unavailable') }
    }
    foreach ($item in $items) {
        $exe = if ([IO.File]::Exists([string]$item.command)) { [string]$item.command } else { [RovarinAppMetadata]::ExtractExecutablePath([string]$item.command) }
        $label = if ($exe) { [IO.Path]::GetFileName($exe) } else { '' }
        if ($item -is [Collections.IDictionary]) { $item.executable = $label } else { $item | Add-Member -NotePropertyName executable -NotePropertyValue $label -Force }
    }
    @{ success = $true; code = 'startup-inventory'; items = @($items.ToArray()); warnings = @($warnings.ToArray() | Select-Object -Unique) }
}
function Startup-Toggle($request) {
    if ($request.locator.source -eq 'scheduled-task') { return (Set-StartupTask $request) }
    if ($request.locator.source -notin @('registry-user', 'registry-user32', 'folder-user')) {
        return @{ success = $false; code = 'unsupported'; error = 'Only user-scoped startup entries can be toggled without administrator privileges.' }
    }
    $name = [string]$request.locator.key
    $enabled = [bool]$request.enabled
    if ($request.locator.source -in @('registry-user','registry-user32')) {
        $view=if($request.locator.source -eq 'registry-user32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey([Microsoft.Win32.RegistryHive]::CurrentUser,$view)
        try{$key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Run')}finally{$base.Dispose()}
        if ($null -eq $key) { return @{ success = $false; code = 'not-found'; error = 'Startup registry key not accessible.' } }
        $cmd = [string]$key.GetValue($name)
        $key.Dispose()
        if ($null -eq $cmd) { return @{ success = $false; code = 'not-found'; error = 'Startup entry not found.' } }
        $fp = Fingerprint ("$($request.locator.source)|$name|$cmd")
        if ($fp -cne $request.fingerprint) { return @{ success = $false; code = 'startup-changed'; error = 'Startup entry was modified externally.' } }
        Set-StartupApproved $(if($request.locator.source -eq 'registry-user32'){'Run32'}else{'Run'}) $name $enabled
        return @{ success = $true; code = 'completed'; enabled = $enabled }
    } elseif ($request.locator.source -eq 'folder-user') {
        $userStartup = [Environment]::GetFolderPath('Startup')
        $filePath = Join-Path $userStartup $name
        if (-not (Test-Path -LiteralPath $filePath)) { return @{ success = $false; code = 'not-found'; error = 'Startup file not found.' } }
        $file = Get-Item -LiteralPath $filePath
        if($file.Extension -ine '.lnk' -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint)){return @{success=$false;code='unsupported'}}
        $fp = Fingerprint ("folder-user|$($file.Name)|$($file.Length)|$($file.LastWriteTimeUtc.Ticks)")
        if ($fp -cne $request.fingerprint) { return @{ success = $false; code = 'startup-changed'; error = 'Startup file was modified externally.' } }
        Set-StartupApproved 'StartupFolder' $name $enabled
        return @{ success = $true; code = 'completed'; enabled = $enabled }
    }
    return @{ success = $false; code = 'unsupported' }
}
function Open-StartupSettings($request) {
    # A fixed Windows UI handoff, not an external-package state write. The
    # public StartupTask API is scoped to its own app package.
    if($request.locator.source -ne 'packaged-startup'){return @{success=$false;code='unsupported'}}
    $parts=([string]$request.locator.key) -split '\|',2
    if($parts.Count -ne 2 -or $parts[0] -notmatch '^[A-Za-z0-9._-]{1,200}$' -or $parts[1].Length -lt 1 -or $parts[1].Length -gt 256 -or $parts[1] -match '[\x00-\x1f]'){return @{success=$false;code='unsupported'}}
    if((Fingerprint ([string]$request.locator.key)) -cne $request.fingerprint){return @{success=$false;code='startup-changed'}}
    $found=$false
    foreach($package in @(Get-AppxPackage -ErrorAction Stop | Where-Object {$_.PackageFamilyName -ceq $parts[0]})){
        $manifest=Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop
        foreach($task in @($manifest.SelectNodes("//*[local-name()='Extension' and @Category='windows.startupTask']//*[local-name()='StartupTask']"))){if([string]$task.TaskId -ceq $parts[1]){$found=$true}}
    }
    if(-not $found){return @{success=$false;code='not-found'}}
    Start-Process -FilePath 'ms-settings:startupapps' -ErrorAction Stop
    @{success=$true;code='settings-opened';changed=$false}
}
function Open-InstalledAppsSettings($request) {
    # Fixed Windows UI handoff to Windows Settings -> Installed apps (Apps & features)
    try { Start-Process -FilePath 'ms-settings:appsfeatures' -ErrorAction Stop }
    catch { Start-Process -FilePath 'ms-settings:installed-apps' -ErrorAction Stop }
    @{success=$true;code='settings-opened';changed=$false}
}
function Inventory {
    $global:sizeBudget.Restart()
    $rows=New-Object Collections.Generic.List[object]
    $jobs=New-Object Collections.Generic.List[object]
    $pool=$null
    $packagesAvailable=$null -ne (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue)
    $packageStartupReused=$false
    try {
        if($packagesAvailable){
            try {
                $packages=@(Get-AppxPackage -ErrorAction Stop)
                $toProcess=New-Object Collections.Generic.List[object]
                foreach($pkg in $packages){
                    $fp=Fingerprint $pkg.PackageFullName
                    $locId='appx|'+[string]$pkg.PackageFullName
                    $cachedFp=if($global:cachedFingerprints){if($global:cachedFingerprints -is [Collections.IDictionary]){$global:cachedFingerprints[$locId]}else{$global:cachedFingerprints.PSObject.Properties[$locId].Value}}else{$null}
                    if($cachedFp -and $cachedFp -ceq $fp){
                        $rows.Add(@{unchanged=$true;locator=@{scope='appx';key=[string]$pkg.PackageFullName};fingerprint=$fp})
                    }else{
                        $toProcess.Add($pkg)
                    }
                }
                if($toProcess.Count -eq 0 -and $packages.Count -gt 0){
                    $packageStartupReused=$true
                }elseif($toProcess.Count -gt 0){
                    # Four bounded, read-only workers overlap package presentation with registry inventory.
                    # Mutation/launch helpers below still independently re-resolve exact identities.
                    $initial=[Management.Automation.Runspaces.InitialSessionState]::CreateDefault2()
                    foreach($name in @('Package-Row','Collect-PackageStartup','Fingerprint','Get-DirectorySizeKB','Get-RovarinPackageDisplayName','Get-RovarinPackageDescription','Get-RovarinCleanPublisher','Test-IsOpaqueIdentifier')){
                        $initial.Commands.Add((New-Object Management.Automation.Runspaces.SessionStateFunctionEntry($name,(Get-Item ('Function:'+ $name)).Definition)))
                    }
                    $pool=[RunspaceFactory]::CreateRunspacePool(1,4,$initial,$Host)
                    $pool.Open()
                    $worker={param($batch,$cachedSizes)
                        $ErrorActionPreference='Stop'
                        $global:cachedSizes=$cachedSizes
                        $global:calculatedSizes=@{}
                        $global:sizeBudget=[Diagnostics.Stopwatch]::StartNew()
                        $global:packageStartup=New-Object Collections.Generic.List[object]
                        $items=New-Object Collections.Generic.List[object]
                        foreach($package in $batch){$items.Add((Package-Row $package))}
                        @{apps=@($items.ToArray());startup=@($global:packageStartup.ToArray());sizes=$global:calculatedSizes}
                    }
                    $workerCount=[Math]::Min(4, $toProcess.Count)
                    for($part=0;$part -lt $workerCount;$part++){
                        $batch=@(for($i=$part;$i -lt $toProcess.Count;$i+=$workerCount){$toProcess[$i]})
                        $ps=[PowerShell]::Create();$ps.RunspacePool=$pool
                        $null=$ps.AddScript($worker).AddArgument($batch).AddArgument($global:cachedSizes)
                        $jobs.Add(@{pipe=$ps;handle=$ps.BeginInvoke()})
                    }
                }
            }catch{$packagesAvailable=$false}
        }
    foreach($scope in @('user','machine64','machine32')){
        $hive=if($scope -eq 'user'){[Microsoft.Win32.RegistryHive]::CurrentUser}else{[Microsoft.Win32.RegistryHive]::LocalMachine}
        $view=if($scope -eq 'machine32'){[Microsoft.Win32.RegistryView]::Registry32}else{[Microsoft.Win32.RegistryView]::Registry64}
        $base=[Microsoft.Win32.RegistryKey]::OpenBaseKey($hive,$view);$key=$null
        try{$key=$base.OpenSubKey('Software\Microsoft\Windows\CurrentVersion\Uninstall');if($null -ne $key){foreach($name in $key.GetSubKeyNames()){if($rows.Count -ge 2048){throw 'Inventory bound exceeded'};$row=Registry-Row $scope $name $true;if($null -ne $row){$rows.Add($row)}}}}finally{if($key){$key.Dispose()};$base.Dispose()}
    }

        if($packagesAvailable -and $jobs.Count -gt 0){
            foreach($job in $jobs){
                try {
                    $result=@($job.pipe.EndInvoke($job.handle))
                    if($job.pipe.HadErrors -or $result.Count -ne 1){throw 'Package metadata unavailable'}
                    foreach($row in $result[0].apps){if($rows.Count -ge 2048){throw 'Inventory bound exceeded'};$rows.Add($row)}
                    foreach($item in $result[0].startup){$global:packageStartup.Add($item)}
                    foreach($key in $result[0].sizes.Keys){$global:calculatedSizes[$key]=$result[0].sizes[$key]}
                }catch{$packagesAvailable=$false;break}
            }
        }
    }finally{
        foreach($job in $jobs){try{if(-not $job.handle.IsCompleted){$job.pipe.Stop()}}finally{$job.pipe.Dispose()}}
        if($pool){$pool.Close();$pool.Dispose()}
    }
    @{success=$true;code='inventory';apps=@($rows.ToArray());packagesAvailable=$packagesAvailable;packageStartup=@($global:packageStartup.ToArray());packageStartupReused=$packageStartupReused;calculatedSizes=$global:calculatedSizes}
}

try {
    $text=[Console]::In.ReadToEnd();if($text.Length -gt 524288){throw 'Invalid input'};$request=$text | ConvertFrom-Json
    Start-AppxDiagnostic $request
    $global:cachedSizes = if ($request.cachedSizes) { $request.cachedSizes } else { @{} }
    $global:cachedFingerprints = if ($request.cachedFingerprints) { $request.cachedFingerprints } else { @{} }
    $global:calculatedSizes = @{}
    if($request.action -eq 'inventory'){Inventory | ConvertTo-Json -Depth 8 -Compress;exit}
    if($request.action -eq 'startup-inventory'){Startup-Inventory | ConvertTo-Json -Depth 6 -Compress;exit}
    if($request.action -eq 'startup-toggle'){Startup-Toggle $request | ConvertTo-Json -Compress;exit}
    if($request.action -eq 'startup-settings'){Open-StartupSettings $request | ConvertTo-Json -Compress;exit}
    if($request.action -eq 'installed-apps-settings'){Open-InstalledAppsSettings $request | ConvertTo-Json -Compress;exit}
    if($request.action -eq 'launch'){Launch-App $request | ConvertTo-Json -Compress;exit}
    if($request.action -eq 'verify-uninstall'){
        if($request.locator.scope -notin @('user','machine64','machine32','appx') -or $request.locator.key -match '[\\/\r\n]' -or $request.locator.key.Length -gt 300){throw 'Invalid verification identity'}
        if($request.locator.scope -eq 'appx'){
            if($request.ownerSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){throw 'Invalid verification identity'}
            $registered=@(Get-AppxPackage -ErrorAction Stop | Where-Object {$_.PackageFullName -ceq $request.locator.key -or ($request.packageFamily -and $_.PackageFamilyName -ceq $request.packageFamily)})
            @{success=$true;code='inspected';installed=($registered.Count -gt 0)} | ConvertTo-Json -Compress;exit
        } else {
            $present = Test-RegistryEntryPresent $request.locator.scope $request.locator.key
            @{success=$true;code='inspected';installed=[bool]$present} | ConvertTo-Json -Compress;exit
        }
    }
    if($request.action -ne 'uninstall' -or $request.locator.scope -notin @('user','machine64','machine32','appx') -or $request.locator.key -match '[\\/\r\n]' -or $request.locator.key.Length -gt 300){throw 'Invalid operation'}
    if($request.locator.scope -eq 'appx'){
        if($request.ownerSid -cne [Security.Principal.WindowsIdentity]::GetCurrent().User.Value){@{success=$false;code='user-mismatch'} | ConvertTo-Json -Compress;exit}
        $package=Get-AppxPackage -ErrorAction Stop | Where-Object {$_.PackageFullName -ceq $request.locator.key} | Select-Object -First 1
        if($null -eq $package){@{success=$false;code='not-installed'} | ConvertTo-Json -Compress;exit}
        $row=Package-Row $package $true
    }else{$row=Registry-Row $request.locator.scope $request.locator.key}
    if($null -eq $row){@{success=$false;code='not-installed'} | ConvertTo-Json -Compress;exit}
    if($row.fingerprint -cne $request.fingerprint){@{success=$false;code='inventory-changed'} | ConvertTo-Json -Compress;exit}
    if($row.protected -or $row.type -eq 'manual' -or ($request.batch -eq $true -and -not $row.batchCapable)){@{success=$false;code='unsupported'} | ConvertTo-Json -Compress;exit}
    if($row.type -eq 'appx'){
        Write-AppxDiagnostic 'removal-started' @{package=$package.PackageFullName;family=$package.PackageFamilyName;command='Remove-AppxPackage -Package <exact PackageFullName> -ErrorAction Stop'}
        Remove-AppxPackage -Package $package.PackageFullName -ErrorAction Stop
        Write-AppxDiagnostic 'removal-returned' @{success=$true}
        $remaining=@(Get-AppxPackage -ErrorAction Stop | Where-Object {$_.PackageFamilyName -ceq $package.PackageFamilyName})
        Write-AppxDiagnostic 'registration-verified' @{remaining=$remaining.Count;family=$package.PackageFamilyName}
        if($remaining.Count){@{success=$false;code='removal-unconfirmed'} | ConvertTo-Json -Compress;exit}
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
        $sw=[Diagnostics.Stopwatch]::StartNew()
        $process=[Diagnostics.Process]::Start($info)
        if($stream){$stream.Dispose();$stream=$null}
        if(-not $process.WaitForExit(90000)){
            if (-not (Test-RegistryEntryPresent $request.locator.scope $request.locator.key)) {
                @{success=$true;code='completed';exitCode=0} | ConvertTo-Json -Compress;exit
            }
            @{success=$false;code='still-running'} | ConvertTo-Json -Compress;exit
        }
        $exitCode=$process.ExitCode
        $present=Test-RegistryEntryPresent $request.locator.scope $request.locator.key
        # Many desktop uninstallers (Steam, NSIS _?=, Inno Setup, Squirrel) spawn a child/IPC dialog
        # and exit 0 immediately, or return a non-zero exit code after removing the application.
        if($present -and $exitCode -eq 0 -and $row.type -eq 'exe'){
            while($present -and $sw.ElapsedMilliseconds -lt 85000){
                Start-Sleep -Milliseconds 750
                $present=Test-RegistryEntryPresent $request.locator.scope $request.locator.key
            }
        }
        $code=if(-not $present){
            if($exitCode -in @(3010,1641)){'reboot-required'}else{'completed'}
        }elseif($row.type -ne 'msi'){
            if($exitCode -eq 1223){'cancelled'}elseif($exitCode -eq 0){'completed'}else{'uninstall-failed'}
        }else{
            switch($exitCode){0{'completed'}3010{'reboot-required'}1641{'reboot-required'}1605{'not-installed'}1614{'not-installed'}1602{'cancelled'}default{'uninstall-failed'}}
        }
        @{success=($code -in @('completed','reboot-required'));code=$code;exitCode=$exitCode} | ConvertTo-Json -Compress
    }finally{if($stream){$stream.Dispose()};if($process){$process.Dispose()}}
}catch{
    $errorRecord=$_
    Write-AppxDiagnostic 'error' @{exceptionType=$errorRecord.Exception.GetType().FullName;errorId=$errorRecord.FullyQualifiedErrorId;category=[string]$errorRecord.CategoryInfo.Category;hresults=@([regex]::Matches([string]$errorRecord.Exception.Message,'0x[0-9A-Fa-f]{8}') | ForEach-Object {$_.Value.ToUpperInvariant()} | Select-Object -Unique);activityIds=@([regex]::Matches([string]$errorRecord.Exception.Message,'[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}') | ForEach-Object {$_.Value} | Select-Object -Unique)}
    $code=if($_.Exception.NativeErrorCode -eq 1223){'cancelled'}elseif($_.Exception -is [UnauthorizedAccessException]){'access-denied'}else{'operation-failed'}
    $hresult=$null
    $match=[regex]::Match([string]$_.Exception.Message,'0x[0-9A-Fa-f]{8}')
    if($match.Success){$hresult=$match.Value.ToUpperInvariant()}
    if($request.locator.scope -eq 'appx'){
        $code=switch($hresult){'0X80070005'{'access-denied'}'0X80073CFA'{'removal-denied'}'0X80073D02'{'package-in-use'}'0X80073CF1'{'not-installed'}default{'package-removal-failed'}}
    }
    # Return only a fixed result code/HRESULT, never raw Windows messages or user paths.
    @{success=$false;code=$code;hresult=$hresult} | ConvertTo-Json -Compress
}finally{
    if($script:appxDiagnosticStream){Write-AppxDiagnostic 'helper-finished' @{pid=$PID};$script:appxDiagnosticStream.Dispose()}
}
