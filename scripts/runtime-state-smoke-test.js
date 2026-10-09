'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),{execFileSync}=require('child_process');
const pins=require('../pin-manager'),root=path.resolve(__dirname,'..');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-runtime-state-'));
function command(text) { const file=path.join(temp,'command.ps1'); fs.writeFileSync(file,text); return call(file); }
const call=(script,args=[],env=process.env)=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',script,...args],{env:{...env,PSModulePath:path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/Modules')},windowsHide:true,encoding:'utf8',timeout:15000});
try{
 const app=path.join(temp,'app'),scripts=path.join(app,'scripts');fs.mkdirSync(scripts,{recursive:true});
 const env={...process.env,LOCALAPPDATA:temp};
 for(const name of ['dashboard-runtime.ps1','migrate-development-state.ps1','native-startup.ps1'])fs.copyFileSync(path.join(root,'scripts',name),path.join(scripts,name));
 fs.copyFileSync(path.join(root,'pin-manager.js'),path.join(app,'pin-manager.js'));
 fs.writeFileSync(path.join(app,'.rovarin-development-state.json'),'{"schema":1}');
 const old=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=temp;let file;try{file=pins.developmentConfigFile(app)}finally{process.env.LOCALAPPDATA=old}
 const data=path.dirname(file);fs.mkdirSync(data,{recursive:true});pins.writeConfig(file,{pin:'314159',retained:true});
 // Fixture ownership/ACL only; production migration never widens permissions.
 command(`$p='${data.replace(/'/g,"''")}';$a=New-Object Security.AccessControl.DirectorySecurity;$s=[Security.Principal.WindowsIdentity]::GetCurrent().User;$a.SetOwner($s);$a.SetAccessRuleProtection($true,$false);foreach($i in @($s,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')))){$a.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule($i,'FullControl','ContainerInherit,ObjectInherit','None','Allow')))};Set-Acl -LiteralPath $p -AclObject $a`);
 const prefs=Buffer.from('{"fixture":true}'),source=path.join(app,'quick-launch.json'),dest=path.join(data,'quick-launch.json');fs.writeFileSync(source,prefs);
 fs.writeFileSync(dest,'{"conflict":true}');
 assert.throws(()=>call(path.join(scripts,'migrate-development-state.ps1'),[],env));assert(fs.readFileSync(source).equals(prefs),'conflict retains source');assert.strictEqual(fs.readFileSync(dest,'utf8'),'{"conflict":true}');fs.unlinkSync(dest);
 const log=call(path.join(scripts,'migrate-development-state.ps1'),[],env);assert(!log.includes('314159'));assert(fs.readFileSync(dest).equals(prefs));assert(!fs.existsSync(source));assert.strictEqual(pins.readConfig(file).pin,'314159');
 assert(call(path.join(scripts,'migrate-development-state.ps1'),[],env).includes('complete'),'migration is retry-safe');
 fs.linkSync(dest,source);assert.throws(()=>call(path.join(scripts,'migrate-development-state.ps1'),[],env));assert(fs.existsSync(source));fs.unlinkSync(source);
 console.log('PASS fixed development state migration: exact preservation, conflict rejection, linked-file rejection, retry, no PIN changes');
 // Execute the production startup helper against an isolated folder by adapting the TEST COPY only.
 const folder=path.join(temp,'startup');fs.mkdirSync(folder);fs.writeFileSync(path.join(app,'run_hidden.vbs'),'fixture');
 let startup=fs.readFileSync(path.join(scripts,'native-startup.ps1'),'utf8');startup=startup.replace("[Environment]::GetFolderPath('Startup')","'"+folder.replace(/'/g,"''")+"'").replace("$key='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\StartupFolder'","$key='HKCU:\\Software\\RovarinTestNeverCreated\\StartupApproved'");fs.writeFileSync(path.join(scripts,'native-startup.ps1'),startup);
 const run=action=>JSON.parse(call(path.join(scripts,'native-startup.ps1'),['-Action',action],env));
 assert.strictEqual(run('Status').enabled,false);assert.strictEqual(run('Enable').enabled,true);assert.strictEqual(run('Status').enabled,true);assert.strictEqual(run('Disable').enabled,false);assert(!fs.existsSync(path.join(folder,'Rovarin Development.lnk')));
 const foreign=path.join(folder,'Rovarin Development.lnk');command(`$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${foreign.replace(/'/g,"''")}');$s.TargetPath='C:\\Windows\\notepad.exe';$s.Save()`);assert.throws(()=>run('Disable'));assert(fs.existsSync(foreign),'unrelated startup entry survives');
 assert.throws(()=>call(path.join(scripts,'native-startup.ps1'),['-Action','Arbitrary'],env));
 console.log('PASS startup actual-state ON/OFF, normal-user shortcut, conflicting registration untouched, fixed-action validation; no host startup changed');
 const frontend=fs.readFileSync(path.join(root,'public/app.js'),'utf8'),html=fs.readFileSync(path.join(root,'public/index.html'),'utf8'),native=fs.readFileSync(path.join(root,'packaging/DesktopShell.cs'),'utf8');
 assert(html.slice(html.indexOf('id="nativeSecurityControls"'),html.indexOf('id="generalSettingsPanel"')).includes('id="startWithWindows"'));assert(frontend.includes("if (!nativeSecurity) return;"));assert(native.includes('await NativeRequestAsync("/api/desktop/security", new { action = "status" });'));assert(native.includes('startupBusy || busy || exiting || loginPresentation'));assert(!fs.readFileSync(path.join(root,'scripts/desktop-preview.ps1'),'utf8').includes('CreateShortcut'));
 console.log('PASS native-only authenticated startup control, no remote endpoint, no generated root shortcut');
}finally{assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});}