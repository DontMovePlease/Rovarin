/* Disposable Windows DPAPI + real HTTP persistence/integration fixtures. */
'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const {spawn,execFileSync}=require('child_process');
const pins=require('../pin-manager');
const root=path.resolve(__dirname,'..'),pause=ms=>new Promise(r=>setTimeout(r,ms));
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-pin-lifecycle-')),app=path.join(temp,'app'),data=path.join(temp,'data');
let child,base,output='',checks=0;
const check=(actual,expected,label)=>{assert.deepStrictEqual(actual,expected,label);checks++;};
const fixturePin=()=>pins.generatePin();
async function start(preload){
  output='';base=null;
  const env={...process.env,PORT:'0',PC_MONITOR_PIN:'',NODE_OPTIONS:'',NODE_PATH:''};
  child=spawn(process.execPath,[...(preload?['--require',preload]:[]),path.join(app,'server.js')],{cwd:app,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
  child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
  for(let i=0;i<180;i++){const match=output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);if(match){base='http://127.0.0.1:'+match[1];return;}if(child.exitCode!==null)break;await pause(100);}
  throw Error('Disposable PIN backend did not start: '+output);
}
async function stop(){if(child&&child.exitCode===null){const closed=new Promise(r=>child.once('close',r));child.kill();await closed;}}
(async()=>{
  assert.strictEqual(process.platform,'win32','Windows DPAPI integration requires Windows');
  fs.mkdirSync(app);fs.mkdirSync(data);fs.mkdirSync(path.join(app,'scripts'));
  for(const name of fs.readdirSync(root).filter(n=>/\.js$/.test(n)))fs.copyFileSync(path.join(root,name),path.join(app,name));
  fs.copyFileSync(path.join(root,'package.json'),path.join(app,'package.json'));
  fs.cpSync(path.join(root,'public'),path.join(app,'public'),{recursive:true});
  for(const name of ['native-trust.ps1','dashboard-runtime.ps1'])fs.copyFileSync(path.join(root,'scripts',name),path.join(app,'scripts',name));
  fs.writeFileSync(path.join(app,'installation.json'),JSON.stringify({version:'0.6.0'}));
  const file=path.join(data,'config.json');
  assert.throws(()=>pins.readConfig(file));checks++;
  const retained=path.join(temp,'retained-data');fs.mkdirSync(retained);fs.writeFileSync(path.join(retained,'temperature-settings.json'),'{}');assert.throws(()=>pins.prepareEnrollment(path.join(retained,'config.json')),/Existing local data/);checks++;
  check(fs.readFileSync(path.join(retained,'temperature-settings.json'),'utf8'),'{}','missing PIN never replaces retained settings');
  pins.prepareEnrollment(file,true);check(!!pins.readConfig(file).pinSetup,true,'fresh setup required');
  assert.throws(()=>pins.prepareEnrollment(file));checks++;
  const trust=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(app,'scripts/native-trust.ps1')],{windowsHide:true,timeout:20000,encoding:'utf8'}).trim();
  await start();
  const request=(route,body,cookie='',key=trust,origin=base)=>fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(key?{'X-PC-Monitor-Desktop':key}:{}),...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
  const cookieOf=r=>r.headers.getSetCookie().find(x=>x.startsWith('pc_monitor_session=')).split(';')[0];
  const status=cookie=>request('/api/desktop/pin',{action:'status'},cookie).then(r=>r.json());
  const login=pin=>request('/api/login',{pin},'',null);
  const metric=cookie=>fetch(base+'/api/metrics',{headers:{Cookie:cookie}}).then(r=>r.status);
  check((await fetch(base+'/').then(r=>r.text())).includes('name="rovarin-pin-setup" content="true"'),true,'pending login metadata');
  check((await login(fixturePin())).status,409,'no PIN authentication during setup');
  check(await metric(''),401,'no protected access during setup');
  check((await request('/api/desktop/auth',{})).status,401,'native automatic auth cannot bypass setup');
  const newPin='0'+fixturePin().slice(1), enrollment={action:'enroll',newPin,confirmPin:newPin,revision:(await status('')).revision};
  check((await request('/api/desktop/pin',enrollment,'',null)).status,401,'localhost browser cannot enroll');
  check((await request('/api/desktop/pin',enrollment,'','A'.repeat(43)+'=')).status,401,'forged proof refused');
  check((await request('/api/desktop/pin',enrollment,'',trust,'http://evil.invalid')).status,403,'cross-origin enrollment refused');
  check((await fetch(base+'/api/desktop/pin')).status,401,'GET cannot enroll');
  for(const invalid of ['','12345','1234567','12x456','123456\n'])check((await request('/api/desktop/pin',{...enrollment,newPin:invalid,confirmPin:invalid})).status,409,'six-digit validation');
  check((await request('/api/desktop/pin',{...enrollment,confirmPin:fixturePin()})).status,409,'confirmation mismatch');
  const races=await Promise.all([request('/api/desktop/pin',enrollment),request('/api/desktop/pin',enrollment)]);
  check(races.map(r=>r.status).sort(),[200,409],'one concurrent enrollment wins');
  check(pins.readConfig(file).pin,newPin,'leading zero survives');
  check(fs.readFileSync(file,'utf8').includes(newPin),false,'no plaintext credential on disk');
  await stop();await start();
  const first=await login(newPin);check(first.status,200,'setup persisted across restart');let remote=cookieOf(first);
  let state=await status(remote);
  const next=fixturePin();
  check((await request('/api/desktop/pin',{action:'change',currentPin:newPin,newPin:next,confirmPin:next,revision:state.revision},remote,null)).status,401,'browser cannot change PIN');
  check((await request('/api/desktop/pin',{action:'change',currentPin:'999999'===newPin?'888888':'999999',newPin:next,confirmPin:next,revision:state.revision},remote)).status,401,'current PIN required');
  // Establish a native automatic session too; it must not survive rotation.
  check((await request('/api/desktop/security',{action:'preference',requireDesktopPin:false,confirmed:true},remote)).status,200,'native preference');
  const auto=await request('/api/desktop/auth',{});check(auto.status,200,'automatic native session created');const nativeOld=cookieOf(auto);
  const changed=await request('/api/desktop/pin',{action:'change',currentPin:newPin,newPin:next,confirmPin:next,revision:state.revision},remote);
  check(changed.status,200,'verified rotation committed');const replacement=cookieOf(changed);
  check(await metric(remote),401,'old remote revoked');check(await metric(nativeOld),401,'old native revoked');check(await metric(replacement),200,'verified caller replacement session');
  check((await login(newPin)).status,401,'old PIN rejected');check((await login(next)).status,200,'new PIN authenticates');
  const staleRevision=state.revision;state=await status(replacement);
  assert.throws(()=>pins.updatePin(file,{action:'reset',newPin:fixturePin(),confirmPin:'000000',revision:staleRevision}));checks++;
  const recoveryRevision=pins.credentialRevision(pins.readConfig(file)),recovered=fixturePin();
  const reset=spawn(process.execPath,[path.join(app,'pin-manager.js'),'--reset-pin'],{cwd:app,windowsHide:true,stdio:['pipe','pipe','pipe']});
  let resetOut='';reset.stdout.on('data',x=>resetOut+=x);reset.stderr.on('data',x=>resetOut+=x);reset.stdin.end(JSON.stringify({newPin:recovered,confirmPin:recovered,revision:recoveryRevision}));
  check(await new Promise(r=>reset.once('close',r)),0,'local stdin recovery reset');check(resetOut.includes(recovered),false,'recovery does not print PIN');
  check(await metric(replacement),401,'recovery revokes replacement native session');check((await login(next)).status,401,'pre-recovery PIN rejected');check((await login(recovered)).status,200,'recovery PIN works');
  assert.throws(()=>pins.updatePin(file,{action:'reset',newPin:next,confirmPin:next,revision:recoveryRevision}),/changed/);checks++;
  await stop();
  // Upgrade: retain legacy length, all preferences and native proof; copying
  // current source/build inputs must never initialize or overwrite user data.
  const legacy=pins.generatePin(undefined,12),legacyConfig={...pins.readConfig(file),pin:legacy,kept:{setting:true}};
  delete legacyConfig.pinCredential;delete legacyConfig.pinVersion;delete legacyConfig.pinInitializedId;delete legacyConfig.pinLifecycleVersion;
  // Deliberately model an old plaintext-format fixture, never a new product PIN.
  fs.writeFileSync(file,JSON.stringify(legacyConfig));
  const before=fs.readFileSync(file);for(const name of ['server.js','pin-manager.js','package.json'])fs.copyFileSync(path.join(root,name),path.join(app,name));
  check(fs.readFileSync(file),before,'upgrade/rebuild preserves exact config bytes');
  await start();check((await login(legacy)).status,200,'legacy twelve-digit login after upgrade');
  check(pins.readConfig(file).kept,{setting:true},'settings preserved');
  const legacyCookie=cookieOf(await login(legacy));check((await status(legacyCookie)).success,true,'native trust preserved');
  pins.writeConfig(file,{...pins.readConfig(file),legacyPreference:true});
  check(await metric(legacyCookie),200,'same-PIN protected-storage migration does not revoke a session');
  check(pins.readConfig(file).pin,legacy,'same-PIN storage migration preserves PIN');
  check(fs.readFileSync(file,'utf8').includes(legacy),false,'migrated fixture is protected at rest');
  await stop();
  const race=path.join(app,'credential-race.cjs');
  fs.writeFileSync(race,`const p=require('./pin-manager'),original=p.updatePin;p.updatePin=(file,request)=>{const committed=original(file,request);if(request.action==='change'){const newer=p.generatePin(committed.pin);original(file,{action:'reset',newPin:newer,confirmPin:newer,revision:p.credentialRevision(committed)});}return committed;};`);
  await start(race);
  const raceCookie=cookieOf(await login(legacy)),raceState=await status(raceCookie),racePin=fixturePin();
  const raced=await request('/api/desktop/pin',{action:'change',currentPin:legacy,newPin:racePin,confirmPin:racePin,revision:raceState.revision},raceCookie);
  check(raced.status,409,'concurrent Recovery must prevent stale native replacement session');
  check(raced.headers.getSetCookie().some(value=>value.startsWith('pc_monitor_session=')),false,'stale change does not issue a session cookie');
  check(await metric(raceCookie),401,'concurrent reset revokes native caller');
  let latest=pins.readConfig(file).pin;const latestLogin=await login(latest);check(latestLogin.status,200,'latest recovery PIN remains usable');
  let currentCookie=cookieOf(latestLogin);
  await stop();pins.writeConfig(file,{...pins.readConfig(file),desktopLocked:true});
  const loginRace=path.join(app,'login-race.cjs');
  fs.writeFileSync(loginRace,`const p=require('./pin-manager'),write=p.writeConfig;p.writeConfig=(file,value)=>{write(file,value);if(value.desktopLocked===false){const current=p.readConfig(file),next=p.generatePin(current.pin);p.updatePin(file,{action:'reset',newPin:next,confirmPin:next,revision:p.credentialRevision(current)});}};`);
  await start(loginRace);const interruptedLogin=await login(latest);
  check(interruptedLogin.status,409,'concurrent Recovery cannot turn old-PIN login into a current session');
  check(interruptedLogin.headers.getSetCookie().some(value=>value.startsWith('pc_monitor_session=')),false,'raced login issues no session cookie');
  latest=pins.readConfig(file).pin;const latestAfterLogin=await login(latest);check(latestAfterLogin.status,200,'latest PIN works after raced login');currentCookie=cookieOf(latestAfterLogin);
  const currentRevision=(await status(currentCookie)).revision;
  for(let i=0;i<5;i++)await request('/api/desktop/pin',{action:'change',currentPin:pins.generatePin(latest),newPin:next,confirmPin:next,revision:currentRevision},currentCookie);
  check((await login(latest)).status,429,'current-PIN failures share lockout budget');
  await stop();
  fs.writeFileSync(file,'{broken');assert.throws(()=>pins.readConfig(file));assert.throws(()=>pins.prepareEnrollment(file));checks+=2;
  fs.unlinkSync(file);assert.throws(()=>pins.prepareEnrollment(file));checks++;
  const broken=spawn(process.execPath,[path.join(app,'server.js')],{cwd:app,windowsHide:true,env:{...process.env,PORT:'0',PC_MONITOR_PIN:''},stdio:'ignore'});
  check(await new Promise(r=>broken.once('close',r)),1,'missing installed credentials fail closed');check(fs.existsSync(file),false,'no automatic replacement');
  fs.unlinkSync(path.join(app,'installation.json'));const unknown=spawn(process.execPath,[path.join(app,'server.js')],{cwd:app,windowsHide:true,env:{...process.env,PORT:'0',PC_MONITOR_PIN:''},stdio:'ignore'});check(await new Promise(r=>unknown.once('close',r)),1,'unmarked startup cannot invent installation state');check(fs.existsSync(path.join(app,'config.json')),false,'unmarked startup never generates a replacement PIN');
  check(output.includes(recovered)||output.includes(legacy)||output.includes(trust),false,'no secrets in backend output');
  // A missing/tampered DPAPI birth record cannot authorize first enrollment.
  const other=path.join(temp,'interrupted');fs.mkdirSync(other);const interrupted=path.join(other,'config.json');pins.prepareEnrollment(interrupted);
  const pending=pins.readConfig(interrupted);fs.renameSync(path.join(other,'pin-enrollment.json'),path.join(other,'saved.bin'));
  assert.throws(()=>pins.readConfig(interrupted));checks++;fs.renameSync(path.join(other,'saved.bin'),path.join(other,'pin-enrollment.json'));
  check(!!pins.readConfig(interrupted).pinSetup,true,'interrupted valid setup may resume');
  const pendingPin=fixturePin();pins.updatePin(interrupted,{action:'enroll',newPin:pendingPin,confirmPin:pendingPin,revision:pins.credentialRevision(pending)});
  const completedBytes=fs.readFileSync(interrupted),oldPending={pinSetup:pending.pinSetup,requireDesktopPin:true};
  fs.writeFileSync(interrupted,JSON.stringify(oldPending));assert.throws(()=>pins.readConfig(interrupted),/already completed/);checks++;
  fs.writeFileSync(interrupted,completedBytes);
  const interruptedDir=path.join(temp,'power-loss');fs.mkdirSync(interruptedDir);const powerLoss=path.join(interruptedDir,'config.json');pins.prepareEnrollment(powerLoss);
  const selected=fixturePin(),pendingRevision=pins.credentialRevision(pins.readConfig(powerLoss)),rename=fs.renameSync;
  try { fs.renameSync=(from,to)=>{if(to===powerLoss)throw Error('simulated interrupted config commit');return rename(from,to);};assert.throws(()=>pins.updatePin(powerLoss,{action:'enroll',newPin:selected,confirmPin:selected,revision:pendingRevision}));checks++; }
  finally { fs.renameSync=rename; }
  check(pins.readConfig(powerLoss).pin,selected,'sealed enrollment journal resumes chosen PIN after interrupted commit');
  check(JSON.parse(fs.readFileSync(path.join(interruptedDir,'pin-enrollment.json'),'utf8')).completed,true,'prepared recovery journal destroyed after commit');
  const retainedCredential=fs.readFileSync(interrupted);assert.throws(()=>pins.writeConfig(interrupted,{...pins.readConfig(interrupted),padding:'x'.repeat(70000)}),/too large/);checks++;check(fs.readFileSync(interrupted),retainedCredential,'invalid replacement cannot retire a usable credential');
  // A completed owner record left by a crashed process is reclaimed safely.
  const dead=spawn(process.execPath,['-e','process.exit(0)'],{windowsHide:true});await new Promise(r=>dead.once('close',r));
  fs.writeFileSync(interrupted+'.pin-lock',JSON.stringify({pid:dead.pid,nonce:'dead'}));
  pins.writeConfig(interrupted,{...pins.readConfig(interrupted),retained:true});check(pins.readConfig(interrupted).retained,true,'dead writer recovery');
  console.log('PASS '+checks+' Windows PIN lifecycle assertions: native-only enrollment, races, validation, DPAPI, persistence, rotation, native/remote revocation, local recovery, stale/missing/corrupt state, legacy upgrade, lockout and interrupted writer recovery.');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await stop();assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:20,retryDelay:200});});
