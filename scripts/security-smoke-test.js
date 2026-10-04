'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const os = require('os');
const pins = require('../pin-manager');

async function testNativeDesktopSecurity() {
  if (process.platform !== 'win32') return;
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-native-security-'));
  let child, url, captured = '';
  try {
    for (const name of ['server.js','server-lifecycle.js','pin-manager.js','process-termination.js','enhanced-support.js','uninstall-manager.js', 'update-manager.js','temperature-manager.js','cpu-temperature-provider.js','process-stats.js','maintenance.js','package.json']) fs.copyFileSync(path.join(root,name),path.join(directory,name));
    fs.mkdirSync(path.join(directory,'scripts'));
    fs.copyFileSync(path.join(root,'scripts/native-trust.ps1'),path.join(directory,'scripts/native-trust.ps1'));
    const configFile = path.join(directory,'config.json');
    pins.writeConfig(configFile,{pin:'654321',retained:true});
    const installer = fs.readFileSync(path.join(root,'packaging/Rovarin.iss'),'utf8');
    assert(installer.includes('Name: "desktopPin";') && installer.includes('Flags: checkedonce; Check: FreshDesktopPreference'));
    assert(installer.includes('if not ExistingConfiguration then begin') && installer.includes('Passwordless desktop requires interactive confirmation.'));
    assert(installer.includes('MB_YESNO or MB_DEFBUTTON2') && installer.includes("Preference := '--desktop-pin-on'"));
    assert(installer.includes('if CurStep = ssPostInstall then begin'), 'preference saved before first launch');
    const frontend = fs.readFileSync(path.join(root,'public/app.js'),'utf8');
    const nativePresentation = frontend.match(/const nativeSecurity = ([^;]+);/)[1];
    assert.strictEqual(vm.runInNewContext(nativePresentation,{window:{}}),false,'phone has no native controls');
    assert.strictEqual(vm.runInNewContext(nativePresentation,{window:{chrome:{},nativeShell:true}}),false,'CSS/client flags do not grant native presentation');
    const invokePreference = flag => new Promise((resolve,reject)=>execFile(process.execPath,[path.join(directory,'pin-manager.js'),flag],{timeout:5000},error=>error?reject(error):resolve()));
    await invokePreference('--desktop-pin-off');
    assert.strictEqual(pins.readConfig(configFile).pin,'654321');assert.strictEqual(pins.readConfig(configFile).requireDesktopPin,false);
    await invokePreference('--desktop-pin-on');
    assert.strictEqual(pins.readConfig(configFile).pin,'654321');assert.strictEqual(pins.readConfig(configFile).requireDesktopPin,true);
    assert.strictEqual(pins.readConfig(configFile).retained,true);
    const localCheck = require('../enhanced-support').isLocalDesktopRequest;
    assert.strictEqual(localCheck({socket:{remoteAddress:'100.64.1.2'},headers:{host:'127.0.0.1:7331'}}),false);
    const credential = await new Promise((resolve,reject) => execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(directory,'scripts/native-trust.ps1')],{windowsHide:true,timeout:15000},(error,stdout)=>error?reject(new Error('Windows DPAPI fixture failed')):resolve(stdout.trim())));
    assert.strictEqual(credential.length,44);
    assert(!fs.readFileSync(path.join(directory,'desktop-trust.bin')).includes(Buffer.from(credential)), 'credential encrypted at rest');
    const env = {...process.env,PORT:'0'}; delete env.PC_MONITOR_PIN;
    child = spawn(process.execPath,['server.js'],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});
    await new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('Native security startup timeout')),15000);
      const read=chunk=>{captured+=chunk;const m=captured.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);if(m&&!url){url='http://127.0.0.1:'+m[1];clearTimeout(timer);resolve();}};
      child.stdout.on('data',read);child.stderr.on('data',read);child.once('error',reject);
    });
    const call=(route,body={},cookie='',key=credential,origin=url)=>fetch(url+route,{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(key?{'X-PC-Monitor-Desktop':key}:{}),...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
    const cookieOf=response=>response.headers.getSetCookie().find(c=>c.startsWith('pc_monitor_session=')).split(';')[0];
    const login=async pin=>{const r=await call('/api/login',{pin},'',null);assert.strictEqual(r.status,200);return cookieOf(r);};
    const cookie=await login('654321');
    assert.strictEqual((await fetch(url+'/api/updates')).status,401);
    assert.strictEqual((await fetch(url+'/api/updates',{headers:{Cookie:cookie}})).status,200);
    assert.strictEqual((await call('/api/desktop/updates',{action:'download'},cookie,null)).status,401);
    assert.strictEqual((await call('/api/desktop/updates',{action:'status'},'',credential)).status,401);
    assert.strictEqual((await call('/api/desktop/updates',{action:'check'},cookie,credential,'http://evil.invalid')).status,403);
    assert.strictEqual((await call('/api/desktop/updates',{action:'download',url:'https://evil.invalid/a',path:'C:/x'},cookie)).status,400);
    assert.strictEqual((await call('/api/desktop/updates',{action:'download'},cookie)).status,409,'development copy cannot install');
    const preference = await call('/api/desktop/updates',{action:'preference'},cookie);
    assert.strictEqual(preference.status,200);assert.strictEqual((await preference.json()).autoCheck,false);
    assert.strictEqual(pins.readConfig(configFile).pin,'654321');
    assert.strictEqual((await call('/api/desktop/updates',{action:'status'},cookie)).status,200);
    assert.strictEqual((await call('/api/desktop/auth')).status,401,'PIN required by default');
    const malformed=await fetch(url+'/api/desktop/security',{method:'POST',headers:{'Content-Type':'application/json',Origin:url,'X-PC-Monitor-Desktop':credential,Cookie:cookie},body:'{broken'});
    assert.strictEqual(malformed.status,400);
    assert.strictEqual((await call('/api/desktop/security',{action:'status'},cookie,null)).status,401,'regular authenticated browser not trusted');
    assert.strictEqual((await call('/api/desktop/security',{action:'status'},'',credential)).status,401,'native secret does not replace settings session');
    assert.strictEqual((await call('/api/desktop/security',{action:'preference',requireDesktopPin:false,confirmed:true},cookie,credential,'http://evil.invalid')).status,403);
    assert.strictEqual((await call('/api/desktop/security',{action:'preference',requireDesktopPin:false,confirmed:false},cookie)).status,400);
    assert.strictEqual((await call('/api/desktop/security',{action:'status',unexpected:true},cookie)).status,400);
    assert.strictEqual((await call('/api/desktop/security',{action:'preference',requireDesktopPin:false,confirmed:true},cookie)).status,200);
    assert.strictEqual(pins.readConfig(configFile).pin,'654321');assert.strictEqual(pins.readConfig(configFile).retained,true);
    assert.strictEqual((await call('/api/desktop/auth',{},'',null)).status,401,'loopback alone never bypasses PIN');
    assert.strictEqual((await call('/api/desktop/auth',{},'',Buffer.alloc(32).toString('base64'))).status,401,'forged native credential rejected');
    assert.strictEqual((await fetch(url+'/api/metrics',{headers:{'User-Agent':'Rovarin.exe'}})).status,401,'phone/browser still protected');
    const native=await call('/api/desktop/auth');assert.strictEqual(native.status,200);const nativeCookie=cookieOf(native);
    assert.strictEqual((await fetch(url+'/api/metrics',{headers:{Cookie:nativeCookie}})).status,200);
    assert.strictEqual((await call('/api/desktop/security',{action:'lock'},nativeCookie)).status,200);
    assert.strictEqual((await fetch(url+'/api/metrics',{headers:{Cookie:nativeCookie}})).status,401);
    assert.strictEqual((await call('/api/desktop/auth')).status,401,'lock persists across native relaunch');
    const afterLock=await login('654321');
    const automatic=await call('/api/desktop/auth');assert.strictEqual(automatic.status,200);const automaticCookie=cookieOf(automatic);
    assert.strictEqual((await call('/api/desktop/security',{action:'preference',requireDesktopPin:true,confirmed:true},afterLock)).status,200);
    assert.strictEqual((await fetch(url+'/api/metrics',{headers:{Cookie:automaticCookie}})).status,401,'re-enable revokes automatic sessions');
    assert.strictEqual((await call('/api/desktop/auth')).status,401);
    const beforeRotation=await login('654321');
    const rotated=await call('/api/desktop/security',{action:'rotate',confirmed:true},beforeRotation);assert.strictEqual(rotated.status,200);
    const newPin=(await rotated.json()).pin;assert.match(newPin,/^\d{6}$/);assert.notStrictEqual(newPin,'654321');
    assert.strictEqual((await fetch(url+'/api/metrics',{headers:{Cookie:cookie}})).status,401);
    assert.strictEqual((await call('/api/login',{pin:'654321'},'',null)).status,401);
    await login(newPin);assert.strictEqual(pins.readConfig(configFile).pin,newPin,'one canonical phone/native PIN');
    assert(!captured.includes(newPin)&&!captured.includes(credential),'no PIN or desktop credential in logs');
    console.log('PASS Windows DPAPI native trust, browser rejection, default/optional PIN, confirmation, lock, preference revocation and canonical PIN rotation');
  } finally {
    if(child&&child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill();await exited;}
    // Windows may briefly retain a scanner/file handle after the owned child exits.
    fs.rmSync(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100});
  }
}

async function testLocalPinManagement() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-pin-test-'));
  let child;
  const file = path.join(directory, 'config.json');
  try {
    const fresh = pins.loadConfig(file);
    assert.match(fresh.pin, /^\d{6}$/);
    assert.match(fs.readFileSync(path.join(root, 'pin-manager.js'), 'utf8'), /crypto\.randomInt\(0, 1000000\)/);
    assert(!pins.validPin('1234')); assert(!pins.validPin('1234567')); assert(!pins.validPin(123456));
    assert(!pins.validPin('123456\n')); assert(!pins.validPin('123456789012\n')); assert(!pins.validPin(' 123456'));
    const legacy = { pin: '123456789012', unrelated: { retained: true } };
    pins.writeConfig(file, legacy); assert.deepStrictEqual(pins.loadConfig(file), legacy);
    fs.writeFileSync(file, '{broken');
    assert.throws(() => pins.loadConfig(file)); assert.strictEqual(fs.readFileSync(file, 'utf8'), '{broken');
    pins.writeConfig(file, legacy);
    for (const name of ['server.js','server-lifecycle.js','pin-manager.js','process-termination.js','enhanced-support.js','uninstall-manager.js', 'update-manager.js','temperature-manager.js','cpu-temperature-provider.js','process-stats.js','maintenance.js','package.json']) fs.copyFileSync(path.join(root, name), path.join(directory, name));
    fs.mkdirSync(path.join(directory,'public'));
    fs.copyFileSync(path.join(root,'public/login.html'),path.join(directory,'public/login.html'));
    let output = '', url;
    await new Promise((resolve, reject) => {
      const env = { ...process.env, PORT: '0' }; delete env.PC_MONITOR_PIN;
      child = spawn(process.execPath, ['server.js'], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] });
      const timer = setTimeout(() => reject(new Error('PIN fixture startup timeout')), 15000);
      const read = chunk => { output += chunk; const match = output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/); if (match && !url) { url = 'http://127.0.0.1:' + match[1]; clearTimeout(timer); resolve(); } };
      child.stdout.on('data', read); child.stderr.on('data', read); child.once('error', reject);
    });
    const call = (route, cookie, body) => fetch(url + route, { method: body ? 'POST' : 'GET', headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json' }, body: body && JSON.stringify(body) });
    const signin = async pin => { const r = await call('/api/login', null, { pin }); assert.strictEqual(r.status, 200); return r.headers.getSetCookie().find(c => c.startsWith('pc_monitor_session=')).split(';')[0]; };
    const legacyPage=await call('/');const legacyHtml=await legacyPage.text();
    assert(legacyHtml.includes('<meta name="rovarin-pin-mode" content="12">'));
    assert(!legacyHtml.includes(legacy.pin),'PIN value must never be rendered');
    assert.strictEqual(legacyPage.headers.get('Cache-Control'),'no-store');
    const a = await signin(legacy.pin), b = await signin(legacy.pin);
    const lease = await call('/api/monitoring/lease', a, { action: 'acquire' }); assert.strictEqual(lease.status, 201);
    const leaseId = (await lease.json()).leaseId;
    const stream = await call('/api/stream?lease=' + leaseId, a); assert.strictEqual(stream.status, 200);
    const reader = stream.body.getReader(); await reader.read();
    const pending = [];
    for (const [route, payload] of [['/api/monitoring/lease',{action:'acquire'}],['/api/maintenance/run',{action:'not-an-action'}]]) {
      const uri = new URL(url), bytes = Buffer.from(JSON.stringify(payload));
      const socket = require('net').createConnection(Number(uri.port), uri.hostname);
      let response = '';
      const done = new Promise(resolve => { socket.on('data', chunk => { response += chunk; }); socket.on('end', () => resolve(response)); });
      await new Promise(resolve => socket.once('connect', resolve));
      socket.write(`POST ${route} HTTP/1.1\r\nHost: ${uri.host}\r\nCookie: ${a}\r\nContent-Type: application/json\r\nContent-Length: ${bytes.length}\r\nConnection: close\r\n\r\n`);
      socket.write(bytes.subarray(0,bytes.length-1)); pending.push({socket,bytes,done});
    }
    await new Promise(resolve => setTimeout(resolve, 150));
    for (const route of ['/api/pin/recovery','/api/pin/regenerate']) {
      assert.strictEqual((await call(route)).status, 401);
      assert.strictEqual((await call(route, a, {})).status, 405, 'no web recovery route is exposed');
    }
    for (let i=0; i<5; i++) assert.strictEqual((await call('/api/login', null, {pin:'wrong'})).status, i===4 ? 429 : 401);
    const helperOutput = await new Promise((resolve, reject) => execFile(process.execPath, ['pin-manager.js','--regenerate'], { cwd: directory, timeout: 5000 }, (error, stdout) => error ? reject(error) : resolve(stdout)));
    const updated = pins.readConfig(file);
    for (const held of pending) { held.socket.end(held.bytes.subarray(held.bytes.length-1)); assert.match(await held.done, /^HTTP\/1\.1 401/, 'revoked in-flight body cannot create a lease or run maintenance'); }
    const currentPage=await call('/');const currentHtml=await currentPage.text();assert(currentHtml.includes('<meta name="rovarin-pin-mode" content="6">'));assert(!currentHtml.includes(updated.pin));
    assert.match(updated.pin, /^\d{6}$/); assert.notStrictEqual(updated.pin, legacy.pin); assert.deepStrictEqual(updated.unrelated, legacy.unrelated);
    assert(!helperOutput.includes(updated.pin) && !output.includes(updated.pin) && !output.includes(legacy.pin));
    assert.strictEqual((await call('/api/monitoring/status', a)).status, 401);
    assert.strictEqual((await call('/api/maintenance/status', b)).status, 401, 'ALL prior sessions are revoked');
    let streamEnded = false;
    for (let i=0; i<5; i++) { const result = await reader.read(); if (result.done) { streamEnded = true; break; } }
    assert(streamEnded, 'PIN replacement closes existing SSE');
    assert.strictEqual((await call('/api/login', null, { pin: legacy.pin })).status, 401);
    const c = await signin(updated.pin);
    const status = await (await call('/api/monitoring/status', c)).json(); assert.strictEqual(status.active, false); assert.deepStrictEqual(status.timers, {});
    // Simulate an interrupted replacement: original file must remain valid.
    const rename = fs.renameSync;
    try { fs.renameSync = () => { throw new Error('fixture write failure'); }; assert.throws(() => pins.writeConfig(file, { ...updated, pin: pins.generatePin(updated.pin) })); }
    finally { fs.renameSync = rename; }
    assert.deepStrictEqual(pins.readConfig(file), updated);
    assert(!fs.readdirSync(directory).some(name => name.endsWith('.tmp')));
    console.log('PASS fresh cryptographic 6-digit PIN, legacy PIN, native-local regeneration, no recovery API, all-session/SSE/lease revocation, settings preservation and atomic failure');
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise(resolve => child.once('exit', resolve)); }
    fs.rmSync(directory, { recursive: true, force: true, maxRetries:10, retryDelay:100 });
  }
}

const root = path.resolve(__dirname, '..');
let pin;
let output = '';
let serverProcess;
let baseUrl;

function request(route, { method = 'GET', cookie, body, headers = {}, rawPath } = {}) {
  return fetch(`${baseUrl}${rawPath || route}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body
  });
}

async function login() {
  const response = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  assert.strictEqual(response.status, 200, 'valid PIN should create a session');
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  assert(cookies.some(value => value.startsWith('auth_pin=') && value.includes('Max-Age=0')), 'obsolete PIN cookies should be cleared');
  const cookieHeader = cookies.find(value => value.startsWith('pc_monitor_session='));
  assert(cookieHeader && cookieHeader.includes('HttpOnly') && cookieHeader.includes('SameSite=Strict'));
  assert(cookieHeader.includes('Max-Age=7'), 'session cookie should use the configured session lifetime');
  const cookie = cookieHeader.split(';')[0];
  assert(!cookie.includes(pin), 'session cookie must not contain the PIN');
  assert(cookie.split('=')[1].length >= 40, 'session token should be high entropy');
  return cookie;
}

async function postLease(cookie, data) {
  return request('/api/monitoring/lease', {
    method: 'POST', cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, PORT: '0', PC_MONITOR_PIN: pin, PC_MONITOR_SESSION_TTL_MS: '7000', PC_MONITORING_LEASE_TTL_MS: '4000' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const timer = setTimeout(() => reject(new Error(`Server did not start in time. ${output.slice(-1200)}`)), 15000);
    const inspect = chunk => {
      output += chunk.toString();
      const match = output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !baseUrl) {
        baseUrl = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timer);
        resolve();
      }
    };
    serverProcess.stdout.on('data', inspect);
    serverProcess.stderr.on('data', inspect);
    serverProcess.on('error', reject);
    serverProcess.on('exit', code => {
      if (!baseUrl) { clearTimeout(timer); reject(new Error(`Server exited (${code}). ${output.slice(-1200)}`)); }
    });
  });
}

async function testUnauthenticatedAndInputValidation() {
  for (const route of ['/api/metrics', '/api/stream', '/api/monitoring/status', '/api/maintenance/status', '/api/maintenance/history', '/api/diagnostics', '/api/system/uninstall']) {
    const response = await request(route);
    assert.strictEqual(response.status, 401, `${route} must require authentication`);
  }
  for (const [route, body] of [
    ['/api/maintenance/run', '{"action":"clean_temp"}'],
    ['/api/monitoring/lease', '{"action":"acquire"}'],
    ['/api/system/uninstall', '{"pin":"000000000000","confirmation":"uninstall-pc-monitor","removeData":false}']
  ]) {
    const response = await request(route, { method: 'POST', body, headers: { 'Content-Type': 'application/json' } });
    assert.strictEqual(response.status, 401, `${route} must require authentication before parsing/execution`);
  }
  assert.strictEqual((await request('/api/logout', { method: 'POST' })).status, 401, 'logout endpoint must reject unauthenticated requests');
  const queryBypass = await request(`/api/maintenance/status?pin=${encodeURIComponent(pin)}`);
  assert.strictEqual(queryBypass.status, 401, 'PIN query parameters must not authenticate');
  const bearerBypass = await request('/api/maintenance/status', { headers: { Authorization: `Bearer ${pin}` } });
  assert.strictEqual(bearerBypass.status, 401, 'PIN bearer headers must not authenticate');
  const invalid = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'incorrect' }) });
  assert.strictEqual(invalid.status, 401);
  const malformedLogin = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.strictEqual(malformedLogin.status, 401, 'malformed login body should fail closed');
  const crossOrigin = await request('/api/login', { method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) });
  assert.strictEqual(crossOrigin.status, 403, 'cross-origin state changes should be rejected');
  console.log('PASS unauthenticated API denial, URL/bearer bypass rejection, malformed login, and origin validation');
}

async function testSessionsLeasesAndSse() {
  const firstCookie = await login();
  const secondCookie = await login();
  const page = await request('/', { cookie: firstCookie });
  assert.strictEqual(page.status, 200);
  const dashboardHtml = await page.text();
  const uiRevision = page.headers.get('x-pc-monitor-ui-revision');
  assert.match(uiRevision || '', /^[a-f0-9]{64}$/);
  assert.strictEqual(page.headers.get('cache-control'), 'no-store');
  assert(dashboardHtml.includes(`name="pc-monitor-ui-revision" content="${uiRevision}"`));
  for (const match of dashboardHtml.matchAll(/(?:src|href)="(\/[^" ]+\.(?:css|js)[^" ]*)"/g)) {
    assert(match[1].endsWith(`?v=${uiRevision}`), 'every dashboard stylesheet/script must be automatically versioned');
    const asset = await request(match[1], { cookie: firstCookie });
    assert.strictEqual(asset.status, 200);
    assert.strictEqual(asset.headers.get('cache-control'), 'no-store');
    assert.match(asset.headers.get('content-type'), match[1].includes('.css?') ? /text\/css/ : /javascript/);
  }
  assert.match(dashboardHtml, /Rovarin Dashboard/);
  assert.doesNotMatch(dashboardHtml, /Unlock Dashboard|pinInput/, 'a valid session should skip PIN login');
  assert.match(dashboardHtml, /data-page="processesPage"/, 'the authenticated dashboard should expose the Processes view');
  assert.match(dashboardHtml, /id="processesPage"[^>]*data-profile="processes"/, 'the Processes page should request its focused monitoring profile');
  assert.match(dashboardHtml, /id="logoutButton"/, 'the dashboard should retain its Lock button');
  assert.match(dashboardHtml, /data-page="diagnosticsPage"/);
  assert.match(dashboardHtml, /id="copyDiagnostics"/);
  for (const asset of ['/diagnostics.js', '/diagnostics.css']) {
    const authenticated = await request(asset, { cookie: firstCookie });
    assert.strictEqual(authenticated.status, 200);
    assert.match(authenticated.headers.get('content-type'), asset.endsWith('.js') ? /javascript/ : /text\/css/);
    assert.match(await (await request(asset)).text(), /Unlock Dashboard|pinInput/, 'diagnostics assets stay authenticated');
  }
  assert.match(page.headers.get('content-security-policy') || '', /frame-ancestors 'none'/);
  assert.strictEqual(page.headers.get('x-content-type-options'), 'nosniff');
  assert.strictEqual(page.headers.get('referrer-policy'), 'no-referrer');
  const loginScript = await request('/login.js');
  assert.strictEqual(loginScript.status, 200, 'login script is public for the login page');
  assert.strictEqual((await request('/processes.js')).status, 200, 'process UI script should be served');
  assert.strictEqual((await request('/processes.css')).status, 200, 'process UI styles should be served');

  const created = await postLease(firstCookie, { action: 'acquire' });
  assert.strictEqual(created.status, 201);
  const leaseId = (await created.json()).leaseId;
  const uiHeartbeat = await postLease(firstCookie, { action: 'heartbeat', leaseId });
  assert.strictEqual(uiHeartbeat.status, 200);
  assert.strictEqual(uiHeartbeat.headers.get('x-pc-monitor-ui-revision'), uiRevision, 'existing heartbeat exposes the same UI revision');
  assert.strictEqual((await request('/api/processes', { cookie: firstCookie, headers: { 'X-Monitor-Lease': leaseId } })).status, 403, 'dashboard profile must not expose process data');
  assert.strictEqual((await request('/api/processes', { cookie: firstCookie })).status, 403, 'process requests must not silently acquire a lease');
  assert.strictEqual((await postLease(firstCookie, { action: 'set-profile', leaseId, profile: 'unknown' })).status, 400);
  assert.strictEqual((await postLease(secondCookie, { action: 'heartbeat', leaseId })).status, 410, 'a second session must not renew another session lease');
  assert.strictEqual((await postLease(secondCookie, { action: 'release', leaseId })).status, 410, 'a second session must not release another session lease');
  const secondLeaseResponse = await postLease(secondCookie, { action: 'acquire' });
  assert.strictEqual(secondLeaseResponse.status, 201);
  const secondLeaseId = (await secondLeaseResponse.json()).leaseId;
  assert.strictEqual((await postLease(secondCookie, { action: 'set-profile', leaseId: secondLeaseId, profile: 'cpu-detail' })).status, 200);
  const status = await request('/api/monitoring/status', { cookie: firstCookie });
  assert.strictEqual(status.status, 200);
  const aggregatedStatus = await status.json();
  assert.strictEqual(aggregatedStatus.timers.cpu, 1000, 'a focused client should request faster CPU sampling');
  assert.strictEqual(aggregatedStatus.timers.network, 4000, 'unrelated dashboard samplers should remain at baseline');
  assert.strictEqual(aggregatedStatus.timers.processes, undefined, 'dashboard/cpu-detail profiles must not enumerate processes');
  assert.strictEqual(Object.keys(aggregatedStatus.timers).filter(name => name === 'cpu').length, 1, 'there must be one effective CPU timer');
  assert.strictEqual((await postLease(secondCookie, { action: 'release', leaseId: secondLeaseId })).status, 200);
  const baselineStatus = await request('/api/monitoring/status', { cookie: firstCookie });
  assert.strictEqual((await baselineStatus.json()).timers.cpu, 4000, 'remaining dashboard client should restore baseline CPU cadence');
  const processProfile = await postLease(firstCookie, { action: 'set-profile', leaseId, profile: 'processes' });
  assert.strictEqual(processProfile.status, 200);
  const processStatusResponse = await request('/api/monitoring/status', { cookie: firstCookie });
  const processStatus = await processStatusResponse.json();
  assert.strictEqual(processStatus.timers.processes, 5000, 'process profile should enable one five-second process sampler');
  assert.strictEqual(processStatus.timers.cpu, 4000, 'Processes focus should preserve the dashboard baseline');
  assert.strictEqual(processStatus.timers.processes, 5000, 'one client profile creates one process timer');
  assert.strictEqual(processStatus.activeCommands.filter(name => name === 'processes').length, 1, 'process collector must use a single in-flight command');
  const processData = await request('/api/processes', { cookie: firstCookie, headers: { 'X-Monitor-Lease': leaseId } });
  assert.strictEqual(processData.status, 200, 'owner with process profile should read cached process snapshot');
  assert.strictEqual((await request('/api/processes', { cookie: secondCookie, headers: { 'X-Monitor-Lease': leaseId } })).status, 403, 'another session cannot read process snapshot through the lease');
  const processSnapshot = await processData.json();
  assert(Array.isArray(processSnapshot.processes) && typeof processSnapshot.stale === 'boolean');
  assert(!JSON.stringify(processSnapshot).match(/commandLine|environment|handles|modules|sockets|token/i), 'process response must contain only limited process data');
  assert.strictEqual((await postLease(firstCookie, { action: 'set-profile', leaseId, profile: 'dashboard' })).status, 200);
  const stoppedProcessStatus = await (await request('/api/monitoring/status', { cookie: firstCookie })).json();
  assert.strictEqual(stoppedProcessStatus.timers.processes, undefined, 'returning to dashboard must stop process enumeration');
  const dashboardLease = await postLease(secondCookie, { action: 'acquire' });
  assert.strictEqual(dashboardLease.status, 201);
  const dashboardLeaseId = (await dashboardLease.json()).leaseId;
  const multiClientProcesses = await postLease(firstCookie, { action: 'set-profile', leaseId, profile: 'processes' });
  assert.strictEqual(multiClientProcesses.status, 200);
  const multiClientStatus = await (await request('/api/monitoring/status', { cookie: firstCookie })).json();
  assert.strictEqual(multiClientStatus.timers.processes, 5000, 'focused Processes client should keep process sampler active');
  assert.strictEqual(multiClientStatus.timers.cpu, 4000, 'remaining dashboard client should keep baseline CPU sampler active');
  await postLease(firstCookie, { action: 'set-profile', leaseId, profile: 'dashboard' });
  await postLease(secondCookie, { action: 'release', leaseId: dashboardLeaseId });
  const extraLeases = [];
  for (let index = 0; index < 3; index++) {
    const extra = await postLease(firstCookie, { action: 'acquire' });
    assert.strictEqual(extra.status, 201);
    extraLeases.push((await extra.json()).leaseId);
  }
  assert.strictEqual((await postLease(firstCookie, { action: 'acquire' })).status, 429, 'per-session lease cap should bound resource use');
  for (const extraLeaseId of extraLeases) await postLease(firstCookie, { action: 'release', leaseId: extraLeaseId });

  const unauthSse = await request('/api/stream', { rawPath: '/api/stream' });
  assert.strictEqual(unauthSse.status, 401);
  const streamResponse = await fetch(`${baseUrl}/api/stream?lease=${leaseId}`, { headers: { Cookie: firstCookie } });
  assert.strictEqual(streamResponse.status, 200, 'authenticated lease should access SSE');
  assert.match(streamResponse.headers.get('content-type') || '', /text\/event-stream/);
  const reader = streamResponse.body.getReader();
  const firstEvent = await reader.read();
  assert(firstEvent.value && firstEvent.value.length > 0, 'SSE should send initial metrics only after authorization');
  const extraReaders = [];
  for (let index = 0; index < 3; index++) {
    const extraStream = await fetch(`${baseUrl}/api/stream?lease=${leaseId}`, { headers: { Cookie: firstCookie } });
    assert.strictEqual(extraStream.status, 200);
    const extraReader = extraStream.body.getReader();
    await extraReader.read();
    extraReaders.push(extraReader);
  }
  const cappedStream = await fetch(`${baseUrl}/api/stream?lease=${leaseId}`, { headers: { Cookie: firstCookie } });
  assert.strictEqual(cappedStream.status, 429, 'SSE connections should be bounded per session');
  await reader.cancel();
  await Promise.all(extraReaders.map(extraReader => extraReader.cancel()));

  await postLease(firstCookie, { action: 'set-profile', leaseId, profile: 'processes' });
  const processStreamResponse = await fetch(`${baseUrl}/api/stream?lease=${leaseId}`, { headers: { Cookie: firstCookie } });
  assert.strictEqual(processStreamResponse.status, 200);
  const processStreamReader = processStreamResponse.body.getReader();
  const processStreamEvent = await Promise.race([
    (async () => {
      const firstChunk = await processStreamReader.read();
      const secondChunk = await processStreamReader.read();
      return `${Buffer.from(firstChunk.value || []).toString('utf8')}${Buffer.from(secondChunk.value || []).toString('utf8')}`;
    })(),
    new Promise(resolve => setTimeout(() => resolve(''), 2500))
  ]);
  assert.match(processStreamEvent, /event: processes/, 'process-profile SSE should stream process snapshots');
  await processStreamReader.cancel();
  await postLease(firstCookie, { action: 'set-profile', leaseId, profile: 'dashboard' });

  const invalidBody = await request('/api/monitoring/lease', { method: 'POST', cookie: firstCookie, headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.strictEqual(invalidBody.status, 400);
  const extraLeaseField = await postLease(firstCookie, { action: 'acquire', profile: 'cpu-detail' });
  assert.strictEqual(extraLeaseField.status, 400, 'unexpected lease fields should be rejected');

  const metrics = await request('/api/metrics', { cookie: firstCookie, headers: { 'X-Monitor-Lease': leaseId } });
  assert.strictEqual(metrics.status, 200, 'metrics endpoint remains compatible for a valid owner lease');
  const unauthProcesses = await request('/api/processes');
  assert.strictEqual(unauthProcesses.status, 401, 'process endpoint must require PIN session authentication');
  const maintenanceStatus = await request('/api/maintenance/status', { cookie: firstCookie });
  assert.strictEqual(maintenanceStatus.status, 200);
  const history = await request('/api/maintenance/history', { cookie: firstCookie });
  assert.strictEqual(history.status, 200);

  const invalidAction = await request('/api/maintenance/run', { method: 'POST', cookie: firstCookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'arbitrary_command' }) });
  assert.strictEqual(invalidAction.status, 400, 'unknown maintenance actions must never dispatch');
  const arbitraryPath = await request('/api/maintenance/run', { method: 'POST', cookie: firstCookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'clean_temp', path: 'C:\\' }) });
  assert.strictEqual(arbitraryPath.status, 400, 'client-supplied paths must be rejected');
  const malformedMaintenance = await request('/api/maintenance/run', { method: 'POST', cookie: firstCookie, headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.strictEqual(malformedMaintenance.status, 400);
  const traversal = await request('/', { cookie: firstCookie, rawPath: '/%2e%2e%2fserver.js' });
  assert([403, 404].includes(traversal.status), 'encoded traversal must not read files outside public/');
  assert(!(await traversal.text()).includes('child_process'), 'traversal response must not disclose source');

  const logout = await request('/api/logout', { method: 'POST', cookie: firstCookie });
  assert.strictEqual(logout.status, 200);
  assert.strictEqual((await request('/api/maintenance/status', { cookie: firstCookie })).status, 401, 'logout must revoke the session');
  assert.strictEqual((await request('/api/diagnostics', { cookie: firstCookie })).status, 401);
  const lockedPage = await request('/', { cookie: firstCookie });
  assert.match(await lockedPage.text(), /Unlock Dashboard|pinInput/, 'a revoked session should return to the PIN screen');
  const afterRelease = await request('/api/monitoring/status', { cookie: secondCookie });
  assert.strictEqual((await afterRelease.json()).active, false, 'logout must release the session leases and stop monitoring');
  console.log('PASS secure sessions, lease ownership/caps, multi-client profile aggregation, metrics, SSE, maintenance input allowlist, and path containment');
  return { firstCookie };
}

async function testExpirationAndRateLimit() {
  const expiringCookie = await login();
  const expiringLease = await postLease(expiringCookie, { action: 'acquire' });
  assert.strictEqual(expiringLease.status, 201);
  await new Promise(resolve => setTimeout(resolve, 4500));
  const status = await request('/api/monitoring/status', { cookie: expiringCookie });
  assert.strictEqual(status.status, 200);
  assert.strictEqual((await status.json()).active, false, 'expired final lease must stop all monitoring timers');
  await new Promise(resolve => setTimeout(resolve, 3200));
  const expiredSession = await request('/api/maintenance/status', { cookie: expiringCookie });
  assert.strictEqual(expiredSession.status, 401, 'expired session cookies must be rejected');
  assert.strictEqual((await request('/api/diagnostics', { cookie: expiringCookie })).status, 401);
  assert.strictEqual((await request('/api/system/uninstall', { method: 'POST', cookie: expiringCookie, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({pin,confirmation:'uninstall-pc-monitor',removeData:false}) })).status,401,'expired sessions cannot request uninstall');
  const expiredPage = await request('/', { cookie: expiringCookie });
  assert.match(await expiredPage.text(), /Unlock Dashboard|pinInput/, 'an expired session should return to the PIN screen');

  // Hold a correct login's final body byte while other requests activate the
  // lockout. Authorization must be rechecked after the body arrives.
  const net = require('net');
  const address = new URL(baseUrl), body = Buffer.from(JSON.stringify({pin}));
  const held = net.createConnection(Number(address.port), address.hostname);
  let heldReply = '';
  const heldDone = new Promise(resolve => { held.on('data', chunk => { heldReply += chunk; }); held.on('end', resolve); });
  await new Promise(resolve => held.once('connect', resolve));
  held.write(`POST /api/login HTTP/1.1\r\nHost: ${address.host}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n`);
  held.write(body.subarray(0, body.length-1));
  await new Promise(resolve => setTimeout(resolve, 150));
  for (let attempt = 0; attempt < 5; attempt++) {
    const response = await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: 'wrong' }) });
    if (attempt < 4) assert.strictEqual(response.status, 401);
    else assert.strictEqual(response.status, 429, 'repeated failed PIN attempts should trigger temporary lockout');
  }
  held.end(body.subarray(body.length-1)); await heldDone;
  assert.match(heldReply, /^HTTP\/1\.1 429/, 'slow/concurrent login cannot bypass newly activated lockout');
  assert.strictEqual((await request('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin }) })).status, 429, 'even the correct PIN must wait during lockout');
  console.log('PASS correct PIN rejected during temporary lockout; waiting for real 60-second expiry');
  await new Promise(resolve => setTimeout(resolve, 60500));
  await login();
  console.log('PASS lease expiration stops monitoring, session expiration is enforced, and repeated failures are throttled');
}

async function main() {
  try {
    await require('./update-smoke-test')();
    testDashboardUpdates();
    testMobileOnboarding();
    await testLoginInteraction();
    await testLocalPinManagement();
    await testNativeDesktopSecurity();
    pin = String(crypto.randomInt(100000000000, 999999999999));
    await startServer();
    await testUnauthenticatedAndInputValidation();
    await testSessionsLeasesAndSse();
    await testExpirationAndRateLimit();
    console.log('PASS security smoke suite');
  } finally {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise(resolve => serverProcess.once('exit', resolve));
    }
  }
}

async function testLoginInteraction() {
  const elements = Object.fromEntries(['pinInput','unlockBtn','errMsg'].map(id => [id,{value:'',textContent:'',disabled:false,events:{},addEventListener(name,fn){this.events[name]=fn;},focus(){}}]));
  const requests=[]; let respond; let navigations=0;
  const context=vm.createContext({document:{getElementById:id=>elements[id],querySelector:()=>({content:'6'})},localStorage:{removeItem(){}},window:{location:{replace(){navigations++;}}},fetch:(_url,options)=>{requests.push(JSON.parse(options.body));return new Promise(resolve=>{respond=resolve;});}});
  vm.runInContext(fs.readFileSync(path.join(root,'public/login.js'),'utf8'),context);
  // Real typing fires keydown then input; pasting fires a single input event.
  const flush=()=>new Promise(resolve=>setImmediate(resolve));
  const fail=async()=>{respond({ok:false,status:401,headers:{get(){return null;}},json:async()=>({success:false})});await flush();};
  const type=digits=>{for(const digit of digits){elements.pinInput.value+=digit;elements.pinInput.events.keydown({key:digit});elements.pinInput.events.input({});}};
  elements.pinInput.value='111111';elements.pinInput.events.input({});
  assert.strictEqual(requests.length,1,'pasting six digits must auto-submit exactly once');
  assert.strictEqual(requests[0].pin,'111111');
  elements.unlockBtn.events.click();
  await elements.pinInput.events.keydown({key:'Enter'});
  await elements.unlockBtn.events.click();
  elements.pinInput.events.input({});
  assert.strictEqual(requests.length,1,'one pending request even with rapid input, Enter/taps');
  await fail();
  assert.strictEqual(elements.pinInput.value,'','a failed PIN is cleared for a fresh attempt');
  assert.strictEqual(elements.unlockBtn.disabled,false);
  assert.strictEqual(elements.errMsg.textContent,'Incorrect PIN. Please try again.');
  type('12345');
  assert.strictEqual(requests.length,1,'digits one through five must not submit');
  elements.pinInput.value='12ab56';elements.pinInput.events.input({});
  assert.strictEqual(requests.length,1,'invalid input must not submit');
  elements.pinInput.value='1234567';elements.pinInput.events.input({});
  assert.strictEqual(requests.length,1,'more than six digits must not auto-submit');
  elements.pinInput.value='';
  type('123456');
  assert.strictEqual(requests.length,2,'six typed digits must auto-submit exactly once');
  assert.strictEqual(requests[1].pin,'123456');
  await fail();
  assert.strictEqual(elements.unlockBtn.disabled,false);
  elements.pinInput.value='654321';elements.pinInput.events.input({});
  assert.strictEqual(requests.length,3,'a new six-digit value auto-submits after a failed login');
  elements.pinInput.value='999999';elements.pinInput.events.input({});
  assert.strictEqual(requests.length,3,'typing while a request is pending must not stack requests');
  await fail();
  assert.strictEqual(elements.pinInput.value,'999999','a stale response must not erase newly typed digits');
  assert.strictEqual(elements.unlockBtn.disabled,false);
  elements.pinInput.events.input({});
  assert.strictEqual(requests.length,4,'the preserved six-digit value retries automatically');
  await fail();
  assert.strictEqual(elements.pinInput.value,'','the retried PIN is cleared after another failure');
  type('999999');
  assert.strictEqual(requests.length,4,'the same six-digit value must not auto-submit twice');
  elements.unlockBtn.events.click();
  assert.strictEqual(requests.length,5,'Enter/button still submits a repeated value manually');
  await fail();
  type('123456');
  assert.strictEqual(requests.length,6,'a new current six-digit PIN auto-submits once');
  respond({ok:true,status:200,json:async()=>({success:true})});await flush();
  assert.strictEqual(navigations,1);
  for(const mode of ['12','manual','invalid']) {
    const legacyElements=Object.fromEntries(['pinInput','unlockBtn','errMsg'].map(id=>[id,{value:'',textContent:'',disabled:false,events:{},addEventListener(name,fn){this.events[name]=fn;},focus(){}}]));
    const legacyRequests=[];let legacyRespond,legacyNavigations=0;
    const legacyContext=vm.createContext({document:{getElementById:id=>legacyElements[id],querySelector:()=>({content:mode})},localStorage:{removeItem(){}},window:{location:{replace(){legacyNavigations++;}}},fetch:(_url,options)=>{legacyRequests.push(JSON.parse(options.body));return new Promise(resolve=>legacyRespond=resolve);}});
    vm.runInContext(fs.readFileSync(path.join(root,'public/login.js'),'utf8'),legacyContext);
    for(const digit of '123456789012') {
      legacyElements.pinInput.value+=digit;legacyElements.pinInput.events.input({});
      assert.strictEqual(legacyRequests.length,0,'legacy/unknown entry never consumes a failed attempt, including at digit six');
    }
    assert.strictEqual(legacyElements.pinInput.value,'123456789012');
    legacyElements.pinInput.events.keydown({key:'Enter'});assert.strictEqual(legacyRequests.length,1);
    assert.strictEqual(legacyRequests[0].pin,'123456789012');
    legacyRespond({ok:true,status:200,json:async()=>({success:true})});await flush();assert.strictEqual(legacyNavigations,1);
    legacyElements.pinInput.value='123456789012';legacyElements.pinInput.events.input({});assert.strictEqual(legacyRequests.length,1);
    legacyElements.unlockBtn.events.click();assert.strictEqual(legacyRequests.length,2);
    legacyRespond({ok:true,status:200,json:async()=>({success:true})});await flush();
  }
  console.log('PASS six-digit typing/paste auto-submit, guarded retries; legacy/unknown modes consume zero attempts while typing and support Enter/button');
  // Presentation-only visual viewport lifecycle. No auth mocks are relaxed.
  const events = () => ({ listeners: new Map(), addEventListener(type, fn) { if (!this.listeners.has(type)) this.listeners.set(type,new Set()); this.listeners.get(type).add(fn); }, removeEventListener(type,fn) { this.listeners.get(type)?.delete(fn); }, dispatch(type) { for(const fn of this.listeners.get(type)||[]) fn(); } });
  const styles=new Map(),classes=new Set(['login-page']);
  const rootElement={style:{setProperty:(key,value)=>styles.set(key,value),removeProperty:key=>styles.delete(key)},classList:{contains:key=>classes.has(key),remove:key=>classes.delete(key),toggle(key,on){if(on)classes.add(key);else classes.delete(key);}}};
  const viewport=Object.assign(events(),{height:844,offsetTop:0});
  const phoneWindow=Object.assign(events(),{visualViewport:viewport,innerWidth:390,innerHeight:844,location:{replace(){}}});
  const phoneContext=vm.createContext({document:{documentElement:rootElement,getElementById:id=>elements[id]},localStorage:{removeItem(){}},window:phoneWindow,fetch(){throw Error('Viewport must not make requests');}});
  vm.runInContext(fs.readFileSync(path.join(root,'public/login.js'),'utf8'),phoneContext);
  assert.strictEqual(styles.get('--login-viewport-height'),'844px');
  viewport.height=320;viewport.offsetTop=47;viewport.dispatch('resize');viewport.dispatch('scroll');
  assert.strictEqual(styles.get('--login-viewport-height'),'320px');assert.strictEqual(styles.get('--login-viewport-top'),'47px');assert(classes.has('login-keyboard'));
  for(let i=0;i<4;i++) {
    phoneWindow.dispatch('pagehide');assert.strictEqual(viewport.listeners.get('resize').size,0);assert.strictEqual(viewport.listeners.get('scroll').size,0);assert.strictEqual(phoneWindow.listeners.get('resize').size,0);
    phoneWindow.dispatch('pageshow');phoneWindow.dispatch('pageshow');assert.strictEqual(viewport.listeners.get('resize').size,1);assert.strictEqual(viewport.listeners.get('scroll').size,1);assert.strictEqual(phoneWindow.listeners.get('resize').size,1);
  }
  viewport.height=844;viewport.offsetTop=0;viewport.dispatch('resize');assert(!classes.has('login-keyboard'));
  classes.add('native-shell');phoneWindow.dispatch('resize');assert.strictEqual(styles.size,0,'Native window must not inherit mobile visual viewport overrides');
  phoneWindow.dispatch('pagehide');
  console.log('PASS keyboard visual viewport/offset, restoration, bfcache reattach without duplicate listeners and native presentation isolation');
}

function testDashboardUpdates() {
  const serverSource = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const revisionCode = serverSource.slice(serverSource.indexOf('let dashboardAssetSignature'), serverSource.indexOf('// HTTP Server'));
  let contents = 'first mobile stylesheet';
  let modified = 1;
  const revisionContext = vm.createContext({
    PUBLIC_FILES: new Set(['app.css']), __dirname: root, path, crypto,
    fs: {
      lstatSync: () => ({ size: contents.length, mtimeMs: modified, ctimeMs: modified, isFile: () => true, isSymbolicLink: () => false }),
      readFileSync: () => Buffer.from(contents)
    }
  });
  vm.runInContext(revisionCode, revisionContext);
  const before = vm.runInContext('getDashboardAssetRevision()', revisionContext);
  assert.strictEqual(vm.runInContext('getDashboardAssetRevision()', revisionContext), before);
  contents = 'updated mobile stylesheet'; modified++;
  const after = vm.runInContext('getDashboardAssetRevision()', revisionContext);
  assert.notStrictEqual(after, before, 'editing an asset changes the revision without restarting the server');
  const clientSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const clientCode = clientSource.slice(clientSource.indexOf('const loadedDashboardRevision'), clientSource.indexOf("try { localStorage.removeItem"));
  let destination = ''; let releases = 0;
  const clientContext = vm.createContext({
    document: { querySelector: () => ({ content: before }), visibilityState: 'visible' },
    window: { location: { href: 'http://127.0.0.1:7331/?existing=1', replace: url => { destination = url; } } },
    URL, releaseMonitoringLease: () => { releases++; }
  });
  vm.runInContext(clientCode, clientContext);
  clientContext.response = { ok: true, headers: { get: () => before } };
  assert.strictEqual(vm.runInContext('reloadForDashboardUpdate(response)', clientContext), false);
  clientContext.response = { ok: false, headers: { get: () => after } };
  assert.strictEqual(vm.runInContext('reloadForDashboardUpdate(response)', clientContext), false);
  clientContext.response.ok = true;
  clientContext.window.pcMonitorUninstalling = true;
  assert.strictEqual(vm.runInContext('reloadForDashboardUpdate(response)', clientContext), false);
  clientContext.window.pcMonitorUninstalling = false;
  assert.strictEqual(vm.runInContext('reloadForDashboardUpdate(response)', clientContext), true);
  assert.strictEqual(new URL(destination).searchParams.get('ui'), after);
  assert.strictEqual(new URL(destination).searchParams.get('existing'), '1');
  assert.strictEqual(releases, 1, 'update reload releases the previous monitoring lease');
  assert.strictEqual(vm.runInContext('reloadForDashboardUpdate(response)', clientContext), false, 'one change causes only one reload');
  console.log('PASS automatic asset revision, update reload, auth/uninstall guards and lease release');
}

function testMobileOnboarding() {
  const appSource = fs.readFileSync(path.join(root, 'public', 'app.js'), 'utf8');
  const begin = appSource.indexOf('// MOBILE-ONBOARDING:BEGIN');
  const end = appSource.indexOf('// MOBILE-ONBOARDING:END');
  assert(begin !== -1 && end > begin, 'phone onboarding block is present');
  const block = appSource.slice(begin, end);
  assert(!block.includes('fetch(') && !block.includes('document.cookie'), 'onboarding makes no requests and never touches cookies');
  const sessionCode = appSource.slice(appSource.indexOf('async function startDashboardSession'), appSource.indexOf('async function fetchInitialMetrics'));
  assert(sessionCode.includes('maybeShowMobileOnboarding();'), 'the sheet is presented from the authenticated dashboard entry only');

  const IOS_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Mobile/15E148 Safari/604.1';
  const IOS_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1';
  const IPAD_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15';
  const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const ANDROID_FIREFOX = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Firefox/121.0 Mobile Safari/537.36';
  const DESKTOP_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  const onboardingEnv = (options = {}) => {
    const settings = { userAgent: IOS_SAFARI, platform: 'iPhone', touchPoints: 5, phone: true, width: 390, height: 844, displayMode: 'browser', iosStandalone: false, native: false, nativeClass: false, store: {}, ...options };
    const listeners = {};
    const dialog = {
      open: false,
      showModal() { if (this.open) throw new Error('already open'); this.open = true; },
      close() { this.open = false; (listeners.close || []).slice().forEach(fn => fn()); },
      addEventListener(name, fn) { (listeners[name] = listeners[name] || []).push(fn); }
    };
    const steps = { items: [], replaceChildren(...nodes) { this.items = nodes; } };
    const install = { hidden: false };
    const dismiss = { clickHandler: null, addEventListener(name, fn) { if (name === 'click') this.clickHandler = fn; }, click() { if (this.clickHandler) this.clickHandler(); } };
    const elements = { mobileOnboardingDialog: dialog, mobileOnboardingSteps: steps, mobileOnboardingInstall: install, mobileOnboardingDismiss: dismiss };
    const context = vm.createContext({
      window: { innerWidth: settings.width, innerHeight: settings.height, ...(settings.native ? { chrome: { webview: {} } } : {}) },
      navigator: { userAgent: settings.userAgent, platform: settings.platform, maxTouchPoints: settings.touchPoints, standalone: settings.iosStandalone },
      matchMedia: query => ({ matches: query === '(max-width: 699px)' ? settings.phone && settings.width <= 699 : query === '(display-mode: standalone)' ? settings.displayMode === 'standalone' : false }),
      localStorage: { getItem: key => (key in settings.store ? settings.store[key] : null), setItem: (key, value) => { settings.store[key] = String(value); } },
      document: {
        documentElement: { classList: { contains: name => name === 'native-shell' && settings.nativeClass } },
        getElementById: id => elements[id] || null,
        createElement: () => ({ textContent: '' })
      }
    });
    vm.runInContext(`${block}\nglobalThis.__onboarding = { maybeShowMobileOnboarding, mobileOnboardingVariant };`, context);
    return { api: context.__onboarding, dialog, steps, install, dismiss, store: settings.store };
  };
  const stepText = env => env.steps.items.map(item => item.textContent);

  // Platform instructions follow reliable capability detection only.
  const variants = onboardingEnv();
  assert.strictEqual(variants.api.mobileOnboardingVariant(IOS_SAFARI, 'iPhone', 5), 'ios');
  assert.strictEqual(variants.api.mobileOnboardingVariant(IPAD_SAFARI, 'MacIntel', 5), 'ios');
  assert.strictEqual(variants.api.mobileOnboardingVariant(IOS_CHROME, 'iPhone', 5), 'generic');
  assert.strictEqual(variants.api.mobileOnboardingVariant(ANDROID_CHROME, 'Linux armv8l', 4), 'android');
  assert.strictEqual(variants.api.mobileOnboardingVariant(ANDROID_FIREFOX, 'Linux armv8l', 4), 'generic');
  assert.strictEqual(variants.api.mobileOnboardingVariant(DESKTOP_CHROME, 'Win32', 0), 'generic');

  // First phone visit presents the sheet once; dismissal marks this device seen.
  const first = onboardingEnv();
  assert.strictEqual(first.api.maybeShowMobileOnboarding(), true, 'first phone visit presents onboarding once');
  assert.strictEqual(first.dialog.open, true);
  assert.deepStrictEqual(stepText(first), ['Tap the Share button', 'Tap "Add to Home Screen"', 'Tap Add']);
  assert.strictEqual(first.install.hidden, false, 'Home Screen steps are offered before installing');
  assert.strictEqual(first.api.maybeShowMobileOnboarding(), false, 'an open sheet is never presented twice');
  first.dismiss.click();
  assert.strictEqual(first.dialog.open, false, 'the Got it button closes the sheet');
  assert.deepStrictEqual(first.store, { 'rovarin.mobileOnboardingSeen': 'true' }, 'dismissing with Got it marks the device seen with no PIN, token or session data');
  assert(!/(pin|token|session|secret|cookie|auth)/i.test(JSON.stringify(first.store)), 'onboarding storage never holds credentials');
  const second = onboardingEnv({ store: first.store });
  assert.strictEqual(second.api.maybeShowMobileOnboarding(), false, 'reloads on a dismissed device never show it again');
  assert.strictEqual(second.dialog.open, false);
  const clean = onboardingEnv();
  assert.strictEqual(clean.api.maybeShowMobileOnboarding(), true, 'a clean browser storage context still sees onboarding');
  const escapeEnv = onboardingEnv();
  assert.strictEqual(escapeEnv.api.maybeShowMobileOnboarding(), true, 'the sheet can be presented again on a fresh device');
  escapeEnv.dialog.close();
  assert.strictEqual(escapeEnv.dialog.open, false, 'Escape dismisses the sheet');
  assert.deepStrictEqual(escapeEnv.store, { 'rovarin.mobileOnboardingSeen': 'true' }, 'dismissal by any means marks the device seen');

  // Never in the native desktop app, even at phone-sized windows.
  for (const settings of [{ native: true }, { nativeClass: true }]) {
    const nativeEnv = onboardingEnv(settings);
    assert.strictEqual(nativeEnv.api.maybeShowMobileOnboarding(), false, 'native desktop never shows mobile onboarding');
    assert.strictEqual(nativeEnv.dialog.open, false);
  }
  const desktopEnv = onboardingEnv({ userAgent: DESKTOP_CHROME, platform: 'Win32', touchPoints: 0, phone: false });
  assert.strictEqual(desktopEnv.api.maybeShowMobileOnboarding(), false, 'desktop browsers never show mobile onboarding');
  for(const touchPoints of [0,5]) {
    const narrowDesktop=onboardingEnv({userAgent:DESKTOP_CHROME,platform:'Win32',touchPoints,phone:true,width:390,height:844});
    assert.strictEqual(narrowDesktop.api.maybeShowMobileOnboarding(),false,'normal desktop browser at 390x844 never shows onboarding, including touch-capable PCs');
    assert.strictEqual(narrowDesktop.dialog.open,false);
  }
  for(const mobile of [{userAgent:IOS_SAFARI,platform:'iPhone'},{userAgent:ANDROID_CHROME,platform:'Linux armv8l'}]) {
    const narrowMobile=onboardingEnv({...mobile,width:390,height:844});
    assert.strictEqual(narrowMobile.api.maybeShowMobileOnboarding(),true,'unseen iOS/Android client at 390x844 shows onboarding');
  }


  // Standalone/Home Screen launches skip only the install instructions.
  for (const settings of [{ displayMode: 'standalone' }, { iosStandalone: true }]) {
    const homeEnv = onboardingEnv(settings);
    assert.strictEqual(homeEnv.api.maybeShowMobileOnboarding(), true, 'standalone launches still explain away-from-home use');
    assert.strictEqual(homeEnv.install.hidden, true, 'standalone launches never repeat install instructions');
  }

  // Android wording never leaks to iPhone users, generic wording to either platform.
  const androidEnv = onboardingEnv({ userAgent: ANDROID_CHROME, platform: 'Linux armv8l', touchPoints: 4 });
  androidEnv.api.maybeShowMobileOnboarding();
  assert.deepStrictEqual(stepText(androidEnv), ['Open the browser menu', 'Choose "Add to Home screen" or "Install app"', 'Confirm']);
  const unknownEnv = onboardingEnv({ userAgent: ANDROID_FIREFOX, platform: 'Linux armv8l', touchPoints: 4 });
  unknownEnv.api.maybeShowMobileOnboarding();
  assert.deepStrictEqual(stepText(unknownEnv), ['Open your browser menu', 'Choose "Add to Home screen" (or "Install app")', 'Confirm']);
  assert(!stepText(androidEnv).join(' ').includes('Share'), 'Android users never receive iPhone steps');
  assert(!stepText(first).join(' ').includes('browser menu'), 'iPhone users never receive browser-menu steps');

  // The lock screen never loads the sheet, and Tailscale copy requires Connected away from home.
  const loginHtml = fs.readFileSync(path.join(root, 'public', 'login.html'), 'utf8');
  assert(!loginHtml.includes('app.js') && !loginHtml.includes('mobileOnboarding'), 'onboarding never appears in front of PIN authentication');
  const dashboardHtml = fs.readFileSync(path.join(root, 'public', 'index.html'), 'utf8');
  const sheetHtml = dashboardHtml.slice(dashboardHtml.indexOf('mobileOnboardingDialog'), dashboardHtml.indexOf('</dialog>', dashboardHtml.indexOf('mobileOnboardingDialog')));
  assert(sheetHtml.includes('Finish setting up Rovarin') && /away from home/i.test(sheetHtml) &&
    sheetHtml.includes('Tailscale') && sheetHtml.includes('Connected'), 'onboarding explains Tailscale must show Connected away from home');
  const setupSource = fs.readFileSync(path.join(root, 'scripts', 'setup.ps1'), 'utf8');
  assert(setupSource.includes('Away from home? Open Tailscale on that device and make sure it shows Connected before opening Rovarin'), 'setup QR instructions require Tailscale Connected away from home');
  assert(setupSource.includes('This PC must also stay online and connected to Tailscale'), 'setup QR instructions keep this PC connected');
  assert(setupSource.includes('Away from home? Your phone also needs Tailscale open and Connected before opening Rovarin.'), 'setup explains the phone must be connected before Rovarin opens');
  const diagnosticsSource = fs.readFileSync(path.join(root, 'public', 'diagnostics.js'), 'utf8');
  assert(diagnosticsSource.includes('your phone needs Tailscale Connected too'), 'diagnostics explains the phone must be connected');
  console.log('PASS one-time phone onboarding, platform steps, native/desktop suppression, standalone detection and Tailscale copy');
}

(process.argv[2] === '--native-desktop-only' ? testNativeDesktopSecurity() : main()).catch(err => { console.error(err.stack || err.message); console.error(output.slice(-1600)); process.exitCode = 1; });
