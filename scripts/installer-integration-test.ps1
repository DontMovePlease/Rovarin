$ErrorActionPreference = 'Stop'
$env:PSModulePath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\Modules'
$repo = Split-Path -Parent $PSScriptRoot
$testDir = [IO.Path]::GetFullPath((Join-Path $repo 'packaging\test-install'))
if ($testDir -ne [IO.Path]::GetFullPath((Join-Path $repo 'packaging\test-install'))) { throw 'Unsafe test directory.' }
$registration = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\{C51A4180-26D2-4F48-93BD-B40B182B78DA}_is1'
# The real installer is tested only when it cannot replace an existing installed
# product's registration. The development repository is not an installed product.
if (Test-Path -LiteralPath $registration) { throw 'An installed Rovarin already exists. Use a clean VM for this integration test.' }
if (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Rovarin')) { throw 'An existing Rovarin Start menu folder requires inspection before testing.' }
$desktopLink = Join-Path ([Environment]::GetFolderPath('Desktop')) 'Rovarin.lnk'
if (Test-Path -LiteralPath $desktopLink) { throw 'An existing Rovarin Desktop shortcut requires inspection before testing.' }
if (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'Rovarin.lnk')) { throw 'An existing Rovarin startup shortcut requires inspection before testing.' }
foreach ($folder in @([Environment]::GetFolderPath('Desktop'),[Environment]::GetFolderPath('Startup'),[Environment]::GetFolderPath('Programs'))) {
    if (Test-Path -LiteralPath (Join-Path $folder 'PC Monitor.lnk')) { throw 'An existing legacy shortcut requires a clean VM.' }
}
if (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'PC Monitor')) { throw 'An existing legacy Start menu folder requires a clean VM.' }
$legacyDir = Join-Path $repo 'packaging\test-install-legacy'
if (Test-Path -LiteralPath $legacyDir) { throw 'Legacy isolated fixture already exists; inspect it before rerunning.' }
if (Test-Path -LiteralPath $testDir) { throw 'Isolated test directory already exists; inspect it before rerunning.' }
$exe = Join-Path $repo 'dist\RovarinSetup.exe'
$arguments = @('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/COMPONENTS=core','/TASKS=desktopPin', '/GROUP=RovarinIsolatedTest', "/DIR=`"$testDir`"", "/LOG=`"$(Join-Path $repo 'packaging\cache\integration.log')`"")
$appDir = Join-Path $testDir 'app'
$dataDir = Join-Path $testDir 'data'
$cookieSession = $null
$runtime = $null
function Assert-Test($condition,$message) { if (-not $condition) { throw $message } }
function Remove-SyncHardLinks([string]$Path) {
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $drive = Split-Path -Qualifier $Path
    if (-not $drive) { try { $drive = (Get-Item -LiteralPath $Path).PSDrive.Root.TrimEnd('\') } catch {} }
    $links = & cmd.exe /c "fsutil hardlink list `"$Path`"" 2>$null
    foreach ($link in $links) {
        $trimmed = [string]$link.Trim()
        if ($trimmed -and $trimmed -match '\.tmp\.driveupload') {
            $fullPath = if ($trimmed.StartsWith('\')) { $drive + $trimmed } else { Join-Path $drive $trimmed }
            if (Test-Path -LiteralPath $fullPath) {
                Remove-Item -LiteralPath $fullPath -Force -ErrorAction SilentlyContinue
            }
        }
    }
    $parent = Split-Path -Parent $Path
    if ($parent -and (Test-Path -LiteralPath $parent)) {
        Get-ChildItem -LiteralPath $parent -Force -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.tmp\.driveupload' } | Remove-Item -Recurse -Force -ErrorAction SilentlyContinue
    }
    $remaining = @(& cmd.exe /c "fsutil hardlink list `"$Path`"" 2>$null)
    if ($remaining.Count -gt 1) {
        for ($i = 0; $i -lt 5; $i++) {
            try {
                $content = [IO.File]::ReadAllText($Path)
                $breakTmp = $Path + '.' + [Guid]::NewGuid().ToString('N') + '.tmp'
                [IO.File]::WriteAllText($breakTmp, $content, (New-Object Text.UTF8Encoding($false)))
                [IO.File]::Delete($Path)
                [IO.File]::Move($breakTmp, $Path)
                break
            } catch {
                Start-Sleep -Milliseconds 200
            }
        }
    }
}
function Clear-SyncReadOnly([string]$Root) {
    # Drive sync can set ReadOnly on fixture directories; only the fixed fixture root is touched.
    if (-not (Test-Path -LiteralPath $Root)) { return }
    $items = @(Get-Item -LiteralPath $Root -Force) + @(Get-ChildItem -LiteralPath $Root -Recurse -Force -ErrorAction SilentlyContinue | Where-Object { $_.PSIsContainer })
    foreach ($item in $items) {
        if ($item.Attributes -band [IO.FileAttributes]::ReadOnly) {
            try { $item.Attributes = $item.Attributes -band (-bnot [IO.FileAttributes]::ReadOnly) } catch {}
        }
    }
}
function Install-TestCopy {
    # Previous start.ps1 changes location. Release the caller's directory handle
    # before migration removes the old application-owned directory.
    Set-Location $repo
    Clear-SyncReadOnly $testDir; Clear-SyncReadOnly $legacyDir
    # -Wait waits the whole descendant tree, including the intentional background
    # server started for migration health verification. Wait only on Inno's handle.
    $installer = Start-Process -FilePath $exe -ArgumentList $arguments -WindowStyle Hidden -PassThru
    Assert-Test ($installer.WaitForExit(150000)) 'Installer exceeded bounded completion time; fixture retained.'
    Assert-Test ($installer.ExitCode -eq 0) "Installer failed: $($installer.ExitCode)"
    $installer.Dispose()
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    $migrationResult=Join-Path $dataDir 'rebrand-result.json'
    if(Test-Path -LiteralPath $migrationResult){Write-Output ([IO.File]::ReadAllText($migrationResult));throw 'Installer migration did not complete.'}
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $dataDir 'rebrand-migration.json'))) 'Migration receipt remained after installer completion.'
    $entry=Get-ItemProperty -LiteralPath $registration -ErrorAction Stop
    $expectedVersion=(Get-Content -LiteralPath (Join-Path $repo 'package.json') -Raw | ConvertFrom-Json).version
    Assert-Test ($entry.DisplayName -ceq 'Rovarin' -and $entry.DisplayVersion -ceq $expectedVersion -and $entry.Publisher -ceq 'Rovarin') 'Installed Apps identity/version/publisher incorrect.'
    Assert-Test ($entry.InstallLocation.TrimEnd('\') -ieq $testDir -and $entry.UninstallString -ceq ('"'+(Join-Path $testDir 'unins000.exe')+'"')) 'Installed Apps uninstall command/location incorrect.'
    Assert-Test (-not $entry.SystemComponent -and -not $entry.NoRemove) 'Installed Apps entry is hidden or cannot be removed.'
    Assert-Test (Test-Path -LiteralPath (Join-Path $appDir 'uninstall-trust.json')) 'Trusted uninstall metadata missing.'
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\installed-uninstall.ps1') -Mode Validate
    Assert-Test ($LASTEXITCODE -eq 0) 'Fresh installer safety validation failed.'
    foreach ($linkPath in @($desktopLink,(Join-Path ([Environment]::GetFolderPath('Programs')) 'Rovarin\Rovarin.lnk'))) {
        Assert-Test (Test-Path -LiteralPath $linkPath) 'Installed shortcut missing.'
        $link=(New-Object -ComObject WScript.Shell).CreateShortcut($linkPath)
        Assert-Test ($link.TargetPath -ieq (Join-Path $appDir 'Rovarin.exe') -and $link.Arguments -ceq '' -and $link.WorkingDirectory -ieq $appDir) 'Shortcut does not use the application-owned launcher/working directory.'
    }
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'Rovarin.lnk'))) 'Unchecked startup preference was ignored.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Rovarin\Rovarin Web Dashboard.lnk'))) 'Retired desktop browser shortcut remains after install/upgrade.'
}
function Assert-Removed([bool]$Full) {
    $limit=(Get-Date).AddSeconds(90)
    while ((Test-Path -LiteralPath (Join-Path $testDir 'unins000.exe')) -and (Get-Date) -lt $limit) { Start-Sleep -Milliseconds 250 }
    if (Test-Path -LiteralPath (Join-Path $testDir 'unins000.exe')) {
        $failure=Join-Path $dataDir 'uninstall-result.json'
        if (Test-Path -LiteralPath $failure) { Write-Output ('Safe handoff diagnostic: '+[IO.File]::ReadAllText($failure)) }
        Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($testDir) -and $_.Name -in @('node.exe','powershell.exe','_unins.tmp') } | Select-Object ProcessId,ParentProcessId,Name | ConvertTo-Json | Write-Output
        $errorLog=Join-Path $dataDir 'server-error.log';if(Test-Path -LiteralPath $errorLog){Get-Content -LiteralPath $errorLog -Tail 3 | Write-Output}
    }
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $testDir 'unins000.exe'))) 'Uninstaller remained.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $appDir 'server.js'))) 'Application remained.'
    Assert-Test (-not (Test-Path -LiteralPath $appDir)) 'Empty application directory or stale generated metadata remained.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $testDir 'runtime\node.exe'))) 'Bundled runtime remained.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $testDir 'desktop-profile'))) 'Desktop browser cache remained.'
    Assert-Test (-not (Test-Path -LiteralPath $registration)) 'Uninstall registration remained.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Rovarin\Rovarin.lnk'))) 'Dead Start menu shortcut remained.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Startup')) 'Rovarin.lnk'))) 'Startup registration remained.'
    Assert-Test (-not (Test-Path -LiteralPath $desktopLink)) 'Desktop shortcut remained.'
    foreach ($name in @('server.pid','server-state.json','server.instance.json','server-start.lock','server.log','server-error.log','launcher-error.log','enhanced-install.json','onboarding.lock','uninstall-result.json','uninstall-handoff.json')) {
        Assert-Test (-not (Test-Path -LiteralPath (Join-Path $dataDir $name))) "Runtime artifact remained: $name"
    }
    Assert-Test (@(Get-ChildItem -LiteralPath $dataDir -Filter 'server-start.*' -ErrorAction SilentlyContinue).Count -eq 0) 'Stale startup guards remained.'
    if ($Full) { foreach($name in @('config.json','temperature-settings.json','onboarding-complete.json','desktop-window.json','desktop-trust.bin')) { Assert-Test (-not (Test-Path -LiteralPath (Join-Path $dataDir $name))) "Full removal left settings: $name" } }
}
function Uninstall-TestCopy([bool]$Full) {
    Set-Location $repo
    Clear-SyncReadOnly $testDir
    $uninstallArgs=@('/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART',"/LOG=`"$(Join-Path $repo 'packaging\cache\integration-uninstall.log')`"")
    if ($Full) { $uninstallArgs+='/FULLREMOVAL' }
    $registeredCommand=(Get-ItemProperty -LiteralPath $registration).UninstallString
    Assert-Test ($registeredCommand -ceq ('"'+(Join-Path $testDir 'unins000.exe')+'"')) 'Untrusted Windows uninstall command.'
    $uninstallLog = Join-Path $repo 'packaging\cache\integration-uninstall.log'
    $p = $null
    $uninstalled = $false
    for ($attempt = 0; $attempt -lt 6; $attempt++) {
        if (Test-Path -LiteralPath $dataDir) {
            Get-ChildItem -LiteralPath $dataDir -Force -ErrorAction SilentlyContinue | ForEach-Object {
                if ($_.PSIsContainer -and $_.Name -match '\.tmp\.driveupload') {
                    Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
                } else {
                    Remove-SyncHardLinks $_.FullName
                }
            }
        }
        if ($p) { $p.Dispose() }
        $p = Start-Process -FilePath $registeredCommand.Trim('"') -ArgumentList $uninstallArgs -WindowStyle Hidden -PassThru
        $limit = (Get-Date).AddSeconds(45)
        while ((Get-Date) -lt $limit) {
            $activeUnins = @(Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object { $_.Name -like '*unins*.tmp' })
            if ($activeUnins.Count -eq 0 -and (-not (Test-Path -LiteralPath (Join-Path $testDir 'unins000.exe')) -or (Test-Path -LiteralPath $uninstallLog))) {
                Start-Sleep -Milliseconds 500
                break
            }
            Start-Sleep -Milliseconds 250
        }
        $uninstalled = (-not (Test-Path -LiteralPath (Join-Path $testDir 'unins000.exe'))) -or ($p.ExitCode -eq 0) -or ((Test-Path -LiteralPath $uninstallLog) -and ((Get-Content -LiteralPath $uninstallLog -Raw -ErrorAction SilentlyContinue) -match 'Uninstallation process succeeded'))
        if ($uninstalled) { break }
        Start-Sleep -Seconds 2
    }
    if (-not $uninstalled) {
        Write-Output "Uninstall failed with exit code: $($p.ExitCode)"
        if (Test-Path -LiteralPath $uninstallLog) {
            Write-Output "integration-uninstall.log:"
            Get-Content -LiteralPath $uninstallLog -Tail 25 | Write-Output
        } else {
            Write-Output "integration-uninstall.log was not created."
        }
        $valErr = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\installed-uninstall.ps1') -Mode Validate 2>&1
        Write-Output "installed-uninstall.ps1 -Mode Validate ($LASTEXITCODE): $valErr"
        $stpErr = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\stop.ps1') 2>&1
        Write-Output "stop.ps1 ($LASTEXITCODE): $stpErr"
    }
    Assert-Test $uninstalled 'Isolated normal uninstall failed.'; if ($p) { $p.Dispose() }
    Assert-Removed $Full
}
function Login-TestCopy {
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    & (Join-Path $appDir 'scripts\start.ps1') | Out-Null
    $script:runtime = Wait-DashboardRuntime $appDir 15
    if (-not $script:runtime.healthy) {
        Start-Sleep -Seconds 2
        foreach ($record in @('server.pid','server-state.json','server.instance.json','server-start.lock')) {
            $recordPath = Join-Path $dataDir $record
            if (Test-Path -LiteralPath $recordPath) { Remove-Item -LiteralPath $recordPath -Force -ErrorAction SilentlyContinue }
        }
        Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
        & (Join-Path $appDir 'scripts\start.ps1') | Out-Null
        $script:runtime = Wait-DashboardRuntime $appDir 15
    }
    Assert-Test ($script:runtime.healthy) ("Reinstalled server unhealthy: " + $script:runtime.state + ' ' + $script:runtime.reason)
    $script:base="http://127.0.0.1:$($runtime.port)"
    $script:cookieSession=New-Object Microsoft.PowerShell.Commands.WebRequestSession
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    $script:pin=(Get-Content -LiteralPath (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json).pin
    Invoke-RestMethod "$base/api/login" -Method Post -ContentType 'application/json' -Body (@{pin=$pin}|ConvertTo-Json -Compress) -WebSession $cookieSession -TimeoutSec 5 | Out-Null
}
function Remote-Uninstall([bool]$Full) {
    $body=@{pin=$pin;confirmation='uninstall-pc-monitor';removeData=$Full}|ConvertTo-Json -Compress
    # Queue complete headers and all but the final body byte on two sockets.
    # Finish both bodies together: no HttpWebRequest pool/100-continue delay can
    # turn this concurrency check into a request after the server already exits.
    $uri=[Uri]$base;$bytes=[Text.Encoding]::UTF8.GetBytes($body)
    $cookie=$cookieSession.Cookies.GetCookieHeader($uri)
    $header=[Text.Encoding]::ASCII.GetBytes("POST /api/system/uninstall HTTP/1.1`r`nHost: 127.0.0.1:$($uri.Port)`r`nCookie: $cookie`r`nContent-Type: application/json`r`nContent-Length: $($bytes.Length)`r`nConnection: close`r`n`r`n")
    $clients=@();$streams=@()
    try {
        for($i=0;$i -lt 2;$i++) {
            $client=New-Object Net.Sockets.TcpClient;$client.Connect('127.0.0.1',$uri.Port);$clients+=$client
            $stream=$client.GetStream();$stream.ReadTimeout=25000;$stream.WriteTimeout=5000;$streams+=$stream
            $stream.Write($header,0,$header.Length);$stream.Write($bytes,0,$bytes.Length-1)
        }
        foreach($stream in $streams) { $stream.Write($bytes,$bytes.Length-1,1) }
        $statuses=@();$responses=@()
        foreach($stream in $streams) {
            $reader=New-Object IO.StreamReader($stream);$response=$reader.ReadToEnd();$reader.Dispose();$responses+=$response
            Assert-Test ($response -match '^HTTP/1.1 (\d{3})') 'Malformed uninstall response.';$statuses+=[int]$Matches[1]
        }
        Assert-Test (($statuses | Sort-Object) -join ',' -eq '202,409') 'Expected one accepted and one duplicate rejection.'
        Assert-Test (($responses -join '').Contains('uninstall-accepted')) 'Accepted result missing.'
    }
    catch {
        $failure=Join-Path $dataDir 'uninstall-result.json'
        if (Test-Path -LiteralPath $failure) { Write-Output ('Safe handoff diagnostic: '+[IO.File]::ReadAllText($failure)) }
        throw
    } finally { foreach($client in $clients) { $client.Dispose() } }
    Assert-Removed $Full
}
function Test-DesktopLaunchers([bool]$Cold=$true) {
    # Exercise native product shortcuts/finish launch; the internal diagnostic
    # browser mode is tested separately with only browser opening intercepted.
    $desktopScript=Join-Path $appDir 'scripts\desktop.ps1'
    $original=[IO.File]::ReadAllBytes($desktopScript)
    $probePath=Join-Path $dataDir 'qa-desktop.json'
    $marker=Join-Path $dataDir 'onboarding-complete.json'
    $originalMarker=if(Test-Path -LiteralPath $marker){[IO.File]::ReadAllText($marker)}else{$null}
    $probeFunction=@'
function Start-Process {
    param($FilePath,$ArgumentList)
    $record=@{pid=$runtime.pid;address=$(if($ArgumentList){[string]$ArgumentList}else{[string]$FilePath})}|ConvertTo-Json -Compress
    [IO.File]::WriteAllText(('PROBE.'+$PID+'.tmp'),$record)
    [IO.File]::Move(('PROBE.'+$PID+'.tmp'),('PROBE.'+$PID))
}
'@
    try {
        $source=[Text.Encoding]::UTF8.GetString($original)
        Assert-Test ($source.Contains('$url = "http://127.0.0.1:')) 'Browser interception anchor changed.'
        $source=$source.Replace('$url = "http://127.0.0.1:',($probeFunction.Replace('PROBE',$probePath.Replace("'","''"))+"`r`n`$url = `"http://127.0.0.1:"))
        [IO.File]::WriteAllText($desktopScript,$source,(New-Object Text.UTF8Encoding($false)))
        [IO.File]::WriteAllText($marker,'{"completed":true}')
        if($Cold){
        $ownedProcess=Get-Process -Id $runtime.pid -ErrorAction Stop
        try {
            & (Join-Path $appDir 'scripts\stop.ps1') | Out-Null
            Assert-Test ($ownedProcess.WaitForExit(5000) -and $ownedProcess.HasExited) 'Fixture stop failed before desktop cold launch.'
            Assert-Test ((Get-DashboardRuntime $appDir).state -eq 'none') 'An exited server with a retained Windows handle must not block relaunch.'
        } finally { $ownedProcess.Dispose() }
        Start-Sleep -Milliseconds 500
        }
        $launcherPid=$null
        foreach($entry in @($desktopLink,(Join-Path ([Environment]::GetFolderPath('Programs')) 'Rovarin\Rovarin.lnk'),'finish')) {
            Get-ChildItem -LiteralPath $dataDir -Filter 'qa-desktop.json.*' | Remove-Item -Force
            if($entry -eq 'finish'){Start-Process -FilePath (Join-Path $appDir 'Rovarin.exe') -WindowStyle Hidden}
            else {Start-Process -FilePath $entry -WindowStyle Hidden}
            if($entry -eq $desktopLink){Start-Process -FilePath $entry -WindowStyle Hidden}
            $nativeDeadline=(Get-Date).AddSeconds(35)
            do {
                $script:runtime=Get-DashboardRuntime $appDir
                $shells=@(Get-CimInstance Win32_Process -Filter "Name='Rovarin.exe'" | Where-Object {$_.ExecutablePath -ieq (Join-Path $appDir 'Rovarin.exe') -and $_.CommandLine -notmatch 'close-desktop'})
                if($runtime.healthy -and $shells.Count -eq 1){break};Start-Sleep -Milliseconds 200
            } while((Get-Date) -lt $nativeDeadline)
            if (-not ($runtime.healthy -and $shells.Count -eq 1)) {
                Write-Output "Native shortcut diagnostic: entry=$entry, healthy=$($runtime.healthy), state=$($runtime.state), reason=$($runtime.reason), shellsCount=$($shells.Count)"
                foreach($name in @('server-error.log','launcher-error.log','server.log')){$failure=Join-Path $dataDir $name;if(Test-Path -LiteralPath $failure){Get-Content -LiteralPath $failure -Tail 5 | Write-Output}}
            }
            Assert-Test ($runtime.healthy -and $shells.Count -eq 1) 'Native shortcut did not reach one healthy backend/desktop.'
            $nativePid=$runtime.pid
            $ownedShell=Get-Process -Id $shells[0].ProcessId -ErrorAction Stop
            try {
                $null=$ownedShell.Handle
                $close=Start-Process -FilePath (Join-Path $appDir 'Rovarin.exe') -ArgumentList 'close-desktop' -WindowStyle Hidden -PassThru -Wait
                Assert-Test ($close.ExitCode -eq 0 -and $ownedShell.WaitForExit(10000)) 'Native desktop did not close through its owned fixed event.'
                $close.Dispose()
            } finally {$ownedShell.Dispose()}
            $script:runtime=Get-DashboardRuntime $appDir
            Assert-Test ($runtime.healthy -and $runtime.pid -eq $nativePid) 'Exiting native UI stopped/replaced backend.'
            # Internal developer/diagnostic browser access still obeys the
            # same actual-port/duplicate protection as before.
            Start-Process -FilePath (Join-Path $appDir 'Rovarin.exe') -ArgumentList 'web' -WindowStyle Hidden
            $expectedProbes=1
            if($entry -eq $desktopLink){Start-Process -FilePath (Join-Path $appDir 'Rovarin.exe') -ArgumentList 'web' -WindowStyle Hidden;$expectedProbes=2}
            $deadline=(Get-Date).AddSeconds(25)
            do {
                $probes=@(Get-ChildItem -LiteralPath $dataDir -Filter 'qa-desktop.json.*' | Where-Object {$_.Extension -ne '.tmp'})
                if($probes.Count -ge $expectedProbes){break};Start-Sleep -Milliseconds 150
            } while((Get-Date) -lt $deadline)
            if($probes.Count -ne $expectedProbes){
                $check=Get-DashboardRuntime $appDir
                Write-Output ("Launcher probe diagnostic: observed $($probes.Count)/$expectedProbes; $($check.state); $($check.reason)")
                foreach($name in @('server-error.log','launcher-error.log')){$failure=Join-Path $dataDir $name;if(Test-Path -LiteralPath $failure){Get-Content -LiteralPath $failure -Tail 5 | Write-Output}}
            }
            Assert-Test ($probes.Count -eq $expectedProbes) 'Overlapping installed launchers did not both reach browser handoff.'
            $probe=Get-Content -LiteralPath $probes[0].FullName -Raw | ConvertFrom-Json
            $script:runtime=Get-DashboardRuntime $appDir
            Assert-Test ($runtime.healthy -and $probe.address.EndsWith("http://127.0.0.1:$($runtime.port)")) 'Desktop did not discover actual port.'
            if($launcherPid){Assert-Test ($runtime.pid -eq $launcherPid) 'Shortcut created a second server.'}
            foreach($file in $probes){Assert-Test ((Get-Content -LiteralPath $file.FullName -Raw | ConvertFrom-Json).pid -eq $runtime.pid) 'Concurrent launch selected a different server.'}
            $instances=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object {$_.ExecutablePath -ieq (Join-Path $testDir 'runtime\node.exe') -and $_.CommandLine.Contains((Join-Path $appDir 'server.js'))})
            Assert-Test ($instances.Count -eq 1) 'More than one installed server instance.'
            $launcherPid=$runtime.pid
        }
        Write-Output 'PASS actual native Desktop/Start Menu/finish, concurrent one-shell/server reuse, UI-only exit and separate actual-port web handoff'
    } finally {
        [IO.File]::WriteAllBytes($desktopScript,$original)
        foreach($file in @($probePath,($probePath+'.tmp'),$marker)){if(Test-Path -LiteralPath $file){Remove-Item -LiteralPath $file -Force}}
        if($null -ne $originalMarker){[IO.File]::WriteAllText($marker,$originalMarker)}
        Get-ChildItem -LiteralPath $dataDir -Filter 'qa-desktop.json.*' | Remove-Item -Force
    }
}
try {
    # Upgrade the protected previously published artifact before testing a true
    # clean install. This catches version/registration and old-shortcut changes.
    $previousInstaller=Join-Path $repo 'packaging\cache\pre-rovarin\PCMonitorSetup.exe'
    $legacyUpgrade=Test-Path -LiteralPath $previousInstaller
    if (-not $legacyUpgrade) { $previousInstaller=Join-Path $repo 'publish\RovarinSetup.exe' }
    if(Test-Path -LiteralPath $previousInstaller) {
        $previousArguments=$arguments
        if($legacyUpgrade){$previousArguments=@($arguments | ForEach-Object { $_.Replace($testDir,$legacyDir) })}
        $previous=Start-Process -FilePath $previousInstaller -ArgumentList $previousArguments -WindowStyle Hidden -Wait -PassThru
        Assert-Test ($previous.ExitCode -eq 0) 'Previous candidate install failed.';$previous.Dispose()
        $previousVersion=(Get-ItemProperty -LiteralPath $registration).DisplayVersion
        $previousApp=if($legacyUpgrade){Join-Path $legacyDir 'app'}else{$appDir}
        $previousData=if($legacyUpgrade){Join-Path $legacyDir 'data'}else{$dataDir}
        $configPath=Join-Path $previousData 'config.json'
        Remove-SyncHardLinks $configPath
        . (Join-Path $previousApp 'scripts\dashboard-runtime.ps1')
        & (Join-Path $previousApp 'scripts\start.ps1') | Out-Null
        $runtime = Wait-DashboardRuntime $previousApp 15
        if (-not $runtime.healthy) {
            Start-Sleep -Seconds 2
            foreach ($record in @('server.pid','server-state.json','server.instance.json','server-start.lock')) {
                $recordPath = Join-Path $previousData $record
                if (Test-Path -LiteralPath $recordPath) { Remove-Item -LiteralPath $recordPath -Force -ErrorAction SilentlyContinue }
            }
            Remove-SyncHardLinks $configPath
            & (Join-Path $previousApp 'scripts\start.ps1') | Out-Null
            $runtime = Wait-DashboardRuntime $previousApp 15
        }
        Assert-Test $runtime.healthy 'Previous installed candidate not healthy.'
        if($legacyUpgrade){
            $legacyPreferences=Get-Content -LiteralPath (Join-Path $previousData 'config.json') -Raw | ConvertFrom-Json
            $legacyPreferences.requireDesktopPin=$false
            $legacyPreferences | Add-Member -NotePropertyName desktopLocked -NotePropertyValue $true -Force
            [IO.File]::WriteAllText((Join-Path $previousData 'config.json'),($legacyPreferences|ConvertTo-Json),(New-Object Text.UTF8Encoding($false)))
            Remove-SyncHardLinks (Join-Path $previousData 'config.json')
        }
        $upgradeConfig=[IO.File]::ReadAllText((Join-Path $previousData 'config.json'))
        [IO.File]::WriteAllText((Join-Path $previousData 'temperature-settings.json'),'{"mode":"off"}')
        if($legacyUpgrade){
            $enhancedState=@{exitCode=1460;completedAt=[DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()}|ConvertTo-Json -Compress
            [IO.File]::WriteAllText((Join-Path $previousData 'enhanced-install.json'),$enhancedState)
        }
        $credential=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $previousApp 'scripts\native-trust.ps1')
        Assert-Test ($LASTEXITCODE -eq 0 -and $credential.Length -eq 44) 'Legacy desktop trust unavailable.'
        $credential=$null
        $legacyTrustHash=(Get-FileHash -LiteralPath (Join-Path $previousData 'desktop-trust.bin')).Hash
        if($legacyUpgrade){[IO.File]::WriteAllText((Join-Path $legacyDir 'user-keeps.txt'),'unrelated user file')}
        Get-ChildItem -LiteralPath $previousData -File | ForEach-Object { Remove-SyncHardLinks $_.FullName }
        Install-TestCopy
        Assert-Test (Test-Path -LiteralPath (Join-Path $dataDir 'onboarding-complete.json')) 'Upgrade unexpectedly triggers automatic PIN display.'
        Assert-Test ([IO.File]::ReadAllText((Join-Path $dataDir 'config.json')) -ceq $upgradeConfig) 'Previous-release upgrade changed PIN/config.'
        if($legacyUpgrade){
            $migratedPreferences=Get-Content -LiteralPath (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json
            Assert-Test ($migratedPreferences.requireDesktopPin -eq $false -and $migratedPreferences.desktopLocked -eq $true) 'Migration reset trusted-desktop preference or persistent lock.'
        }
        Assert-Test ([IO.File]::ReadAllText((Join-Path $dataDir 'temperature-settings.json')) -ceq '{"mode":"off"}') 'Previous-release upgrade changed temperature settings.'
        Assert-Test ((Get-FileHash -LiteralPath (Join-Path $dataDir 'desktop-trust.bin')).Hash -ceq $legacyTrustHash) 'Migration changed desktop trust.'
        if($legacyUpgrade){
            Assert-Test ([IO.File]::ReadAllText((Join-Path $dataDir 'enhanced-install.json')) -ceq $enhancedState) 'Migration lost the driver retry guard.'
            $guarded=& (Join-Path $testDir 'runtime\node.exe') -e "const E=require(process.argv[1]).EnhancedSupport;const s=new E({root:process.argv[2],stateDirectory:process.argv[3]}).status();if(!s.installing||s.result.code!=='install-unconfirmed')process.exit(1)" (Join-Path $appDir 'enhanced-support.js') $appDir $dataDir
            Assert-Test ($LASTEXITCODE -eq 0) 'Migration cleared the unconfirmed driver installation protection.'
        }
        $credential=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\native-trust.ps1')
        Assert-Test ($LASTEXITCODE -eq 0 -and $credential.Length -eq 44) 'Migrated DPAPI credential cannot be read.'
        $credential=$null
        if($legacyUpgrade){
            Assert-Test (-not (Test-Path -LiteralPath (Join-Path $legacyDir 'app'))) 'Obsolete legacy application remained.'
            Assert-Test (-not (Test-Path -LiteralPath (Join-Path $legacyDir 'data'))) 'Obsolete legacy configuration remained.'
            Assert-Test ([IO.File]::ReadAllText((Join-Path $legacyDir 'user-keeps.txt')) -ceq 'unrelated user file') 'Migration removed unrelated user data.'
            # Test-created sentinel only, after proving migration retained it.
            Remove-Item -LiteralPath (Join-Path $legacyDir 'user-keeps.txt') -Force
            Assert-Test (@(Get-ChildItem -LiteralPath $legacyDir -Force).Count -eq 0) 'Unexpected legacy fixture files remain.'
            Remove-Item -LiteralPath $legacyDir -Force
            Assert-Test (-not (Test-Path -LiteralPath $legacyDir)) 'Obsolete legacy installation directory remained.'
            Assert-Test (-not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'PC Monitor'))) 'Legacy Start menu remained.'
            Assert-Test (-not (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Desktop')) 'PC Monitor.lnk'))) 'Legacy Desktop shortcut remained.'
        }
        Assert-Test (-not (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue)) 'Upgrade did not stop its previous owned server.'
        $nextVersion=(Get-ItemProperty -LiteralPath $registration).DisplayVersion
        Uninstall-TestCopy $true
        Assert-Test ([IO.Path]::GetFullPath($testDir) -eq [IO.Path]::GetFullPath((Join-Path $repo 'packaging\test-install'))) 'Unsafe upgrade fixture cleanup.'
        if(Test-Path -LiteralPath $testDir){Remove-Item -LiteralPath $testDir -Recurse -Force}
        Write-Output "PASS previous-published $previousVersion -> $nextVersion upgrade, stable HKCU registration, owned shutdown, application shortcut migration, PIN/preferences preservation and registered normal full uninstall"
    }
    Install-TestCopy
    Assert-Test (Test-Path -LiteralPath (Join-Path $testDir 'runtime\node.exe')) 'Bundled Node missing.'
    Assert-Test (-not (Test-Path -LiteralPath (Join-Path $appDir 'config.json'))) 'Installer must not distribute a PIN/config in its application payload.'
    $freshInstallerConfig = Get-Content -LiteralPath (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json
    Assert-Test ($freshInstallerConfig.pin -match '^\d{6}$' -and $freshInstallerConfig.requireDesktopPin -eq $true) 'Fresh installer must locally generate a canonical PIN and apply default desktop PIN protection.'
    Assert-Test (Test-Path -LiteralPath (Join-Path ([Environment]::GetFolderPath('Programs')) 'Rovarin\Rovarin.lnk')) 'Start menu shortcut missing.'
    . (Join-Path $appDir 'scripts\dashboard-runtime.ps1')
    & (Join-Path $appDir 'scripts\start.ps1') | Out-Null
    $runtime = Wait-DashboardRuntime $appDir 15
    if (-not $runtime.healthy) {
        Start-Sleep -Seconds 2
        & (Join-Path $appDir 'scripts\start.ps1') | Out-Null
        $runtime = Wait-DashboardRuntime $appDir 15
    }
    Assert-Test ($runtime.state -eq 'owned' -and $runtime.healthy) 'Installed server not healthy.'
    $oldPid = $runtime.pid
    & (Join-Path $appDir 'scripts\start.ps1')
    Assert-Test ((Get-DashboardRuntime $appDir).pid -eq $oldPid) 'Duplicate launcher replaced the server.'
    Test-DesktopLaunchers
    Test-DesktopLaunchers
    Test-DesktopLaunchers
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    $configBytes = [IO.File]::ReadAllText((Join-Path $dataDir 'config.json'))
    $pin = ($configBytes | ConvertFrom-Json).pin
    $firstPin=$pin
    Assert-Test ($pin -match '^\d{6}$') 'Fresh-install PIN must be six digits.'
    $base = "http://127.0.0.1:$($runtime.port)"
    $cookieSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
    Invoke-RestMethod "$base/api/login" -Method Post -ContentType 'application/json' -Body (@{pin=$pin}|ConvertTo-Json -Compress) -WebSession $cookieSession -TimeoutSec 5 | Out-Null
    $diag = Invoke-RestMethod "$base/api/diagnostics" -WebSession $cookieSession -TimeoutSec 20
    Assert-Test ($diag.binding.actualPort -eq $runtime.port) 'Actual port mismatch.'
    $enhanced = Invoke-RestMethod "$base/api/temperature/enhanced" -WebSession $cookieSession -TimeoutSec 5
    Assert-Test ($enhanced.bundled -and $enhanced.localDesktop) 'Local bundled support not detected.'
    $idle = Invoke-RestMethod "$base/api/monitoring/status" -WebSession $cookieSession -TimeoutSec 5
    Assert-Test (-not $idle.active -and @($idle.timers.PSObject.Properties).Count -eq 0) 'Idle telemetry running.'
    Invoke-RestMethod "$base/api/temperature/settings" -Method Post -ContentType 'application/json' -Body '{"mode":"off"}' -WebSession $cookieSession -TimeoutSec 5 | Out-Null
    $prefs = [IO.File]::ReadAllText((Join-Path $dataDir 'temperature-settings.json'))
    $setup = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\setup.ps1') -CheckOnly | ConvertFrom-Json
    Assert-Test ($setup.pinValid -and $setup.firstRun -and $setup.actualPort -eq $runtime.port) 'First-run local setup failed.'
    # Render the actual WinForms layout off screen, replacing the fixture PIN
    # after authentication. No real PIN is ever put into a screenshot.
    $previewSource = [IO.File]::ReadAllText((Join-Path $appDir 'scripts\setup.ps1'))
    $previewSource = $previewSource.Replace('Add-Type -AssemblyName System.Windows.Forms', "`$pin = '000000'`r`nAdd-Type -AssemblyName System.Windows.Forms")
    $previewPath = Join-Path $repo 'packaging\cache\onboarding-preview.png'
    $render = "`$form.Opacity = 0; `$form.Show(); [Windows.Forms.Application]::DoEvents(); `$form.PerformLayout(); `$bitmap = New-Object Drawing.Bitmap(`$form.Width,`$form.Height); `$form.DrawToBitmap(`$bitmap,(New-Object Drawing.Rectangle(0,0,`$form.Width,`$form.Height))); `$bitmap.Save('$($previewPath.Replace("'","''"))'); `$bitmap.Dispose(); `$form.Close()"
    $previewSource = $previewSource.Replace('$form.ShowDialog() | Out-Null', $render)
    $previewScript = Join-Path $appDir 'scripts\setup-preview-test.ps1'
    [IO.File]::WriteAllText($previewScript, $previewSource, (New-Object Text.UTF8Encoding($false)))
    & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $previewScript -Automatic
    Assert-Test (Test-Path -LiteralPath $previewPath) 'Onboarding layout did not render.'
    Assert-Test ($LASTEXITCODE -eq 0 -and (Test-Path -LiteralPath (Join-Path $dataDir 'onboarding-complete.json'))) 'Dismissing Setup did not record completion.'
    Remove-Item -LiteralPath $previewScript -Force
    $nextSetup=& powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\setup.ps1') -CheckOnly | ConvertFrom-Json
    Assert-Test (-not $nextSetup.firstRun -and $nextSetup.pinValid) 'Second launch must skip automatic PIN presentation; explicit local recovery remains available.'
    Test-DesktopLaunchers $false
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    $pin = (Get-Content -LiteralPath (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json).pin
    $tsIp = ($diag.checks | Where-Object id -eq 'tailscale-ip' | Select-Object -First 1).value
    if ($tsIp) {
        $tsBase = "http://${tsIp}:$($runtime.port)"
        $tsSession = New-Object Microsoft.PowerShell.Commands.WebRequestSession
        Invoke-RestMethod "$tsBase/api/login" -Method Post -ContentType 'application/json' -Body (@{pin=$pin}|ConvertTo-Json -Compress) -WebSession $tsSession -TimeoutSec 5 | Out-Null
        $tsStatus = Invoke-RestMethod "$tsBase/api/temperature/enhanced" -WebSession $tsSession -TimeoutSec 5
        Assert-Test (-not $tsStatus.localDesktop) 'Tailscale request received local privileges.'
        try {
            Invoke-RestMethod "$tsBase/api/temperature/enhanced/install" -Method Post -ContentType 'application/json' -Body '{}' -WebSession $tsSession -TimeoutSec 5 | Out-Null
            throw 'Remote driver installation was accepted.'
        } catch [System.Net.WebException] { Assert-Test ([int]$_.Exception.Response.StatusCode -eq 403) 'Remote rejection wrong status.' }
        Write-Output 'PASS installed Tailscale-address auth/read and 403 install denial (PC self-test; not an iPhone path test)'
    }
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    Invoke-RestMethod "$base/api/login" -Method Post -ContentType 'application/json' -Body (@{pin=$pin}|ConvertTo-Json -Compress) -WebSession $cookieSession -TimeoutSec 5 | Out-Null
    $lease = Invoke-RestMethod "$base/api/monitoring/lease" -Method Post -ContentType 'application/json' -Body '{"action":"acquire"}' -WebSession $cookieSession -TimeoutSec 5
    $stream = [Net.HttpWebRequest]::Create("$base/api/stream?lease=$($lease.leaseId)")
    $stream.CookieContainer=$cookieSession.Cookies; $stream.Proxy=$null; $stream.Timeout=5000
    $response=$stream.GetResponse(); Assert-Test ([int]$response.StatusCode -eq 200) 'SSE failed.'; $response.Close()
    Invoke-RestMethod "$base/api/monitoring/lease" -Method Post -ContentType 'application/json' -Body (@{action='release';leaseId=$lease.leaseId}|ConvertTo-Json -Compress) -WebSession $cookieSession -TimeoutSec 5 | Out-Null
    $idle = Invoke-RestMethod "$base/api/monitoring/status" -WebSession $cookieSession -TimeoutSec 5
    Assert-Test (-not $idle.active) 'Lease release did not stop sampling.'
    # A directory junction inside data must fail closed, not traverse/delete it.
    $sentinel=Join-Path $testDir 'sentinel'; New-Item -ItemType Directory -Path $sentinel | Out-Null
    [IO.File]::WriteAllText((Join-Path $sentinel 'keep.txt'),'unrelated fixture file')
    $junction=Join-Path $dataDir 'trap'
    New-Item -ItemType Junction -Path $junction -Target $sentinel | Out-Null
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\installed-uninstall.ps1') -Mode Validate
        Assert-Test ($LASTEXITCODE -ne 0) 'Data junction was accepted.'
        Assert-Test ([IO.File]::ReadAllText((Join-Path $sentinel 'keep.txt')) -ceq 'unrelated fixture file') 'Junction target changed.'
    } finally {
        # RemoveDirectory deletes only the junction entry, never its target.
        Add-Type 'using System; using System.Runtime.InteropServices; public static class FixtureJunction { [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] public static extern bool RemoveDirectory(string path); }'
        Assert-Test ([FixtureJunction]::RemoveDirectory($junction)) 'Could not remove fixture junction safely.'
    }
    $profile=Join-Path $testDir 'desktop-profile'
    New-Item -ItemType Directory -Force -Path $profile | Out-Null
    $profileTrap=Join-Path $profile 'trap'
    New-Item -ItemType Junction -Path $profileTrap -Target $sentinel | Out-Null
    try {
        & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\installed-uninstall.ps1') -Mode Validate
        Assert-Test ($LASTEXITCODE -ne 0) 'Desktop cache junction was accepted.'
        Assert-Test ([IO.File]::ReadAllText((Join-Path $sentinel 'keep.txt')) -ceq 'unrelated fixture file') 'Desktop cache junction target changed.'
    } finally {Assert-Test ([FixtureJunction]::RemoveDirectory($profileTrap)) 'Could not remove cache fixture junction safely.'}
    # Native installed recovery changes the PIN without a PIN HTTP endpoint.
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    $beforeRecovery=$pin
    for($attempt=0;$attempt -lt 4;$attempt++){
        Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
        $recovery = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\setup.ps1') -CheckOnly -RegeneratePin 2>$null
        if($LASTEXITCODE -eq 0){break}
        Start-Sleep -Seconds 2
    }
    Assert-Test ($LASTEXITCODE -eq 0 -and ($recovery | ConvertFrom-Json).pinValid) 'Native PIN recovery failed.'
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    $pin=(Get-Content -LiteralPath (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json).pin
    Assert-Test ($pin -match '^\d{6}$' -and $pin -cne $beforeRecovery) 'Recovery did not replace PIN.'
    Assert-Test (-not (($recovery -join '') -match [regex]::Escape($pin))) 'Recovery output exposed PIN.'
    try { Invoke-RestMethod "$base/api/monitoring/status" -WebSession $cookieSession -TimeoutSec 5 | Out-Null; throw 'Old session retained.' }
    catch [System.Net.WebException] { Assert-Test ([int]$_.Exception.Response.StatusCode -eq 401) 'Old session not revoked.' }
    # Seed a deliberate legacy fixture while its precisely owned server is stopped.
    & (Join-Path $appDir 'scripts\stop.ps1') | Out-Null
    $legacyConfig=Get-Content -LiteralPath (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json
    $legacyConfig.pin='123456789012'
    $legacyConfig.requireDesktopPin=$false
    [IO.File]::WriteAllText((Join-Path $dataDir 'config.json'),($legacyConfig | ConvertTo-Json), (New-Object Text.UTF8Encoding($false)))
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    Login-TestCopy
    $oldPid=$runtime.pid; $firstPin=$pin; $configBytes=[IO.File]::ReadAllText((Join-Path $dataDir 'config.json'))
    Assert-Test ($pin -match '^\d{12}$') 'Legacy PIN not accepted.'
    Write-Output 'PASS fresh six-digit PIN, native installed regeneration, secret-free output, revoked session and legacy twelve-digit login'
    # Real upgrade: safely stops the precisely owned bundled process before copy.
    $trustFile=Join-Path $dataDir 'desktop-trust.bin'
    # Shortcut tests close as soon as lifecycle reuse is proved; WebView2 may
    # not yet be initialized. Provision this upgrade fixture explicitly using
    # the SAME shipped DPAPI helper, keeping its output out of logs.
    $fixtureCredential=& powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File (Join-Path $appDir 'scripts\native-trust.ps1')
    Assert-Test ($LASTEXITCODE -eq 0 -and $fixtureCredential.Length -eq 44 -and (Test-Path -LiteralPath $trustFile)) 'Fixture desktop credential provisioning failed.'
    $fixtureCredential=$null
    $trustHash=(Get-FileHash -LiteralPath $trustFile).Hash
    Install-TestCopy
    Assert-Test (-not (Get-Process -Id $oldPid -ErrorAction SilentlyContinue)) 'Upgrade left old server alive.'
    Assert-Test ([IO.File]::ReadAllText((Join-Path $dataDir 'config.json')) -ceq $configBytes) 'Upgrade changed PIN/config.'
    Assert-Test ((Get-Content -LiteralPath (Join-Path $dataDir 'config.json') -Raw | ConvertFrom-Json).requireDesktopPin -eq $false) 'Upgrade reset the desktop PIN preference.'
    Assert-Test ((Get-FileHash -LiteralPath $trustFile).Hash -ceq $trustHash) 'Upgrade changed protected desktop trust state.'
    Assert-Test ([IO.File]::ReadAllText((Join-Path $dataDir 'temperature-settings.json')) -ceq $prefs) 'Upgrade changed temperature settings.'
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    & (Join-Path $appDir 'scripts\start.ps1') | Out-Null
    $runtime = Wait-DashboardRuntime $appDir 15
    if (-not $runtime.healthy) {
        Start-Sleep -Seconds 2
        & (Join-Path $appDir 'scripts\start.ps1') | Out-Null
        $runtime = Wait-DashboardRuntime $appDir 15
    }
    Assert-Test ($runtime.healthy -and $runtime.pid -ne $oldPid) 'Restart after upgrade failed.'
    $lines=@(& netstat.exe -ano -p tcp | Select-String ":$($runtime.port)\s+.*LISTENING\s+$($runtime.pid)\s*$")
    Assert-Test ($lines.Count -eq 1) 'Expected one installed listener.'
    Write-Output "PASS real isolated install, bundled runtime, generated PIN, local first-run, shortcut, auth/diagnostics/SSE/lease, duplicate prevention, actual port $($runtime.port), upgrade stop/restart and byte-preserved config/preferences"
    # A stale guard and completed setup marker exercise both cleanup policies.
    [IO.File]::WriteAllText((Join-Path $dataDir ('server-start.'+('a'*64)+'.lock')),'fixture dead guard')
    [IO.File]::WriteAllText((Join-Path $dataDir 'onboarding-complete.json'),'{"completed":true}')
    $interruptedPin=Join-Path $dataDir ('config.json.'+('b'*24)+'.tmp')
    [IO.File]::WriteAllText($interruptedPin,'fixture interrupted atomic PIN replacement')
    Remove-SyncHardLinks $interruptedPin
    Remove-SyncHardLinks (Join-Path $dataDir 'config.json')
    Get-ChildItem -LiteralPath $dataDir | ForEach-Object { Remove-SyncHardLinks $_.FullName }
    Uninstall-TestCopy $false
    Assert-Test (-not (Test-Path -LiteralPath $interruptedPin)) 'Interrupted PIN staging file retained.'
    Assert-Test ([IO.File]::ReadAllText((Join-Path $dataDir 'config.json')) -ceq $configBytes) 'Normal uninstall did not preserve PIN.'
    Assert-Test ([IO.File]::ReadAllText((Join-Path $dataDir 'temperature-settings.json')) -ceq $prefs) 'Normal uninstall did not preserve preferences.'
    Assert-Test (Test-Path -LiteralPath (Join-Path $sentinel 'keep.txt')) 'Uninstall removed unrelated files.'
    Install-TestCopy; Login-TestCopy
    Assert-Test ($pin -ceq $firstPin) 'Preserved-data reinstall changed PIN.'
    $status=Invoke-RestMethod "$base/api/system/uninstall" -WebSession $cookieSession -TimeoutSec 5
    Assert-Test $status.available 'Installed remote uninstall unavailable.'
    # Tampered uninstall metadata fails before acceptance, retaining the server.
    $trustPath=Join-Path $appDir 'uninstall-trust.json';$trustBytes=[IO.File]::ReadAllText($trustPath)
    $tampered=$trustBytes | ConvertFrom-Json; $tampered.hashes.'unins000.exe'='0'*64
    [IO.File]::WriteAllText($trustPath,($tampered|ConvertTo-Json -Depth 4))
    try {
        try {
            Invoke-RestMethod "$base/api/system/uninstall" -Method Post -ContentType 'application/json' -Body (@{pin=$pin;confirmation='uninstall-pc-monitor';removeData=$false}|ConvertTo-Json -Compress) -WebSession $cookieSession -TimeoutSec 25 | Out-Null
            throw 'Tampered uninstaller accepted.'
        } catch [Net.WebException] { Assert-Test ([int]$_.Exception.Response.StatusCode -eq 503) 'Tamper rejection status incorrect.'; $_.Exception.Response.Close() }
        Assert-Test ((Get-DashboardRuntime $appDir).healthy) 'Failed handoff stopped the server.'
    } finally { [IO.File]::WriteAllText($trustPath,$trustBytes) }
    $wrong=if($pin -ceq '000000000000'){'111111111111'}else{'000000000000'}
    try {
        Invoke-RestMethod "$base/api/system/uninstall" -Method Post -ContentType 'application/json' -Body (@{pin=$wrong;confirmation='uninstall-pc-monitor';removeData=$false}|ConvertTo-Json -Compress) -WebSession $cookieSession -TimeoutSec 5 | Out-Null
        throw 'Wrong uninstall PIN accepted.'
    } catch [Net.WebException] { Assert-Test ([int]$_.Exception.Response.StatusCode -eq 401) 'Wrong PIN status incorrect.' }
    $lease=Invoke-RestMethod "$base/api/monitoring/lease" -Method Post -ContentType 'application/json' -Body '{"action":"acquire"}' -WebSession $cookieSession -TimeoutSec 5
    Remote-Uninstall $false
    Assert-Test ([IO.File]::ReadAllText((Join-Path $dataDir 'config.json')) -ceq $configBytes) 'Remote preserved uninstall changed configuration.'
    Write-Output 'PASS normal uninstall after upgrade, stale/log/shortcut cleanup, junction denial, unrelated-file preservation, preserved-settings reinstall and PIN-confirmed remote preserved uninstall'
    Install-TestCopy; Login-TestCopy
    Remote-Uninstall $true
    Install-TestCopy; Login-TestCopy
    Assert-Test ($pin -cne $firstPin) 'Full-removal reinstall reused old PIN.'
    Assert-Test ($pin -match '^\d{6}$') 'Full-removal reinstall must generate six digits.'
    $freshMode=Invoke-RestMethod "$base/api/temperature/settings" -WebSession $cookieSession -TimeoutSec 5
    Assert-Test ($freshMode.mode -eq 'enhanced') 'Full-removal reinstall retained Off preference.'
    Uninstall-TestCopy $true
    Write-Output 'PASS remote full removal erases secrets/settings, fresh reinstall generates new PIN/defaults, normal full removal shares the same cleanup; PawnIO/Tailscale never uninstalled'
} catch {
    Write-Output ("Integration failure: " + $_.Exception.Message)
    foreach($name in @('server-state.json','server.instance.json','server-error.log')) {
        $diagnostic=Join-Path $dataDir $name
        if(Test-Path -LiteralPath $diagnostic){Write-Output ("Fixture diagnostic: " + $name);Get-Content -LiteralPath $diagnostic -Tail 5 | Write-Output}
    }
    throw
} finally {
    Set-Location $repo
    $uninstaller = Join-Path $testDir 'unins000.exe'
    if (Test-Path -LiteralPath $uninstaller) {
        $uninstall = Start-Process -FilePath $uninstaller -ArgumentList '/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART' -WindowStyle Hidden -Wait -PassThru
        if ($uninstall.ExitCode -ne 0) { throw 'Isolated uninstall failed; test state retained for inspection.' }
        if ($runtime -and $runtime.pid) { Assert-Test (-not (Get-Process -Id $runtime.pid -ErrorAction SilentlyContinue)) 'Uninstall did not stop its server.' }
        if ($configBytes) { Assert-Test (Test-Path -LiteralPath (Join-Path $dataDir 'config.json')) 'Uninstall removed user configuration.' }
        Assert-Test (-not (Test-Path -LiteralPath $registration)) 'Uninstall registration remained.'
        # Only fixture files in the previously checked fixed test directory.
        if ([IO.Path]::GetFullPath($testDir) -ne [IO.Path]::GetFullPath((Join-Path $repo 'packaging\test-install'))) { throw 'Unsafe test cleanup.' }
        Write-Output 'PASS isolated normal uninstall stops only its owned runtime, removes registration/shortcuts, retains user data; test fixture cleaned'
    }
    if (Test-Path -LiteralPath $testDir) {
        Assert-Test (-not (Test-Path -LiteralPath (Join-Path $appDir 'server.js'))) 'Cannot remove a live fixture.'
        Assert-Test ([IO.Path]::GetFullPath($testDir) -eq [IO.Path]::GetFullPath((Join-Path $repo 'packaging\test-install'))) 'Unsafe fixture cleanup.'
        Remove-Item -LiteralPath $testDir -Recurse -Force
    }
}
