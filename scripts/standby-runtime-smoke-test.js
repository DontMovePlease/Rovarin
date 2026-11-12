'use strict';
// The real native listener and canonical server run only in this disposable copy.
const fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),assert=require('assert');
const {spawn,execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'rovarin-standby-'));
const app=path.join(temp,'app'),exe=path.join(temp,'Standby.exe');let supervisor,base,port,browser,portBlocker;
const wait=ms=>new Promise(r=>setTimeout(r,ms));const pin=String(crypto.randomInt(100000,1000000));
const report={cycles:[],measurements:[]};
function measure(label){
 const script='$p=Get-Process -Id '+supervisor.pid+' -ErrorAction Stop;[pscustomobject]@{pid=$p.Id;workingSetBytes=$p.WorkingSet64;privateCommitBytes=$p.PrivateMemorySize64;cpuSeconds=$p.TotalProcessorTime.TotalSeconds}|ConvertTo-Json -Compress';
 const value=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,encoding:'utf8'}));report.measurements.push({label,...value});return value;
}
function crashOwnedBackend(pid){
 const quote=s=>"'"+s.replace(/'/g,"''")+"'";
 const script='$p=Get-CimInstance Win32_Process -Filter '+quote('ProcessId='+pid)+';if($p.ExecutablePath -ine '+quote(process.execPath)+' -or -not $p.CommandLine.Contains('+quote(path.join(app,'server.js'))+')){throw "Not owned fixture"};Stop-Process -Id '+pid+' -Force';
 execFileSync('powershell.exe',['-NoProfile','-Command',script],{windowsHide:true,timeout:5000});
}
function hash(file){return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');}
function command(action){return JSON.parse(execFileSync(exe,[action],{windowsHide:true,encoding:'utf8',timeout:20000}));}
async function until(fn,limit=40000){const end=Date.now()+limit;let last;while(Date.now()<end){try{const v=await fn();if(v)return v;}catch(e){last=e;}await wait(300);}throw Error('Standby fixture deadline'+(last?': '+last.message:''));}
async function request(route,body,cookie){return fetch(base+route,{method:body?'POST':'GET',headers:{Origin:base,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});}
function launch(){supervisor=spawn(exe,['run'],{windowsHide:true,stdio:['ignore','pipe','pipe']});supervisor.stdout.resume();supervisor.stderr.resume();}
async function mobileBrowser(){
 const {chromium}=require(process.env.ROVARIN_PLAYWRIGHT_PATH||'playwright');
 browser=await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 const context=await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true,userAgent:'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148'}),errors=[];
 let page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.locator('#pinInput').fill(pin);await page.locator('#unlockBtn').click();
 await page.waitForFunction(()=>typeof latestDashboardMetrics!=='undefined'&&latestDashboardMetrics?.ram?.sampledAt,{},{timeout:45000});
 assert.equal(await page.locator('#nativeSecurityControls').isVisible(),false);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
 const initialPid=command('status').backendPid;await page.close();await until(()=>!command('status').backendReady,65000);
 page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>typeof latestDashboardMetrics!=='undefined'&&latestDashboardMetrics?.ram?.sampledAt,{},{timeout:45000});assert.notEqual(command('status').backendPid,initialPid);
 const beforeOffline=await page.evaluate(()=>latestDashboardMetrics.ram.sampledAt);await context.setOffline(true);await until(()=>!command('status').backendReady,65000);await context.setOffline(false);
 await page.waitForFunction(previous=>latestDashboardMetrics?.ram?.sampledAt>previous,beforeOffline,{timeout:45000});assert.equal(await page.locator('#pinInput').count(),0);
 await page.close();await until(()=>!command('status').backendReady,65000);assert.deepEqual(errors,[]);await browser.close();browser=null;
 console.log('PASS 390px real browser PIN wake, SSE metrics, page-close idle shutdown, cookie reopen and offline/online automatic reconnection (not physical iOS/Tailscale)');
}
async function main(){
 fs.mkdirSync(app);for(const n of fs.readdirSync(root).filter(n=>n.endsWith('.js')||n==='package.json'))fs.copyFileSync(path.join(root,n),path.join(app,n));
 fs.cpSync(path.join(root,'public'),path.join(app,'public'),{recursive:true});fs.mkdirSync(path.join(app,'scripts'));
 for(const name of ['dashboard-runtime.ps1','native-trust.ps1'])fs.copyFileSync(path.join(root,'scripts',name),path.join(app,'scripts',name));
 // A fixture-only operation hold exercises the production supervisor's busy gate.
 const maintenance=path.join(app,'maintenance.js');let source=fs.readFileSync(maintenance,'utf8');assert(source.includes('standbyBusy:()=>isRunning||boostProbePending'));source=source.replace('standbyBusy:()=>isRunning||boostProbePending','standbyBusy:()=>isRunning||boostProbePending||fs.existsSync(path.join(__dirname,"fixture-operation.hold"))');fs.writeFileSync(maintenance,source);
 require('../pin-manager').writeConfig(path.join(app,'config.json'),{pin,autoCheckUpdates:false,retained:'standby-fixture'});
 const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');execFileSync(compiler,['/nologo','/target:exe','/r:System.Web.Extensions.dll','/r:System.Security.dll','/out:'+exe,path.join(root,'packaging/StandbySupervisor.cs')],{windowsHide:true,timeout:30000});
 port=await new Promise(resolve=>{const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{const p=s.address().port;s.close(()=>resolve(p));});});base='http://127.0.0.1:'+port;
 const files={};function add(dir,prefix=''){for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const rel=prefix+entry.name;if(entry.isDirectory()){if(['public','scripts'].includes(rel))add(path.join(dir,entry.name),rel+'/');}else if(rel!=='config.json')files[rel]=hash(path.join(dir,entry.name));}}add(app);
 const fingerprint=require('../server-lifecycle').runtimeFingerprint(app);
 fs.writeFileSync(path.join(temp,'standby-runtime.json'),JSON.stringify({schema:1,root:app,node:process.execPath,nodeHash:hash(process.execPath),config:path.join(app,'config.json'),port,timeoutMs:20000,files,fingerprint}));
 const preferredPort=port;portBlocker=require('net').createServer(socket=>socket.destroy());await new Promise((resolve,reject)=>{portBlocker.once('error',reject);portBlocker.listen(preferredPort,'127.0.0.1',resolve);});
 const configBefore=hash(path.join(app,'config.json'));launch();await until(()=>command('status'));port=command('status').port;assert(port>preferredPort&&port<=preferredPort+4,'native listener uses only approved fallback range');base='http://127.0.0.1:'+port;
 assert.equal(command('status').backendReady,false);assert.equal((await request('/')).status,200);assert.equal(command('status').backendReady,false,'anonymous page never wakes Node');
 assert.equal((await request('/api/metrics')).status,401);assert.equal(command('status').backendReady,false);
 const denied=await new Promise((resolve,reject)=>{const req=require('http').get(base+'/',{localAddress:'127.0.0.2'},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});req.on('error',e=>e.code==='ECONNRESET'?resolve('reset'):reject(e));});
 assert([403,'reset'].includes(denied),'non-approved source is denied before wake');assert.equal(command('status').backendReady,false);
 assert.equal((await fetch(base+'/api/desktop/status',{headers:{'X-PC-Monitor-Desktop':crypto.randomBytes(32).toString('base64')}})).status,401);assert.equal(command('status').backendReady,false,'forged native proof cannot wake');
 const badOrigin=await fetch(base+'/api/login',{method:'POST',headers:{Origin:'https://attacker.invalid','Content-Type':'application/json'},body:JSON.stringify({pin})});assert.equal(badOrigin.status,403);assert.equal(command('status').backendReady,false);
 console.log('PASS native-only listener, existing PIN page/assets, API denial and cross-origin wake refusal without Node');
 measure('cold native-only standby');
 if(process.argv.includes('--browser-only')){await mobileBrowser();assert(command('stop').ready);await until(()=>supervisor.exitCode!==null);fs.writeFileSync(path.join(root,'packaging/cache/standby-browser-acceptance.json'),JSON.stringify({passed:true,browser:'installed Windows Edge, iPhone viewport/UA',realIphone:false,realTailscale:false,closedPage:true,offlineReconnection:true},null,2));return;}
 const start=performance.now();const login=await request('/api/login',{pin});assert.equal(login.status,200,await login.text());
 const cookie=login.headers.getSetCookie().find(x=>x.startsWith('pc_monitor_session=')).split(';')[0];
 const first=command('status');assert(first.backendReady);const initialPid=first.backendPid;assert.equal((await request('/',null,cookie)).status,200);report.coldWakeMs=Math.round(performance.now()-start);console.log('MEASURE authenticated cold wake ms='+report.coldWakeMs);
 const diagnostics=await (await request('/api/diagnostics',null,cookie)).json();assert.equal(diagnostics.binding.preferredPort,preferredPort);assert.equal(diagnostics.binding.actualPort,port);assert.equal(diagnostics.binding.fallbackRequired,true);assert(portBlocker.listening,'unrelated occupied listener is untouched');
 const logins=await Promise.all(Array.from({length:3},()=>request('/api/login',{pin})));for(const response of logins)assert.equal(response.status,200);assert.equal(command('status').backendPid,initialPid,'simultaneous requests share one backend');
 console.log('PASS simultaneous authenticated clients reuse exactly one backend');
 fs.writeFileSync(path.join(app,'fixture-operation.hold'),'owned fixture');await wait(25000);assert(command('status').backendReady,'protected operation retains Node');fs.unlinkSync(path.join(app,'fixture-operation.hold'));
 const shutdownStart=performance.now();await until(()=>!command('status').backendReady,35000);assert.equal(hash(path.join(app,'config.json')),configBefore);report.heldOperationReleaseToStopMs=Math.round(performance.now()-shutdownStart);console.log('PASS protected-operation hold and real idle Node exit; grace since last authentication exceeded 20s');
 measure('native-only after first backend exit');
 const resumeStart=performance.now();const resumed=await request('/',null,cookie);assert.equal(resumed.status,200);assert((await resumed.text()).includes('dashboardPage'),'ordinary cookie restored after controlled standby');assert.notEqual(command('status').backendPid,initialPid);report.reconnectMs=Math.round(performance.now()-resumeStart);console.log('MEASURE cookie reconnect ms='+report.reconnectMs);
 const live=command('status').backendPid;
 fs.writeFileSync(path.join(app,'fixture-operation.hold'),'owned fixture');
 const prior=supervisor.pid;supervisor.kill();await new Promise(resolve=>supervisor.once('exit',resolve));launch();await until(()=>command('status'));assert.notEqual(supervisor.pid,prior);assert.equal(command('status').port,port,'Node must not inherit and retain the public listener');assert.equal(command('status').backendPid,live,'recover protected backend after supervisor crash');assert.equal((await request('/',null,cookie)).status,200);
 console.log('PASS supervisor crash recovery reattaches protected backend and preserves its ordinary session');
 fs.unlinkSync(path.join(app,'fixture-operation.hold'));
 crashOwnedBackend(live);await until(()=>!command('status').backendReady);assert.equal((await request('/',null,cookie)).status,200,'a canonical login page remains accessible after backend crash');
 const recovered=await request('/api/login',{pin});assert.equal(recovered.status,200);console.log('PASS unexpected backend crash permits authenticated restart without duplicate processes');
 await until(()=>!command('status').backendReady,35000);console.log('PASS second real idle exit, no persistent Node; credentials unchanged');
 let cycleCookie,otherDeviceCookie;
 for(let i=0;i<3;i++){
  const begin=performance.now(),response=i===0?await request('/api/login',{pin}):await request('/',null,i===1?cycleCookie:otherDeviceCookie);assert.equal(response.status,200);
  if(i===0){cycleCookie=response.headers.getSetCookie().find(x=>x.startsWith('pc_monitor_session=')).split(';')[0];const other=await request('/api/login',{pin});assert.equal(other.status,200);otherDeviceCookie=other.headers.getSetCookie().find(x=>x.startsWith('pc_monitor_session=')).split(';')[0];}
  else assert((await response.text()).includes('dashboardPage'),'each device keeps its ordinary session across multiple standby cycles');
  const wakeMs=Math.round(performance.now()-begin),pid=command('status').backendPid;
  if(i===0){
   const leaseResponse=await request('/api/monitoring/lease',{action:'acquire'},cycleCookie);assert.equal(leaseResponse.status,201);const lease=await leaseResponse.json();
   await wait(25000);assert(command('status').backendReady,'a still-valid monitoring lease outlives a shorter idle deadline');
   assert.equal((await request('/api/monitoring/lease',{action:'release',leaseId:lease.leaseId},cycleCookie)).status,200);
  }
  const idleAt=performance.now();await until(()=>!command('status').backendReady,65000);
  assert.throws(()=>process.kill(pid,0),'owned Node process is genuinely gone');
  report.cycles.push({wakeMs,closeToStandbyMs:Math.round(performance.now()-idleAt),...measure('native-only cycle '+(i+1))});
 }
 console.log('PASS three additional real wake/exit cycles and live-lease protection');
 const protectedLogin=await request('/api/login',{pin});assert.equal(protectedLogin.status,200);const protectedCookie=protectedLogin.headers.getSetCookie().find(x=>x.startsWith('pc_monitor_session=')).split(';')[0];
 const incorrect=pin==='111111'?'222222':'111111';assert.equal((await request('/api/system/uninstall',{pin:incorrect,confirmation:'uninstall-pc-monitor',removeData:false},protectedCookie)).status,401);
 await wait(25000);assert(command('status').backendReady,'standby cannot reset a fresh-PIN action guess budget');
 assert.equal((await request('/api/login',{pin})).status,200);await until(()=>!command('status').backendReady,35000);
 console.log('PASS security guess budget protects Node until successful authentication clears it');
 const pins=require('../pin-manager'),configFile=path.join(app,'config.json'),optOut=pins.readConfig(configFile);optOut.smartStandby=false;pins.writeConfig(configFile,optOut);
 await until(()=>command('status').backendReady);const persistentPid=command('status').backendPid;await wait(25000);assert.equal(command('status').backendPid,persistentPid,'opt-out retains always-running backend');
 let stopResult;try{stopResult=command('stop');}catch(e){stopResult=JSON.parse(e.stdout.toString());}assert.equal(stopResult.busy,true);await until(()=>supervisor.exitCode!==null,15000);assert.throws(()=>process.kill(persistentPid,0),'opt-out stop exits Node without an immediate replacement');
 launch();await until(()=>command('status'));await until(()=>command('status').backendReady);
 const optIn=pins.readConfig(configFile);optIn.smartStandby=true;pins.writeConfig(configFile,optIn);await until(()=>!command('status').backendReady,35000);
 console.log('PASS opt-out keeps backend running; opt-in returns it to native-only standby');
 const beforeIdle=measure('settled complete native-only standby');await wait(3000);const afterIdle=measure('standby CPU interval');report.idleCpuSeconds=afterIdle.cpuSeconds-beforeIdle.cpuSeconds;
 const firstSupervisor=supervisor.pid;supervisor.kill();await new Promise(resolve=>supervisor.once('exit',resolve));launch();await until(()=>command('status'));assert.notEqual(supervisor.pid,firstSupervisor);assert.equal(command('status').backendReady,false);
 const wrong=pin==='111111'?'222222':'111111';for(let i=0;i<5;i++)assert.equal((await request('/api/login',{pin:wrong})).status,i===4?429:401);const locked=await request('/api/login',{pin});assert.equal(locked.status,429);assert.equal(locked.headers.get('retry-after'),'60');assert.equal(command('status').backendReady,false);
 console.log('PASS supervisor restart, five-attempt lockout and unauthorized attempts never start backend');
 supervisor.kill();await new Promise(resolve=>supervisor.once('exit',resolve));launch();await until(()=>command('status'));assert.equal((await request('/api/login',{pin})).status,429,'lockout survives supervisor crash');
 assert.equal(pins.readConfig(configFile).pin,pin);assert.equal(pins.readConfig(configFile).retained,'standby-fixture');
 const recoveredPin=pins.generatePin(pin);pins.updatePin(configFile,{action:'reset',newPin:recoveredPin,confirmPin:recoveredPin,revision:pins.credentialRevision(pins.readConfig(configFile))});
 assert.equal((await request('/api/login',{pin:recoveredPin})).status,200,'validated local PIN recovery clears stale wake lockout');
 assert.equal((await request('/api/login',{pin})).status,401,'old PIN remains invalid after recovery');
 assert.equal((await request('/api/monitoring/status',null,cycleCookie)).status,401,'old session cannot survive PIN recovery');
 await until(()=>!command('status').backendReady,35000);assert(command('stop').ready);await until(()=>supervisor.exitCode!==null);console.log('PASS local recovery, session revocation, native shutdown and unrelated config preservation');
 report.passed=true;report.timeoutMs=20000;fs.writeFileSync(path.join(root,'packaging/cache/standby-runtime-acceptance.json'),JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;console.error('Retained isolated fixture: '+temp);}).finally(async()=>{
 if(browser)await browser.close();
 if(portBlocker)await new Promise(resolve=>portBlocker.close(resolve));
 try{fs.unlinkSync(path.join(app,'fixture-operation.hold'));}catch{}
 if(supervisor&&supervisor.exitCode===null){try{await until(()=>!command('status').backendReady,65000);command('stop');await until(()=>supervisor.exitCode!==null,5000);}catch{supervisor.kill();}}
 // Never remove files if any owned backend may still be completing work.
 if(process.exitCode!==1&&supervisor?.exitCode!==null)fs.rmSync(temp,{recursive:true,force:true});
});
