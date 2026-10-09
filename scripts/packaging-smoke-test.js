'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const { EnhancedSupport, isLocalDesktopRequest, installationResult, PAWNIO_SHA256 } = require('../enhanced-support');
const { ASSETS } = require('../cpu-temperature-provider');
const { UninstallManager } = require('../uninstall-manager');
const { verifyAndPublish } = require('./release-verify');
const root = path.resolve(__dirname, '..');
const payload = path.join(root, 'packaging', 'payload');
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
// Windows can briefly retain a fixture's current-directory handle after exit.
// Retry only removal of our validated mkdtemp tree; persistent errors still fail.
async function removeOwnedFixture(temp) {
  assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  assert(!fs.lstatSync(temp).isSymbolicLink(),'fixture root must not redirect');
  await fs.promises.rm(temp,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  assert(!fs.existsSync(temp),'disposable fixture cleanup must complete');
}
async function testFixtureCleanup() {
  if (process.platform !== 'win32') return;
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-packaging-cleanup-'));
  const child=spawn(process.execPath,['-e',"console.log('ready');setTimeout(()=>{},800)"],{cwd:temp,windowsHide:true,stdio:['ignore','pipe','pipe']});
  const closed=new Promise((resolve,reject)=>{child.once('close',resolve);child.once('error',reject)});
  try {
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('Cleanup fixture readiness timed out')),5000);child.stdout.once('data',()=>{clearTimeout(timer);resolve()});child.once('error',error=>{clearTimeout(timer);reject(error)})});
    assert.throws(()=>fs.rmSync(temp,{recursive:true,force:true}),error=>error.code==='EPERM','Windows child current-directory handle reproduces deletion failure');
    await removeOwnedFixture(temp);await closed;
    assert(!fs.existsSync(temp),'bounded retry leaves no held fixture');
    console.log('PASS reproduced Windows current-directory EPERM; bounded cleanup waits for owned child release and removes fixture');
  } finally {
    if(child.exitCode===null){child.kill();await closed;}
    if(fs.existsSync(temp))await removeOwnedFixture(temp);
  }
}
// Independent test decoder for the small byte-mode version 2/3 phone QRs.
// Read format/mask, skip function modules, undo masking and deinterleave data.
// Production uses only the unmodified upstream encoder, not this test decoder.
function decodePhoneQr(qr) {
  const n=qr.size, at=(x,y)=>Number(qr.rows[y][x]), fixed=Array.from({length:n},()=>Array(n).fill(false));
  const mark=(x,y,w,h)=>{for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)fixed[j][i]=true;};
  mark(0,0,9,9);mark(n-8,0,8,9);mark(0,n-8,9,8);mark(6,0,1,n);mark(0,6,n,1);mark(n-9,n-9,5,5);fixed[n-8][8]=true;
  let format=0;
  for(let i=0;i<15;i++){const [x,y]=i<6?[8,i]:i===6?[8,7]:i===7?[8,8]:i===8?[7,8]:[14-i,8];format|=at(x,y)<<i;}
  const data=(format^0x5412)>>>10, mask=data&7, level=data>>>3;
  const masks=[(x,y)=>(x+y)%2===0,(x,y)=>y%2===0,(x,y)=>x%3===0,(x,y)=>(x+y)%3===0,(x,y)=>(Math.floor(x/3)+Math.floor(y/2))%2===0,(x,y)=>x*y%2+x*y%3===0,(x,y)=>(x*y%2+x*y%3)%2===0,(x,y)=>((x+y)%2+x*y%3)%2===0];
  const bits=[];
  for(let right=n-1;right>=1;right-=2){if(right===6)right=5;for(let vertical=0;vertical<n;vertical++){const y=((right+1)&2)===0?n-1-vertical:vertical;for(let j=0;j<2;j++){const x=right-j;if(!fixed[y][x])bits.push(at(x,y)^Number(masks[mask](x,y)));}}}
  const bytes=[];for(let i=0;i+7<bits.length;i+=8)bytes.push(bits.slice(i,i+8).reduce((v,b)=>v*2+b,0));
  const version=(n-17)/4;assert([2,3].includes(version));
  const specs=version===2?{1:[34,1],0:[28,1],3:[22,1],2:[16,1]}:{1:[55,1],0:[44,1],3:[34,2],2:[26,2]};
  const [length,blocks]=specs[level], ordered=[];
  for(let block=0;block<blocks;block++)for(let i=0;i<length/blocks;i++)ordered.push(bytes[i*blocks+block]);
  const readBits=(offset,count)=>{let value=0;for(let i=0;i<count;i++)value=value*2+((ordered[(offset+i)>>3]>>>(7-((offset+i)&7)))&1);return value;};
  assert.strictEqual(readBits(0,4),4,'byte mode');const count=readBits(4,8);
  return Buffer.from(Array.from({length:count},(_,i)=>readBits(12+i*8,8))).toString('utf8');
}
// Exercise the exact packaged sources/runtime, without installing drivers,
// registering startup, or touching the user's running development server.
async function testPackagedRuntime() {
  if (process.platform !== 'win32') return;
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-release-qa-'));
  const app = path.join(temp, 'app');
  fs.cpSync(payload, temp, { recursive: true });
  const foreignOwner = path.join(temp,'data/server.instance.json');
  fs.mkdirSync(path.dirname(foreignOwner),{recursive:true});
  fs.writeFileSync(foreignOwner,JSON.stringify({pid:process.pid}));
  try {
    const ownership = JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',
      `. '${path.join(app,'scripts/dashboard-runtime.ps1').replace(/'/g,"''")}'; Get-DashboardRuntime '${app.replace(/'/g,"''")}' | ConvertTo-Json`],
    {windowsHide:true,encoding:'utf8',timeout:10000}));
    assert.strictEqual(ownership.state,'unsafe','unrelated live Node cannot be adopted as an installed server');
  } finally {fs.unlinkSync(foreignOwner);}
  const node = path.join(temp, 'runtime/node.exe');
  let child, base, output, startupOwned = false;
  const blockers = [];
  async function stop() {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill(); await exited;
    }
  }
  async function start(fixture) {
    output = ''; base = null;
    const args = fixture ? ['--require', path.join(__dirname, 'diagnostics-test-tools.js')] : [];
    child = spawn(node, [...args, path.join(app, 'server.js')], {
      cwd: app, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NODE_OPTIONS: '', NODE_PATH: '', PORT: '0', PC_MONITOR_PIN: '',
        PC_MONITORING_LEASE_TTL_MS: '8000', PC_MONITOR_DIAGNOSTICS_FIXTURE: fixture || '',
        ...(fixture ? { PC_MONITOR_NVIDIA_SMI_PATH: 'nvidia-smi' } : {}) }
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Packaged startup timeout')), 15000);
      const read = chunk => {
        output += chunk;
        const match = output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);
        if (match) { base = 'http://127.0.0.1:' + match[1]; clearTimeout(timer); resolve(); }
      };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('error', error => { clearTimeout(timer); reject(error); });
      child.once('exit', () => { clearTimeout(timer); if (!base) reject(new Error('Packaged startup exited')); });
    });
    const pin = JSON.parse(fs.readFileSync(path.join(temp, 'data/config.json'))).pin;
    assert(!output.includes(pin));
    const response = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    assert.strictEqual(response.status, 200);
    return response.headers.getSetCookie().find(value => value.startsWith('pc_monitor_session=')).split(';')[0];
  }
  const get = async (route, cookie, lease) => {
    const response = await fetch(base + route, { headers: { Cookie: cookie, ...(lease ? { 'X-Monitor-Lease': lease } : {}) } });
    assert.strictEqual(response.status, 200, route); return response.json();
  };
  const post = async (route, cookie, body) => {
    const response = await fetch(base + route, { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert(response.ok, route); return response.json();
  };
  async function idle(cookie) {
    // Allow canceled native children to be reaped before asserting quiescence.
    for (let i = 0; i < 30; i++) {
      const status = await get('/api/monitoring/status', cookie);
      if (!status.terminatingCommands.length) {
        assert(!status.active); assert.deepStrictEqual(status.timers, {});
        assert.deepStrictEqual(status.activeCommands, []); return;
      }
      await pause(100);
    }
    throw new Error('Packaged telemetry child did not stop');
  }
  function resource() {
    // The PID comes only from this test's directly spawned bundled child.
    const value = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$p=Get-Process -Id ${child.pid} -ErrorAction Stop; [pscustomobject]@{cpu=$p.CPU;rss=$p.WorkingSet64}|ConvertTo-Json -Compress`],
    { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    return { ...JSON.parse(value), at: Date.now() };
  }
  async function measure(label, cookie, lease) {
    const before = resource();
    for (let i = 0; i < 3; i++) {
      await pause(4000);
      if (lease) await post('/api/monitoring/lease', cookie, { action: 'heartbeat', leaseId: lease });
    }
    const after = resource();
    console.log('MEASURE packaged ' + label + ': ' + JSON.stringify({
      seconds: Math.round((after.at - before.at) / 1000),
      cpuOneCorePercent: Math.round((after.cpu - before.cpu) / ((after.at - before.at) / 1000) * 1000) / 10,
      workingSetMB: Math.round(after.rss / 1048576 * 10) / 10
    }));
  }
  try {
    let cookie = await start();
    assert.strictEqual((await fetch(base + '/api/metrics')).status, 401);
    await idle(cookie); await measure('idle', cookie);
    let lease = (await post('/api/monitoring/lease', cookie, { action: 'acquire' })).leaseId;
    await measure('dashboard', cookie, lease);
    let status = await get('/api/monitoring/status', cookie);
    assert.strictEqual(status.timers.cpu, 4000); assert(!status.timers.processes);
    await post('/api/monitoring/lease', cookie, { action: 'set-profile', leaseId: lease, profile: 'processes' });
    await measure('processes', cookie, lease);
    status = await get('/api/monitoring/status', cookie);
    assert.strictEqual(status.timers.processes, 5000);
    const snapshot = await get('/api/processes', cookie, lease);
    assert(snapshot.sampledAt > 0 && snapshot.processes.length > 0, 'real packaged process enumeration');
    await post('/api/monitoring/lease', cookie, { action: 'release', leaseId: lease });
    await idle(cookie); await measure('released-idle', cookie);
    lease = (await post('/api/monitoring/lease', cookie, { action: 'acquire' })).leaseId;
    await pause(9000); await idle(cookie);
    assert.strictEqual((await fetch(base + '/api/metrics', { headers: { Cookie: cookie, 'X-Monitor-Lease': lease } })).status, 410);
    console.log('PASS packaged Node runtime, actual process enumeration, baseline/5s cadence, idle/release/expiry and no surviving telemetry commands');
    await stop();
    for (const fixture of ['missing', 'offline', 'collector-missing', 'collector-malformed', 'collector-timeout', 'collector-throws']) {
      cookie = await start(fixture);
      const report = await get('/api/diagnostics', cookie);
      const checks = Object.fromEntries(report.checks.map(check => [check.id, check]));
      if (fixture === 'missing') {
        assert.strictEqual(checks['tailscale'].status, 'unavailable');
        assert.strictEqual(checks['gpu-telemetry'].status, 'unavailable');
        assert(!checks['tailscale-ip'].value);
      } else if (fixture === 'offline') assert.strictEqual(checks['tailscale-status'].value, 'NeedsLogin');
      else {
        const expected = ['collector-missing', 'collector-throws'].includes(fixture) ? 'unavailable' : 'failed';
        for (const id of ['network-telemetry', 'process-monitoring', 'tailscale-status']) assert.strictEqual(checks[id].status, expected);
        assert.strictEqual(checks['gpu-telemetry'].status, 'supported');
      }
      await idle(cookie);
      lease = (await post('/api/monitoring/lease', cookie, { action: 'acquire' })).leaseId;
      await pause(2500);
      const { metrics } = await get('/api/metrics', cookie, lease);
      assert(metrics.cpu.sampledAt && metrics.ram.sampledAt, 'native metrics survive tool failure');
      assert.strictEqual(child.exitCode, null);
      assert(!/unhandled|uncaught/i.test(output));
      await post('/api/monitoring/lease', cookie, { action: 'release', leaseId: lease });
      await idle(cookie); await stop();
      console.log('PASS packaged degraded-tool fixture: ' + fixture + ' (simulated tools, real bundled runtime)');
    }
    // Execute the real hidden sign-in launcher through an isolated shortcut.
    // Do not create anything in the user's actual Startup folder.
    const net = require('net');
    for (const port of [7331, 7332, 7333]) {
      const blocker = net.createServer(socket => socket.destroy());
      const bound = await new Promise((resolve, reject) => {
        blocker.once('error', error => error.code === 'EADDRINUSE' ? resolve(false) : reject(error));
        blocker.listen(port, '0.0.0.0', () => resolve(true));
      });
      if (bound) blockers.push(blocker);
    }
    const quote = value => value.replace(/'/g, "''");
    const shortcut = path.join(temp, 'qa-startup.lnk');
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `$shell=New-Object -ComObject WScript.Shell; $link=$shell.CreateShortcut('${quote(shortcut)}'); $link.TargetPath='${quote(path.join(app, 'Rovarin.exe'))}'; $link.Arguments='startup'; $link.WorkingDirectory='${quote(app)}'; $link.Save(); Start-Process -FilePath '${quote(shortcut)}' -WindowStyle Hidden`],
    { windowsHide: true, timeout: 5000, stdio: 'pipe' });
    // stop.ps1 independently verifies the exact bundled executable/script.
    startupOwned = true;
    let state;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      try { state = JSON.parse(fs.readFileSync(path.join(temp, 'data/server-state.json'))); } catch (_) {}
      if (state?.actualPort && (await fetch('http://127.0.0.1:' + state.actualPort + '/api/metrics', { signal: AbortSignal.timeout(2000) }).catch(() => null))?.status === 401) break;
      await pause(200);
    }
    assert(state?.actualPort >= 7334 && state.actualPort <= 7335, 'successive real occupied-port fallback');
    base = 'http://127.0.0.1:' + state.actualPort;
    const pin = JSON.parse(fs.readFileSync(path.join(temp, 'data/config.json'))).pin;
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
    assert.strictEqual(login.status, 200);
    cookie = login.headers.getSetCookie().find(value => value.startsWith('pc_monitor_session=')).split(';')[0];
    const report = await get('/api/diagnostics', cookie);
    assert.strictEqual(report.binding.actualPort, state.actualPort); assert.strictEqual(report.binding.preferredPort, 7331);
    assert.strictEqual(report.binding.fallbackRequired, true);
    execFileSync(path.join(app, 'Rovarin.exe'), ['startup'], { windowsHide: true, timeout: 10000 });
    await pause(4000);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp, 'data/server-state.json'))).pid, state.pid, 'repeat sign-in launcher reuses owner');
    const setup = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'scripts/setup.ps1'), '-CheckOnly'], { windowsHide: true, timeout: 25000, encoding: 'utf8' }));
    assert.strictEqual(setup.actualPort, state.actualPort);
    const windowHandle = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-Process -Id ${state.pid}).MainWindowHandle`], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    assert.strictEqual(Number(windowHandle.trim()), 0);
    const listeners = execFileSync('netstat.exe', ['-ano', '-p', 'tcp'], { windowsHide: true, timeout: 5000, encoding: 'utf8' });
    assert.strictEqual(listeners.split(/\r?\n/).filter(line => new RegExp(':' + state.actualPort + '\\s+.*LISTENING\\s+' + state.pid + '\\s*$').test(line)).length, 1);
    await idle(cookie);
    console.log('PASS real hidden startup launcher via isolated shortcut, successive 7331–7333 conflicts, actual-port Setup/Diagnostics, duplicate reuse and exactly one owned listener (not a Windows sign-in test)');
  } finally {
    let stopError;
    try { await stop(); }
    catch (error) { stopError = error; }
    try {
      if (startupOwned) execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(app, 'scripts/stop.ps1')], { windowsHide: true, timeout: 15000, stdio: 'pipe' });
    } catch (error) { stopError = error; }
    // Always close our conflict listeners so a failed ownership query reports
    // a test failure rather than keeping the suite alive indefinitely.
    for (const blocker of blockers) await new Promise(resolve => blocker.close(resolve));
    if (stopError) throw stopError; // Retain the fixture; never delete a live app.
    assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
    await removeOwnedFixture(temp);
  }
}
async function testMigrationPreflight() {
  if(process.platform!=='win32')return;
  const fixture=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-migration-test-'));
  const local=path.join(fixture,'LocalAppData'),legacy=path.join(local,'PCMonitor'),destination=path.join(local,'Rovarin');
  fs.mkdirSync(local);const script=path.join(root,'scripts/rebrand-migration.ps1');
  const quote=value=>"'"+value.replace(/'/g,"''")+"'";
  const registration='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{C51A4180-26D2-4F48-93BD-B40B182B78DA}_is1';
  const bootstrap=path.join(fixture,'bootstrap.ps1'),specFile=path.join(fixture,'fixture.json');
  fs.writeFileSync(bootstrap,
    '$ErrorActionPreference="Stop"\n'+
    '$spec=Get-Content -LiteralPath '+quote(specFile)+' -Raw|ConvertFrom-Json\n'+
    '$registration='+quote(registration)+'\n'+
    'function global:Test-Path { param([string]$LiteralPath) if($LiteralPath -eq $registration){return $spec.registered}; Microsoft.PowerShell.Management\\Test-Path -LiteralPath $LiteralPath }\n'+
    'function global:Get-ItemProperty { param([string]$LiteralPath) if($LiteralPath -ne $registration){throw "unexpected-registry-read"};return $spec.entry }\n'+
    'function global:Get-CimInstance { [CmdletBinding()]param([string]$ClassName,[int]$OperationTimeoutSec) if($ClassName -ne "Win32_Process" -or $OperationTimeoutSec -ne 10){throw "unbounded-process-query"}; if($spec.queryFails){throw "process-query-unavailable"};return $spec.processes }\n'+
    '& '+quote(script)+' -Mode Prepare -Destination '+quote(destination)+'\nexit $LASTEXITCODE\n');
  const entry={DisplayName:'PC Monitor',DisplayVersion:'0.1.0',InstallLocation:legacy,UninstallString:'"'+path.join(legacy,'unins000.exe')+'"'};
  const cases=[
    {label:'no registration fresh install',registered:false,entry,processes:[],exit:0},
    {label:'removed default legacy install and unrelated process',registered:true,entry,processes:[{ExecutablePath:'C:\\Windows\\System32\\unrelated.exe',CommandLine:'unrelated.exe'}],exit:0},
    {label:'ambiguous missing install path',registered:true,entry:{...entry,InstallLocation:path.join(local,'unrelated')},processes:[],exit:1},
    {label:'wrong legacy uninstall command',registered:true,entry:{...entry,UninstallString:'unrelated.exe'},processes:[],exit:1},
    {label:'deleted executable still alive',registered:true,entry,processes:[{ExecutablePath:path.join(legacy,'runtime/node.exe'),CommandLine:''}],exit:1},
    {label:'legacy script reference still alive',registered:true,entry,processes:[{ExecutablePath:'node.exe',CommandLine:'node "'+path.join(legacy,'app/server.js')+'"'}],exit:1},
    {label:'ownership query unavailable',registered:true,entry,processes:[],queryFails:true,exit:1},
    {label:'current Rovarin upgrade',registered:true,entry:{...entry,DisplayName:'Rovarin',InstallLocation:destination},processes:[],exit:0}
  ];
  try {
    async function check(test){
      fs.writeFileSync(specFile,JSON.stringify(test));
      const result=await new Promise(resolve=>require('child_process').execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',bootstrap],{env:{...process.env,LOCALAPPDATA:local},windowsHide:true,timeout:20000,maxBuffer:16384},(error,stdout,stderr)=>resolve({error,stdout,stderr})));
      assert.strictEqual(result.error?result.error.code:0,test.exit,test.label+': '+result.stderr);
      assert(!result.stdout.includes('123456')&&!result.stderr.includes('123456'),'fixture PIN must not enter output');
    }
    for(const test of cases)await check(test);
    // A partially present install is NOT the absent-root exception. Preserve its data.
    fs.mkdirSync(path.join(legacy,'data'),{recursive:true});
    const config=path.join(legacy,'data/config.json'),saved=Buffer.from('{"pin":"123456","requireDesktopPin":true,"autoCheckUpdates":false}');
    fs.writeFileSync(config,saved);
    await check({label:'partial legacy installation remains fail closed',registered:true,entry,processes:[],exit:1});
    assert(fs.readFileSync(config).equals(saved),'refusal changed existing PIN/settings');
    assert(!fs.existsSync(destination),'preflight must not create a second config tree');
    const helper=fs.readFileSync(script,'utf8');
    assert(!/Remove-Item[^\n]*registration|Stop-Process|taskkill/i.test(helper),'migration preflight cannot delete registration or stop arbitrary processes');
    console.log('PASS migration fresh/current/stale registration, bounded process checks, partial/ambiguous/live/query-failure refusal, config preservation and no registry/process mutation');
  }finally{await fs.promises.rm(fixture,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

async function main() {
  await testMigrationPreflight();
  await testFixtureCleanup();
  execFileSync(process.execPath,[path.join(__dirname,'config-access-smoke-test.js')],{stdio:'inherit',timeout:15000});
  await require('./update-smoke-test')();
  await require('./release-manager-smoke-test')(root);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'packaging', 'payload-manifest.json')));
  for (const file of manifest.files) assert.strictEqual(hash(path.join(payload, file.path)), file.sha256, file.path);
  const files = manifest.files.map(file => file.path);
  // Current product text must be Rovarin. Opaque protocols and the dedicated
  // legacy migration helper are intentional compatibility, not visible branding.
  // Reviewed migration-only safety guards: exact complete lines for each
  // helper/server. Hashes bind the exception to the entire inspected deny-list/owned-
  // process condition; any changed or additional legacy text still fails.
  const compatibilityGuardLines = {
  "app/scripts/app-leftovers.cs": ["b432d234de8d5a8df1cfb4d5f1917b88a4330191e794165afc8a7c33bf07f8a7"],
  "app/leftover-manager.js": ["6e330604dd39645f0d988af04077306626ca7d9f5c431c58d1b22f98c6610740"],
  "app/scripts/terminate-process.ps1": ["4d4d3a970c1804ff016cd339820096110ffd1fa207fa51c18fe970b424a1616b"],
  "app/server.js": ["a6f79e93bd4b701e8c215ca933b55b1e388595b39d4e6d8525b7fd9ce305bd08"],
  "app/scripts/app-manager.ps1": [
    "aa7490602e22db2ad40ffccb54fe7faeafac54539fa981d1ec7531a71ad92b41",
    "525b01a0c8e0d24b53cecdcf86fdfdefcca8459cc5889a8300b434c0c8141fa3"
  ],
  "app/scripts/process-tree.cs": [
    "d61fa68dedf425782abb352835011869026fd63d8c94fd53bda848c195ca8f47",
    "87d6583ff11ec396d8b8b69540955c45ee63f3f3fecfb7c73eec28de8e528e02"
  ]
};
  for(const file of files.filter(file=>/\.(?:js|ps1|cs|vbs|html|css|json|md|txt)$/.test(file))) {
    if(file==='app/scripts/rebrand-migration.ps1')continue;
    const text=fs.readFileSync(path.join(payload,file),'utf8').replace(/PC_MONITOR[A-Z_]*|pc_monitor_session|PCMonitor\.NativeDesktop\.v1|x-pc-monitor-(?:desktop|ui-revision)|uninstall-pc-monitor|pc-monitor-(?:ui-revision|sidebar-expanded|stream-state|processes|pagechange|desktop-visibility|uninstalling)|pcMonitorUninstalling/gi,'');
    const reviewed = compatibilityGuardLines[file] || [];
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      if (!/pc[ _-]?monitor/i.test(line)) continue;
      const digest = crypto.createHash('sha256').update(line).digest('hex');
      assert(reviewed.includes(digest),'Unintended legacy branding in '+file);
    }
    for (const digest of reviewed) assert(lines.some(line=>crypto.createHash('sha256').update(line).digest('hex')===digest),'Reviewed legacy safety guard changed in '+file);
  }
  for (const file of ['runtime/node.exe', 'runtime/LICENSE', 'app/installation.json', 'app/update-manager.js', 'app/scripts/installed-update.ps1', 'app/scripts/setup.ps1', 'app/scripts/install-enhanced.ps1', 'app/scripts/rebrand-migration.ps1', 'app/desktop.vbs', 'app/startup.vbs', 'app/startup-disable.vbs']) assert(files.includes(file));
  for (const asset of ASSETS) assert(files.includes('app/vendor/LibreHardwareMonitor/0.9.6/' + asset));
  for (const file of ['LICENSE', 'THIRD-PARTY-NOTICES.txt', 'licenses/PawnIO.Modules.txt', 'source/LibreHardwareMonitor.zip']) assert(files.includes('app/vendor/LibreHardwareMonitor/0.9.6/' + file));
  assert(!files.some(file => /(?:config\.json|temperature-settings|server\.pid|server-state|server\.instance|\.log$|node_modules|smoke-test|pet-output|AGENTS\.md|PROJECT_STATUS\.md|THE-PLAN\.md)/.test(file)));
  for (const file of ['pin-manager.js','process-termination.js', 'app-manager.js','leftover-manager.js','scripts/app-leftovers.ps1','scripts/app-leftovers.cs','public/app-leftovers.js','scripts/terminate-process.ps1']) assert(files.includes('app/' + file));
  const pins = require('../pin-manager');
  const developmentConfig = pins.configurationFile(root);
  const developmentPin = fs.existsSync(developmentConfig) ? pins.readConfig(developmentConfig).pin : null;
  const privateAddresses = Object.values(os.networkInterfaces()).flat().filter(Boolean).map(info => info.address).filter(address => /^100\./.test(address));
  for (const file of manifest.files) {
    const contents = fs.readFileSync(path.join(payload, file.path));
    for (const privateValue of [developmentPin, os.homedir(), ...privateAddresses].filter(value => typeof value === 'string' && value.length > 0)) {
      assert(!contents.includes(Buffer.from(privateValue)) && !contents.includes(Buffer.from(privateValue, 'utf16le')), 'private development value in ' + file.path);
    }
  }
  assert(!files.some(file => /(?:\.sys$|developer|unrestricted|debug)/i.test(file)), 'no extracted unsigned/developer driver');
  const pawn = path.join(payload, 'app/vendor/PawnIO/2.2.0/PawnIO_setup.exe');
  assert.strictEqual(hash(pawn), PAWNIO_SHA256);
  const helper = fs.readFileSync(path.join(root, 'scripts/install-enhanced.ps1'), 'utf8');
  assert(helper.includes("-ArgumentList '-install', '-silent'"));
  assert(helper.includes("$signature.Status -ne 'Valid'"));
  assert(helper.includes('[IO.FileShare]::Read')); assert(helper.includes('240000'));
  const terms = fs.readFileSync(path.join(payload, 'app/vendor/PawnIO/2.2.0/NOTICE.txt'), 'utf8');
  assert(terms.includes('redistributed unmodified')); assert(terms.includes('proprietary'));
  const iss = fs.readFileSync(path.join(root, 'packaging/Rovarin.iss'), 'utf8');
  assert(iss.includes('VersionInfoVersion={#AppVersion}.0')); assert(iss.includes('VersionInfoProductVersion={#AppVersion}.0'));
  assert(iss.includes('PrivilegesRequired=lowest')); assert(iss.includes('PrepareToInstall')); assert(iss.includes('InitializeUninstall'));
  assert(iss.includes('{userstartup}\\Rovarin')); assert(!iss.includes('[Registry]'));
  assert.match(iss, /Name: "startup";[^\r\n]*Flags: checkedonce/);
  assert.match(iss, /Name: "desktopPin";[^\r\n]*Flags: checkedonce; Check: FreshDesktopPreference/);
  assert(iss.includes('if not ExistingConfiguration then begin') && iss.includes('Passwordless desktop requires interactive confirmation.'));
  assert(files.includes('app/scripts/native-trust.ps1'), 'native-only DPAPI helper must ship');
  assert(files.includes('app/scripts/native-startup.ps1'), 'fixed native startup helper must ship');
  assert(!files.includes('app/scripts/migrate-development-state.ps1') && !files.includes('app/scripts/development-start.ps1'), 'developer migration/launcher never ship');
  assert(!files.some(file => /desktop-trust\.bin$/.test(file)), 'no recipient credential in payload');
  assert(!iss.includes('Tasks: desktopicon'), 'desktop shortcut is unconditional');
  assert.strictEqual((iss.match(/Name: "\{autodesktop\}\\Rovarin"/g) || []).length, 1);
  assert.strictEqual((iss.match(/Name: "\{group\}\\Rovarin";/g) || []).length, 1);
  assert.match(iss, /Description: "Launch Rovarin"; Flags: postinstall nowait skipifsilent/);
  for (const directive of ['Uninstallable=yes','CreateUninstallRegKey=yes','UninstallDisplayName=Rovarin','FinishedHeadingLabel=Rovarin installed successfully']) assert(iss.includes(directive));
  assert(!iss.includes('Filename: "{sys}\\wscript.exe"'), 'normal shortcuts must target the application');
  assert(iss.includes('Filename: "{app}\\app\\Rovarin.exe"; WorkingDir: "{app}\\app"'));
  const launcher = path.join(payload,'app/Rovarin.exe');
  const nativeMetadata=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$v=[Diagnostics.FileVersionInfo]::GetVersionInfo('${launcher.replace(/'/g,"''")}'); @{product=$v.ProductName;description=$v.FileDescription;version=$v.FileVersion}|ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true,timeout:10000}));
  assert.strictEqual(nativeMetadata.product,'Rovarin');
  assert.strictEqual(nativeMetadata.description,'Rovarin');
  assert.strictEqual(nativeMetadata.version,JSON.parse(fs.readFileSync(path.join(root,'package.json'))).version+'.0');
  assert(iss.includes('DefaultDirName={localappdata}\\Rovarin') && iss.includes('UsePreviousAppDir=no') && iss.includes("RebrandMigration('Prepare')") && iss.includes("RebrandMigration('Commit')"));
  assert(!files.some(file=>/PCMonitor(?:Setup)?\.(?:exe|ico)/i.test(file)), 'current payload has no legacy executables/icons');
  const migration=fs.readFileSync(path.join(root,'scripts/rebrand-migration.ps1'),'utf8');
  for(const protection of ['legacy-hash-mismatch','conflicting-canonical-settings','replacement-setting-mismatch','legacy-setting-changed','redirecting-path','WaitForExit(60000)']) assert(migration.includes(protection));
  assert(fs.existsSync(launcher));
  const nativeBinary=fs.readFileSync(launcher);
  assert.strictEqual(nativeBinary.readUInt16LE(nativeBinary.readUInt32LE(0x3c)+24+68),2,'native desktop must use Windows GUI subsystem, no console');
  for(const name of ['Rovarin.ico','Rovarin.exe.config','Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll','WebView2Loader.dll','WebView2-LICENSE.txt','scripts/desktop-host.ps1']) assert(files.includes('app/'+name),'native payload missing '+name);
  const shellSource=fs.readFileSync(path.join(root,'packaging/DesktopShell.cs'),'utf8');
  assert(shellSource.includes('AreHostObjectsAllowed = false') && shellSource.includes('IsDashboardUri(e.Source, origin)'));
  assert(shellSource.includes('EventWaitHandleSecurity') && shellSource.includes('MutexSecurity') && shellSource.includes('WindowsIdentity.GetCurrent().User'));
  assert(iss.includes("'close-desktop'"));
  assert(!/Name: "\{group\}\\Rovarin Web Dashboard";/.test(iss), 'no end-user desktop browser shortcut');
  assert(iss.includes('Type: files; Name: "{group}\\Rovarin Web Dashboard.lnk"'), 'upgrade retires the old owned browser shortcut');
  assert(!shellSource.includes('OpenWeb') && !shellSource.includes('Open web dashboard') && !shellSource.includes('Open Web Dashboard'));
  assert(shellSource.includes('Copy Mobile Address') && shellSource.includes('Your clipboard was not changed.'));
  assert(!fs.readFileSync(path.join(root,'scripts/desktop.ps1'),'utf8').includes('--app='), 'retired Edge app launch');
  assert(!files.includes('app/scripts/desktop-preview.ps1') && !files.includes('app/scripts/desktop-preview-host.ps1'), 'development desktop helpers are not shipped');
  const previewSource=fs.readFileSync(path.join(root,'scripts/desktop-preview.ps1'),'utf8');
  assert(previewSource.includes("'packaging\\DesktopShell.cs'") && previewSource.includes('No backend or public/ files are copied'));
  assert(previewSource.includes("-ArgumentList 'close-desktop'") && !previewSource.includes('Stop-Process'), 'development rebuild uses cooperative shell closure');
  const buildSource=fs.readFileSync(path.join(root,'packaging/build.ps1'),'utf8');
  assert(buildSource.includes("@('data','desktop-profile')") && buildSource.indexOf('Generated payload contains local application data.') < buildSource.indexOf('Remove-Item -LiteralPath $payload'), 'build refuses to delete payload-local user state');
  const rejected = require('child_process').spawnSync(launcher, ['arbitrary-command'], {windowsHide:true,timeout:5000});
  assert.strictEqual(rejected.status, 2, 'launcher rejects unrecognized modes');
  execFileSync('powershell.exe', ['-NoProfile','-Command', `
    . '${path.join(root,'scripts/dashboard-runtime.ps1').replace(/'/g,"''")}'
    $script:reads=0
    function Get-DashboardRuntime { $script:reads++; if($script:reads -lt 3){return @{state='starting';pid=42}}; return @{state='owned';healthy=$true;pid=42} }
    $result=Wait-DashboardRuntime 'fixture' 3
    if(-not $result.healthy -or $reads -ne 3){throw 'Starting instance did not wait/reuse'}
    function Get-DashboardRuntime {return @{state='starting';pid=42}}
    $watch=[Diagnostics.Stopwatch]::StartNew();$result=Wait-DashboardRuntime 'fixture' 1
    if($result.state -ne 'starting' -or $watch.Elapsed.TotalSeconds -gt 2.5){throw 'Wait is not bounded'}
    function Get-DashboardRuntime {return @{state='unsafe'}}
    if((Wait-DashboardRuntime 'fixture' 1).state -ne 'unsafe'){throw 'Unsafe ownership must fail closed'}
  `], {windowsHide:true,timeout:10000});
  console.log('PASS app-owned fixed-mode GUI launcher, explicit uninstall metadata, completion wording and bounded starting/unsafe wait');
  const setupSource = fs.readFileSync(path.join(root, 'scripts/setup.ps1'), 'utf8');
  assert(!/iPhone|connect from your phone/i.test(setupSource), 'Setup/recovery must support any device');
  assert(iss.includes('WizardStyle=modern dark polar includetitlebar'));
  const projectLicense = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
  assert(projectLicense.includes('# PolyForm Noncommercial License 1.0.0') && projectLicense.includes('## Changes and New Works License'));
  assert.strictEqual(JSON.parse(fs.readFileSync(path.join(root, 'package.json'))).license, 'PolyForm-Noncommercial-1.0.0');
  assert.strictEqual(fs.readFileSync(path.join(payload, 'app/LICENSE'), 'utf8'), projectLicense, 'Installer must show the current project license');
  execFileSync('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts/setup-ui-test.ps1')], { windowsHide: true, timeout: 30000, stdio: 'inherit' });
  const {encodePhoneAddress}=require('./phone-qr');
  for(const url of ['http://100.64.1.2:7331','http://100.64.1.2:7332','http://100.127.255.254:65535'])assert.strictEqual(decodePhoneQr(encodePhoneAddress(url)),url,'QR must contain only the exact URL');
  for(const url of [null,'','http://127.0.0.1:7331','http://100.63.1.2:7331','http://100.128.1.2:7331','http://100.64.1.2:65536','http://100.64.1.2:7331?pin=123456','http://100.64.1.2:7331/','https://100.64.1.2:7331'])assert.throws(()=>encodePhoneAddress(url));
  assert(files.includes('app/scripts/phone-qr.js') && files.includes('app/scripts/empty-recycle-bin.ps1'));
  assert.strictEqual(hash(path.join(payload,'app/vendor/QRCode/1.8.0/qrcodegen.js')),'6a1116192ed1dd67fa1bf31e77f5817103d71c23bbac24c382e698b7668bdd01');
  assert(fs.readFileSync(path.join(payload,'app/vendor/QRCode/1.8.0/qrcodegen.js'),'utf8').includes('Permission is hereby granted'));
  assert(files.includes('app/vendor/QRCode/1.8.0/NOTICE.txt'));
  assert(!/fetch\(|require\(['"]https?['"]\)|createConnection\(|\.connect\(/.test(fs.readFileSync(path.join(root,'scripts/phone-qr.js'),'utf8')), 'QR helper has no network request mechanism');
  assert(setupSource.includes('$form.Add_FormClosing({Complete-LocalOnboarding})'));
  assert(setupSource.includes('[Windows.Forms.Clipboard]::SetText($script:pin)'), 'Copy uses the refreshed canonical PIN');
  assert(/\$copy\.Add_Click\(\{\s*if \(\-not \(Update-SetupPin\)\) \{ return \}\s*\[Windows\.Forms\.Clipboard\]::SetText\(\$script:pin\)/.test(setupSource), 'Copy must refresh successfully before accessing the clipboard');
  assert(fs.readFileSync(path.join(root,'scripts/installed-desktop.ps1'),'utf8').includes("'setup.ps1') -Automatic"));
  assert(iss.includes('ExistingOnboarding') && iss.includes('onboarding-complete.json'));
  console.log('PASS locally decoded exact URL-only QR, fallback port, invalid/secret URL rejection, pinned MIT encoder and one-time local Setup wiring');
  assert(setupSource.includes("Start-Process 'https://tailscale.com/download/windows'"));
  assert(setupSource.includes('Read-SetupDiagnostics -Refresh') && setupSource.includes('Update-PhoneSetup'));
  const onboarding = execFileSync('powershell.exe', ['-NoProfile', '-Command', `
    $source=[IO.File]::ReadAllText('${path.join(root,'scripts/setup.ps1').replace(/'/g,"''")}')
    $tokens=$null;$errors=$null;$ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors)
    if($errors.Count){throw 'Setup parse failed'}
    $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-PhoneSetupState'},$true)
    Invoke-Expression $definition.Extent.Text
    function Report($available,$state,$ip) { @{checks=@(@{id='tailscale';status=$available},@{id='tailscale-status';status=$(if($state -eq 'Running'){'supported'}else{'unavailable'});value=$state},@{id='tailscale-ip';value=$ip})} }
    $missing=Get-PhoneSetupState (Report 'unavailable' $null $null) 7332
    $offline=Get-PhoneSetupState (Report 'supported' 'NeedsLogin' '100.64.1.2') 7332
    $connected=Get-PhoneSetupState (Report 'supported' 'Running' '100.64.1.2') 7332
    $invalid=@('100.999.1.2','100.63.1.2','100.128.1.2','127.0.0.1','100.64.1.2?pin=123456') | ForEach-Object { (Get-PhoneSetupState (Report 'supported' 'Running' $_) 7332).address }
    if($invalid | Where-Object {$_}) {throw 'Unsafe phone URL'}
    if((Get-PhoneSetupState (Report 'supported' 'Running' '100.64.1.2') 0).address){throw 'Invalid port'}
    @($missing,$offline,$connected) | ConvertTo-Json -Depth 4
  `], {encoding:'utf8',windowsHide:true,timeout:10000});
  const states = JSON.parse(onboarding);
  assert.deepStrictEqual(states.map(state => state.kind), ['missing','disconnected','connected']);
  assert(states[0].install && !states[0].address && states[0].instructions.includes('works locally'));
  assert(!states[1].install && !states[1].address && states[1].instructions.includes('installed but not connected'));
  assert.strictEqual(states[2].address,'http://100.64.1.2:7332');
  assert(!states[2].address.includes('pin'));
  for (const state of states) assert(state.instructions.includes('another device') && !state.instructions.includes('iPhone'));
  console.log('PASS native phone onboarding missing/disconnected/connected, safe actual-port URL, re-check state reconciliation, official download and local finish; default startup/unconditional single shortcuts/finish launch');
  assert(iss.includes('Name: "{app}\\app\\uninstall-trust.json"'));
  assert(!iss.includes('Type: filesandordirs'), 'no unchecked recursive uninstall deletion');
  assert.strictEqual(installationResult(0).success, true);
  for (const code of [3010,1641]) assert.strictEqual(installationResult(code).rebootRequired, true);
  for (const code of [1223,1602]) assert.strictEqual(installationResult(code).code, 'cancelled');
  assert.strictEqual(installationResult(5).success, false); assert.strictEqual(installationResult(1460).code, 'install-unconfirmed');
  for(const code of ['package-invalid','package-unavailable','launch-failed'])assert.strictEqual(installationResult(-1,code).code,code);
  execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`
    $tokens=$null;$errors=$null;$source=[IO.File]::ReadAllText('${path.join(root,'scripts/install-enhanced.ps1').replace(/'/g,"''")}')
    $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Enhanced helper syntax'}
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'Get-EnhancedInstallMessage'},$true)
    Invoke-Expression $fn.Extent.Text
    foreach($code in @(0,3010,1641,1223,1602,1460,5)){ $message=Get-EnhancedInstallMessage @{exitCode=$code;failureCode='install-failed'};if(-not $message.Contains('Rovarin')){throw 'Missing core usability status'};if($code -in @(3010,1641) -and -not $message.Contains('Restart Windows')){throw 'Reboot message'};if($code -eq 0 -and -not $message.Contains('checked separately')){throw 'Sensor status conflated'};if($code -eq 5 -and -not $message.Contains('exit 5')){throw 'Failure exit missing'} }
    foreach($stage in @('package-invalid','package-unavailable','launch-failed')){if((Get-EnhancedInstallMessage @{exitCode=-1;failureCode=$stage}).Contains('not returned')){throw 'Validation/launch must not look like timeout'}}
    Add-Type -AssemblyName System.Drawing
    $source=[IO.File]::ReadAllText('${path.join(root,'scripts/setup.ps1').replace(/'/g,"''")}')
    $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Setup syntax'}
    $fn=$ast.Find({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq 'New-PhoneQrBitmap'},$true)
    $definition=$fn.Extent.Text.Replace('(Join-Path $PSScriptRoot ''phone-qr.js'')', "'${path.join(root,'scripts/phone-qr.js').replace(/'/g,"''")}'")
    $node='${process.execPath.replace(/'/g,"''")}';Invoke-Expression $definition
    if($null -ne (New-PhoneQrBitmap '')){throw 'QR visible without address'}
    if($null -ne (New-PhoneQrBitmap 'http://100.64.1.2:7332?pin=123456')){throw 'QR accepts PIN'}
    $bitmap=New-PhoneQrBitmap 'http://100.64.1.2:7332'
    if($null -eq $bitmap -or $bitmap.Width -ne 132){throw 'Native QR failed'}
    try{$bitmap.Save('${path.join(root,'packaging/cache/qr-preview.png').replace(/'/g,"''")}')}finally{$bitmap.Dispose()}
  `],{windowsHide:true,timeout:15000});
  const request = (address, host = '127.0.0.1:7331') => ({ socket: { remoteAddress: address }, headers: { host, 'x-forwarded-for': '127.0.0.1' } });
  for (const address of ['127.0.0.1','::ffff:127.0.0.1','::1']) assert(isLocalDesktopRequest(request(address)));
  for (const address of ['100.64.0.2','::ffff:100.64.0.2','192.168.0.1','fd7a:115c:a1e0::1']) assert(!isLocalDesktopRequest(request(address)));
  assert(!isLocalDesktopRequest(request('127.0.0.1','100.64.0.2:7331'))); assert(!isLocalDesktopRequest(request('127.0.0.1','attacker.invalid')));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-packaging-'));
  let child;
  try {
    const { EventEmitter } = require('events');
    const fixtureRoot = path.join(temp, 'handoff-app'); fs.mkdirSync(fixtureRoot);
    fs.writeFileSync(path.join(fixtureRoot,'installation.json'),JSON.stringify({schema:1,channel:'windows-x64'}));
    fs.mkdirSync(path.join(fixtureRoot,'scripts'));fs.mkdirSync(path.join(temp,'data'));
    fs.writeFileSync(path.join(fixtureRoot,'scripts/installed-uninstall.ps1'),'fixed mock helper');
    fs.writeFileSync(path.join(fixtureRoot,'uninstall-trust.json'),JSON.stringify({hashes:{'app\\scripts\\installed-uninstall.ps1':hash(path.join(fixtureRoot,'scripts/installed-uninstall.ps1'))}}));
    let launches = 0;
    const manager = new UninstallManager({root:fixtureRoot,launch:(command,args,options)=>{
      launches++; assert(command.endsWith('powershell.exe')); assert(args.includes('Launch')); assert(!args.includes('-FullRemoval')); assert(!args.includes('-OwnerPid')); assert(options.windowsHide && options.stdio==='ignore');
      const child = new EventEmitter(); child.unref=()=>{};
      setTimeout(()=>{const file=path.join(temp,'data/uninstall-handoff.json');const record=JSON.parse(fs.readFileSync(file));assert(record.removeData);assert.strictEqual(record.ownerPid,process.pid);record.phase='ready';fs.writeFileSync(file,JSON.stringify(record));child.emit('exit',0);},5); return child;
    }});
    const handoff = await manager.prepare(true);
    await assert.rejects(manager.prepare(true),/uninstall-in-progress/);
    await handoff.commit(); await handoff.commit(); assert.strictEqual(launches,1); assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp,'data/uninstall-handoff.json'))).phase,'committed'); assert(manager.accepted);
    const missingInstall=new UninstallManager({root:temp,launch:()=>{throw new Error('must not launch');}});
    await assert.rejects(missingInstall.prepare(false),/installed-only/);
    const failed=new UninstallManager({root:fixtureRoot,launch:()=>{throw new Error('failed');}});
    await assert.rejects(failed.prepare(false),/handoff-unavailable/); assert(!failed.busy);
    let abortedLaunches=0;
    const abortable=new UninstallManager({root:fixtureRoot,launch:()=>{
      abortedLaunches++;const child=new EventEmitter();child.unref=()=>{};
      setTimeout(()=>{const file=path.join(temp,'data/uninstall-handoff.json');const record=JSON.parse(fs.readFileSync(file));record.phase='ready';fs.writeFileSync(file,JSON.stringify(record));child.emit('exit',0);},5);return child;
    }});
    const aborted=await abortable.prepare(false);await aborted.abort();assert(!abortable.busy);assert.strictEqual(abortedLaunches,1);assert.strictEqual(JSON.parse(fs.readFileSync(path.join(temp,'data/uninstall-handoff.json'))).phase,'aborted');
    // Exercise the destructive UI without a browser or real uninstall operation.
    const vm=require('vm'); const elements=new Map(); const listeners=new Map();
    const element=id=>{if(!elements.has(id))elements.set(id,{value:'',checked:false,disabled:false,hidden:true,textContent:'',listeners:{},addEventListener(type,fn){this.listeners[type]=fn;}});return elements.get(id);};
    let posts=0, confirmed=false, signal=0;
    const windowMock={confirm:()=>confirmed,addEventListener:(name,fn)=>listeners.set(name,fn),dispatchEvent:event=>{if(event.type==='pc-monitor-uninstalling')signal++;}};
    vm.runInNewContext(fs.readFileSync(path.join(root,'public/uninstall.js'),'utf8'),{document:{getElementById:element},window:windowMock,CustomEvent:class{constructor(type){this.type=type;}},fetch:async(url,options)=>{
      assert(!url.includes('pin=')); if(options.method==='POST'){posts++;assert.strictEqual(JSON.parse(options.body).confirmation,'uninstall-pc-monitor');return {status:202,json:async()=>({code:'uninstall-accepted'})};}
      return {ok:true,json:async()=>({available:true,uninstalling:false})};
    }});
    listeners.get('pc-monitor-pagechange')({detail:{page:'diagnosticsPage'}}); await pause(5);assert.strictEqual(element('uninstallControls').hidden,false);
    element('uninstallPin').value='000000000000';await element('uninstallForm').listeners.submit({preventDefault(){}});assert.strictEqual(posts,0);
    confirmed=true;await element('uninstallForm').listeners.submit({preventDefault(){}});assert.strictEqual(posts,1);assert.strictEqual(signal,1);assert(windowMock.pcMonitorUninstalling);assert.strictEqual(element('uninstallPin').value,'');assert(element('uninstallSubmit').disabled);
    await element('uninstallForm').listeners.submit({preventDefault(){}});assert.strictEqual(posts,1);
    console.log('PASS uninstall UI final confirmation, installed-only visibility, body-only PIN clearing and accepted/no-retry state (DOM fixture)');
    const releaseRoot=path.join(temp,'release'); fs.mkdirSync(path.join(releaseRoot,'dist'),{recursive:true});fs.mkdirSync(path.join(releaseRoot,'packaging'));
    fs.writeFileSync(path.join(releaseRoot,'dist/RovarinSetup.exe'),'test fixture only');fs.writeFileSync(path.join(releaseRoot,'packaging/payload-manifest.json'),'{"files":[]}');fs.writeFileSync(path.join(releaseRoot,'package.json'),'{"version":"1.0.0"}');
    fs.writeFileSync(path.join(releaseRoot,'dist/build.json'),JSON.stringify({sha256:hash(path.join(releaseRoot,'dist/RovarinSetup.exe')),payloadManifestSha256:hash(path.join(releaseRoot,'packaging/payload-manifest.json')),inputs:[]}));
    await assert.rejects(verifyAndPublish(releaseRoot,async()=>{throw new Error('mock regression failed');}),/mock regression failed/);assert(!fs.existsSync(path.join(releaseRoot,'publish')));
    let calls=0;const published=await verifyAndPublish(releaseRoot,async()=>{calls++;});assert.strictEqual(calls,9);assert.strictEqual(published,hash(path.join(releaseRoot,'publish/RovarinSetup.exe')));
    const prior=fs.readFileSync(path.join(releaseRoot,'publish/RovarinSetup.exe'));
    await assert.rejects(verifyAndPublish(releaseRoot,async()=>{throw new Error('mock installer failed');}),/mock installer failed/);assert(fs.readFileSync(path.join(releaseRoot,'publish/RovarinSetup.exe')).equals(prior));
    await assert.rejects(verifyAndPublish(releaseRoot,async()=>{fs.writeFileSync(path.join(releaseRoot,'dist/RovarinSetup.exe'),'changed during verification');}),/Build changed/);assert(fs.readFileSync(path.join(releaseRoot,'publish/RovarinSetup.exe')).equals(prior));
    // Isolated RC builds promote only distributable bytes into the actual project.
    const outputProject=path.join(temp,'accessible-rc-project');fs.mkdirSync(outputProject);
    fs.writeFileSync(path.join(releaseRoot,'dist/RovarinSetup.exe'),prior);
    await verifyAndPublish(releaseRoot,async()=>{},outputProject);
    const accessible=path.join(outputProject,'publish');
    assert.deepStrictEqual(fs.readdirSync(accessible).sort(),['RovarinSetup.exe','RovarinSetup.sha256','release.json'].sort());
    assert(fs.readFileSync(path.join(accessible,'RovarinSetup.exe')).equals(prior));
    assert(fs.readFileSync(path.join(accessible,'RovarinSetup.sha256'),'utf8').startsWith(hash(path.join(accessible,'RovarinSetup.exe'))));
    await assert.rejects(verifyAndPublish(releaseRoot,async()=>{throw new Error('RC validation failed');},outputProject),/RC validation failed/);
    assert(fs.readFileSync(path.join(accessible,'RovarinSetup.exe')).equals(prior),'Failed RC must preserve accessible candidate');
    fs.writeFileSync(path.join(accessible,'config.json'),'private fixture');
    await assert.rejects(verifyAndPublish(releaseRoot,async()=>{},outputProject),/Publish contains unrelated files/);
    assert(fs.readFileSync(path.join(accessible,'RovarinSetup.exe')).equals(prior));
    console.log('PASS installed-only handoff, fixed arguments, acknowledgement/commit, duplicate guard, launch failure and verify-before-publish preservation (mock release fixture)');
    console.log('PASS staged RC promotion to established project publish folder, exact checksum, distributable-only assets and failed/private-output refusal');
    const service = new EnhancedSupport({ root: path.join(payload, 'app'), stateDirectory: temp, execute: (command, args, options, callback) => {
      assert(command.endsWith('powershell.exe')); assert(args.includes(path.join(payload, 'app/scripts/install-enhanced.ps1'))); assert(options.timeout === 300000);
      setTimeout(() => callback(null, JSON.stringify({exitCode:3010})), 20);
    } });
    const installing = service.install(); assert.strictEqual((await service.install()).code, 'install-in-progress'); assert.strictEqual((await installing).code, 'reboot-required');
    let probes=0;
    const driver=new EnhancedSupport({root:path.join(payload,'app'),stateDirectory:temp,execute:(command,args,options,callback)=>{probes++;assert(args.includes('-StatusOnly'));assert(options.timeout===10000 && options.maxBuffer===16384);setTimeout(()=>callback(null,'{"pawnIoInstalled":true}'),5);}});
    await Promise.all([driver.detectDriver(),driver.detectDriver(),driver.detectDriver()]);await driver.detectDriver();assert.strictEqual(probes,1,'driver checks coalesce/cache without a timer');
    for(const code of ['no-sensors','unsupported-cpu']){const state=driver.status({status:'unavailable',code,pawnIoInstalled:true});assert(state.driverInstalled && state.sensor==='unavailable');assert.match(state.note,/no supported CPU temperature sensor/);}
    assert.strictEqual(driver.status({status:'available',pawnIoInstalled:true}).sensor,'available');
    assert.strictEqual(driver.status({status:'failed',code:'provider-load-failed'}).sensor,'failed');
    assert.strictEqual(driver.status().sensor,'not-sampled');
    for(const result of [{output:'{"pawnIoInstalled":false}',status:'supported',installed:false},{output:'bad JSON',status:'failed',installed:null},{error:{code:'ENOENT'},status:'unavailable',installed:null},{error:{killed:true},status:'failed',installed:null}]){
      const check=new EnhancedSupport({stateDirectory:temp,execute:(_command,_args,_options,done)=>done(result.error,result.output)});await check.detectDriver();assert.strictEqual(check.driver.status,result.status);assert.strictEqual(check.status().driverInstalled,result.installed);
    }
    fs.writeFileSync(path.join(temp,'enhanced-install.json'),JSON.stringify({exitCode:3010,completedAt:Date.now()}));
    assert(driver.status().result.rebootRequired);assert.match(driver.status().note,/Restart Windows/);
    fs.writeFileSync(path.join(temp,'enhanced-install.json'),JSON.stringify({exitCode:3010,completedAt:Date.now()-os.uptime()*1000-6000}));assert(!driver.status().result.rebootRequired);assert(!driver.status().result.message.includes('Restart Windows'));
    fs.writeFileSync(path.join(temp,'enhanced-install.json'),JSON.stringify({exitCode:-1,failureCode:'package-invalid',completedAt:Date.now()}));assert.strictEqual(driver.status().result.code,'package-invalid');
    fs.unlinkSync(path.join(temp,'enhanced-install.json'));
    const providerSource=fs.readFileSync(path.join(root,'scripts/cpu-temperature-provider.ps1'),'utf8');assert(providerSource.indexOf('if ($StatusOnly)') < providerSource.indexOf('$computer.Open()'),'driver detection must not open hardware');
    console.log('PASS separate Enhanced install/reboot/cancel/package/launch messages, driver availability, VM-like unsupported sensor, provider failure and shared on-demand driver checks');
    const missing = new EnhancedSupport({ root: temp }); assert.strictEqual((await missing.install()).code, 'package-unavailable');
    fs.mkdirSync(path.join(temp,'vendor/PawnIO/2.2.0'), {recursive:true}); fs.writeFileSync(path.join(temp,'vendor/PawnIO/2.2.0/PawnIO_setup.exe'), 'invalid');
    assert.strictEqual((await missing.install()).code, 'package-invalid');
    console.log('PASS payload hashes/licenses/no secrets, signed production package selection, fixed UAC flags, local address enforcement, result mapping and in-flight guard');
    // Isolated installed structure, random port, no startup/driver changes.
    const app = path.join(temp, 'app'); fs.mkdirSync(app);
    for (const name of ['server.js','diagnostics.js','maintenance-service.js','server-lifecycle.js','pin-manager.js','process-termination.js', 'app-manager.js','leftover-manager.js','enhanced-support.js','uninstall-manager.js', 'update-manager.js','cpu-temperature-provider.js','temperature-manager.js','maintenance.js','process-stats.js','package.json']) fs.copyFileSync(path.join(root,name),path.join(app,name));
    fs.writeFileSync(path.join(app,'installation.json'),'{}');
    let output = '', base;
    child = spawn(process.execPath, [path.join(app,'server.js')], {cwd:app, env:{...process.env,PORT:'0',PC_MONITOR_PIN:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject) => {
      const timeout=setTimeout(()=>reject(new Error('Startup timed out')),15000);
      const inspect = chunk => { output+=chunk; const match=output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/); if(match){base='http://127.0.0.1:'+match[1];clearTimeout(timeout);resolve();} };
      child.stdout.on('data',inspect);child.stderr.on('data',inspect);child.once('error',reject);
    });
    const dataDir=path.join(temp,'data'); const configFile=path.join(dataDir,'config.json');
    const config=fs.readFileSync(configFile,'utf8'); const pin=JSON.parse(config).pin;
    assert(/^\d{6}$/.test(pin)); assert(!output.includes(pin)); assert(!fs.existsSync(path.join(app,'config.json')));
    const call = (route, method='GET', body, headers={}) => fetch(base+route,{method,headers,body});
    assert.strictEqual((await call('/api/temperature/enhanced')).status,401);
    assert.strictEqual((await call('/api/temperature/enhanced/install','POST','{}',{'Content-Type':'application/json'})).status,401);
    const login=await call('/api/login','POST',JSON.stringify({pin}),{'Content-Type':'application/json'});assert.strictEqual(login.status,200);
    const cookie=login.headers.getSetCookie().find(value=>value.startsWith('pc_monitor_session=')).split(';')[0];
    const headers={'Cookie':cookie,'Content-Type':'application/json'};
    const uninstallBody=JSON.stringify({pin,confirmation:'uninstall-pc-monitor',removeData:false});
    assert.strictEqual((await call('/api/system/uninstall')).status,401);
    assert.strictEqual((await call('/api/system/uninstall','POST',uninstallBody,{'Content-Type':'application/json'})).status,401);
    assert.strictEqual((await call('/api/system/uninstall','POST',uninstallBody,{...headers,Origin:'https://attacker.invalid'})).status,403);
    assert.strictEqual((await call('/api/system/uninstall','DELETE',uninstallBody,headers)).status,405);
    assert.strictEqual((await call('/api/system/uninstall?pin=never','POST',uninstallBody,headers)).status,400);
    assert.strictEqual((await call('/api/system/uninstall','POST',uninstallBody,{Cookie:cookie})).status,415);
    for(const body of ['{','[]','null',JSON.stringify({pin,confirmation:'uninstall-pc-monitor',removeData:false,path:'C:\\Windows'}),JSON.stringify({pin,confirmation:'uninstall-pc-monitor',removeData:false,command:'calc.exe'}),JSON.stringify({pin,confirmation:'yes',removeData:false})]) assert.strictEqual((await call('/api/system/uninstall','POST',body,headers)).status,400);
    assert.strictEqual((await call('/api/system/uninstall','POST',uninstallBody,headers)).status,409,'untrusted/source copy cannot uninstall');
    assert.strictEqual((await (await call('/api/system/uninstall','GET',undefined,headers)).json()).available,false);
    assert.strictEqual((await call('/api/temperature/enhanced/install','POST','{}',{...headers,Origin:'https://attacker.invalid'})).status,403);
    const http=require('http');
    await new Promise((resolve,reject)=>{ const req=http.request(base+'/api/temperature/enhanced/install',{method:'POST',headers:{...headers,Host:'100.64.0.2:'+new URL(base).port}},res=>{assert.strictEqual(res.statusCode,403);res.resume();res.on('end',resolve);});req.on('error',reject);req.end('{}'); });
    for(const body of ['{','{"path":"C:\\\\Windows"}','{"command":"calc.exe"}','[]','null']) assert.strictEqual((await call('/api/temperature/enhanced/install','POST',body,headers)).status,400);
    assert.strictEqual((await call('/api/temperature/enhanced/install','POST','{}',{Cookie:cookie})).status,415);
    assert.strictEqual((await call('/api/temperature/enhanced/install','POST','{}',headers)).status,503,'missing bundled package fails without execution');
    assert.strictEqual((await call('/api/temperature/enhanced?path=../','GET',undefined,headers)).status,400);
    const status=await (await call('/api/temperature/enhanced','GET',undefined,headers)).json();assert(status.localDesktop);assert(!status.bundled);assert(!JSON.stringify(status).includes(pin));
    const report=await (await call('/api/diagnostics','GET',undefined,headers)).json();assert(!JSON.stringify(report).includes(pin));assert(report.binding.actualPort===Number(new URL(base).port));
    const idle=await (await call('/api/monitoring/status','GET',undefined,headers)).json();assert.deepStrictEqual(idle.timers,{});assert.deepStrictEqual(idle.activeCommands,[]);
    assert.strictEqual(fs.readFileSync(configFile,'utf8'),config,'API preserves PIN');
    console.log('PASS installed data separation, secure PIN generation, authenticated/local-only fixed installation API, origin/JSON/path rejection, actual port, secret-free diagnostics and idle samplers');
    const wrong=pin==='000000000000'?'111111111111':'000000000000';
    for(let i=0;i<5;i++) assert.strictEqual((await call('/api/system/uninstall','POST',JSON.stringify({pin:wrong,confirmation:'uninstall-pc-monitor',removeData:false}),headers)).status,i===4?429:401);
    assert.strictEqual((await call('/api/system/uninstall','POST',uninstallBody,headers)).status,429);
    assert.strictEqual((await call('/api/login','POST',JSON.stringify({pin}),{'Content-Type':'application/json'})).status,429,'uninstall PIN failures share login lockout');
    console.log('PASS uninstall auth/origin/method/strict-input/dev-copy protection and shared PIN abuse lockout');
    await call('/api/logout','POST',undefined,headers);
    assert.strictEqual((await call('/api/temperature/enhanced','GET',undefined,headers)).status,401);
    assert.strictEqual((await call('/api/system/uninstall','POST',uninstallBody,headers)).status,401);
  } finally {
    if(child && child.exitCode===null){const closed=new Promise(resolve=>child.once('close',resolve));child.kill();await closed;}
    // Own mkdtemp directory only; resolve containment before removing.
    await removeOwnedFixture(temp);
  }
}
async function testEnhancedExisting() {
  const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-enhanced-existing-'));
  try {
    const code=path.join(temp,'fixture.cs'),binary=path.join(temp,'versioned.dll');
    fs.writeFileSync(code,'using System.Reflection;[assembly:AssemblyFileVersion("2.2.0.0")] public class Fixture {}');
    execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:library','/out:'+binary,code],{windowsHide:true,stdio:'pipe'});
    const directory=path.join(temp,'PawnIO'),driver=path.join(temp,'System32/DriverStore/FileRepository/pawnio.inf_fixture/PawnIO.sys');
    fs.mkdirSync(directory,{recursive:true});fs.mkdirSync(path.dirname(driver),{recursive:true});
    fs.copyFileSync(binary,path.join(directory,'PawnIOLib.dll'));fs.copyFileSync(binary,driver);
    const q=v=>v.replace(/'/g,"''");
    const output=execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',`
      $t=$null;$e=$null;$text=[IO.File]::ReadAllText('${q(path.join(root,'scripts/install-enhanced.ps1'))}');$ast=[Management.Automation.Language.Parser]::ParseInput($text,[ref]$t,[ref]$e);if($e.Count){throw 'Syntax'}
      foreach($name in @('Test-EnhancedAlreadyInstalled','Get-EnhancedInstallMessage')){$f=$ast.Find({param($n)$n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -eq $name},$true);Invoke-Expression $f.Extent.Text}
      $env:ProgramFiles='${q(temp)}';$env:SystemRoot='${q(temp)}';$script:case='valid'
      function Get-ItemProperty($LiteralPath){
        if($script:case -eq 'absent'){throw 'Missing'}
        if($LiteralPath -like '*Uninstall*'){return @{DisplayVersion=$(if($script:case -eq 'old'){'2.1.0.0'}else{'2.2.0.0'});InstallLocation=$(if($script:case -eq 'wrong-directory'){'C:\\Other\\PawnIO'}else{'${q(directory)}'})}}
        return @{Type=$(if($script:case -eq 'shared-host'){32}else{1});Start=$(if($script:case -eq 'disabled'){4}else{3});ImagePath=$(if($script:case -eq 'wrong-driver'){'C:\\Other\\PawnIO.sys'}else{'${q(driver)}'})}
      }
      function Get-Item($LiteralPath,[switch]$Force){@{Attributes=$(if($script:case -eq 'redirected'){[IO.FileAttributes]::ReparsePoint}else{[IO.FileAttributes]::Normal})}}
      function Get-AuthenticodeSignature($LiteralPath){@{Status=$(if($script:case -eq 'invalid-signature'){'HashMismatch'}else{'Valid'});SignerCertificate=@{Subject=$(if($script:case -eq 'wrong-publisher'){'CN=Other,'}elseif($LiteralPath.EndsWith('.sys')){'CN=Microsoft Windows Hardware Compatibility Publisher,'}else{'CN=namazso.eu,'})}}}
      foreach($case in @('valid','absent','old','wrong-directory','shared-host','disabled','wrong-driver','redirected','invalid-signature','wrong-publisher')){$script:case=$case;if((Test-EnhancedAlreadyInstalled) -ne ($case -eq 'valid')){throw ('Verification: '+$case)}}
      $m=Get-EnhancedInstallMessage @{exitCode=0;failureCode='already-installed'};if(!$m.Contains('already installed') -or !$m.Contains('checked separately')){throw 'Status'}
      if(!(Get-EnhancedInstallMessage @{exitCode=183;failureCode='install-failed'}).Contains('exit 183')){throw 'Duplicate error swallowed'}
      Write-Output 'ENHANCED_EXISTING_PASS'
    `],{windowsHide:true,timeout:30000,encoding:'utf8'});
    assert(output.includes('ENHANCED_EXISTING_PASS'));
    const helper=fs.readFileSync(path.join(root,'scripts/install-enhanced.ps1'),'utf8');
    assert(helper.indexOf('if (Test-EnhancedAlreadyInstalled)') > helper.indexOf("throw 'Package verification failed.'"));
    assert(helper.indexOf('$previous.exitCode -eq 1460') < helper.indexOf('if (Test-EnhancedAlreadyInstalled)'), 'existing files cannot clear an unconfirmed installer before reboot');
    assert(helper.includes("if ($Notify -and $result.failureCode -ne 'already-installed')"));
    assert.strictEqual(installationResult(183).success,false);assert(installationResult(0,'already-installed').message.includes('already installed'));
    const iss=fs.readFileSync(path.join(root,'packaging/Rovarin.iss'),'utf8');
    assert(iss.includes('Name: "{group}\\Rovarin Setup and PIN Recovery"') && iss.includes('Lost your PIN? Open Windows Start'));
    assert(iss.includes('Parameters: "setup"; Description: "Open Setup and PIN Recovery"; Flags: postinstall nowait skipifsilent unchecked'));
    console.log('PASS verified PawnIO reuse; missing/old/wrong/shared/disabled/redirected/tampered registrations refused; error 183 preserved; PIN Recovery shortcut/guidance');
  } finally { await removeOwnedFixture(temp); }
}

(process.argv[2]==='--migration-only' ? testMigrationPreflight() : process.argv[2]==='--enhanced-only' ? testEnhancedExisting() : main().then(testEnhancedExisting).then(testPackagedRuntime).then(()=>require('./native-desktop-test')(__dirname.replace(/[\\/]scripts$/,''),payload))).catch(error=>{console.error(error);process.exitCode=1;});
