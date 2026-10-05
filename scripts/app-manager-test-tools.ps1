param([Parameter(Mandatory=$true)][string]$Directory,[Parameter(Mandatory=$true)][string]$Prefix,[switch]$Cleanup)
$ErrorActionPreference='Stop'
if($Prefix -notmatch '^SystemManagementQA-[a-f0-9]{24}$'){throw 'Unsafe fixture identity'}
$resolved=[IO.Path]::GetFullPath($Directory);$temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
if(-not $resolved.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or [IO.Path]::GetFileName($resolved) -notmatch '^rovarin-app-qa-'){throw 'Unsafe fixture directory'}
$base='Software\Microsoft\Windows\CurrentVersion\Uninstall\'
$names=@('individual','batch-good','batch-failure','unsafe','ambiguous','protected')
if($Cleanup){foreach($name in $names){$key=$base+$Prefix+'-'+$name;$entry=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($key);if($entry){try{if($entry.GetValue('RovarinQAFixture') -cne $Prefix){throw 'Fixture ownership mismatch'}}finally{$entry.Dispose()};[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($key,$false)}};return}
[IO.Directory]::CreateDirectory($resolved) | Out-Null
$csc=Join-Path $env:SystemRoot 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
foreach($name in $names){
    $keyName=$Prefix+'-'+$name;$keyPath=$base+$keyName
    if([Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($keyPath)){throw 'Fixture already exists'}
    $exe=Join-Path $resolved ('uninstall-'+$name+'.exe')
    if($name -in @('individual','batch-good','batch-failure')){
        $remove=if($name -eq 'batch-failure'){'return 1603;'}else{'Microsoft.Win32.Registry.CurrentUser.DeleteSubKeyTree(@"'+$keyPath+'",false); return 0;'}
        $source='public static class Fixture { public static int Main(string[] args) { '+$remove+' } }'
        $sourceFile=Join-Path $resolved ('fixture-'+$name+'.cs');[IO.File]::WriteAllText($sourceFile,$source)
        & $csc /nologo /target:winexe "/out:$exe" $sourceFile
        if($LASTEXITCODE -ne 0){throw 'Fixture compilation failed'}
    }
    $key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyPath)
    try {
        $key.SetValue('DisplayName','Disposable App QA '+$name);$key.SetValue('DisplayVersion','1.0');$key.SetValue('Publisher','Rovarin test fixture');$key.SetValue('EstimatedSize',1024,[Microsoft.Win32.RegistryValueKind]::DWord);$key.SetValue('RovarinQAFixture',$Prefix);$key.SetValue('Comments','Local disposable fixture description');if($name -eq 'ambiguous'){$key.DeleteValue('EstimatedSize',$false)}
        if($name -eq 'unsafe'){$key.SetValue('UninstallString','"'+(Join-Path $env:SystemRoot 'System32\cmd.exe')+'" /c anything')}
        elseif($name -eq 'ambiguous'){$key.SetValue('UninstallString',(Join-Path $resolved 'uninstall-individual.exe'))}
        elseif($name -eq 'protected'){$key.SetValue('DisplayName','Rovarin');$key.SetValue('UninstallString','"'+(Join-Path $resolved 'uninstall-individual.exe')+'"')}
        else {$key.SetValue('UninstallString','"'+$exe+'"');$key.SetValue('QuietUninstallString','"'+$exe+'" /quiet')}
    }finally{$key.Dispose()}
}
