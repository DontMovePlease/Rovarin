# Shared, local-only package display metadata. Never used to select an uninstall target.
function Get-RovarinPackageDisplayName($package,$manifest=$null) {
    try {
        if($null -eq $manifest){$manifest=Get-AppxPackageManifest -Package $package.PackageFullName -ErrorAction Stop}
        $display=[string]$manifest.Package.Properties.DisplayName
        if($display -and $display -notmatch '^ms-resource:'){return $display.Trim()}
        if($display -match '^ms-resource:'){
            if(-not ('RovarinDisplayResources' -as [type])){
                Add-Type -TypeDefinition 'using System;using System.Text;using System.Runtime.InteropServices;public static class RovarinDisplayResources{[DllImport("shlwapi.dll",CharSet=CharSet.Unicode)]static extern int SHLoadIndirectString(string source,StringBuilder output,uint length,IntPtr reserved);public static string Resolve(string source){var output=new StringBuilder(1024);return SHLoadIndirectString(source,output,1024,IntPtr.Zero)==0?output.ToString():null;}}'
            }
            $resource=$display
            if($resource -notmatch '^ms-resource://'){$resource='ms-resource://'+$package.Name+'/resources/'+($resource -replace '^ms-resource:(/*)','')}
            $resolved=[RovarinDisplayResources]::Resolve('@{'+$package.PackageFullName+'?'+$resource+'}')
            if($resolved -and $resolved -notmatch '^(@|ms-resource:)'){return $resolved.Trim()}
        }
    }catch{}
    return [string]$package.Name
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
