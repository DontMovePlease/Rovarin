'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),os=require('node:os'),crypto=require('node:crypto');
const {spawn,execFileSync}=require('node:child_process');
const {AppManager,windowsOperation}=require('../app-manager');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'rovarin-startup-test-'));
const shell=path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe');
let backend,browser;
const navigationOnly=process.argv.includes('--navigation-only');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const row=(source,key,extra={})=>({locator:{source,key},source,name:key,displayName:key,fingerprint:crypto.createHash('sha256').update(source+key).digest('hex'),scope:'user',enabled:true,readOnly:false,...extra});
const rows=[row('registry-user','Fixture User'),row('registry-machine','Fixture Machine',{scope:'machine',requiresElevation:true}),row('scheduled-task','\\Fixture Task',{displayName:'Fixture Task',requiresElevation:true,taskManageable:true}),row('packaged-startup','Fixture_family|iCloudCKKSStartupTask',{displayName:'iCloud Keychain',readOnly:true}),row('packaged-startup','Policy_family|Task',{displayName:'Policy Package',readOnly:true,policyControlled:true}),row('app-service','Fixture Service',{scope:'machine',readOnly:true}),row('registry-user','Unknown State',{enabled:null})];
function ps(file,args=[]){return execFileSync(shell,['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file,...args],{windowsHide:true,encoding:'utf8',timeout:90000});}
async function mocked(){
  let response={success:true,code:'completed',enabled:false},calls=0;
  const manager=new AppManager({operation:async request=>{calls++;return request.action==='startup-inventory'?{success:true,items:rows}:request.action==='startup-settings'?{success:true,code:'settings-opened',changed:false}:response;}});
  const inventory=await manager.startupInventory(true);
  assert.deepEqual(inventory.items.map(x=>x.controlMode),['direct','local-approval','local-approval','windows-settings','unsupported','unsupported','unsupported']);
  assert(!JSON.stringify(inventory).includes('locator'));assert(!JSON.stringify(inventory).includes('fingerprint'));
  const user=inventory.items[0],task=inventory.items[2],pkg=inventory.items[3];
  await assert.rejects(manager.toggleStartup(task.id,false),/local-approval-required/);
  await assert.rejects(manager.toggleStartup(task.id,false,{localApproval:true,authorize:()=>false}),/authentication-required/);
  await assert.rejects(manager.toggleStartup(inventory.items[6].id,false),/elevation-required/);
  assert.deepEqual(await manager.openStartupSettings(pkg.id),{success:true,code:'settings-opened',changed:false});
  assert.equal(manager.startupRows.get(pkg.id).enabled,true,'opening Settings never changes reported state');
  await assert.rejects(manager.openStartupSettings(inventory.items[4].id),/unsupported/);
  await assert.rejects(manager.openStartupSettings(user.id),/unsupported/);
  await assert.rejects(manager.openStartupSettings(pkg.id,()=>false),/authentication-required/);
  response={success:true,code:'completed'};
  await assert.rejects(manager.toggleStartup(user.id,false),/startup-state-unconfirmed/);
  assert.equal(manager.startupRows.get(user.id).enabled,true);
  response={success:true,code:'completed',enabled:true};
  await assert.rejects(manager.toggleStartup(user.id,false),/startup-state-unconfirmed/);
  response={success:false,code:'cancelled'};
  await assert.rejects(manager.toggleStartup(task.id,false,{localApproval:true}),/cancelled/);
  assert.equal(manager.startupRows.get(task.id).enabled,true);
  response={success:true,code:'completed',enabled:false};
  assert.equal((await manager.toggleStartup(task.id,false,{localApproval:true})).enabled,false);
  assert.equal(manager.startupCache,null,'task mutation forces a fresh inventory/identity');
  const denied=await windowsOperation({action:'startup-toggle',localApproval:true,locator:{source:'scheduled-task',key:'\\NotARealTask'},fingerprint:'a'.repeat(64),enabled:false},undefined,()=>false);
  assert.equal(denied.code,'authentication-required','revoked session never reaches compiler/UAC');
  assert(calls>0);
  console.log('PASS startup capability/privacy contracts, local approval/auth revocation, cancellation, unknown/missing/contradictory readback and Settings is not a toggle');
}
function nativeFixtures(){
  if(process.platform!=='win32')return;
  const name='StartupCoverageFixture-'+crypto.randomBytes(16).toString('hex');
  try{process.stdout.write(ps(path.join(__dirname,'startup-manager-fixture.ps1'),['-Directory',temp,'-TaskName',name]));}
  finally{process.stdout.write(ps(path.join(__dirname,'startup-manager-fixture.ps1'),['-Directory',temp,'-TaskName',name,'-Cleanup']));}
  const script=path.join(temp,'registry-and-settings.ps1');
  const quote=value=>"'"+value.replace(/'/g,"''")+"'";
  fs.writeFileSync(script,`$ErrorActionPreference='Stop'
$t=$null;$e=$null;$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(__dirname,'app-manager.ps1'))},[ref]$t,[ref]$e)
if($e.Count){throw 'Invalid production helper syntax'}
foreach($f in $ast.FindAll({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Fingerprint','Set-StartupApproved','Is-StartupApproved','Startup-Toggle','Open-StartupSettings')},$true)){Invoke-Expression $f.Extent.Text}
$name=${quote(name)};$run='Software\\Microsoft\\Windows\\CurrentVersion\\Run';$approval='Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run'
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($run);$approve=$null
try{
 if($key.GetValueNames() -contains $name){throw 'Fixture collision'}
 $command='C:\\StartupCoverageFixtureNeverRun-'+$name+'.exe';$key.SetValue($name,$command)
 foreach($desired in @($false,$true,$false)){
  $r=Startup-Toggle ([pscustomobject]@{locator=@{source='registry-user';key=$name};fingerprint=(Fingerprint ('registry-user|'+$name+'|'+$command));enabled=$desired})
  if(-not $r.success -or $r.enabled -ne $desired -or (Is-StartupApproved 'Run' $name 'HKCU:') -ne $desired){throw 'Owned Run/approval readback failed'}
 }
 $a=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($approval,$true)
 try{$a.SetValue($name,[byte[]]@(2),[Microsoft.Win32.RegistryValueKind]::Binary)}finally{$a.Dispose()}
 if($null -ne (Is-StartupApproved 'Run' $name 'HKCU:')){throw 'Truncated approval guessed enabled'}
 $refused=$false;try{Set-StartupApproved 'Run' $name $true}catch{$refused=$true};if(-not $refused){throw 'Unknown approval state was overwritten'}
 if($key.GetValue($name) -cne $command){throw 'Startup command changed'}
}finally{
 if($key.GetValue($name) -ceq $command){$key.DeleteValue($name,$false)}else{throw 'Fixture command changed; retained'}
 $key.Dispose();$approve=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($approval,$true)
 if($approve){try{$approve.DeleteValue($name,$false)}finally{$approve.Dispose()}}
}
$script:opened=0
function Get-AppxPackage {[pscustomobject]@{PackageFamilyName='Fixture_family';PackageFullName='Fixture_1'}}
function Get-AppxPackageManifest {[xml]'<Package><Extension Category="windows.startupTask"><StartupTask TaskId="Task"/></Extension></Package>'}
function Start-Process {param([string]$FilePath) if($FilePath -cne 'ms-settings:startupapps'){throw 'Unexpected URI'};$script:opened++}
$request=[pscustomobject]@{locator=@{source='packaged-startup';key='Fixture_family|Task'};fingerprint=(Fingerprint 'Fixture_family|Task')}
$r=Open-StartupSettings $request
if(-not $r.success -or $r.changed -ne $false -or $script:opened -ne 1){throw 'Settings handoff contract'}
$request.locator.key='Fixture_family|Missing';$request.fingerprint=Fingerprint $request.locator.key
if((Open-StartupSettings $request).success -or $script:opened -ne 1){throw 'Stale package task opened settings'}
$request.locator.key='Fixture_family|Task';$request.fingerprint='a'*64
if((Open-StartupSettings $request).success -or $script:opened -ne 1){throw 'Stale package identity accepted'}
'PASS real owned HKCU startup approval disable/enable/disable with exact readback, registration preservation and cleanup; fixed Windows Settings URI and stale identity refusal with launch doubled'
`);
  process.stdout.write(ps(script));
}
async function httpAndUi(){
  const app=path.join(temp,'app'),data=path.join(temp,'data');fs.mkdirSync(app);fs.mkdirSync(data);
  for(const file of [...require('../server-lifecycle').ROOT_SERVER_FILES,'package.json'])fs.copyFileSync(path.join(root,file),path.join(app,file));
  fs.cpSync(path.join(root,'public'),path.join(app,'public'),{recursive:true});
  fs.writeFileSync(path.join(app,'installation.json'),'{}');
  const pin=String(crypto.randomInt(100000,1000000));require('../pin-manager').writeConfig(path.join(data,'config.json'),{pin,autoCheckUpdates:false});
  const state=path.join(temp,'ui-state.json');fs.writeFileSync(state,JSON.stringify({packageEnabled:true,mode:'normal'}));
  const preload=path.join(temp,'preload.js');
  fs.writeFileSync(preload,`const fs=require('fs'),Module=require('module');const original=Module._load;const file=${JSON.stringify(path.join(app,'app-manager.js'))};const real=require(file);const rows=${JSON.stringify(rows)};class FixtureManager extends real.AppManager{constructor(options){super({...options,operation:async r=>{const s=JSON.parse(fs.readFileSync(${JSON.stringify(state)}));if(r.action==='inventory')return {success:true,apps:[],packagesAvailable:false};if(r.action==='startup-inventory')return {success:true,items:rows.map(x=>x.locator.key==='Fixture_family|iCloudCKKSStartupTask'?{...x,enabled:s.packageEnabled}:x)};if(r.action==='startup-settings')return {success:true,code:'settings-opened',changed:false};if(r.action==='startup-toggle'){if(s.mode==='cancelled')return {success:false,code:'cancelled'};if(s.mode==='unconfirmed')return {success:true,code:'completed'};const x=rows.find(x=>x.locator.source===r.locator.source&&x.locator.key===r.locator.key);x.enabled=r.enabled;return {success:true,code:'completed',enabled:r.enabled};}throw Error('Fixture refuses non-startup mutation');}})}}Module._load=function(r,p,m){const value=original.call(this,r,p,m);return value===real?{...real,AppManager:FixtureManager}:value;};`);
  let output='';backend=spawn(process.execPath,['--require',preload,path.join(app,'server.js')],{cwd:app,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'0',PC_MONITOR_PIN:'',NODE_OPTIONS:''}});
  backend.stdout.on('data',x=>output+=x);backend.stderr.on('data',x=>output+=x);
  let base;for(let i=0;i<150;i++){const ready=output.match(/Localhost access: (http:\/\/127\.0\.0\.1:\d+)/);if(ready){base=ready[1];break;}if(backend.exitCode!==null)throw Error('Startup fixture backend exited');await pause(100);}assert(base);
  const login=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json'},body:JSON.stringify({pin})});assert.equal(login.status,200);
  const cookie=login.headers.getSetCookie().find(x=>x.startsWith('pc_monitor_session=')).split(';')[0],headers={Cookie:cookie,Origin:base,'Content-Type':'application/json'};
  const inventory=await fetch(base+'/api/apps/startup',{headers}).then(r=>r.json()),pkg=inventory.items.find(x=>x.controlMode==='windows-settings');
  const post=(route,body,extra={})=>fetch(base+route,{method:'POST',headers:{...headers,...extra},body:JSON.stringify(body)});
  const request={id:pkg.id,confirmation:'open-startup-settings'},settings='/api/apps/startup/settings';
  assert.equal((await post(settings,request,{Cookie:''})).status,401);
  assert.equal((await post(settings,request,{Origin:'https://attacker.invalid'})).status,403);
  for(const bad of [{...request,uri:'anything'},{...request,callerSid:'spoofed'},{...request,enabled:true},{...request,pin},{...request,confirmation:'change-startup'},{...request,id:'command'}])assert.equal((await post(settings,bad)).status,400);
  assert.equal((await post('/api/apps/startup/toggle',{id:inventory.items.find(x=>x.source==='scheduled-task').id,enabled:false,confirmation:'change-startup'})).status,400,'actual startup changes still require PIN');
  assert.equal((await post(settings,{...request,id:'f'.repeat(64)})).status,404);
  assert.deepEqual(await (await post(settings,request)).json(),{success:true,code:'settings-opened',changed:false});
  assert.equal((await post('/api/apps/startup/toggle',{id:pkg.id,pin,confirmation:'change-startup',enabled:false})).status,403);
  const task=inventory.items.find(x=>x.source==='scheduled-task'),toggle={id:task.id,pin,enabled:false,confirmation:'change-startup'};
  const wrongPin=pin==='999999'?'888888':'999999';
  assert.equal((await post('/api/apps/startup/toggle',{...toggle,pin:wrongPin})).status,401,'a valid session does not replace PIN confirmation for startup changes');
  assert.equal((await post('/api/apps/startup/toggle',toggle)).status,409);
  fs.writeFileSync(state,JSON.stringify({packageEnabled:true,mode:'unconfirmed'}));
  assert.equal((await post('/api/apps/startup/toggle',{...toggle,confirmation:'change-startup-with-local-approval'})).status,409);
  fs.writeFileSync(state,JSON.stringify({packageEnabled:true,mode:'normal'}));
  console.log('PASS actual startup HTTP session/origin/typed-ID guards; Settings navigation needs no PIN; startup changes retain current-PIN/local-approval/unconfirmed-state guards; no host action adapter');
  const playwright=process.env.ROVARIN_PLAYWRIGHT_PATH;
  assert(playwright,'Set ROVARIN_PLAYWRIGHT_PATH to the existing external Playwright installation');
  browser=await require(playwright).chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
  const context=await browser.newContext();await context.request.post(base+'/api/login',{headers:{Origin:base},data:{pin}});
  const page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  for(const width of [320,390,900,1440]){
    fs.writeFileSync(state,JSON.stringify({packageEnabled:true,mode:'normal'}));
    await page.setViewportSize({width,height:850});await page.goto(base);await page.waitForFunction(()=>typeof showAppPage==='function');await page.evaluate(()=>showAppPage('appsPage'));await page.locator('#appsTabStartup').click();
    await page.waitForFunction(()=>document.querySelectorAll('.startup-row').length===7);
    await page.locator('#startupRefresh').click();await page.waitForFunction(()=>document.querySelector('#startupList').getAttribute('aria-busy')==='false');
    const packaged=page.locator('.startup-row').filter({has:page.getByRole('heading',{name:'iCloud Keychain',exact:true})});
    assert((await page.locator('#startupStatus').innerText()).includes('1 in Windows Settings'));
    assert((await packaged.innerText()).includes('Enabled'));
    await packaged.getByRole('button',{name:'Manage in Windows settings: iCloud Keychain'}).click();
    await page.waitForFunction(()=>document.querySelector('#startupStatus').textContent.includes('No startup change has been confirmed'));
    assert.equal(await page.locator('#startupConfirmDialog').evaluate(x=>x.open),false,'Settings navigation never opens the PIN dialog');
    assert.equal(await page.locator('#startupConfirmPin').inputValue(),'');
    assert((await page.locator('#startupStatus').innerText()).includes('No startup change has been confirmed'));
    assert((await packaged.innerText()).includes('Enabled'),'opening Settings does not optimistically toggle');
    fs.writeFileSync(state,JSON.stringify({packageEnabled:false,mode:'normal'}));
    await packaged.getByRole('button',{name:'Verify Windows state',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('#startupStatus').textContent.includes('Verified Windows state for iCloud Keychain: Disabled'));
    assert((await packaged.innerText()).includes('Disabled'));
    await page.locator('#startupControlFilter').check();assert.equal(await page.locator('.startup-row').count(),3);await page.locator('#startupControlFilter').uncheck();
    assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),'startup UI fits viewport '+width);
    assert.equal(await page.locator('.startup-associated-services').count(),1);
  }
  assert.deepEqual(errors,[]);
  console.log('PASS actual desktop/phone-width startup UI: iCloud Keychain, direct/approval/Settings/unsupported labels, honest handoff, fresh state verification, filters and no overflow');
}
(async()=>{if(!navigationOnly){await mocked();nativeFixtures();}await httpAndUi();})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{
  if(browser)await browser.close();
  if(backend&&backend.exitCode===null){const done=new Promise(resolve=>backend.once('close',resolve));backend.kill();await done;}
  assert(path.resolve(temp).startsWith(fs.realpathSync.native(os.tmpdir())+path.sep));
  if(navigationOnly)console.log('Navigation-only artifacts retained: '+temp);
  else fs.rmSync(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
});
