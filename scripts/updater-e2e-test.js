'use strict';
// Real Inno/native update E2E. Every adapter is injected ONLY into disposable
// installer fixture copies; production source has no URL/path/channel override.
// Never install sensitive runtime state under a synced checkout: Drive's
// .tmp.driveupload hard links correctly fail config's nlink===1 guard.
// Use the fixed current-user LocalAppData test location, not weaker validation.
const fs=require('fs'),path=require('path'),crypto=require('crypto'),assert=require('assert');
const {execFileSync,spawn}=require('child_process');
const root=path.resolve(__dirname,'..'),cache=path.join(root,'packaging/cache/updater-e2e'),install=path.join(process.env.LOCALAPPDATA,'RovarinUpdaterE2E');
const app=path.join(install,'app'),data=path.join(install,'data'),report=path.join(cache,'report.json'),control=path.join(cache,'control.json');
const registry='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{C51A4180-26D2-4F48-93BD-B40B182B78DA}_is1';
const group='RovarinUpdaterIsolatedTest';
const reuse=process.argv.includes('--reuse-fixtures');
const resume=process.argv.includes('--resume-fixture');
const hash=f=>crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const quote=s=>"'"+s.replaceAll("'","''")+"'";
const pause=ms=>new Promise(r=>setTimeout(r,ms));
function ps(code,timeout=20000){return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',"$env:PSModulePath=Join-Path $env:SystemRoot 'System32\\WindowsPowerShell\\v1.0\\Modules';$ErrorActionPreference='Stop';"+code],{encoding:'utf8',windowsHide:true,timeout}).trim();}
function ownedInstall(exe,argumentsList){ps(`$p=Start-Process -FilePath ${quote(exe)} -ArgumentList ${argumentsList.map(quote).join(',')} -WindowStyle Hidden -PassThru;try{if(-not $p.WaitForExit(150000)){throw 'Owned installer timeout'};$p.Refresh();if($p.ExitCode -ne 0){throw 'Owned installer failure'}}finally{$p.Dispose()}`,170000);}
async function waitPhase(phase,seconds){const deadline=Date.now()+seconds*1000;while(Date.now()<deadline){try{const result=JSON.parse(fs.readFileSync(report));if(result.phase==='failed')throw Error('Native fixture driver failed');if(result.phase===phase)return result;}catch(e){if(e.message==='Native fixture driver failed')throw e;}await pause(250);}throw Error('Native fixture timed out: '+phase);}
function build(version){
 if(reuse){const exe=path.join(cache,version,'output/RovarinSetup.exe');assert(fs.existsSync(exe));return exe;}
 const dir=path.join(cache,version),payload=path.join(dir,'payload');fs.mkdirSync(dir);fs.cpSync(path.join(root,'packaging/payload'),payload,{recursive:true});
 const a=path.join(payload,'app');let packageJson=JSON.parse(fs.readFileSync(path.join(a,'package.json')));packageJson.version=version;fs.writeFileSync(path.join(a,'package.json'),JSON.stringify(packageJson,null,2));
 let shell=fs.readFileSync(path.join(root,'packaging/DesktopShell.cs'),'utf8');
 const driver=fs.readFileSync(path.join(root,'scripts/updater-e2e-native-test.cs'),'utf8').replaceAll('REPORT_PATH',report.replaceAll('"','""')).replaceAll('CONTROL_PATH',control.replaceAll('"','""'));
 shell=shell.replace('    private bool updateBusy;',driver+'\n    private bool updateBusy;');
 shell=shell.replace('if (login != "true") {','if (login != "true") {\n                            FixtureDriver();');
 // Simulate explicit user approval in this test assembly only. The production
 // confirmation and fixed web-message/native credential path are unchanged.
 const confirmation=/if \(MessageBox\.Show\(this, "Download and verify the official Rovarin update[^\n]+!= DialogResult\.Yes\)/;
 assert(confirmation.test(shell));shell=shell.replace(confirmation,'if (false)');
 fs.writeFileSync(path.join(dir,'DesktopShell.cs'),shell);
 let launcher=fs.readFileSync(path.join(root,'packaging/RovarinLauncher.cs'),'utf8').replaceAll('0.1.1.0',version+'.0');fs.writeFileSync(path.join(dir,'RovarinLauncher.cs'),launcher);
 const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
 execFileSync(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',`/r:${path.join(a,'Microsoft.Web.WebView2.Core.dll')}`,`/r:${path.join(a,'Microsoft.Web.WebView2.WinForms.dll')}`,`/win32manifest:${path.join(root,'packaging/desktop.manifest')}`,`/win32icon:${path.join(a,'Rovarin.ico')}`,`/out:${path.join(a,'Rovarin.exe')}`,path.join(dir,'RovarinLauncher.cs'),path.join(dir,'DesktopShell.cs')],{windowsHide:true,timeout:20000});
 if(version==='0.1.1'){
  const url='https://github.com/DontMovePlease/Rovarin/releases/download/v0.1.2/RovarinSetup.exe';
  const next=path.join(cache,'0.1.2/output/RovarinSetup.exe');
  const transport=`const fs=require('fs'),{Readable}=require('stream'),crypto=require('crypto');module.exports=async url=>{const c=JSON.parse(fs.readFileSync(${JSON.stringify(control)}));const p=${JSON.stringify(next)};if(url.startsWith('https://api.github.com/repos/DontMovePlease/Rovarin/releases?')){const sha=c.badChecksum?'0'.repeat(64):crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');return Readable.from([Buffer.from(JSON.stringify([{tag_name:'v0.1.2',draft:false,prerelease:true,published_at:'2026-10-01T00:00:00Z',html_url:'https://github.com/DontMovePlease/Rovarin/releases/tag/v0.1.2',assets:[{name:'RovarinSetup.exe',state:'uploaded',size:fs.statSync(p).size,digest:'sha256:'+sha,browser_download_url:${JSON.stringify(url)}}]}]))]);}if(url===${JSON.stringify(url)})return fs.createReadStream(p);throw Error('Fixture source refused');};`;
  fs.writeFileSync(path.join(a,'fixture-transport.js'),transport);
  let updater=fs.readFileSync(path.join(a,'update-manager.js'),'utf8').replace('transport = request, channel = DEFAULT_CHANNEL','transport = require(\'./fixture-transport\'), channel = DEFAULT_CHANNEL');fs.writeFileSync(path.join(a,'update-manager.js'),updater);
  const helper=path.join(a,'scripts/installed-update.ps1');let h=fs.readFileSync(helper,'utf8');h=h.replace("@('/NORESTART',('/DIR=",`@('/VERYSILENT','/SUPPRESSMSGBOXES','/COMPONENTS=core','/TASKS=desktopPin','/GROUP=${group}','/NORESTART',('/DIR=`);fs.writeFileSync(helper,h);
 }
 let iss=fs.readFileSync(path.join(root,'packaging/Rovarin.iss'),'utf8').replace('#define AppVersion "0.1.1"','#define AppVersion "'+version+'"').replace('OutputDir=..\\dist','OutputDir=output');fs.writeFileSync(path.join(dir,'Rovarin.iss'),iss);
 execFileSync(path.join(root,'packaging/cache/inno/ISCC.exe'),['/Q',path.join(dir,'Rovarin.iss')],{windowsHide:true,timeout:150000,stdio:'pipe'});
 const info=JSON.parse(ps("$v=[Diagnostics.FileVersionInfo]::GetVersionInfo("+quote(path.join(dir,'output/RovarinSetup.exe'))+");@{version=('{0}.{1}.{2}.{3}' -f $v.FileMajorPart,$v.FileMinorPart,$v.FileBuildPart,$v.FilePrivatePart)}|ConvertTo-Json -Compress"));assert.strictEqual(info.version,version+'.0','Installer binary version must match verified update association');
 console.log('BUILT disposable real installer '+version+' (never dist/publish)');return path.join(dir,'output/RovarinSetup.exe');
}
async function main(){
 assert.strictEqual(process.platform,'win32');
 const locations=JSON.parse(ps(`@{desktop=[Environment]::GetFolderPath('Desktop');programs=[Environment]::GetFolderPath('Programs');startup=[Environment]::GetFolderPath('Startup')}|ConvertTo-Json -Compress`));
 if(!resume)assert.strictEqual(ps(`Test-Path -LiteralPath ${quote(registry)}`),'False','Existing installation: use clean VM');else assert.strictEqual(path.resolve(JSON.parse(ps(`Get-ItemProperty -LiteralPath ${quote(registry)}|Select-Object InstallLocation|ConvertTo-Json -Compress`)).InstallLocation),install);
 for(const p of (resume?[]:[path.join(locations.desktop,'Rovarin.lnk'),path.join(locations.startup,'Rovarin.lnk'),path.join(locations.programs,'Rovarin'),path.join(locations.programs,group),install,...(reuse?[]:[cache])]))assert(!fs.existsSync(p),'Existing fixture/Windows integration: '+p);
 for(const p of [path.join(locations.desktop,'PC Monitor.lnk'),path.join(locations.startup,'PC Monitor.lnk'),path.join(locations.programs,'PC Monitor')])assert(!fs.existsSync(p),'Existing legacy integration');
 const publishedHash=hash(path.join(root,'publish/RovarinSetup.exe'));if(!reuse)fs.mkdirSync(cache);if(fs.existsSync(report))fs.unlinkSync(report);fs.writeFileSync(control,JSON.stringify({badChecksum:true,allowUpgrade:false}));
 const newer=build('0.1.2'),baseline=build('0.1.1');let installed=false,complete=false,oldCookie;
 try{
  installed=true;if(!resume)ownedInstall(baseline,['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/COMPONENTS=core','/TASKS=desktopPin','/GROUP='+group,'/DIR="'+install+'"']);installed=true;
  const pins=require('../pin-manager'),configFile=path.join(data,'config.json'),initial=pins.readConfig(configFile);
  pins.writeConfig(configFile,{...initial,requireDesktopPin:false,autoCheckUpdates:false,e2ePreference:'preserve-this-setting'});
  fs.writeFileSync(path.join(data,'temperature-settings.json'),JSON.stringify({mode:'off'}));fs.writeFileSync(path.join(data,'onboarding-complete.json'),'{"completed":true}');
  const desktop=spawn(path.join(app,'Rovarin.exe'),[],{cwd:app,windowsHide:true,stdio:'ignore'});desktop.once('error',()=>{});
  for(let i=0;i<200;i++){if(fs.existsSync(path.join(data,'server-state.json')))break;await pause(250);}
  assert(fs.existsSync(path.join(data,'server-state.json')),'Native fixture backend failed to publish runtime');console.log('PASS fresh installed native baseline starts backend');
  await waitPhase('failure-tested',120);
  assert(!fs.existsSync(path.join(install,'updates/RovarinSetup.exe')),'Failed checksum cannot leave executable');
  const trustHash=hash(path.join(data,'desktop-trust.bin')),oldState=JSON.parse(fs.readFileSync(path.join(data,'server-state.json'))),oldBase='http://127.0.0.1:'+oldState.actualPort;
  const login=await fetch(oldBase+'/api/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:oldBase},body:JSON.stringify({pin:initial.pin})});assert.strictEqual(login.status,200);oldCookie=login.headers.getSetCookie().find(c=>c.startsWith('pc_monitor_session=')).split(';')[0];
  assert.strictEqual((await fetch(oldBase+'/api/metrics',{headers:{Cookie:oldCookie}})).status,200);
  assert.strictEqual(pins.readConfig(configFile).pin,initial.pin);assert.strictEqual(pins.readConfig(configFile).requireDesktopPin,false);assert.strictEqual(pins.readConfig(configFile).autoCheckUpdates,false);assert.strictEqual(fs.lstatSync(configFile).nlink,1);
  const permissions=JSON.parse(ps("$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User;$acl=Get-Acl -LiteralPath "+quote(configFile)+";@{ownerMatches=($acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -eq $sid.Value);publicAllow=@($acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])|Where-Object {$_.IdentityReference.Value -in @('S-1-1-0','S-1-5-11','S-1-5-32-545') -and $_.AccessControlType -eq 'Allow'}).Count}|ConvertTo-Json -Compress"));assert.strictEqual(permissions.ownerMatches,true);assert.strictEqual(permissions.publicAllow,0);
  console.log('PIN BASELINE CREATED: YES\nSETTINGS BASELINE CREATED: YES');console.log('PASS baseline native Settings persistence, single-link config, current-user ownership and no broad account grants');
  console.log('PASS actual installed 0.1.1 checksum failure leaves native/dashboard/backend usable');
  fs.writeFileSync(control,JSON.stringify({badChecksum:false,allowUpgrade:true}));
  const result=await waitPhase('reopened',210);assert.strictEqual(result.version,'0.1.2');await pause(2000);
  const config=pins.readConfig(configFile);assert.strictEqual(config.pin,initial.pin);assert.strictEqual(config.requireDesktopPin,false);assert.strictEqual(config.autoCheckUpdates,false);assert.strictEqual(fs.lstatSync(configFile).nlink,1);assert.strictEqual(config.e2ePreference,'preserve-this-setting');assert.strictEqual(hash(path.join(data,'desktop-trust.bin')),trustHash);assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data,'temperature-settings.json'))).mode,'off');assert(!fs.existsSync(path.join(app,'config.json')));
  const state=JSON.parse(fs.readFileSync(path.join(data,'server-state.json')));assert.notStrictEqual(state.pid,oldState.pid);const base='http://127.0.0.1:'+state.actualPort;
  assert.strictEqual((await fetch(base+'/api/metrics',{headers:{Cookie:oldCookie}})).status,401,'Old in-memory session is revoked across backend replacement');
  let cookie;const post=(route,body)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:base,...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const auth=await post('/api/login',{pin:initial.pin});assert.strictEqual(auth.status,200);cookie=auth.headers.getSetCookie().find(c=>c.startsWith('pc_monitor_session=')).split(';')[0];
  assert.strictEqual((await fetch(base+'/',{headers:{Cookie:cookie}})).status,200);const status=await fetch(base+'/api/updates',{headers:{Cookie:cookie}}).then(r=>r.json());assert.strictEqual(status.currentVersion,'0.1.2');
  assert.strictEqual((await post('/api/desktop/updates',{action:'download',url:'https://evil.invalid'})).status,401,'Normal web client never gains native update execution');
  const lease=await post('/api/monitoring/lease',{action:'acquire'});assert.strictEqual(lease.status,201);const leaseId=(await lease.json()).leaseId;const controller=new AbortController();try{const stream=await fetch(base+'/api/stream?lease='+leaseId,{headers:{Cookie:cookie},signal:controller.signal});assert.strictEqual(stream.status,200);assert(!(await stream.body.getReader().read()).done);}finally{controller.abort();await post('/api/monitoring/lease',{action:'release',leaseId});}
  const ip=Object.values(require('os').networkInterfaces()).flat().find(a=>a&&a.family==='IPv4'&&/^100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address));assert(ip,'Tailscale interface required for this release gate');const remote='http://'+ip.address+':'+state.actualPort;assert.strictEqual((await fetch(remote+'/api/metrics',{headers:{Cookie:cookie},signal:AbortSignal.timeout(5000)})).status,200);
  const counts=JSON.parse(ps(`$n=@(Get-CimInstance Win32_Process -Filter "Name='node.exe'"|Where-Object {$_.ExecutablePath -eq ${quote(path.join(install,'runtime/node.exe'))}});$d=@(Get-CimInstance Win32_Process -Filter "Name='Rovarin.exe'"|Where-Object {$_.ExecutablePath -eq ${quote(path.join(app,'Rovarin.exe'))}});@{nodes=$n.Count;desktop=$d.Count;listeners=@(Get-NetTCPConnection -State Listen|Where-Object {$_.OwningProcess -in $n.ProcessId}).Count}|ConvertTo-Json -Compress`));assert.deepStrictEqual(counts,{nodes:1,desktop:1,listeners:1});
  const registration=JSON.parse(ps(`Get-ItemProperty -LiteralPath ${quote(registry)}|Select-Object DisplayVersion,InstallLocation,@{Name='iconGroup';Expression={$_.'Inno Setup: Icon Group'}}|ConvertTo-Json -Compress`));assert.strictEqual(registration.DisplayVersion,'0.1.2');assert.strictEqual(path.resolve(registration.InstallLocation),install);
  assert(['Rovarin',group].includes(registration.iconGroup),'Unexpected Start Menu registration');
  for(const shortcut of [path.join(locations.desktop,'Rovarin.lnk'),path.join(locations.programs,registration.iconGroup,'Rovarin.lnk')]){assert(fs.existsSync(shortcut),'Registered owned shortcut is missing');const target=JSON.parse(ps(`$l=(New-Object -ComObject WScript.Shell).CreateShortcut(${quote(shortcut)});@{target=$l.TargetPath;working=$l.WorkingDirectory}|ConvertTo-Json -Compress`));assert.strictEqual(path.resolve(target.target),path.join(app,'Rovarin.exe'));assert.strictEqual(path.resolve(target.working),app);}
  assert(!fs.existsSync(path.join(locations.startup,'Rovarin.lnk')));
  console.log('FROM 0.1.1 -> TO 0.1.2 (disposable installed builds)');console.log('PIN PRESERVED: YES\nSETTINGS PRESERVED: YES\nTRUST PREFERENCE PRESERVED: YES\nROVARIN REOPENED: YES\nREMOTE ACCESS AFTER UPGRADE: YES (PC Tailscale interface; not physical remote peer)');console.log('PASS real native Update Now -> streamed verified installer -> installed-update -> Inno replacement -> reopened native app; auth/session policy, SSE/leases, registry/shortcuts, one backend/desktop/listener');complete=true;
 }catch(error){console.log('Fixture operation failed: '+error.message);throw error;}finally{
  if(installed){const r=JSON.parse(ps(`Get-ItemProperty -LiteralPath ${quote(registry)}|Select-Object InstallLocation|ConvertTo-Json -Compress`));assert.strictEqual(path.resolve(r.InstallLocation),install,'Refuse cleanup of any unrelated installation');ownedInstall(path.join(install,'unins000.exe'),['/VERYSILENT','/SUPPRESSMSGBOXES','/NORESTART','/FULLREMOVAL']);assert.strictEqual(ps(`Test-Path -LiteralPath ${quote(registry)}`),'False');assert(!fs.existsSync(path.join(locations.desktop,'Rovarin.lnk')));assert(!fs.existsSync(path.join(locations.programs,group,'Rovarin.lnk')));console.log('PASS owned fixture uninstall/registration/shortcut cleanup');}
  assert.strictEqual(hash(path.join(root,'publish/RovarinSetup.exe')),publishedHash,'Public installer must remain unchanged');
  if(!complete)console.log('E2E NOT COMPLETE; retained build artifacts for diagnosis');
 }
}
async function preserveDevelopmentShortcut(){
 const desktop=ps("[Environment]::GetFolderPath('Desktop')"),shortcut=path.join(desktop,'Rovarin.lnk');let saved;
 if(resume){saved=fs.readFileSync(path.join(root,'packaging/cache/updater-e2e-shortcut-backup.lnk'));}
 else if(fs.existsSync(shortcut)){
  const target=ps("$l=(New-Object -ComObject WScript.Shell).CreateShortcut("+quote(shortcut)+");$l.TargetPath");
  assert.strictEqual(path.resolve(target),path.join(root,'packaging/cache/desktop-preview/Rovarin.exe'),'Refuse to displace an unrelated shortcut');
  saved=fs.readFileSync(shortcut);fs.writeFileSync(path.join(root,'packaging/cache/updater-e2e-shortcut-backup.lnk'),saved);fs.unlinkSync(shortcut);
 }
 try{await main();}finally{if(saved){assert(!fs.existsSync(shortcut),'Fixture shortcut must be cleaned before restoring development shortcut');fs.writeFileSync(shortcut,saved);console.log('Development shortcut restored unchanged');}}
}
preserveDevelopmentShortcut().catch(e=>{console.error(e.message);process.exitCode=1});