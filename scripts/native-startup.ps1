param([ValidateSet('Status','Enable','Disable')][string]$Action='Status')
$ErrorActionPreference='Stop'
try {
    $appDir=Split-Path -Parent $PSScriptRoot
    $installed=Test-Path -LiteralPath (Join-Path $appDir 'installation.json')
    if(-not $installed -and -not (Test-Path -LiteralPath (Join-Path $appDir '.rovarin-development-state.json'))){throw 'Unmarked development startup is unavailable.'}
    $folder=[Environment]::GetFolderPath('Startup')
    if((Get-Item -LiteralPath $folder -Force).Attributes -band [IO.FileAttributes]::ReparsePoint){throw 'Redirecting startup folder.'}
    $name=if($installed){'Rovarin.lnk'}else{'Rovarin Development.lnk'}
    $file=Join-Path $folder $name
    $target=if($installed){Join-Path $appDir 'Rovarin.exe'}else{Join-Path $env:SystemRoot 'System32\wscript.exe'}
    $arguments=if($installed){'startup'}else{'"'+(Join-Path $appDir 'run_hidden.vbs')+'"'}
    if(-not (Test-Path -LiteralPath $target -PathType Leaf)){throw 'Startup target unavailable.'}
    $shell=New-Object -ComObject WScript.Shell
    $exists=Test-Path -LiteralPath $file
    if($exists){
        $item=Get-Item -LiteralPath $file -Force
        if($item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint)){throw 'Unsafe startup shortcut.'}
        $link=$shell.CreateShortcut($file)
        if($link.TargetPath -ine $target -or $link.Arguments -cne $arguments -or $link.WorkingDirectory -ine $appDir){throw 'Startup registration belongs to another installation.'}
    }
    $key='HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder'
    $approved=Get-ItemProperty -LiteralPath $key -Name $name -ErrorAction SilentlyContinue
    $bytes=if($approved){$approved.$name}else{$null}
    if($bytes -and ($bytes -isnot [byte[]] -or $bytes.Length -ne 12 -or $bytes[0] -notin @(2,3))){throw 'Unrecognized Windows startup state.'}
    if($Action -eq 'Enable'){
        $link=$shell.CreateShortcut($file);$link.TargetPath=$target;$link.Arguments=$arguments;$link.WorkingDirectory=$appDir;$link.Description='Start Rovarin with Windows';$link.Save()
        if($bytes -and $bytes[0] -eq 3){$bytes=New-Object byte[] 12;$bytes[0]=2;Set-ItemProperty -LiteralPath $key -Name $name -Value $bytes -Type Binary}
        $exists=$true
    }elseif($Action -eq 'Disable'){
        if($exists){Remove-Item -LiteralPath $file -Force};$exists=$false
    }
    $enabled=$exists -and (-not $bytes -or $bytes[0] -eq 2)
    @{enabled=[bool]$enabled;available=$true} | ConvertTo-Json -Compress
}catch { @{available=$false;enabled=$false;message='Windows startup could not be safely confirmed or changed.'} | ConvertTo-Json -Compress;exit 1 }