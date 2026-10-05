'use strict';

const assert = require('assert');
const crypto = require('crypto');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const vm = require('vm');
const { verifyProcessExit } = require('../process-stats');
const { terminateProcess } = require('../process-termination');

async function testNativeIdentityHelper() {
  const child = spawnDisposable();
  try {
    const { execFile } = require('child_process');
    const identity = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$p=Get-Process -Id ${child.pid}; @{pid=$p.Id;name=$p.ProcessName;startedAt=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`], { windowsHide: true, timeout: 10000 }, (error, stdout) => error ? reject(error) : resolve(JSON.parse(stdout))));
    // Bypass the cached API gate deliberately: the native helper itself must
    // reject a stale/reused identity and leave this unrelated live instance alone.
    assert.strictEqual((await terminateProcess({ ...identity, startedAt: FAKE_STARTED_AT })).code, 'stale-process');
    assert(probeAlive(child.pid));
    assert.strictEqual((await terminateProcess({ ...identity, name: identity.name + '-other' })).code, 'stale-process');
    assert(probeAlive(child.pid));
    const result = await terminateProcess(identity);
    assert.strictEqual(result.code, 'terminated'); assert.strictEqual(result.verified, true);
    await waitForExit(child);
    assert.strictEqual((await terminateProcess(identity)).code, 'already-exited');
    console.log('PASS native handle verifies exact creation time/name, rejects stale PID-reuse identity, terminates owned target and handles exit before action');
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill(); }
}

async function testHandleRaceFixture() {
  const os = require('os');
  const { execFile } = require('child_process');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-handle-test-'));
  try {
    const helper = fs.readFileSync(path.join(root, 'scripts/terminate-process.ps1'), 'utf8');
    let code = helper.match(/Add-Type -TypeDefinition @'\r?\n([\s\S]*?)\r?\n'@/)[1];
    code = code.replace(/\s*\[DllImport[^\n]+\n/g, '\n');
    code = code.replace(/    static extern [^\n]+\n/g, '');
    // Same production Run method, fake native boundary: PID mapping changes
    // during image validation, while the held handle must still target object 1.
    code = code.replace('    public static string Run', `
    public static int Current=1, Killed=0, Closed=0;
    static IntPtr OpenProcess(uint a,bool i,int p) { return new IntPtr(Current); }
    static bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u) { c=h.ToInt32()==1?100:200; e=k=u=0; return true; }
    static bool QueryFullProcessImageName(IntPtr h,uint f,StringBuilder n,ref uint s) { n.Append("node.exe"); Current=2; return true; }
    static bool IsProcessCritical(IntPtr h,out bool critical) { critical=false;return true; }
    static bool TerminateProcess(IntPtr h,uint c) { Killed=h.ToInt32(); return true; }
    static uint WaitForSingleObject(IntPtr h,uint m) { return Killed==h.ToInt32()?0u:258u; }
    static bool CloseHandle(IntPtr h) { Closed++; return true; }
    public static string Run`);
    const file = path.join(directory, 'fixture.ps1');
    fs.writeFileSync(file, `Add-Type -TypeDefinition @'\n${code}\n'@\n$r=[RovarinTermination]::Run(123,'node',100); if($r -ne 'terminated' -or [RovarinTermination]::Killed -ne 1 -or [RovarinTermination]::Closed -ne 1){throw 'Held object changed'}\n$r=[RovarinTermination]::Run(123,'node',100); if($r -ne 'stale-process' -or [RovarinTermination]::Killed -ne 1 -or [RovarinTermination]::Closed -ne 2){throw 'Reused PID was terminated'}\n'PASS held-handle PID mapping race fixture'`);
    const output = await new Promise((resolve, reject) => execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { windowsHide: true, timeout: 15000 }, (error, stdout, stderr) => error ? reject(new Error(stderr)) : resolve(stdout)));
    assert.match(output, /PASS held-handle/); console.log(output.trim());
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}

async function testExitVerification() {
  const exited = () => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); };
  assert.strictEqual(await verifyProcessExit(123, { probe: exited }), 'exited');
  let probes = 0;
  assert.strictEqual(await verifyProcessExit(123, { probe: () => { probes++; }, timeoutMs: 200, pause: async () => {} }), 'still-running');
  assert.strictEqual(probes, 3, 'exit verification is bounded and only probes');
  assert.strictEqual(await verifyProcessExit(123, { probe: () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }); } }), 'unconfirmed');
  probes = 0;
  assert.strictEqual(await verifyProcessExit(123, { probe: () => { if (++probes > 2) exited(); }, pause: async () => {} }), 'exited');
  console.log('PASS bounded exit verification: exited, delayed exit, still-running, and permission-denied outcomes');
}

async function testProcessesUI(){
 const elements=new Map(),events=new Map();
 function element(){const e={children:[],events:new Map(),attrs:{},dataset:{},value:'',hidden:false,_text:'',parentElement:null,className:'',classList:{values:new Set(),add(x){this.values.add(x)},remove(x){this.values.delete(x)},toggle(x,on){on?this.values.add(x):this.values.delete(x)},contains(x){return this.values.has(x)}},setAttribute(k,v){this.attrs[k]=v},removeAttribute(k){delete this.attrs[k]},addEventListener(k,v){this.events.set(k,v)},appendChild(x){x.remove();x.parentElement=this;this.children.push(x)},insertBefore(x,b){x.remove();x.parentElement=this;const i=b?this.children.indexOf(b):-1;i<0?this.children.push(x):this.children.splice(i,0,x)},replaceChildren(){for(const c of this.children)c.parentElement=null;this.children=[];this._text=''},remove(){if(this.parentElement)this.parentElement.children=this.parentElement.children.filter(x=>x!==this);this.parentElement=null},insertRow(){const n=element();this.appendChild(n);return n},insertCell(){return this.insertRow()}};Object.defineProperty(e,'cells',{get(){return this.children}});Object.defineProperty(e,'textContent',{get(){return this._text+this.children.map(c=>c.textContent).join('')},set(v){this.replaceChildren();this._text=String(v)}});return e;}
 const get=id=>{if(!elements.has(id))elements.set(id,element());return elements.get(id)};
 const buttons=['name','pid','cpu','memory'].map(sort=>{const n=element();n.dataset.sort=sort;n.parentElement=element();return n});let latest,sent,route;
 const ctx={document:{visibilityState:'visible',getElementById:get,createElement:element,querySelectorAll:()=>buttons,addEventListener(){}},window:{monitoringLeaseId:'lease',confirm:()=>true,location:{replace(){}},addEventListener:(k,f)=>events.set(k,f)},setTimeout,clearTimeout,setInterval,clearInterval,Intl,fetch:async(url,options)=>{if(url.endsWith('/kill')||url.endsWith('/kill-tree')){sent=JSON.parse(options.body);route=url;return {ok:true,status:200,json:async()=>({success:true,verified:true,results:[{code:'terminated'}]})}}if(url.endsWith('/tree'))return {ok:true,json:async()=>({success:true,descendantCount:2})};return {ok:true,json:async()=>latest}}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'public/processes.js'),'utf8'),ctx);
 let tick=0;const send=processes=>{latest={processes,sampledAt:Date.now()+tick++,stale:false};events.get('pc-monitor-processes')({detail:latest})};const rows=get('processesRows'),a={pid:100,name:'chat',displayName:'ChatGPT',hasFriendlyName:true,displayGroup:'a'.repeat(64),startedAt:'2026-01-01',cpuPercent:1,ramMB:20},b={...a,pid:200,cpuPercent:2,ramMB:30};
 send([a,b]);assert.equal(rows.children.length,1);assert.equal(rows.children[0].cells[2].textContent,'3.0%');assert.equal(rows.children[0].cells[3].textContent,'50 MB');assert(get('processesKillButton').disabled,'group is not a termination identity');
 rows.children[0].events.get('click')();assert.equal(rows.children.length,3);const child=rows.children.find(x=>x.__process?.pid===100);child.events.get('pointerdown')();child.events.get('click')();
 send([{...a,cpuPercent:90,ramMB:50},b]);assert.equal(rows.children[0].cells[2].textContent,'92.0%','group CPU live');assert.equal(rows.children[0].cells[3].textContent,'80 MB','group RAM live');assert.equal(rows.children[1].__process.pid,100,'CPU order recalculates despite selection/lost release');assert(rows.children[1].classList.contains('is-selected'));assert.equal(rows.children[1].cells[2].textContent,'90.0%');
 const c={...a,pid:300,cpuPercent:3};send([a,b,c]);assert.equal(rows.children.length,4,'expanded group persists');assert.match(rows.children[0].cells[0].textContent,/\(3\)/);send([a,b]);assert.equal(rows.children.length,3,'exit changes count');
 const d={...a,pid:400,displayGroup:null};send([a,b,d]);assert.equal(rows.children.length,4,'same friendly name without app evidence stays separate');
 get('processesFreezeButton').events.get('click')();const before=rows.children.find(x=>x.__group).cells[2].textContent;send([{...a,cpuPercent:99},b,d]);assert.equal(rows.children.find(x=>x.__group).cells[2].textContent,before,'Pause freezes presentation');assert.equal(get('processesLiveText').textContent,'Paused');get('processesFreezeButton').events.get('click')();assert.equal(rows.children.find(x=>x.__group).cells[2].textContent,'101.0%','Resume newest immediately');
 get('processesSearch').value='200';get('processesSearch').events.get('input')();assert.equal(rows.children.length,2,'PID search exposes matching child with group context');get('processesSearch').value='missing';get('processesSearch').events.get('input')();assert.match(rows.children[0].cells[0].textContent,/No processes match/);get('processesSearch').value='';get('processesSearch').events.get('input')();
 send([{...a,startedAt:'2026-01-02'},b]);assert(get('processesKillButton').disabled,'PID reuse cannot inherit selection');assert.match(get('processesKillStatus').textContent,/Process ended/);
 rows.children.find(x=>x.__process?.pid===200).events.get('click')();get('processesKillButton').events.get('click')();await new Promise(r=>setImmediate(r));assert.deepStrictEqual(sent,{pid:b.pid,name:b.name,startedAt:b.startedAt});assert.equal(route,'/api/processes/kill');assert(!rows.children.some(x=>x.__process?.pid===200),'ended exact child removed even with late cache');
 events.get('pc-monitor-pagechange')({detail:{page:'dashboardPage'}});send([{...a,displayGroup:null}]);rows.children[0].events.get('click')();get('processesTreeButton').events.get('click')();await new Promise(r=>setImmediate(r));assert.deepStrictEqual(sent,{pid:a.pid,name:a.name,startedAt:a.startedAt,confirmed:true});assert.equal(route,'/api/processes/kill-tree');
 events.get('pc-monitor-pagechange')({detail:{page:'dashboardPage'}});send([{...a,startedAt:'2026-01-03',displayGroup:null,displayName:'Zebra 10'}, {...b,startedAt:'2026-01-03',displayGroup:null,displayName:'adobe'}]);buttons[0].events.get('click')();assert.match(rows.children[0].cells[0].textContent,/adobe/);buttons[0].events.get('click')();assert.match(rows.children[0].cells[0].textContent,/Zebra/);buttons[1].events.get('click')();assert.equal(rows.children[0].__process.pid,100);buttons[3].events.get('click')();assert.equal(rows.children[0].__process.pid,200);send([{...a,startedAt:'2026-01-03',displayGroup:null,ramMB:100},{...b,startedAt:'2026-01-03',displayGroup:null}]);assert.equal(rows.children[0].__process.pid,100,'memory live sort');
 ctx.document.visibilityState='hidden';events.get('pc-monitor-pagechange')({detail:{page:'dashboardPage'}});
 console.log('PASS grouped live CPU/RAM/counts/add/remove, selection without implicit freeze, expansion/search, explicit Pause/Resume, sorting, PID reuse and exact single/tree action identities');
}

const root = path.resolve(__dirname, '..');
const pin = String(crypto.randomInt(100000000000, 999999999999));
const FAKE_STARTED_AT = '2001-01-01T00:00:00.0000000Z';
let serverProcess;
let output = '';
let baseUrl = null;
const disposableChildren = new Set();

function request(route, { method = 'GET', cookie, leaseId, body, headers = {} } = {}) {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: {
      ...(cookie ? { Cookie: cookie } : {}),
      ...(leaseId ? { 'X-Monitor-Lease': leaseId } : {}),
      ...headers
    },
    body
  });
}

function startServer() {
  return new Promise((resolve, reject) => {
    serverProcess = spawn(process.execPath, ['server.js'], {
      cwd: root,
      env: { ...process.env, PORT: '0', PC_MONITOR_PIN: pin, PC_MONITOR_SESSION_TTL_MS: '60000', PC_MONITORING_LEASE_TTL_MS: '30000' },
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
      if (!baseUrl) {
        clearTimeout(timer);
        reject(new Error(`Server exited (${code}). ${output.slice(-1200)}`));
      }
    });
  });
}

async function login() {
  const response = await request('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  assert.strictEqual(response.status, 200, 'valid PIN should authenticate the kill-test client');
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  const sessionCookie = cookies.find(cookie => cookie.startsWith('pc_monitor_session='));
  assert(sessionCookie, 'login should return the normal authenticated session cookie');
  return sessionCookie.split(';')[0];
}

async function postLease(cookie, payload) {
  return request('/api/monitoring/lease', {
    method: 'POST', cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function getStatus(cookie) {
  const response = await request('/api/monitoring/status', { cookie });
  assert.strictEqual(response.status, 200);
  return response.json();
}

async function getProcesses(cookie, leaseId) {
  const response = await request('/api/processes', { cookie, leaseId });
  assert.strictEqual(response.status, 200, 'the processes lease owner should read the cached snapshot');
  return response.json();
}

async function waitForObservedProcess(cookie, leaseId, pid, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await getProcesses(cookie, leaseId);
    const observed = snapshot.processes.find(item => item.pid === pid);
    if (observed && observed.startedAt) return { snapshot, observed };
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Timed out waiting for PID ${pid} in the process snapshot. ${output.slice(-1200)}`);
}

function spawnDisposable() {
  // Harmless, short-lived target: holds a buffer and burns brief CPU slices so it
  // reliably appears inside the bounded top-50 snapshot. Never a system process.
  const child = spawn(process.execPath, ['-e',
    'global.keep = Buffer.alloc(64 * 1024 * 1024); setInterval(() => { const end = Date.now() + 40; while (Date.now() < end) {} }, 200);'
  ], { windowsHide: true, stdio: 'ignore' });
  disposableChildren.add(child);
  child.once('exit', () => disposableChildren.delete(child));
  return child;
}

function probeAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (_) { return false; }
}

async function waitForExit(child, timeoutMs = 8000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Disposable process ${child.pid} did not exit in time.`)), timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function killProcess(cookie, leaseId, payload, extraHeaders = {}) {
  return request('/api/processes/kill', {
    method: 'POST', cookie, leaseId,
    headers: { 'Content-Type': 'application/json', ...extraHeaders },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload)
  });
}

async function testProcessKill() {
  await startServer();
  const cookie = await login();
  const cookie2 = await login();
  let leaseId = null;
  let leaseId2 = null;
  try {
    const acquired = await postLease(cookie, { action: 'acquire' });
    assert.strictEqual(acquired.status, 201);
    leaseId = (await acquired.json()).leaseId;
    assert.strictEqual((await postLease(cookie, { action: 'set-profile', leaseId, profile: 'processes' })).status, 200);

    // ── Authentication, origin, and lease scoping ─────────────────────────────
    const unauth = await killProcess(null, leaseId, { pid: 1234, name: 'node', startedAt: FAKE_STARTED_AT });
    assert.strictEqual(unauth.status, 401, 'unauthenticated kill must be rejected');

    const crossSite = await killProcess(cookie, leaseId, { pid: 1234, name: 'node', startedAt: FAKE_STARTED_AT }, { 'Sec-Fetch-Site': 'cross-site' });
    assert.strictEqual(crossSite.status, 403, 'cross-origin kill must be rejected');

    const dashboardAcquired = await postLease(cookie2, { action: 'acquire' });
    assert.strictEqual(dashboardAcquired.status, 201);
    leaseId2 = (await dashboardAcquired.json()).leaseId;
    const wrongProfile = await killProcess(cookie2, leaseId2, { pid: 1234, name: 'node', startedAt: FAKE_STARTED_AT });
    assert.strictEqual(wrongProfile.status, 403, 'a dashboard-only lease must not allow kills');
    assert.strictEqual((await wrongProfile.json()).code, 'profile-required');

    const foreignLease = await killProcess(cookie2, leaseId, { pid: 1234, name: 'node', startedAt: FAKE_STARTED_AT });
    assert.strictEqual(foreignLease.status, 403, 'another session cannot use this lease for a kill');
    console.log('PASS kill authentication, origin validation, and lease scoping');

    // ── Strict input validation ───────────────────────────────────────────────
    const invalidCases = [
      { pid: '1234', name: 'node', startedAt: FAKE_STARTED_AT },
      { pid: -1, name: 'node', startedAt: FAKE_STARTED_AT },
      { pid: 12.5, name: 'node', startedAt: FAKE_STARTED_AT },
      { pid: 0, name: 'node', startedAt: FAKE_STARTED_AT },
      { pid: 4194305, name: 'node', startedAt: FAKE_STARTED_AT },
      { pid: 1234, name: '', startedAt: FAKE_STARTED_AT },
      { pid: 1234, name: 'node' },
      { pid: 1234, name: 'node', startedAt: 'not-a-date' },
      { pid: 1234, name: 'node', startedAt: FAKE_STARTED_AT, force: true },
      { pid: 1234, name: 'node', startedAt: FAKE_STARTED_AT, extra: null },
      'not json at all',
      { pid: '1234; taskkill /f /im node.exe', name: 'node', startedAt: FAKE_STARTED_AT }
    ];
    for (const payload of invalidCases) {
      const response = await killProcess(cookie, leaseId, payload);
      assert.strictEqual(response.status, 400, `invalid payload must be rejected: ${JSON.stringify(payload).slice(0, 90)}`);
      const data = await response.json();
      assert.strictEqual(data.success, false);
      assert.strictEqual(data.code, 'invalid-request');
    }

    const wrongType = await request('/api/processes/kill', {
      method: 'POST', cookie, leaseId,
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ pid: 1234, name: 'node', startedAt: FAKE_STARTED_AT })
    });
    assert.strictEqual(wrongType.status, 415, 'non-JSON content types must be rejected');

    const oversized = await killProcess(cookie, leaseId, `{"pid":1,"name":"x","startedAt":"${FAKE_STARTED_AT.repeat(60)}"}`);
    assert.strictEqual(oversized.status, 413, 'oversized kill bodies must be rejected');

    const shellName = await killProcess(cookie, leaseId, { pid: 999999, name: 'node"; Start-Process calc; "', startedAt: FAKE_STARTED_AT });
    assert.notStrictEqual(shellName.status, 200, 'shell syntax in fields must never succeed or be interpreted');
    assert([400, 409, 410].includes(shellName.status), `unexpected status for shell-syntax payload: ${shellName.status}`);
    assert.strictEqual((await request('/api/monitoring/status', { cookie })).status, 200, 'server must stay healthy after injection attempts');
    console.log('PASS strict kill input validation, content-type enforcement, and no command-execution path');

    // ── Rovarin self-protection ────────────────────────────────────────────
    const protectionCases = [
      { payload: { pid: serverProcess.pid, name: 'node', startedAt: FAKE_STARTED_AT }, label: 'the active server' },
      { payload: { pid: process.pid, name: 'node', startedAt: FAKE_STARTED_AT }, label: 'its parent control process' },
      { payload: { pid: 4, name: 'System', startedAt: FAKE_STARTED_AT }, label: 'a system PID' },
      { payload: { pid: 12345, name: 'csrss', startedAt: FAKE_STARTED_AT }, label: 'a critical process name' }
    ];
    for (const { payload, label } of protectionCases) {
      const response = await killProcess(cookie, leaseId, payload);
      assert.strictEqual(response.status, 403, `${label} must be refused`);
      assert.strictEqual((await response.json()).code, 'protected-process', `${label} must be reported as protected`);
    }
    assert.strictEqual(serverProcess.exitCode, null, 'the server must still be running after self-protection refusals');
    assert.strictEqual((await request('/api/monitoring/status', { cookie })).status, 200, 'server must answer after self-protection refusals');
    console.log('PASS Rovarin self-protection and critical-process refusal');

    // ── Process identity / PID reuse ──────────────────────────────────────────
    const child1 = spawnDisposable();
    const { observed: observed1 } = await waitForObservedProcess(cookie, leaseId, child1.pid);

    const wrongTime = await killProcess(cookie, leaseId, { pid: observed1.pid, name: observed1.name, startedAt: FAKE_STARTED_AT });
    assert.strictEqual(wrongTime.status, 409, 'a stale start time must be refused');
    assert.strictEqual((await wrongTime.json()).code, 'stale-process');
    assert(probeAlive(child1.pid), 'a stale identity must not terminate the live process');

    const wrongName = await killProcess(cookie, leaseId, { pid: observed1.pid, name: `${observed1.name}-other`, startedAt: observed1.startedAt });
    assert.strictEqual(wrongName.status, 409, 'a mismatched name must be refused');
    assert(probeAlive(child1.pid), 'a name mismatch must not terminate the live process');
    console.log('PASS PID-reuse identity verification refuses stale targets');

    // ── Already exited ────────────────────────────────────────────────────────
    child1.kill();
    await waitForExit(child1);
    const exited = await killProcess(cookie, leaseId, { pid: observed1.pid, name: observed1.name, startedAt: observed1.startedAt });
    assert.strictEqual(exited.status, 410, 'an already-exited process must return a controlled response');
    assert.strictEqual((await exited.json()).code, 'already-exited');
    console.log('PASS already-exited processes return controlled responses');

    // ── Real termination of a disposable process + duplicate request ──────────
    const child2 = spawnDisposable();
    const { observed: observed2 } = await waitForObservedProcess(cookie, leaseId, child2.pid);
    const killed = await killProcess(cookie, leaseId, { pid: observed2.pid, name: observed2.name, startedAt: observed2.startedAt });
    assert.strictEqual(killed.status, 200, 'a verified kill should succeed');
    const killedData = await killed.json();
    assert.strictEqual(killedData.success, true);
    assert.strictEqual(killedData.code, 'terminated');
    assert.strictEqual(killedData.pid, observed2.pid);
    await waitForExit(child2, 8000);
    assert(!probeAlive(child2.pid), 'the terminated disposable process must be gone');

    const duplicate = await killProcess(cookie, leaseId, { pid: observed2.pid, name: observed2.name, startedAt: observed2.startedAt });
    assert.strictEqual(duplicate.status, 200, 'a duplicate kill must resolve as a controlled idempotent response');
    assert.strictEqual((await duplicate.json()).code, 'already-terminated');

    const snapshotAfterKill = await getProcesses(cookie, leaseId);
    assert(!snapshotAfterKill.processes.some(item => item.pid === observed2.pid), 'the killed process must be dropped from the cached snapshot immediately');
    console.log('PASS real termination of a disposable process, snapshot removal, and duplicate requests');

    // ── Concurrent duplicate requests ─────────────────────────────────────────
    const child3 = spawnDisposable();
    const { observed: observed3 } = await waitForObservedProcess(cookie, leaseId, child3.pid);
    const [first, second] = await Promise.all([
      killProcess(cookie, leaseId, { pid: observed3.pid, name: observed3.name, startedAt: observed3.startedAt }),
      killProcess(cookie, leaseId, { pid: observed3.pid, name: observed3.name, startedAt: observed3.startedAt })
    ]);
    assert.deepStrictEqual([first.status, second.status].sort((a, b) => a - b), [200, 200], 'concurrent duplicates must both resolve cleanly');
    const bodyCodes = [(await first.json()).code, (await second.json()).code].sort();
    assert.deepStrictEqual(bodyCodes, ['already-terminated', 'terminated'], 'exactly one concurrent request may perform the termination');
    await waitForExit(child3, 8000);
    console.log('PASS concurrent duplicate kill requests terminate exactly once');

    // Reproduce the documented single-process scope with disposable fixtures:
    // ending a parent must not silently expand into killing its children.
    await postLease(cookie, { action: 'heartbeat', leaseId });
const parent = spawn(process.execPath, ['-e', 'const {spawn}=require("child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true,detached:true});child.unref();console.log(child.pid);global.keep=Buffer.alloc(64*1024*1024);setInterval(()=>{const end=Date.now()+40;while(Date.now()<end){}},200);'], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    disposableChildren.add(parent);
    parent.once('exit', () => disposableChildren.delete(parent));
    let descendantPid;
    try {
      descendantPid = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Disposable parent did not identify its child.')), 5000);
        parent.stdout.once('data', chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())); });
      });
      assert(Number.isSafeInteger(descendantPid) && descendantPid > 0);
      const { observed } = await waitForObservedProcess(cookie, leaseId, parent.pid);
      const response = await killProcess(cookie, leaseId, { pid: observed.pid, name: observed.name, startedAt: observed.startedAt });
      assert.strictEqual(response.status, 200);
      assert.strictEqual((await response.json()).verified, true);
      await waitForExit(parent);
      assert(probeAlive(descendantPid), 'single-identity End Task intentionally leaves child processes alive');
      console.log('PASS reproduced surviving child after verified parent termination; no unsafe process-tree expansion');
    } finally { if (descendantPid) { try { process.kill(descendantPid); } catch (_) {} } }

    // Actual API tree preview/confirmation/termination, using only owned fixtures.
    const treeParent = spawn(process.execPath, ['-e', 'const {spawn}=require("child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{stdio:"ignore",windowsHide:true,detached:true});child.unref();console.log(child.pid);global.keep=Buffer.alloc(64*1024*1024);setInterval(()=>{const end=Date.now()+40;while(Date.now()<end){}},200);'], {windowsHide:true,stdio:['ignore','pipe','ignore']});
    disposableChildren.add(treeParent);treeParent.once('exit',()=>disposableChildren.delete(treeParent));
    let treeChild;
    try {
      treeChild=await new Promise((resolve,reject)=>{const t=setTimeout(()=>reject(Error('Owned tree fixture timeout')),5000);treeParent.stdout.once('data',c=>{clearTimeout(t);resolve(Number(String(c).trim()))});});
      const {observed}=await waitForObservedProcess(cookie,leaseId,treeParent.pid);
      const identity={pid:observed.pid,name:observed.name,startedAt:observed.startedAt};
      const treeRequest=(route,body)=>request(route,{method:'POST',cookie,leaseId,headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const preview=await treeRequest('/api/processes/tree',identity);assert.equal(preview.status,200);assert((await preview.json()).descendantCount>=1);
      assert.equal((await treeRequest('/api/processes/kill-tree',identity)).status,400,'tree execution requires explicit confirmation');
      assert.equal((await treeRequest('/api/processes/kill-tree',{...identity,confirmed:true,command:'anything'})).status,400,'arbitrary input refused');
      const result=await treeRequest('/api/processes/kill-tree',{...identity,confirmed:true});assert.equal(result.status,200);assert((await result.json()).verified);
      await waitForExit(treeParent);assert(!probeAlive(treeChild));
      console.log('PASS actual authenticated process-tree API preview, explicit confirmation, fixed-input enforcement and verified descendant termination');
    } finally {if(treeChild){try{process.kill(treeChild)}catch(_){}}}

    // ── Adaptive monitoring and existing APIs unchanged ───────────────────────
    const status = await getStatus(cookie);
    assert.strictEqual(status.timers.processes, 5000, 'the kill feature must not change process sampling cadence');
    assert(!Object.keys(status.timers).some(key => key.includes('kill')), 'kill must not add a polling timer');
    assert(!status.activeCommands.some(name => String(name).includes('kill')), 'kill must not add a background command');
    const metrics = await request('/api/metrics', { cookie, leaseId });
    assert.strictEqual(metrics.status, 200, '/api/metrics must remain intact');
    const stream = await request(`/api/stream?lease=${encodeURIComponent(leaseId)}`, { cookie });
    assert.strictEqual(stream.status, 200, '/api/stream must remain intact');
    await stream.body.cancel();
    console.log('PASS adaptive monitoring unchanged and existing APIs intact');
  } finally {
    if (leaseId) await postLease(cookie, { action: 'release', leaseId }).catch(() => {});
    if (leaseId2) await postLease(cookie2, { action: 'release', leaseId2 }).catch(() => {});
    for (const child of disposableChildren) { try { child.kill(); } catch (_) {} }
  }
}

async function main() {
  try {
    await testExitVerification();
    await testProcessesUI();
    await testHandleRaceFixture();
    await testNativeIdentityHelper();
    await testProcessKill();
    console.log('PASS kill authentication, validation, identity protection, self-protection, and real termination');
  } finally {
    if (serverProcess && serverProcess.exitCode === null) {
      serverProcess.kill();
      await new Promise(resolve => serverProcess.once('exit', resolve));
    }
  }
}

main().catch(error => {
  console.error(error.stack || error.message);
  console.error(output.slice(-1600));
  process.exitCode = 1;
});
