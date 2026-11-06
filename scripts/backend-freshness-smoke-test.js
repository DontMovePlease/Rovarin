"use strict";
const fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),assert=require('assert'),{spawn,execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-backend-freshness-')),pins=require('../pin-manager');
const profile=path.join(dir,'profile'),state=path.join(profile,'.rovarin-development',crypto.createHash('sha256').update(dir.toLowerCase()).digest('hex'));
const fixtureEnv={...process.env,USERPROFILE:profile,LOCALAPPDATA:path.join(dir,'tool-appdata'),PORT:'7331',PC_MONITOR_PIN:''};
let child;const shell=process.env.SystemRoot+'\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
function helper(env=fixtureEnv){return JSON.parse(execFileSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(dir,'scripts/desktop-preview-host.ps1')],{env,windowsHide:true,timeout:45000,encoding:'utf8'}));}
async function login(port,pin){const base='http://127.0.0.1:'+port;const response=await fetch(base+'/api/login',{method:'POST',headers:{Origin:base,'Content-Type':'application/json',Connection:'close'},body:JSON.stringify({pin})});assert.equal(response.status,200,'same saved PIN authenticates');const cookie=response.headers.getSetCookie().find(x=>x.startsWith('pc_monitor_session=')).split(';')[0];await fetch(base+'/api/logout',{method:'POST',headers:{Origin:base,Cookie:cookie,Connection:'close'}});}
(async()=>{
 for(const name of fs.readdirSync(root).filter(n=>n.endsWith('.js')))fs.copyFileSync(path.join(root,name),path.join(dir,name));
 fs.copyFileSync(path.join(root,'package.json'),path.join(dir,'package.json'));
 fs.mkdirSync(path.join(dir,'scripts'));for(const name of ['desktop-preview-host.ps1','start.ps1','stop.ps1','development-start.ps1','dashboard-runtime.ps1'])fs.copyFileSync(path.join(root,'scripts',name),path.join(dir,'scripts',name));fs.copyFileSync(path.join(root,'run_hidden.vbs'),path.join(dir,'run_hidden.vbs'));
 fs.mkdirSync(state,{recursive:true});fs.writeFileSync(path.join(dir,'.rovarin-development-state.json'),'{"schema":2}');
 const pin=String(crypto.randomInt(100000,1000000)),file=path.join(state,'config.json');pins.writeConfig(file,{pin,fixtureSetting:'preserved'});const before=fs.readFileSync(file);
 let output='';child=spawn(process.execPath,[path.join(dir,'server.js')],{cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe'],env:fixtureEnv});child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
 for(let i=0;i<200&&!output.includes('Localhost access:');i++){if(child.exitCode!==null)throw Error('Fixture startup failed');await new Promise(r=>setTimeout(r,100));}
 const initial=JSON.parse(fs.readFileSync(path.join(state,'server-state.json')));await login(initial.actualPort,pin);
 const connection=require('net').connect(initial.actualPort,'127.0.0.1');
 try {
  await new Promise((resolve,reject)=>{connection.once('connect',resolve);connection.once('error',reject);connection.setTimeout(3000,()=>reject(Error('Listener fixture connection timed out')));});
  const probe=". '"+path.join(dir,'scripts/dashboard-runtime.ps1').replaceAll("'","''")+"'; @{owned=(Get-DashboardListener "+initial.actualPort+" "+initial.pid+");wrongOwner=(Get-DashboardListener "+initial.actualPort+" "+process.pid+");connectedClient=(Get-DashboardListener "+connection.localPort+" "+process.pid+")} | ConvertTo-Json -Compress";
  const proof=JSON.parse(execFileSync(shell,['-NoProfile','-Command',probe],{env:fixtureEnv,windowsHide:true,timeout:15000,encoding:'utf8'}));
  assert.strictEqual(proof.owned,true,'Windows listener-only table proves the real server owner');
  assert.strictEqual(proof.wrongOwner,false,'A responsive port never authorizes a different process');
  assert.strictEqual(proof.connectedClient,false,'An established client socket is not a listening server');
  console.log('PASS direct Windows listener ownership: correct PID accepted, wrong PID and established client socket rejected');
 } finally {connection.destroy();}
 const reuse=helper();assert(reuse.ready);assert.equal(JSON.parse(fs.readFileSync(path.join(state,'server-state.json'))).pid,initial.pid,'unchanged source reuses owned backend');
 const nativeEnv={...fixtureEnv,LOCALAPPDATA:path.join(dir,'native-appdata')};
 const otherContext=helper(nativeEnv);assert(otherContext.ready);assert.equal(otherContext.port,initial.actualPort,'different AppData contexts select the same owned backend');
 assert.equal(JSON.parse(fs.readFileSync(path.join(state,'server-state.json'))).pid,initial.pid);
 let duplicateOutput='';const duplicate=spawn(process.execPath,[path.join(dir,'server.js')],{cwd:dir,windowsHide:true,stdio:['ignore','pipe','pipe'],env:nativeEnv});duplicate.stdout.on('data',x=>duplicateOutput+=x);duplicate.stderr.on('data',x=>duplicateOutput+=x);
 const duplicateExit=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{duplicate.kill();reject(Error('Duplicate fixture did not exit'));},10000);duplicate.once('error',reject);duplicate.once('exit',code=>{clearTimeout(timer);resolve(code)});});
 assert.equal(duplicateExit,1,'different AppData context cannot create a fallback backend');assert(duplicateOutput.includes('No second instance was started'));await login(initial.actualPort,pin);

 fs.appendFileSync(path.join(dir,'server.js'),'\n// Backend content change fixture\n');const restarted=helper();assert(restarted.ready);const current=JSON.parse(fs.readFileSync(path.join(state,'server-state.json')));assert.notEqual(current.pid,initial.pid,'native startup replaces stale backend');assert(/^[a-f0-9]{64}$/.test(current.sourceFingerprint));await login(restarted.port,pin);assert(fs.readFileSync(file).equals(before),'PIN/settings byte-identical after automatic restart');
 helper();assert.equal(JSON.parse(fs.readFileSync(path.join(state,'server-state.json'))).pid,current.pid,'reopening current app does not duplicate/restart backend');await login(current.actualPort,pin);
 execFileSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(dir,'scripts/stop.ps1')],{env:fixtureEnv,windowsHide:true,timeout:20000,stdio:'pipe'});
 fs.writeFileSync(path.join(state,'server.pid'),String(initial.pid));
 const recovered=helper();assert(recovered.ready,'two confirmed-dead conflicting records recover automatically');
 const recoveryState=JSON.parse(fs.readFileSync(path.join(state,'server-state.json')));assert.notEqual(recoveryState.pid,current.pid);await login(recovered.port,pin);
 fs.writeFileSync(path.join(state,'server.pid'),String(initial.pid));
 const script=". '"+path.join(dir,'scripts/dashboard-runtime.ps1').replaceAll("'","''")+"'; Get-DashboardRuntime '"+dir.replaceAll("'","''")+"' | ConvertTo-Json -Compress";
 const unsafe=JSON.parse(execFileSync(shell,['-NoProfile','-Command',script],{env:fixtureEnv,windowsHide:true,timeout:10000,encoding:'utf8'}));assert.equal(unsafe.state,'unsafe','live conflicting ownership stays fail-closed');
 fs.writeFileSync(path.join(state,'server.pid'),String(recoveryState.pid));assert(fs.readFileSync(file).equals(before));
 console.log('PASS marked-v2 shared storage across different AppData contexts, duplicate backend refusal, real native startup helper: current backend reuse, stale content automatic owned restart, same saved PIN before/after, byte-identical settings, repeated reopen without duplication, dead-record conflict recovery and live-owner conflict refusal');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{
 try{execFileSync(shell,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(dir,'scripts/stop.ps1')],{env:fixtureEnv,windowsHide:true,timeout:20000,stdio:'pipe'});}catch(e){console.error('Fixture stop failed; retained isolated state.');process.exitCode=1;return;}
 if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
 const target=path.resolve(dir);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep)&&path.basename(target).startsWith('rovarin-backend-freshness-'));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});
});
