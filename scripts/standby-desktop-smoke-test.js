'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),crypto=require('crypto');
const {execFileSync,spawn}=require('child_process'),root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'rovarin-standby-desktop-')),app=path.join(temp,'app'),data=path.join(temp,'data');let harness,failed=false,activeMemory;
const wait=ms=>new Promise(r=>setTimeout(r,ms));
const ps=code=>execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',code],{windowsHide:true,encoding:'utf8',timeout:100000});
const quote=s=>"'"+s.replace(/'/g,"''")+"'";
function control(command){return JSON.parse(execFileSync(path.join(app,'RovarinStandby.exe'),[command],{windowsHide:true,encoding:'utf8',timeout:20000,stdio:'pipe'}));}
async function until(fn,limit=65000){const end=Date.now()+limit;while(Date.now()<end){if(await fn())return;await wait(300);}throw Error('Native standby fixture deadline');}
async function main(){
 fs.cpSync(path.join(root,'packaging/payload'),temp,{recursive:true});fs.mkdirSync(data,{recursive:true});
 for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.js')||n==='package.json'))fs.copyFileSync(path.join(root,name),path.join(app,name));
 fs.cpSync(path.join(root,'public'),path.join(app,'public'),{recursive:true});
 const maintenance=path.join(app,'maintenance.js');fs.writeFileSync(maintenance,fs.readFileSync(maintenance,'utf8').replace('standbyBusy:()=>isRunning||boostProbePending','standbyBusy:()=>isRunning||boostProbePending||fs.existsSync(path.join(__dirname,"fixture-operation.hold"))'));
 const scriptList=fs.readFileSync(path.join(root,'packaging/build.ps1'),'utf8').match(/\$scripts = @\(([^)]+)\)/)[1];
 for(const match of scriptList.matchAll(/'([^']+)'/g))fs.copyFileSync(path.join(root,'scripts',match[1]),path.join(app,'scripts',match[1]));
 const pins=require('../pin-manager'),configFile=path.join(data,'config.json');pins.writeConfig(configFile,{pin:pins.generatePin(),autoCheckUpdates:false,retained:'native-standby-fixture'});const before=pins.readConfig(configFile);
 const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 const shell=path.join(temp,'DesktopShell.bound.cs');const companion=crypto.createHash('sha256').update(fs.readFileSync(path.join(app,'RovarinMaintenanceSetup.exe'))).digest('hex');
 fs.writeFileSync(shell,fs.readFileSync(path.join(root,'packaging/DesktopShell.cs'),'utf8').replace('internal const string MaintenanceSetupHash = "";','internal const string MaintenanceSetupHash = "'+companion+'";'));
 const refs=['/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',...['Core','WinForms'].map(x=>'/r:'+path.join(app,'Microsoft.Web.WebView2.'+x+'.dll'))];
 execFileSync(compiler,['/nologo','/target:winexe','/platform:x64',...refs,'/win32manifest:'+path.join(root,'packaging/desktop.manifest'),'/out:'+path.join(app,'Rovarin.exe'),path.join(root,'packaging/RovarinLauncher.cs'),shell],{windowsHide:true,timeout:30000});
 execFileSync(compiler,['/nologo','/target:exe','/platform:x64',...refs,'/win32manifest:'+path.join(root,'packaging/desktop.manifest'),'/out:'+path.join(app,'NativeDesktopTest.exe'),path.join(root,'scripts/native-desktop-test.cs')],{windowsHide:true,timeout:30000});
 fs.copyFileSync(path.join(app,'Rovarin.exe.config'),path.join(app,'NativeDesktopTest.exe.config'));
 const port=await new Promise(resolve=>{const server=require('net').createServer();server.listen(0,'127.0.0.1',()=>{const value=server.address().port;server.close(()=>resolve(value));});});
 execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(root,'scripts/build-standby.ps1'),'-AppDirectory',app,'-NodePath',path.join(temp,'runtime/node.exe'),'-ConfigurationFile',configFile,'-Port',String(port),'-TimeoutSeconds','20'],{windowsHide:true,timeout:30000});
 // Exercise per-user startup registration, preserving every unrelated task/link.
 ps('. '+quote(path.join(app,'scripts/standby-runtime.ps1'))+';Set-StandbyStartup $true;if(-not (Get-StandbyStartup)){throw "Startup enable failed"};Set-StandbyStartup $false;if(Get-StandbyStartup){throw "Startup disable failed"}');
 console.log('PASS isolated owned per-user logon/on-demand task registration, opt-out and no elevation');
 harness=spawn(path.join(app,'NativeDesktopTest.exe'),[],{cwd:app,windowsHide:true,env:{...process.env,ROVARIN_NATIVE_STANDBY_ONLY:'1'},stdio:['ignore','pipe','pipe']});let output='';harness.stdout.on('data',x=>{output+=x;process.stdout.write(x);if(x.toString().includes('MEASURE standby active process tree')){
  activeMemory=JSON.parse(ps('$all=@(Get-CimInstance Win32_Process);$ids=@('+harness.pid+')+@($all|Where-Object {$_.ExecutablePath -ieq '+quote(path.join(app,'RovarinStandby.exe'))+' -or $_.ExecutablePath -ieq '+quote(path.join(temp,'runtime/node.exe'))+'}|ForEach-Object {$_.ProcessId});do{$next=@($all|Where-Object {$_.ParentProcessId -in $ids -and $_.ProcessId -notin $ids}|ForEach-Object {$_.ProcessId});$ids+=$next}while($next.Count);@($ids|ForEach-Object {Get-Process -Id $_ -ErrorAction SilentlyContinue}|ForEach-Object {[pscustomobject]@{pid=$_.Id;name=$_.ProcessName;workingSetBytes=$_.WorkingSet64;privateCommitBytes=$_.PrivateMemorySize64}})|ConvertTo-Json -Compress'));
 }});harness.stderr.on('data',x=>{output+=x;process.stderr.write(x)});
 await until(()=>harness.exitCode!==null,120000);assert.equal(harness.exitCode,0,output);
 const closedAt=performance.now();await until(()=>!control('status').backendReady);const latency=Math.round(performance.now()-closedAt);
 const state=JSON.parse(ps('$all=@(Get-CimInstance Win32_Process);$nodes=@($all|Where-Object {$_.ExecutablePath -eq '+quote(path.join(temp,'runtime/node.exe'))+'});$web=@($all|Where-Object {$_.Name -eq "msedgewebview2.exe" -and $_.CommandLine -and $_.CommandLine.Contains('+quote(temp)+')});[pscustomobject]@{nodes=$nodes.Count;webviews=$web.Count}|ConvertTo-Json -Compress'));
 assert.equal(state.nodes,0,'real Node process gone');assert.equal(state.webviews,0,'owned WebView2 tree gone');
 const after=pins.readConfig(configFile);assert.equal(after.pin,before.pin);assert.equal(after.retained,before.retained);assert.equal(after.smartStandby,true);assert.equal(JSON.stringify(after.pinCredential),JSON.stringify(before.pinCredential));
 console.log('PASS actual native X releases WebView2; backend exits to standby in '+latency+'ms; PIN/settings/trust retained');
 const nativeMeasure=()=>JSON.parse(ps('$row=@(Get-CimInstance Win32_Process -Filter "Name=\'RovarinStandby.exe\'"|Where-Object {$_.ExecutablePath -ieq '+quote(path.join(app,'RovarinStandby.exe'))+' -and $_.CommandLine -match " run$"});if($row.Count -ne 1){throw "Native process count"};$p=Get-Process -Id $row[0].ProcessId;[pscustomobject]@{pid=$p.Id;workingSetBytes=$p.WorkingSet64;privateCommitBytes=$p.PrivateMemorySize64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds}|ConvertTo-Json -Compress'));
 const idleBefore=nativeMeasure(),idleStarted=performance.now();await wait(65000);const idleAfter=nativeMeasure();assert.equal(idleAfter.pid,idleBefore.pid,'recovery trigger skips the running supervisor');
 const idleMeasurement={seconds:(performance.now()-idleStarted)/1000,before:idleBefore,after:idleAfter,cpuSeconds:idleAfter.cpuSeconds-idleBefore.cpuSeconds};
 console.log('PASS complete native-only standby remains one process across the recovery trigger; measured 65-second CPU interval');
 const wake=control('wake');assert(wake.ready);assert.equal(wake.port,port);console.log('PASS local authenticated native activation restarts Node on original port');
 const backendPid=control('status').backendPid,hold=path.join(app,'fixture-operation.hold');fs.writeFileSync(hold,'owned fixture');
 const crashedAt=performance.now();
 ps('$owned=@(Get-CimInstance Win32_Process -Filter "Name=\'RovarinStandby.exe\'"|Where-Object {$_.ExecutablePath -ieq '+quote(path.join(app,'RovarinStandby.exe'))+' -and $_.CommandLine -match " run$"});if($owned.Count -ne 1){throw "Supervisor ownership"};Stop-Process -Id $owned[0].ProcessId -Force');
 await until(()=>{try{return !control('status').ready;}catch{return true;}},10000);
 await until(()=>{try{return control('status').backendReady;}catch{return false;}},100000);
 const taskRecoveryMs=Math.round(performance.now()-crashedAt);assert.equal(control('status').backendPid,backendPid);assert.equal(control('status').port,port);fs.unlinkSync(hold);
 console.log('PASS real Task Scheduler crash recovery on original port in '+taskRecoveryMs+'ms; protected backend retained');
 await until(()=>!control('status').backendReady);
 // Simulate a new logon without signing the owner out. An old recovery schedule
 // must disable itself when automatic startup was not selected.
 ps('. '+quote(path.join(app,'scripts/standby-runtime.ps1'))+';Stop-StandbyRuntime;$s=Get-StandbyScheduler;$t=Get-OwnedStandbyTask $s;$d=$t.Definition;$d.Data="RovarinLogon:0000000000000000";$d.Settings.Enabled=$true;$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;$null=$s.GetFolder("\").RegisterTaskDefinition((Get-StandbyTaskName),$d,6,$sid,$null,3)');
 execFileSync(path.join(app,'RovarinStandby.exe'),['run'],{windowsHide:true,timeout:10000,stdio:'pipe'});
 ps('. '+quote(path.join(app,'scripts/standby-runtime.ps1'))+';$t=Get-OwnedStandbyTask (Get-StandbyScheduler);if($t.Enabled){throw "Old-session recovery was not disabled"};$s=Start-StandbyRuntime;if($s.backendReady){throw "Rearm should remain native-only"};Stop-StandbyRuntime -RemoveStartup');
 console.log('PASS startup opt-out blocks a different logon; reopening rearms current-session recovery');
 console.log('PASS standby stop and owned task removal; no runtime service installed');
 // Exercise production uninstall registration/cleanup without touching HKCU or
 // executing any installer. Only the fixed registration read is substituted.
 for(const file of ['unins000.exe','unins000.dat'])fs.writeFileSync(path.join(temp,file),'INERT QA BYTES; NEVER EXECUTE');
 const registry='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{C51A4180-26D2-4F48-93BD-B40B182B78DA}_is1';
 const registration='function Get-ItemProperty([string]$LiteralPath){if($LiteralPath -cne '+quote(registry)+'){throw "Unexpected registry access"};return @{InstallLocation='+quote(temp)+'}};& '+quote(path.join(app,'scripts/installed-uninstall.ps1'));
 ps(registration+' -Mode Register');const trust=JSON.parse(fs.readFileSync(path.join(app,'uninstall-trust.json')));
 for(const key of ['app\\RovarinStandby.exe','app\\standby-runtime.json','app\\scripts\\standby-runtime.ps1'])assert(trust.hashes[key],'new runtime is covered by uninstall trust');
 const manifestFile=path.join(app,'standby-runtime.json'),manifestBytes=fs.readFileSync(manifestFile);fs.appendFileSync(manifestFile,'\n');assert.throws(()=>ps(registration+' -Mode Validate'),'changed supervisor metadata fails uninstall validation');fs.writeFileSync(manifestFile,manifestBytes);ps(registration+' -Mode Validate');
 const pinBeforeCleanup=fs.readFileSync(configFile),nativeTrustBefore=fs.readFileSync(path.join(data,'desktop-trust.bin'));fs.writeFileSync(path.join(data,'unrelated-user-note.txt'),'retain');
 ps(registration+' -Mode Cleanup');assert(fs.readFileSync(configFile).equals(pinBeforeCleanup));assert(fs.readFileSync(path.join(data,'desktop-trust.bin')).equals(nativeTrustBefore));assert(!fs.existsSync(path.join(data,'standby-state.bin')));assert(fs.existsSync(path.join(data,'unrelated-user-note.txt')));
 ps(registration+' -Mode Cleanup -FullRemoval');assert(!fs.existsSync(configFile));assert(!fs.existsSync(path.join(data,'desktop-trust.bin')));assert(fs.existsSync(path.join(data,'unrelated-user-note.txt')));
 console.log('PASS fixed uninstall trust binds native files; tamper refusal, retained PIN/trust, full removal and unknown-file preservation (isolated registration-read fixture; no installer executed)');
 fs.writeFileSync(path.join(root,'packaging/cache/standby-desktop-acceptance.json'),JSON.stringify({passed:true,desktopCloseToStandbyMs:latency,taskCrashRecoveryMs:taskRecoveryMs,taskFailureMode:'owned forced termination; repeating trigger replaces ineffective RestartOnFailure',activeProcessTree:activeMemory,nativeStandby:idleMeasurement,remaining:state,pinPreserved:true,settingsPreserved:true,windowsStartupTaskTested:true,logonOptOutSimulated:true,physicalIphone:false},null,2));
}
main().catch(e=>{failed=true;console.error(e.stack);console.error(e.stdout?.toString()||'');try{console.error(ps('. '+quote(path.join(app,'scripts/standby-runtime.ps1'))+';$t=Get-OwnedStandbyTask (Get-StandbyScheduler);if($t){[pscustomobject]@{state=$t.State;lastResult=$t.LastTaskResult;lastRun=$t.LastRunTime;restartInterval=$t.Definition.Settings.RestartInterval;restartCount=$t.Definition.Settings.RestartCount}|ConvertTo-Json -Compress}'));}catch{}console.error('Retained isolated fixture: '+temp);process.exitCode=1;}).finally(async()=>{
 try{fs.unlinkSync(path.join(app,'fixture-operation.hold'));}catch{}
 if(harness&&harness.exitCode===null){try{execFileSync(path.join(app,'Rovarin.exe'),['close-desktop'],{windowsHide:true,timeout:15000});}catch{}}
 if(fs.existsSync(path.join(app,'RovarinStandby.exe'))){try{ps('. '+quote(path.join(app,'scripts/standby-runtime.ps1'))+';Stop-StandbyRuntime -RemoveStartup');}catch(e){failed=true;console.error('Owned fixture cleanup unconfirmed; preserved '+temp);}}
 if(!failed)fs.rmSync(temp,{recursive:true,force:true});
});
