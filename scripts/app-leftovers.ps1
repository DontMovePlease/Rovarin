$ErrorActionPreference='Stop'
[Console]::OutputEncoding=New-Object Text.UTF8Encoding($false)
[Console]::InputEncoding=New-Object Text.UTF8Encoding($false)
Add-Type -TypeDefinition (Get-Content -LiteralPath (Join-Path $PSScriptRoot 'app-leftovers.cs') -Raw)
try {
 $inputText=[Console]::In.ReadToEnd();if($inputText.Length -gt 4194304){throw 'request-limit'};$request=$inputText|ConvertFrom-Json
 switch($request.action) {
  'capture' {$captured=@();$excluded=@();if($request.paths.Count -gt 24){throw 'candidate-limit'};foreach($entry in $request.paths){try{$captured+= [RovarinLeftovers]::Capture([string]$entry.path,[string]$entry.source)}catch{$excluded+=@{location=$entry.path;reason='protected-redirected-or-unavailable'}}};@{success=$true;candidates=$captured;excluded=$excluded}|ConvertTo-Json -Depth 6 -Compress}
  'scan' {$items=@();foreach($item in $request.candidates){$c=New-Object RovarinLeftovers+Candidate;$c.Path=$item.Path;$c.Source=$item.Source;$c.Identity=$item.Identity;$items+=$c};[RovarinLeftovers]::Inspect([RovarinLeftovers+Candidate[]]$items)|ConvertTo-Json -Depth 8 -Compress}
  'delete' {if($request.guard.scope -eq 'appx'){try{$packages=@(Get-AppxPackage -ErrorAction Stop);if(@($packages|Where-Object {$_.PackageFamilyName -eq $request.guard.packageFamily}).Count){throw 'application-present'}}catch{@{success=$false;code='skipped';filesSkipped=$request.manifest.Files;details=@(@{location='Folder';reason='package-state-unverified-or-present'})}|ConvertTo-Json -Depth 4 -Compress;exit}};$m=New-Object RovarinLeftovers+Manifest;$m.Candidate=New-Object RovarinLeftovers+Candidate;$m.Candidate.Path=$request.manifest.Candidate.Path;$m.Candidate.Source=$request.manifest.Candidate.Source;$m.Candidate.Identity=$request.manifest.Candidate.Identity;$m.Fingerprint=$request.manifest.Fingerprint;$m.Files=$request.manifest.Files;$m.Bytes=$request.manifest.Bytes;$entries=@();foreach($item in $request.manifest.Entries){$e=New-Object RovarinLeftovers+Entry;$e.Relative=$item.Relative;$e.Directory=$item.Directory;$e.Identity=$item.Identity;$e.Hash=$item.Hash;$e.Bytes=$item.Bytes;$entries+=$e};$m.Entries=[RovarinLeftovers+Entry[]]$entries;[RovarinLeftovers]::Remove($m,[string]$request.guard.scope,[string]$request.guard.key)|ConvertTo-Json -Depth 6 -Compress}
  default {throw 'unsupported-action'}
 }
}catch{@{success=$false;code='operation-failed'}|ConvertTo-Json -Compress}
