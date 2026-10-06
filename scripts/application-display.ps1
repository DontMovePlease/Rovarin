# Shared, local-only package display metadata. Never used to select an uninstall target.
function Test-IsOpaqueIdentifier($name) {
    if (-not $name -or -not ($name -is [string])) { return $true }
    $t = $name.Trim()
    if (-not $t) { return $true }
    if ($t -match '^\{?[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}?$') { return $true }
    if ($t -match '^(ms-resource:|@\{)') { return $true }
    if ($t -match '^\d{5,}$') { return $true }
    if ($t -match '^[0-9a-fA-F_\-]{12,}$' -and ($t -replace '[^0-9]').Length -ge 4) { return $true }
    return $false
}

function Get-RovarinPackageDisplayName($package,$manifest=$null) {
    try {
        if($null -eq $manifest){$manifest=Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop}
        $display=[string]$manifest.Package.Properties.DisplayName
        if($display -and $display -notmatch '^ms-resource:' -and -not (Test-IsOpaqueIdentifier $display)){return $display.Trim()}
        if($display -match '^ms-resource:'){
            if(-not ('RovarinDisplayResources' -as [type])){
                Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class RovarinDisplayResources{[DllImport("shlwapi.dll",CharSet=CharSet.Unicode)]static extern int SHLoadIndirectString(string source,StringBuilder output,uint length,IntPtr reserved);public static string Resolve(string source){var output=new StringBuilder(1024);return SHLoadIndirectString(source,output,1024,IntPtr.Zero)==0?output.ToString():null;}}'
            }
            $resource=$display
            if($resource -notmatch '^ms-resource://'){$resource='ms-resource://'+$package.Name+'/resources/'+($resource -replace '^ms-resource:(/*)','')}
            $resolved=[RovarinDisplayResources]::Resolve('@{'+$package.PackageFullName+'?'+$resource+'}')
            if($resolved -and $resolved -notmatch '^(@|ms-resource:)' -and -not (Test-IsOpaqueIdentifier $resolved)){return $resolved.Trim()}
        }
        if($manifest.Package.Applications.Application){
            foreach($app in $manifest.Package.Applications.Application){
                $appDisplay=[string]$app.VisualElements.DisplayName
                if($appDisplay -and $appDisplay -notmatch '^ms-resource:' -and -not (Test-IsOpaqueIdentifier $appDisplay)){return $appDisplay.Trim()}
                if($appDisplay -match '^ms-resource:' -and ('RovarinDisplayResources' -as [type])){
                    $appRes=$appDisplay
                    if($appRes -notmatch '^ms-resource://'){$appRes='ms-resource://'+$package.Name+'/resources/'+($appRes -replace '^ms-resource:(/*)','')}
                    $appResolved=[RovarinDisplayResources]::Resolve('@{'+$package.PackageFullName+'?'+$appRes+'}')
                    if($appResolved -and $appResolved -notmatch '^(@|ms-resource:)' -and -not (Test-IsOpaqueIdentifier $appResolved)){return $appResolved.Trim()}
                }
                if($app.Executable -and $package.InstallLocation){
                    $exePath=Join-Path $package.InstallLocation $app.Executable
                    if([IO.File]::Exists($exePath)){
                        try {
                            $vi=[Diagnostics.FileVersionInfo]::GetVersionInfo($exePath)
                            if($vi.FileDescription -and $vi.FileDescription.Trim() -and -not (Test-IsOpaqueIdentifier $vi.FileDescription)){
                                return $vi.FileDescription.Trim()
                            }
                            if($vi.ProductName -and $vi.ProductName.Trim() -and $vi.ProductName -notmatch '(?i)Windows.*Operating System' -and -not (Test-IsOpaqueIdentifier $vi.ProductName)){
                                return $vi.ProductName.Trim()
                            }
                        }catch{}
                    }
                }
            }
        }
    }catch{}
    $pkgName=[string]$package.Name
    if(-not (Test-IsOpaqueIdentifier $pkgName)){return $pkgName}
    $pub=[string]$package.Publisher
    if($manifest -and $manifest.Package.Properties.PublisherDisplayName){$pub=[string]$manifest.Package.Properties.PublisherDisplayName}
    if($pub -and $pub -match '^CN=.*O=([^,]+)'){ $pub = $Matches[1].Trim() }
    if($pub -and $pub -notmatch '^(CN=|ms-resource:)'){return "Unknown application by $pub"}
    return "Unknown Microsoft Store app"
}

# Descriptions are presentation only; unresolved resources are never shown as prose.
function Get-RovarinPackageDescription($package,$manifest) {
    try {
        $description=[string]$manifest.Package.Properties.Description
        if(-not $description){return ''}
        if($description -notmatch '^ms-resource:'){return $description.Trim()}
        if(-not ('RovarinAppDescriptionResources' -as [type])){
            Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class RovarinAppDescriptionResources{[DllImport("shlwapi.dll",CharSet=CharSet.Unicode)]static extern int SHLoadIndirectString(string source,StringBuilder output,uint length,IntPtr reserved);public static string Resolve(string source){var output=new StringBuilder(1024);return SHLoadIndirectString(source,output,1024,IntPtr.Zero)==0?output.ToString():null;}}'
        }
        $resource=$description
        if($resource -notmatch '^ms-resource://'){$resource='ms-resource://'+$package.Name+'/resources/'+($resource -replace '^ms-resource:(/*)','')}
        $resolved=[RovarinAppDescriptionResources]::Resolve('@{'+$package.PackageFullName+'?'+$resource+'}')
        if($resolved -and $resolved -notmatch '^(@|ms-resource:)'){return $resolved.Trim()}
    }catch{}
    return ''
}

function Get-RovarinCleanPublisher($raw) {
    if (-not $raw -or -not ($raw -is [string])) { return '' }
    $s = $raw.Trim()
    if (-not $s -or $s -match '^ms-resource:') { return '' }
    if ($s -match '^CN\s*=' -or $s -match ',\s*(O|OU|L|S|C)\s*=') {
        $cn = if ($s -match '(?:^|,\s*)CN\s*=\s*([^,]+)') { $Matches[1].Trim().Trim('"') } else { $null }
        $o = if ($s -match '(?:^|,\s*)O\s*=\s*([^,]+)') { $Matches[1].Trim().Trim('"') } else { $null }
        $ou = if ($s -match '(?:^|,\s*)OU\s*=\s*([^,]+)') { $Matches[1].Trim().Trim('"') } else { $null }
        if ($cn -and $cn -notmatch '^[0-9a-fA-F-]{16,}$' -and $cn -notmatch '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}') {
            return $cn
        }
        if ($o -and $o -notmatch '^[0-9a-fA-F-]{16,}$') {
            return $o
        }
        if ($ou -and $ou -notmatch '^[0-9a-fA-F-]{16,}$') {
            return $ou
        }
        if ($cn) { return $cn }
        return ''
    }
    return $s
}
