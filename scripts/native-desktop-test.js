'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const {spawn,execFileSync}=require('child_process');
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
module.exports=async function testNativeDesktop(root,payload,options={}){
  if(process.platform!=='win32')return;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-native-'));
  fs.cpSync(payload,temp,{recursive:true});
  const app=path.join(temp,'app'),data=path.join(temp,'data');fs.mkdirSync(data);
  const pins = require('../pin-manager'); const testConfig = path.join(data,'config.json');
  pins.writeConfig(testConfig,{...pins.loadConfig(testConfig),autoCheckUpdates:false});
  fs.writeFileSync(path.join(data,'onboarding-complete.json'),'{"completed":true}');
  let child,desktop,base,retain=false;
  const launch=(file,args,options={})=>spawn(file,args,{windowsHide:true,stdio:['ignore','pipe','pipe'],...options});
  async function wait(child,limit=120000){let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>{retain=true;reject(new Error('Native fixture timed out; retained for inspection'))},limit);child.once('error',e=>{clearTimeout(timer);reject(e)});child.once('exit',code=>{clearTimeout(timer);code===0?resolve():reject(new Error(output||`Native fixture exit ${code}`))})});return output;}
  try{
    const compiler=path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    if(options.currentSource){
      // Local shell QA without rebuilding or touching the installer payload.
      fs.cpSync(path.join(root,'public'),path.join(app,'public'),{recursive:true});
      for (const name of ['server.js','pin-manager.js','update-manager.js','app-manager.js','process-termination.js','process-stats.js']) fs.copyFileSync(path.join(root,name),path.join(app,name));
      for(const name of ['terminate-process.ps1','app-manager.ps1','app-uninstall.cs','process-tree.ps1','process-tree.cs','process-display.ps1','application-display.ps1'])fs.copyFileSync(path.join(root,'scripts',name),path.join(app,'scripts',name));
      fs.copyFileSync(path.join(root,'scripts/native-trust.ps1'),path.join(app,'scripts/native-trust.ps1'));
      execFileSync(compiler,['/nologo','/target:winexe','/platform:x64','/optimize+','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',`/r:${path.join(app,'Microsoft.Web.WebView2.Core.dll')}`,`/r:${path.join(app,'Microsoft.Web.WebView2.WinForms.dll')}`,`/win32manifest:${path.join(root,'packaging/desktop.manifest')}`,`/win32icon:${path.join(app,'Rovarin.ico')}`,`/out:${path.join(app,'Rovarin.exe')}`,path.join(root,'packaging/RovarinLauncher.cs'),path.join(root,'packaging/DesktopShell.cs')],{windowsHide:true,timeout:15000});
    }
    // PORT=0 intentionally skips runtime ownership records in this project.
    // A native lifecycle test must use a real, isolated published port instead.
    const port=await new Promise((resolve,reject)=>{const listener=require('net').createServer();listener.once('error',reject);listener.listen(0,'127.0.0.1',()=>{const port=listener.address().port;listener.close(error=>error?reject(error):resolve(port))})});
    child=launch(path.join(temp,'runtime/node.exe'),['"'+path.join(app,'server.js')+'"'],{cwd:app,windowsVerbatimArguments:true,env:{...process.env,PORT:String(port),NODE_OPTIONS:'',NODE_PATH:'',PC_MONITOR_PIN:''}});
    let output='';child.stdout.on('data',x=>output+=x);child.stderr.on('data',x=>output+=x);
    for(let i=0;i<150;i++){const match=output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);if(match){base=`http://127.0.0.1:${match[1]}`;break}await pause(100)}
    assert(base,'Native fixture backend failed');
    const remoteLogin=await fetch(base+'/').then(r=>r.text());
    assert(remoteLogin.includes('class="login-page"'),'Canonical login document missing');
    assert(!remoteLogin.includes('id="lock-window-minimize"')&&!remoteLogin.includes('id="lock-window-exit"')&&!remoteLogin.includes('class="lock-window-controls"'),'Web/mobile login must not contain native window controls');
    execFileSync(compiler,['/nologo','/target:exe','/platform:x64',`/win32manifest:${path.join(root,'packaging/desktop.manifest')}`,'/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',`/r:${path.join(app,'Microsoft.Web.WebView2.Core.dll')}`,`/r:${path.join(app,'Microsoft.Web.WebView2.WinForms.dll')}`,`/out:${path.join(app,'NativeDesktopTest.exe')}`,path.join(root,'scripts/native-desktop-test.cs')],{windowsHide:true,timeout:15000});
    fs.copyFileSync(path.join(app,'Rovarin.exe.config'),path.join(app,'NativeDesktopTest.exe.config'));
    console.log(await wait(launch(path.join(app,'NativeDesktopTest.exe'),[],{cwd:app})));
    for(const file of ['native-lock.png','login-mobile.png','login-keyboard.png','processes-polish.png']) fs.copyFileSync(path.join(app,file),path.join(root,'packaging/cache',file));
    fs.copyFileSync(path.join(app,'native-dashboard.png'),path.join(root,'packaging/cache/native-dashboard.png'));
    fs.copyFileSync(path.join(app,'native-mobile.png'),path.join(root,'packaging/cache/native-mobile.png'));
    fs.copyFileSync(path.join(app,'native-mobile-drawer.png'),path.join(root,'packaging/cache/native-mobile-drawer.png'));
    for(const file of fs.readdirSync(app).filter(file=>/^midnight-.*\.png$/.test(file))) fs.copyFileSync(path.join(app,file),path.join(root,'packaging/cache',file));
    assert.strictEqual((await fetch(base+'/api/metrics')).status,401,'Shell exit leaves protected backend healthy');
    const state=JSON.parse(fs.readFileSync(path.join(data,'server-state.json')));assert.strictEqual(state.pid,child.pid,'Shell reused existing Node');
    // The real fixed-mode EXE, not the harness: two opens reuse a single shell.
    desktop=launch(path.join(app,'Rovarin.exe'),[],{cwd:app});
    await pause(4000);
    assert.strictEqual(desktop.exitCode,null,'Real native shell did not remain running');
    const pin=JSON.parse(fs.readFileSync(path.join(data,'config.json'))).pin;
    const login=await fetch(base+'/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin})});
    const cookie=login.headers.getSetCookie().find(x=>x.startsWith('pc_monitor_session=')).split(';')[0];
    const html=[];
    for(const userAgent of ['Rovarin WebView2','Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile Safari/604.1']){
      const response=await fetch(base+'/',{headers:{Cookie:cookie,'User-Agent':userAgent}});
      assert.strictEqual(response.status,200);assert.strictEqual(response.headers.get('cache-control'),'no-store');
      html.push(await response.text());
    }
    assert.strictEqual(html[0],html[1],'Desktop and mobile must receive the exact same canonical document');
    for(const match of html[0].matchAll(/(?:src|href)="(\/[a-z-]+\.(?:css|js)\?v=[^"]+)"/g)){
      const response=await fetch(base+match[1],{headers:{Cookie:cookie}});
      assert.strictEqual(response.status,200);assert.strictEqual(response.headers.get('cache-control'),'no-store');
      assert.strictEqual(await response.text(),fs.readFileSync(path.join(app,'public',match[1].split('?')[0].slice(1)),'utf8'));
    }
    console.log('PASS shared desktop/mobile HTML, canonical versioned assets and no-store caching');
    const status=()=>fetch(base+'/api/monitoring/status',{headers:{Cookie:cookie}}).then(r=>r.json());
    let monitoring;
    for(let i=0;i<80;i++){monitoring=await status();if(monitoring.leaseCount===1)break;await pause(100)}
    assert.strictEqual(monitoring.leaseCount,1,'Valid saved WebView2 session should open dashboard without PIN');
    const measure=execFileSync('powershell.exe',['-NoProfile','-Command',`$p=Get-Process -Id ${desktop.pid};$cpu=$p.TotalProcessorTime.TotalMilliseconds;Start-Sleep -Seconds 3;$p.Refresh();@{cpuOneCorePercent=[math]::Round(($p.TotalProcessorTime.TotalMilliseconds-$cpu)/30,1);shellWorkingSetMB=[math]::Round($p.WorkingSet64/1MB,1)}|ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8',timeout:10000});
    console.log('MEASURE native shell (not WebView2 child processes): '+measure.trim());
    console.log(await wait(launch(path.join(app,'Rovarin.exe'),[],{cwd:app}),15000));
    console.log(await wait(launch(path.join(app,'Rovarin.exe'),['close-desktop'],{cwd:app}),20000));
    for(let i=0;i<60 && desktop.exitCode===null;i++)await pause(100);
    assert.strictEqual(desktop.exitCode,0,'Owned close did not exit shell');
    assert.strictEqual((await fetch(base+'/api/metrics')).status,401);
    for(let i=0;i<80;i++){monitoring=await status();if(!monitoring.leaseCount && !monitoring.activeCommands.length && !monitoring.terminatingCommands.length)break;await pause(100)}
    assert.strictEqual(monitoring.leaseCount,0,'Exiting shell must release its lease');assert.deepStrictEqual(monitoring.timers,{});
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(data,'server-state.json'))).pid,child.pid);
    assert(fs.existsSync(path.join(data,'desktop-window.json')),'Window bounds not saved');
    console.log('PASS real native EXE, repeated open, owned close, persistent backend, window bounds');
  }catch(error){console.error(error);retain=true;throw error;}finally{
    if(desktop&&desktop.exitCode===null){try{execFileSync(path.join(app,'Rovarin.exe'),['close-desktop'],{windowsHide:true,timeout:15000})}catch{retain=true}}
    if(child&&child.exitCode===null){const done=new Promise(resolve=>child.once('exit',resolve));child.kill();await done;}
    // A failed launch may have started an owned replacement; the fixed lifecycle
    // still verifies executable/script identity before stopping any such fixture.
    try{execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(app,'scripts/stop.ps1')],{windowsHide:true,timeout:20000})}catch{retain=true;}
    if(!retain){assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir())+path.sep));for(let i=0;i<20;i++){try{fs.rmSync(temp,{recursive:true,force:true});break}catch(error){if(i===19)throw error;await pause(300)}}}
  }
};
