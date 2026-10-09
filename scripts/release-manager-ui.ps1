param([switch]$UiSmoke,[switch]$DownloadsSmoke)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
Add-Type -ReferencedAssemblies System.dll,System.Windows.Forms -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Windows.Forms;
public sealed class HelpScrollPanel : Panel {
    public HelpScrollPanel() { AutoScroll=true; TabStop=true; SetStyle(ControlStyles.Selectable,true); }
    protected override void OnMouseEnter(EventArgs e) { base.OnMouseEnter(e); Focus(); }
    [DllImport("user32.dll")] private static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
    public void TestNativeWheel(int delta) { Focus(); SendMessage(Handle,0x020A,new IntPtr(delta << 16),IntPtr.Zero); }
    public void TestWheel(int delta) { base.OnMouseWheel(new MouseEventArgs(MouseButtons.None,0,10,10,delta)); }
}
public sealed class ReleaseWorker : IDisposable {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
    public readonly ConcurrentQueue<string> Lines = new ConcurrentQueue<string>();
    private Process child;
    public void Start(string node, string script, string directory, string input) {
        child = new Process();
        child.StartInfo = new ProcessStartInfo(node, "\"" + script + "\"") {
            WorkingDirectory=directory, UseShellExecute=false, CreateNoWindow=true,
            RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true
        };
        child.OutputDataReceived += (s,e) => { if(e.Data != null) Lines.Enqueue(e.Data); };
        child.ErrorDataReceived += (s,e) => { if(e.Data != null) Lines.Enqueue("{\"type\":\"error\",\"message\":\"Local worker error. Review prerequisites and source.\"}"); };
        child.Start(); child.BeginOutputReadLine(); child.BeginErrorReadLine();
        child.StandardInput.WriteLine(input);
        if(!input.Contains("\"mode\":\"Publish\"")) child.StandardInput.Close();
    }
    public void Approve(bool publish) { child.StandardInput.WriteLine(publish ? "{\"publish\":true}" : "{\"publish\":false}"); child.StandardInput.Close(); }
    public bool Finished { get { return child != null && child.HasExited; } }
    public void Dispose() { if (child != null) { child.WaitForExit(); child.Dispose(); } }
}
'@
$root = Split-Path -Parent $PSScriptRoot
. (Join-Path $PSScriptRoot 'release-manager-dialogs.ps1')
try { $node = (Get-Command node.exe -ErrorAction Stop).Source } catch {
    [Windows.Forms.MessageBox]::Show('Install the supported Node.js development runtime to use Release Manager. Installed Rovarin does not require it.', 'Rovarin Release Manager') | Out-Null
    return
}
$script:worker = $null
$script:done = $null
$script:statusResult = $null
$script:releaseUrl = $null
$script:smokeStage = 0
$script:lastResult = $null
$form = New-Object Windows.Forms.Form
$form.Text = 'Rovarin Release Manager'
$form.Size = New-Object Drawing.Size(1080,740)
$form.MinimumSize = New-Object Drawing.Size(1000,680)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [Drawing.Color]::FromArgb(18,24,34)
$form.ForeColor = [Drawing.Color]::FromArgb(231,237,247)
$form.Font = New-Object Drawing.Font('Segoe UI',10)
$form.AutoScaleMode = 'Dpi'
$layout = New-Object Windows.Forms.TableLayoutPanel
$layout.Dock='Fill';$layout.Padding=New-Object Windows.Forms.Padding(22);$layout.ColumnCount=1;$layout.RowCount=6
foreach($height in @(42,72,-1,34,0,58)){
 if($height -eq -1){$style=New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Percent,100)}else{$style=New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute,$height)}
 $layout.RowStyles.Add($style)|Out-Null
}
$outer=New-Object Windows.Forms.TableLayoutPanel;$outer.Dock='Fill';$outer.ColumnCount=2
$outer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Percent,62)))|Out-Null
$outer.ColumnStyles.Add((New-Object Windows.Forms.ColumnStyle([Windows.Forms.SizeType]::Percent,38)))|Out-Null
$form.Controls.Add($outer);$outer.Controls.Add($layout,0,0)
$helpData=Get-Content -LiteralPath (Join-Path $PSScriptRoot 'release-manager-help.json') -Raw -Encoding UTF8|ConvertFrom-Json
$helpPanel=New-Object HelpScrollPanel;$helpPanel.Dock='Fill';$helpPanel.Padding=New-Object Windows.Forms.Padding(20,26,22,22)
$help=New-Object Windows.Forms.Label;$help.AutoSize=$true;$help.Location=New-Object Drawing.Point(20,26);$help.Font=New-Object Drawing.Font('Segoe UI',11);$help.ForeColor=$form.ForeColor
$help.Add_MouseEnter({$helpPanel.Focus()|Out-Null})
$helpPanel.Controls.Add($help)
$right=New-Object Windows.Forms.TableLayoutPanel;$right.Dock='Fill';$right.ColumnCount=1;$right.RowCount=2
$right.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Percent,50)))|Out-Null
$right.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Percent,50)))|Out-Null
$outer.Controls.Add($right,1,0);$right.Controls.Add($helpPanel,0,0)
$downloadPanel=New-Object Windows.Forms.TableLayoutPanel;$downloadPanel.Dock='Fill';$downloadPanel.Padding=New-Object Windows.Forms.Padding(20,8,22,20);$downloadPanel.RowCount=3
$downloadPanel.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute,32)))|Out-Null
$downloadPanel.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Percent,100)))|Out-Null
$downloadPanel.RowStyles.Add((New-Object Windows.Forms.RowStyle([Windows.Forms.SizeType]::Absolute,42)))|Out-Null
$right.Controls.Add($downloadPanel,0,1)
$downloadHeading=New-Object Windows.Forms.Label;$downloadHeading.Text='Installer Downloads';$downloadHeading.Dock='Fill';$downloadHeading.Font=New-Object Drawing.Font('Segoe UI',13,[Drawing.FontStyle]::Bold);$downloadPanel.Controls.Add($downloadHeading,0,0)
$downloadText=New-Object Windows.Forms.TextBox;$downloadText.Multiline=$true;$downloadText.ReadOnly=$true;$downloadText.ScrollBars='Vertical';$downloadText.BorderStyle='None';$downloadText.Dock='Fill';$downloadText.BackColor=$form.BackColor;$downloadText.ForeColor=$form.ForeColor;$downloadText.Text='Loading GitHub downloads...';$downloadText.AccessibleName='GitHub installer download statistics';$downloadPanel.Controls.Add($downloadText,0,1)
$downloadRefresh=New-Object Windows.Forms.Button;$downloadRefresh.Text='Refresh';$downloadRefresh.Dock='Fill';$downloadRefresh.FlatStyle='Flat';$downloadRefresh.ForeColor=$form.ForeColor;$downloadRefresh.BackColor=[Drawing.Color]::FromArgb(37,51,70);$downloadPanel.Controls.Add($downloadRefresh,0,2)
$script:downloadWorker=$null;$script:downloadResult=$null
function Show-Downloads($value){
 $stats=$value.stats
 if($null -eq $stats){$downloadText.Text='Downloads unavailable'+"

"+$value.error;return}
 $lines=@();if($value.state -eq 'stale'){$lines+='Cached — refresh failed';$lines+=$value.error;$lines+=''}
 if($null -eq $stats.latest){$lines+='No published releases yet.'}
 else{$lines+='Latest: '+$stats.latest.version;$count=if($null -eq $stats.latest.downloads){'Installer asset unavailable'}else{([long]$stats.latest.downloads).ToString('N0')};$lines+='Installer Downloads: '+$count}
 $lines+='';$lines+='All-time installer downloads: '+([long]$stats.total).ToString('N0')
 if($stats.missingInstallers -gt 0){$lines+='Excludes '+$stats.missingInstallers+' releases with no installer asset.'}
 $lines+='';$lines+='Published releases:'
 foreach($item in $stats.versions){$count=if($null -eq $item.downloads){'No installer asset'}else{([long]$item.downloads).ToString('N0')};$lines+=$item.version+'    '+$count}
 $lines+='';$lines+='Last updated: '+([DateTimeOffset]::Parse($stats.refreshedAt).ToLocalTime().ToString('g'))
 $lines+='';$lines+='GitHub-recorded downloads, including repeat and updater downloads. Not unique people or installations.'
 $downloadText.Text=$lines -join "
"
}
$downloadTimer=New-Object Windows.Forms.Timer;$downloadTimer.Interval=150
function Start-Downloads{
 if($script:downloadWorker){return};$downloadRefresh.Enabled=$false;$script:downloadResult=$null
 $script:downloadWorker=New-Object ReleaseWorker
 try{$script:downloadWorker.Start($node,(Join-Path $PSScriptRoot 'release-manager.js'),$root,(@{mode='Downloads'}|ConvertTo-Json -Compress));$downloadTimer.Start()}
 catch{$script:downloadWorker=$null;$downloadRefresh.Enabled=$true;$downloadText.Text='Could not load GitHub downloads. Try Refresh.'}
}
$downloadTimer.Add_Tick({
 if(-not $script:downloadWorker){return};$finished=$script:downloadWorker.Finished;$line=$null
 if($finished){$script:downloadWorker.Dispose()}
 while($script:downloadWorker.Lines.TryDequeue([ref]$line)){try{$v=$line|ConvertFrom-Json;if($v.type -eq 'result'){$script:downloadResult=$v.result}}catch{}}
 if($finished){$script:downloadWorker=$null;$downloadTimer.Stop();$downloadRefresh.Enabled=$true
  if($script:downloadResult){Show-Downloads $script:downloadResult}else{$downloadText.Text='Could not load GitHub downloads. Try Refresh.'}
  if($DownloadsSmoke){
   if(-not $script:downloadSmokeRefreshed){$script:downloadSmokeRefreshed=$true;$downloadRefresh.PerformClick()}
   else{[IO.File]::WriteAllText((Join-Path $root 'packaging/cache/release-downloads-ui-result.json'),(@{visible=$form.Visible;automaticRefresh=$true;manualRefresh=$true;state=$script:downloadResult.state;stats=$script:downloadResult.stats}|ConvertTo-Json -Depth 8));$bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height);$form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height)));$bitmap.Save((Join-Path $root 'packaging/cache/release-downloads-ui.png'));$bitmap.Dispose();$form.Close()}
  }
 }
})
$downloadRefresh.Add_Click({Start-Downloads})
$helpPanel.Add_ClientSizeChanged({$help.MaximumSize=New-Object Drawing.Size([Math]::Max(100,$helpPanel.ClientSize.Width-64),0)})
function Show-Help($name=''){
 if($script:helpName -ceq $name){return};$script:helpName=$name
 if($name){$entry=$helpData.$name;$help.Text="$name`r`n`r`n$($entry.safety)`r`n`r`n$($entry.body)"}
 else{$help.Text="What do you want to do?`r`n`r`nSave Project Progress`r`nSave your work on this PC.`r`n`r`nUpload Project to GitHub`r`nUpdate the online project.`r`n`r`nPreview New Release`r`nSee what publishing would do. Nothing changes.`r`n`r`nPublish New Version`r`nCreate a downloadable update for users.`r`n`r`nRestore Project Progress`r`nReturn to an earlier local save.`r`n`r`nUpdates & Tools`r`nCheck the software this manager needs."}
 $helpPanel.AutoScrollPosition=New-Object Drawing.Point(0,0)
 $help.Location=New-Object Drawing.Point(20,26);$helpPanel.PerformLayout()
}
$heading=New-Object Windows.Forms.Label;$heading.Text='Rovarin Release Manager';$heading.Font=New-Object Drawing.Font('Segoe UI',18,[Drawing.FontStyle]::Bold);$heading.Dock='Fill';$layout.Controls.Add($heading,0,0)
$info=New-Object Windows.Forms.Label;$info.Text='Checking your project...';$info.Dock='Fill';$layout.Controls.Add($info,0,1)
$actions=New-Object Windows.Forms.FlowLayoutPanel;$actions.Dock='Fill';$actions.FlowDirection='TopDown';$actions.WrapContents=$false;$actions.AutoScroll=$true;$layout.Controls.Add($actions,0,2)
function Task-Group($title){
 $group=New-Object Windows.Forms.FlowLayoutPanel;$group.FlowDirection='LeftToRight';$group.WrapContents=$false;$group.Height=58;$group.Width=560;$group.Margin=New-Object Windows.Forms.Padding(0,0,0,16)
 $label=New-Object Windows.Forms.Label;$label.Text=$title;$label.Font=New-Object Drawing.Font('Segoe UI',10,[Drawing.FontStyle]::Bold);$label.ForeColor=[Drawing.Color]::FromArgb(132,172,205);$label.Size=New-Object Drawing.Size(540,25);$actions.Controls.Add($label);$actions.Controls.Add($group);return $group
}
function Button($text,$panel){
 $button=New-Object Windows.Forms.Button;$button.Text=$text;$button.Tag=$text;$button.Size=New-Object Drawing.Size(250,46);$button.Margin=New-Object Windows.Forms.Padding(0,0,12,0);$button.FlatStyle='Flat';$button.UseMnemonic=$false
 $button.BackColor=[Drawing.Color]::FromArgb(37,51,70);$button.ForeColor=$form.ForeColor;$button.FlatAppearance.BorderColor=[Drawing.Color]::FromArgb(65,83,105);$button.Cursor='Hand'
 $button.Add_MouseEnter({Show-Help $this.Tag});$button.Add_Enter({Show-Help $this.Tag});$panel.Controls.Add($button);return $button
}
$projectGroup=Task-Group 'PROJECT';$checkpoint=Button 'Save Project Progress' $projectGroup;$save=Button 'Upload Project to GitHub' $projectGroup
$releaseGroup=Task-Group 'RELEASES';$dry=Button 'Preview New Release' $releaseGroup;$publish=Button 'Publish New Version' $releaseGroup;$publish.BackColor=[Drawing.Color]::FromArgb(48,83,114)
$recoveryGroup=Task-Group 'RECOVERY';$restore=Button 'Restore Project Progress' $recoveryGroup
$toolsGroup=Task-Group 'TOOLS';$toolsButton=Button 'Updates & Tools' $toolsGroup;$github=Button 'Open GitHub' $toolsGroup
$status=New-Object Windows.Forms.Label;$status.Text='Ready';$status.Dock='Fill';$layout.Controls.Add($status,0,3)
$log=New-Object Windows.Forms.TextBox;$log.Multiline=$true;$log.ReadOnly=$true;$log.ScrollBars='Vertical';$log.Dock='Fill';$log.BackColor=[Drawing.Color]::FromArgb(11,17,25);$log.ForeColor=$form.ForeColor;$log.Font=New-Object Drawing.Font('Consolas',10);$log.Visible=$false;$layout.Controls.Add($log,0,4)
$footer=New-Object Windows.Forms.FlowLayoutPanel;$footer.Dock='Fill';$layout.Controls.Add($footer,0,5)
$refresh=Button 'Check Project Status' $footer
$advanced=New-Object Windows.Forms.Button;$advanced.Text='Advanced Details';$advanced.Size=New-Object Drawing.Size(180,46);$advanced.FlatStyle='Flat';$advanced.ForeColor=$form.ForeColor;$footer.Controls.Add($advanced)
$advanced.Add_Click({$log.Visible=-not $log.Visible;$layout.RowStyles[4].Height=if($log.Visible){150}else{0};$advanced.Text=if($log.Visible){'Hide Advanced Details'}else{'Advanced Details'}})
Show-Help
function Log($text) { $log.AppendText($text + "`r`n") }
function Start-Request($request,$callback) {
    if ($script:worker) { return }
    foreach ($button in @($checkpoint,$save,$publish,$restore,$dry,$refresh,$toolsButton)+@($script:toolBusyControls)) { if($button -and -not $button.IsDisposed){$button.Enabled=$false} }
    if($request.mode -in @('Checkpoint','Save','Publish','Restore')){$script:lastOperation=$request.mode}
    $script:updatingTool=$request.mode -in @('UpdateTool','UpdateTools')
    $status.Text=if($request.mode -eq 'UpdateTool'){'Updating '+($script:toolsValue.tools|Where-Object id -eq $request.tool).name+'...'}else{'Checking your project...'}; $script:done=$callback; $script:lastResult=$null
    $script:worker=New-Object ReleaseWorker
    $timer.Start()
    try { $script:worker.Start($node,(Join-Path $PSScriptRoot 'release-manager.js'),$root,($request | ConvertTo-Json -Compress)) }
    catch { $script:worker=$null; $status.Text='Could not start local worker: '+$_.Exception.Message; Log $status.Text; foreach ($button in @($checkpoint,$save,$publish,$restore,$dry,$refresh,$toolsButton)+@($script:toolBusyControls)) { if($button -and -not $button.IsDisposed){$button.Enabled=$true} } }
}
function Show-Status($value) {
    $script:statusResult=$value
    $connected=if($value.github -eq 'Authenticated'){'Connected'}else{'Needs attention'}
    $info.Text="Current version: $($value.version)`r`nGitHub: $connected`r`nProject changes: $($value.changes) files changed"
    Log ($value | ConvertTo-Json -Depth 5)
    if ($value.privateTracked.Count) { Log ('Private files still tracked: ' + ($value.privateTracked -join ', ')) }
    if ($value.versionError) { Log $value.versionError }
}
function Choose-Version([switch]$TestOnly) {
    if (-not $script:statusResult -or $script:statusResult.versionError) { Show-FriendlyError 'Application and installer versions need to agree before publishing. Review Advanced Details.'; return $null }
    $dialog=New-Object Windows.Forms.Form; $dialog.Text='Publish New Version'; $dialog.Size=New-Object Drawing.Size(500,360); $dialog.StartPosition='CenterParent'; $dialog.FormBorderStyle='FixedDialog'; $dialog.MaximizeBox=$false; $dialog.MinimizeBox=$false
    $label=New-Object Windows.Forms.Label; $label.Text='Patch: small fixes. Minor: larger feature update. Custom: exact version. Other people can see and download this version.'; $label.Location=New-Object Drawing.Point(20,18); $label.Size=New-Object Drawing.Size(450,55); $dialog.Controls.Add($label)
    $choices=New-Object Windows.Forms.ComboBox; $choices.DropDownStyle='DropDownList'; $choices.Location=New-Object Drawing.Point(20,80); $choices.Width=440
    $choices.Items.AddRange(@("Patch - $($script:statusResult.patchVersion)","Minor - $($script:statusResult.minorVersion)",'Custom version')); $choices.SelectedIndex=0; $dialog.Controls.Add($choices)
    $versionBox=New-Object Windows.Forms.TextBox; $versionBox.Location=New-Object Drawing.Point(20,118); $versionBox.Width=440; $versionBox.Text=$script:statusResult.patchVersion; $versionBox.ReadOnly=$true; $dialog.Controls.Add($versionBox)
    $choices.Add_SelectedIndexChanged({ switch ($choices.SelectedIndex) { 0 { $versionBox.Text=$script:statusResult.patchVersion; $versionBox.ReadOnly=$true } 1 { $versionBox.Text=$script:statusResult.minorVersion; $versionBox.ReadOnly=$true } 2 { $versionBox.ReadOnly=$false; $versionBox.Focus() } } })
    $noteLabel=New-Object Windows.Forms.Label; $noteLabel.Text='Optional short release note (GitHub also generates change notes):'; $noteLabel.Location=New-Object Drawing.Point(20,155); $noteLabel.Size=New-Object Drawing.Size(440,25); $dialog.Controls.Add($noteLabel)
    $noteBox=New-Object Windows.Forms.TextBox; $noteBox.Multiline=$true; $noteBox.Location=New-Object Drawing.Point(20,188); $noteBox.Size=New-Object Drawing.Size(440,65); $noteBox.MaxLength=3000; $dialog.Controls.Add($noteBox)
    $ok=New-Object Windows.Forms.Button; $ok.Text='Review plan'; $ok.Location=New-Object Drawing.Point(240,260); $ok.Size=New-Object Drawing.Size(105,32); $ok.DialogResult='OK'; $dialog.Controls.Add($ok)
    $cancel=New-Object Windows.Forms.Button; $cancel.Text='Cancel'; $cancel.Location=New-Object Drawing.Point(355,260); $cancel.Size=New-Object Drawing.Size(105,32); $cancel.DialogResult='Cancel'; $dialog.Controls.Add($cancel); $dialog.AcceptButton=$ok; $dialog.CancelButton=$cancel
    if ($TestOnly) {
        if ($versionBox.Text -ne $script:statusResult.patchVersion) { throw 'Patch selection failed' }
        $choices.SelectedIndex=1
        if ($versionBox.Text -ne $script:statusResult.minorVersion -or -not $versionBox.ReadOnly) { throw 'Minor selection failed' }
        $choices.SelectedIndex=2; $versionBox.Text='0.3.0-test.1'
        if ($versionBox.ReadOnly) { throw 'Custom selection failed' }
        $dialog.Dispose(); return
    }
    Style-ManagerDialog $dialog
    $answer=$dialog.ShowDialog($form); $selected=@{version=$versionBox.Text.Trim();note=$noteBox.Text.Trim()}; $dialog.Dispose()
    if ($answer -eq 'OK') { return $selected }; return $null
}
function Confirm-Plan($plan){
 $count=@($plan.changes).Count
 $text=if($plan.action -eq 'Publish'){"Build and test version $($plan.version)?`r`n`r`nThis prepares a downloadable update for other people. Local version and installer files will change. Nothing becomes public until you review the verified result and click Publish Version."}elseif($plan.action -eq 'Restore'){"Return this PC's project to:`r`n$script:restoreDescription`r`n`r`nYour unfinished approved project files will be backed up first. GitHub will NOT be changed."}elseif($plan.action -eq 'Checkpoint'){"Save $count approved project files on this PC?`r`n`r`nThis creates a safe point to return to later. Private files are excluded. Nothing is uploaded to GitHub."}else{"Files that will be uploaded: $count`r`nPrivate files excluded: Yes`r`n`r`nThis saves the project and updates the online GitHub files. Other people can inspect them. It does NOT publish a new downloadable Rovarin version."}
 $approve=switch($plan.action){'Publish'{'Build and Test'}'Restore'{'Restore This Version'}'Checkpoint'{'Save on This PC'}default{'Upload to GitHub'}}
 Log ($plan|ConvertTo-Json -Depth 6)
 return Show-Review 'Review your request' $text $approve ($plan|ConvertTo-Json -Depth 6)
}
function Commit-Message {
    $d=New-Object Windows.Forms.Form; $d.Text='Name this project save'; $d.Size=New-Object Drawing.Size(470,155); $d.StartPosition='CenterParent'; $d.FormBorderStyle='FixedDialog'; $d.MaximizeBox=$false; $d.MinimizeBox=$false
    $t=New-Object Windows.Forms.TextBox; $t.Text='Save Rovarin source'; $t.MaxLength=300; $t.Location=New-Object Drawing.Point(15,15); $t.Width=425; $d.Controls.Add($t)
    $b=New-Object Windows.Forms.Button; $b.Text='Continue'; $b.Location=New-Object Drawing.Point(215,60); $b.Size=New-Object Drawing.Size(110,30); $b.DialogResult='OK'; $d.Controls.Add($b)
    $c=New-Object Windows.Forms.Button; $c.Text='Cancel'; $c.Location=New-Object Drawing.Point(335,60); $c.DialogResult='Cancel'; $d.Controls.Add($c); $d.AcceptButton=$b; $d.CancelButton=$c
    $answer=$d.ShowDialog($form); $value=$t.Text.Trim(); $d.Dispose(); if($answer -eq 'OK') { if(-not $value){$value='Save Rovarin source'}; return $value }; return $null
}
function Success($result) {
    Log $result.message
    if(-not $UiSmoke){$message=switch($script:lastOperation){'Checkpoint'{$result.message}'Save'{'Your approved project files are up to date on GitHub. No downloadable version was published.'}'Restore'{'Project progress was restored on this PC. Unfinished approved files were protected first. GitHub was not changed.'}'Publish'{"Rovarin $($result.version) is published. Other people can download it."}default{'Your request completed.'}};[Windows.Forms.MessageBox]::Show($message,'Completed','OK','Information')|Out-Null}
    foreach ($key in @('sha','localSha','sha256','backup','stash','recovery','assetStatus','url')) { if ($result.$key) { Log ($key+': '+$result.$key) } }
    if ($result.url) {
        $script:releaseUrl=$result.url
        $choice=[Windows.Forms.MessageBox]::Show(('The new version is published. Open its download page?'),'Release published','YesNo','Information')
        if ($choice -eq 'Yes') { Start-Process $script:releaseUrl }
    }
    Start-Request @{mode='Status'} ${function:Show-Status}
}
$save.Add_Click({ Start-Request @{mode='Plan';action='Save'} { param($plan) if(Confirm-Plan $plan){$message=Commit-Message;if($null -ne $message){Start-Request @{mode='Save';confirm=$true;fingerprint=$plan.fingerprint;message=$message} ${function:Success}}} } })
$publish.Add_Click({ $selection=Choose-Version; if($selection){$script:selection=$selection;Start-Request @{mode='Plan';action='Publish';version=$selection.version} { param($plan) if(Confirm-Plan $plan){Start-Request @{mode='Publish';confirm=$true;version=$plan.version;note=$script:selection.note;fingerprint=$plan.fingerprint} ${function:Success}} } } })
$restore.Add_Click({ Start-Request @{mode='History'} {
    param($history)
    $dialog=New-Object Windows.Forms.Form; $dialog.Text='Restore Project Progress'; $dialog.Size=New-Object Drawing.Size(710,440); $dialog.StartPosition='CenterParent'
    $list=New-Object Windows.Forms.ListBox; $list.Location=New-Object Drawing.Point(15,15); $list.Size=New-Object Drawing.Size(660,320); $list.HorizontalScrollbar=$true
    foreach($item in $history){ $list.Items.Add("$(([DateTime]::Parse($item.date)).ToString('MMMM d, yyyy')) - $($item.message)") | Out-Null }; if($list.Items.Count){$list.SelectedIndex=0}; $dialog.Controls.Add($list)
    $ok=New-Object Windows.Forms.Button; $ok.Text='Review This Save'; $ok.Location=New-Object Drawing.Point(435,350); $ok.Size=New-Object Drawing.Size(115,30); $ok.DialogResult='OK'; $dialog.Controls.Add($ok)
    $cancel=New-Object Windows.Forms.Button; $cancel.Text='Cancel'; $cancel.Location=New-Object Drawing.Point(560,350); $cancel.DialogResult='Cancel'; $dialog.Controls.Add($cancel); $dialog.CancelButton=$cancel
    Style-ManagerDialog $dialog
    $answer=$dialog.ShowDialog($form); $index=$list.SelectedIndex; if($index -ge 0){$script:restoreDescription=$list.Items[$index]}; $dialog.Dispose()
    if($answer -eq 'OK' -and $index -ge 0){Start-Request @{mode='Plan';action='Restore';commit=$history[$index].sha} {param($plan) if(Confirm-Plan $plan){Start-Request @{mode='Restore';confirm=$true;commit=$plan.commit;fingerprint=$plan.fingerprint} ${function:Success}}}}
} })
$github.Add_Click({ Start-Process 'https://github.com/DontMovePlease/Rovarin' })
$toolsButton.Add_Click({Start-Request @{mode='Tools'} {param($value) Show-Tools $value}})
$dry.Add_Click({Start-Request @{mode='DryRun';action='Publish'} {param($plan) Log ($plan | ConvertTo-Json -Depth 6);if(Show-Preview $plan){$publish.PerformClick()}}})
$checkpoint.Add_Click({Start-Request @{mode='Plan';action='Checkpoint'} {param($plan) if(Confirm-Plan $plan){$message=Commit-Message;if($null -ne $message){Start-Request @{mode='Checkpoint';confirm=$true;fingerprint=$plan.fingerprint;message=$message} ${function:Success}}}}})
$refresh.Add_Click({Start-Request @{mode='Status'} ${function:Show-Status}})
$timer=New-Object Windows.Forms.Timer; $timer.Interval=150
$timer.Add_Tick({
    try {
    if(-not $script:worker){return}
    $finished=$script:worker.Finished
    if($finished){$script:worker.Dispose()}
    $entry=$null
    while($script:worker.Lines.TryDequeue([ref]$entry)) {
        try { $value=$entry | ConvertFrom-Json } catch { Log 'Unrecognized worker response'; continue }
        switch($value.type){ 'status' {Log $value.message; $status.Text='Working on your request. Please wait.';if($script:updatingTool -and $script:toolSummary -and -not $script:toolSummary.IsDisposed){$script:toolSummary.Text=$value.message}} 'error' {if($UiSmoke -and $value.message -match 'Nothing new to publish'){$script:previewPassed=$true};Log ('STOP: '+$value.message);$status.Text='Could not complete this request';if($script:updatingTool -and $script:toolCheckButton -and -not $script:toolCheckButton.IsDisposed){$script:toolCheckButton.Text='Check Again';foreach($item in $script:toolsValue.tools){$item.canUpdate=$false};if($script:toolActionButton -and -not $script:toolActionButton.IsDisposed){$script:toolActionButton.Text='Why? / Details'}};if(-not $UiSmoke){Show-FriendlyError $value.message}} 'result' {$script:lastResult=$value.result} 'approval' {$timer.Stop();try{$approved=Confirm-Publish $value.summary;if(-not $script:worker.Finished){$script:worker.Approve($approved)}else{Log 'Final confirmation expired. No publication was performed.'}}finally{$timer.Start()}} }
    }
    if($finished) {
        $script:worker=$null
        $timer.Stop()
        foreach($button in @($checkpoint,$save,$publish,$restore,$dry,$refresh,$toolsButton)+@($script:toolBusyControls)){if($button -and -not $button.IsDisposed){$button.Enabled=$true}}
        if($script:toolSignIn -and -not $script:toolSignIn.IsDisposed){$script:toolSignIn.Enabled=$script:toolsValue.account -eq 'Sign-in required'}
        $callback=$script:done; $script:done=$null; $result=$script:lastResult
        if($null -ne $result){$status.Text='Ready';if($callback){& $callback $result}}
        if($script:toolAllButton -and -not $script:toolAllButton.IsDisposed){$script:toolAllButton.Enabled=@($script:toolsValue.tools|Where-Object canUpdate).Count -gt 0}
        if($UiSmoke -and $script:statusResult -and -not $script:worker -and -not $script:toolsSmokeOpen){
            if($script:smokeStage -eq 0){$script:smokeStage=1;Start-Request @{mode='Status'} ${function:Show-Status};return}
            if($script:smokeStage -eq 1){$script:smokeStage=2;Start-Request @{mode='DryRun';action='Publish'} {param($plan) if($plan.action -ne 'Publish'){throw 'Preview failed'};$script:previewPassed=$true;Log 'PASS Publish preview (no writes).'};return}
            if(-not $script:previewPassed){throw 'Publish preview failed; inspect the worker error'}
            if($script:smokeStage -eq 2){$script:smokeStage=3;Start-Request @{mode='Tools'} {param($tools) Show-Tools $tools -InteractiveSmoke;$script:toolsPassed=$true};return}
            if(-not $script:toolsPassed){throw 'Developer tool UI failed'}
            if($script:smokeStage -eq 3){$script:smokeStage=4;Start-Request @{mode='ToolUpdates'} {param($tools) Show-Tools $tools -TestOnly;$script:updatesPassed=$true};return}
            if(-not $script:updatesPassed){throw 'Update check UI failed'}
            if(-not [ReleaseWorker]::IsWindowVisible($form.Handle)){throw 'Native GUI is hidden'}
            if($script:statusResult.version -ne (Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw | ConvertFrom-Json).version){throw 'GUI version mismatch'}
            $script:smokeCheck='version';Choose-Version -TestOnly
            $script:smokeCheck='preview';Show-Preview @{currentVersion='0.1.0';meaningfulChanges=@('public/app.css')} -TestOnly | Out-Null
            $script:smokeCheck='advanced';if($log.Visible){throw 'Advanced Details must start closed'}
            $advanced.PerformClick();if(-not $log.Visible){throw 'Advanced Details did not open'};$advanced.PerformClick()
            $baseSize=$form.Size
            foreach($factor in @(1.0,1.25,1.5)){
                $script:smokeCheck='scale '+$factor;$form.Scale((New-Object Drawing.SizeF($factor,$factor)));$form.PerformLayout();$helpPanel.PerformLayout()
                $help.Text=(1..100|ForEach-Object {'Help scrolling line '+$_}) -join "`r`n"
                $helpPanel.PerformLayout();$helpPanel.TestWheel(-120)
                $script:smokeCheck='wheel '+$factor;if($helpPanel.AutoScrollPosition.Y -ge 0){throw 'Mouse wheel did not scroll help'}
                $helpPanel.AutoScrollPosition=New-Object Drawing.Point(0,0);$helpPanel.TestNativeWheel(-120)
                $script:smokeCheck='native wheel '+$factor;if($helpPanel.AutoScrollPosition.Y -ge 0){throw 'Native wheel message did not scroll'}
                $helpPanel.AutoScrollPosition=New-Object Drawing.Point(0,$helpPanel.VerticalScroll.Maximum)
                $script:smokeCheck='last line '+$factor;if($help.Bottom -gt $helpPanel.ClientSize.Height){throw 'Final help line is not reachable'}
                if($help.Width -gt $helpPanel.ClientSize.Width-35){throw 'Help text overlaps scrollbar'}
                $form.Scale((New-Object Drawing.SizeF((1/$factor),(1/$factor))));$form.Size=$baseSize;$form.PerformLayout()
            }
            $script:helpName=$null;Show-Help

            foreach($entry in $helpData.PSObject.Properties){Show-Help $entry.Name;if(-not $help.Text.Contains($entry.Value.safety)){throw 'Help classification mismatch'};if(-not $helpPanel.ClientRectangle.IntersectsWith($help.Bounds)){throw 'Help text is outside the visible panel'}}
            $script:helpName=$null;Show-Help
            if(-not $checkpoint.Enabled){throw 'Local save button stayed disabled'}
            Confirm-Publish @{version='0.1.1';tag='v0.1.1';sha256=('a'*64)} -TestOnly | Out-Null
            Show-Tools @{account='Sign-in required';tools=@();pinned=@();message='Controlled by project'} -TestOnly
            [IO.File]::WriteAllText((Join-Path $root 'packaging\cache\release-manager-visibility.json'),(@{visible=$form.Visible;nativeVisible=[ReleaseWorker]::IsWindowVisible($form.Handle);pid=$PID;refresh=$true;dryRun=$true;help=$true;scroll=$true;scaleSimulation=$true;advanced=$true;tools=$true;updateCheck=$true;finalConfirmation=$true;github=$script:statusResult.github}|ConvertTo-Json))
            Log 'PASS native GUI startup/status and patch/minor/custom version controls (no publish).'
            $bitmap=New-Object Drawing.Bitmap($form.Width,$form.Height); $form.DrawToBitmap($bitmap,(New-Object Drawing.Rectangle(0,0,$form.Width,$form.Height))); $bitmap.Save((Join-Path $root 'packaging\cache\release-manager-ui.png')); $bitmap.Dispose(); $form.Close()
        }
    }
    } catch {
        if($UiSmoke){$failure='GUI test failed at '+$script:smokeCheck+' '+($Error[0]|Out-String);$script:smokeFailure=$failure;[IO.File]::WriteAllText((Join-Path $root 'packaging/cache/release-manager-ui-failure.txt'),$failure);$timer.Stop();$form.Close()}
        else{Log ($_|Out-String);Show-FriendlyError $_.Exception.Message}
    }
})
$form.Add_FormClosing({param($sender,$event) if($script:worker -or $script:downloadWorker){$event.Cancel=$true;[Windows.Forms.MessageBox]::Show('Wait for the operation to finish. Closing during a build or upload could leave unfinished work.','Operation running') | Out-Null}})
$form.Add_Shown({Start-Downloads;if(-not $DownloadsSmoke){$timer.Start();Start-Request @{mode='Status'} ${function:Show-Status}}})
try {$form.ShowDialog() | Out-Null;if($script:smokeFailure){throw $script:smokeFailure}} finally {$downloadTimer.Stop();$downloadTimer.Dispose();$timer.Stop();$timer.Dispose();$form.Dispose()}
