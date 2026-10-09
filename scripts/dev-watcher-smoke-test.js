'use strict';

const assert = require('assert');
const EventEmitter = require('events');
const { createDevWatcher, handoffExistingDashboard, WATCHED_SERVER_FILES } = require('./dev-watcher');
const { bindServer, portCandidates } = require('../server-lifecycle');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');

async function testInterruptedStartup() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-guard-test-'));
  const lifecycle = path.resolve(__dirname, '..', 'server-lifecycle.js');
  fs.copyFileSync(path.resolve(__dirname, '..', 'pin-manager.js'),path.join(directory,'pin-manager.js'));
  const children = [];
  async function interruptedClaim() {
    // Stop inside the synchronous critical section, before writing instance
    // metadata. Kill only this disposable child, leaving its published guard.
    const code = `const fs=require('fs'),path=require('path');const read=fs.readFileSync;fs.readFileSync=function(file,...args){if(path.basename(String(file))==='server.instance.json'){console.log('GUARD_READY');Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);}return read.call(this,file,...args)};require(${JSON.stringify(lifecycle)}).claimInstance(${JSON.stringify(directory)},7331);`;
    const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    children.push(child);
    await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('Fixture exited before guard acquisition'))); });
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited;
  }
  try {
    await interruptedClaim();
    assert(fs.existsSync(path.join(directory, 'server-start.lock')));
    await interruptedClaim(); // Also prove an interrupted recovery self-heals.
    const { claimInstance } = require('../server-lifecycle');
    const stalePid=children.at(-1).pid;
    fs.writeFileSync(path.join(directory,'server.pid'),String(stalePid));
    fs.writeFileSync(path.join(directory,'server-state.json'),JSON.stringify({pid:stalePid,status:'listening',actualPort:7331}));
    const owner = claimInstance(directory, 7331);
    owner.write({status:'starting',preferredPort:7331});
    assert(!fs.existsSync(path.join(directory,'server.pid')),'dead PID must be retired before new starting state');
    if(process.platform==='win32'){
      const quote=value=>value.replace(/'/g,"''");
      const state=JSON.parse(execFileSync('powershell.exe',['-NoProfile','-Command',`. '${quote(path.join(__dirname,'dashboard-runtime.ps1'))}'; Get-DashboardRuntime '${quote(directory)}' | ConvertTo-Json -Compress`],{windowsHide:true,encoding:'utf8',timeout:10000}));
      assert.strictEqual(state.state,'starting','new startup must not be mistaken for an unsafe PID mismatch');assert.strictEqual(state.pid,process.pid);
    }
    owner.write({ status: 'listening', actualPort: 7331 });
    assert.throws(() => claimInstance(directory, 7331), /already running|still alive/);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'server.instance.json'))).pid, process.pid);
    owner.cleanup();
    fs.writeFileSync(path.join(directory,'server.pid'),String(process.pid));
    assert.throws(()=>claimInstance(directory,7331),/still alive/);
    assert.strictEqual(fs.readFileSync(path.join(directory,'server.pid'),'utf8'),String(process.pid),'live record remains untouched');
    fs.unlinkSync(path.join(directory,'server.pid'));
    assert(!fs.readdirSync(directory).some(name => name.endsWith('.lock')));
    await interruptedClaim();
    const competitors = await Promise.all(Array.from({ length: 4 }, () => {
      const code = `try{require(${JSON.stringify(lifecycle)}).claimInstance(${JSON.stringify(directory)},7331);console.log('OWNED');setInterval(()=>{},1000)}catch(error){console.log('REFUSED');process.exit(1)}`;
      const child = spawn(process.execPath, ['-e', code], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      children.push(child);
      return new Promise((resolve, reject) => { child.stdout.once('data', data => resolve({ child, owned: data.toString().includes('OWNED') })); child.once('error', reject); });
    }));
    assert.strictEqual(competitors.filter(item => item.owned).length, 1, 'concurrent stale recovery must elect exactly one instance');
    for (const { child } of competitors) if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    const recovered = claimInstance(directory, 7331); recovered.cleanup();
    fs.writeFileSync(path.join(directory, 'server-start.lock'), JSON.stringify({ pid: process.pid }));
    assert.throws(() => claimInstance(directory, 7331), /Startup is already running/);
    fs.unlinkSync(path.join(directory, 'server-start.lock'));
    fs.writeFileSync(path.join(directory, 'server-start.lock'), 'unverifiable');
    assert.throws(() => claimInstance(directory, 7331), /cannot be verified/);
    console.log('PASS forced startup interruption, interrupted recovery, concurrent stale recovery, live-owner/duplicate refusal, and malformed-guard fail-closed behavior');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

async function testBinding() {
  assert.deepStrictEqual(portCandidates(), [7331, 7332, 7333, 7334, 7335]);
  assert.deepStrictEqual(portCandidates(0), [0]);
  assert.throws(() => portCandidates('named-pipe'), /Invalid/);
  async function fakeBind(errors) {
    const state = {}, attempts = [];
    const server = new EventEmitter();
    server.listen = (port, host) => { assert.strictEqual(host, '0.0.0.0'); attempts.push(port); const error = errors.shift(); setImmediate(() => server.emit(error ? 'error' : 'listening', error ? { code: error } : undefined)); };
    server.address = () => ({ port: attempts.at(-1) });
    await new Promise(resolve => bindServer(server, 7331, state, resolve, resolve));
    return { state, attempts };
  }
  let result = await fakeBind([]);
  assert.deepStrictEqual(result.attempts, [7331]);
  assert.strictEqual(result.state.fallbackRequired, false);
  result = await fakeBind(['EADDRINUSE', 'EADDRINUSE']);
  assert.deepStrictEqual(result.attempts, [7331, 7332, 7333]);
  assert.strictEqual(result.state.actualPort, 7333);
  assert.strictEqual(result.state.fallbackRequired, true);
  for (const code of ['EACCES', 'EADDRNOTAVAIL', 'EINVAL']) {
    result = await fakeBind([code]);
    assert.deepStrictEqual(result.attempts, [7331]);
    assert.strictEqual(result.state.status, 'failed');
    assert.strictEqual(result.state.errorCode, code);
  }
  result = await fakeBind(Array(5).fill('EADDRINUSE'));
  assert.strictEqual(result.state.status, 'failed');
  assert.strictEqual(result.attempts.length, 5);

  // Real listener conflict, isolated runtime directory: never touches the
  // user's live server or its PID/port records.
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-port-test-'));
  const blocker = http.createServer((_req, res) => res.end('unrelated-test-listener'));
  const children = new Set();
  let active;
  async function launch(port, expectFailure = false) {
    let output = '';
    const child = spawn(process.execPath, ['server.js'], { cwd: directory, env: { ...process.env, PORT: String(port), PC_MONITOR_PIN: '123456789012' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    children.add(child);
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Port test startup timed out: ' + output)), 15000);
      const read = chunk => { output += chunk; const match = output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/); if (match) { clearTimeout(timer); resolve({ child, port: Number(match[1]) }); } };
      child.stdout.on('data', read); child.stderr.on('data', read);
      child.once('error', reject);
      child.once('exit', code => { clearTimeout(timer); if (expectFailure && code !== 0) resolve({ child }); else reject(new Error('Unexpected startup exit: ' + output)); });
    });
  }
  try {
    for (const name of ['server.js', 'diagnostics.js', 'maintenance-service.js', 'server-lifecycle.js', 'pin-manager.js', 'process-termination.js', 'app-manager.js','leftover-manager.js', 'enhanced-support.js', 'uninstall-manager.js', 'update-manager.js', 'maintenance.js', 'temperature-manager.js', 'cpu-temperature-provider.js', 'process-stats.js', 'package.json']) fs.copyFileSync(path.join(__dirname, '..', name), path.join(directory, name));
    await new Promise(resolve => blocker.listen(0, '0.0.0.0', resolve));
    const preferred = blocker.address().port;
    active = await launch(preferred);
    assert(active.port > preferred && active.port <= preferred + 4);
    const state = JSON.parse(fs.readFileSync(path.join(directory, 'server-state.json')));
    assert.strictEqual(state.actualPort, active.port);
    assert.strictEqual(state.pid, active.child.pid);
    assert.strictEqual(state.fallbackRequired, true);
    const base = `http://127.0.0.1:${active.port}`;
    assert.strictEqual((await fetch(base + '/api/metrics')).status, 401);
    const login = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pin: '123456789012' }) });
    const cookie = login.headers.getSetCookie().find(item => item.startsWith('pc_monitor_session=')).split(';')[0];
    const report = await (await fetch(base + '/api/diagnostics', { headers: { Cookie: cookie } })).json();
    assert.strictEqual(report.binding.actualPort, active.port);
    assert.strictEqual(report.binding.preferredPort, preferred);
    assert.strictEqual(report.binding.fallbackRequired, true);
    await launch(preferred, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'server-state.json'))).pid, active.child.pid, 'duplicate startup cannot overwrite owner metadata');
    assert.strictEqual(await (await fetch(`http://127.0.0.1:${preferred}`)).text(), 'unrelated-test-listener');
    if (process.platform === 'win32') {
      const helper = path.join(__dirname, 'dashboard-runtime.ps1').replace(/'/g, "''");
      const dir = directory.replace(/'/g, "''");
      const output = execFileSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', `. '${helper}'; Get-DashboardRuntime '${dir}' | ConvertTo-Json -Compress`], { timeout: 10000, windowsHide: true, encoding: 'utf8' });
      const runtime = JSON.parse(output);
      assert.strictEqual(runtime.port, active.port);
      assert.strictEqual(runtime.pid, active.child.pid);
      assert.strictEqual(runtime.healthy, true);
      const { inspectExistingDashboard } = require('./dev-watcher');
      const owner = await inspectExistingDashboard(directory);
      assert.strictEqual(owner.state, 'owned'); assert.strictEqual(owner.port, active.port);
    }
    const exited = new Promise(resolve => active.child.once('exit', resolve)); active.child.kill(); await exited;
    // Stale PID/lock recovery chooses an available preferred port next time.
    await new Promise(resolve => blocker.close(resolve));
    active = await launch(preferred);
    assert.strictEqual(active.port, preferred);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(directory, 'server-state.json'))).fallbackRequired, false);
    console.log('PASS port default/fallback/exhaustion, unrelated errors, real conflict, duplicate refusal, launcher/watcher active-port detection, diagnostics, and stale recovery');
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill(); await exited; }
    if (blocker.listening) await new Promise(resolve => blocker.close(resolve));
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const watchers = [];
const events = [];
const children = [];
const logger = { log() {}, warn() {}, error(message) { events.push(message); } };

class FakeChild extends EventEmitter {
  constructor(id) {
    super();
    this.pid = id;
    this.exitCode = null;
    this.signalCode = null;
  }
  kill() {
    events.push(`kill:${this.pid}`);
    setTimeout(() => {
      this.exitCode = 0;
      events.push(`close:${this.pid}`);
      this.emit('close', 0, null);
    }, 20);
    return true;
  }
}

function watchDirectory(directory, options, callback) {
  const watcher = new EventEmitter();
  watcher.directory = directory;
  watcher.options = options;
  watcher.callback = callback;
  watcher.close = () => watcher.emit('closed');
  watchers.push(watcher);
  return watcher;
}

function spawnServer(scriptPath, cwd) {
  assert(scriptPath.endsWith('server.js'));
  assert.strictEqual(cwd, 'C:\\project');
  if (children.length) assert.notStrictEqual(children[children.length - 1].exitCode, null, 'old server must exit before replacement starts');
  const child = new FakeChild(children.length + 1);
  events.push(`start:${child.pid}`);
  children.push(child);
  return child;
}

async function main() {
  assert.deepStrictEqual(Array.from(WATCHED_SERVER_FILES).sort(), ['maintenance.js', 'scripts/empty-recycle-bin.ps1', 'scripts/maintenance-elevated.cs', 'process-stats.js', 'server.js', 'diagnostics.js', 'maintenance-service.js', 'server-lifecycle.js', 'pin-manager.js', 'process-termination.js', 'app-manager.js','leftover-manager.js', 'scripts/terminate-process.ps1', 'scripts/process-tree.ps1', 'scripts/process-tree.cs', 'scripts/app-manager.ps1','scripts/app-leftovers.ps1','scripts/app-leftovers.cs', 'scripts/app-uninstall.cs', 'scripts/app-metadata.cs', 'scripts/process-display.ps1', 'scripts/application-display.ps1', 'scripts/installed-update.ps1', 'enhanced-support.js', 'uninstall-manager.js', 'update-manager.js', 'temperature-manager.js', 'cpu-temperature-provider.js', 'scripts/cpu-temperature-provider.ps1'].sort());

  let currentServer = { state: 'owned', pid: 7331 };
  let terminatedPid = null;
  assert.strictEqual(await handoffExistingDashboard({
    inspect: async () => currentServer,
    terminate: pid => { terminatedPid = pid; currentServer = { state: 'none' }; },
    wait: async () => {},
    logger
  }), true, 'verified existing dashboard should be handed off');
  assert.strictEqual(terminatedPid, 7331, 'only the verified listener PID should be signaled');

  let unsafeTerminated = false;
  assert.strictEqual(await handoffExistingDashboard({
    inspect: async () => ({ state: 'unsafe', reason: 'listener owner mismatch' }),
    terminate: () => { unsafeTerminated = true; },
    logger
  }), false, 'unverified listener ownership must block watcher startup');
  assert.strictEqual(unsafeTerminated, false, 'unverified process must never be terminated');

  let unverifiedStartupTermination = false;
  assert.strictEqual(await handoffExistingDashboard({
    inspect: async () => ({ state: 'starting', pid: 7333 }),
    terminate: () => { unverifiedStartupTermination = true; },
    wait: async () => {},
    timeoutMs: 5,
    pollMs: 1,
    logger
  }), false, 'a process that never establishes verified listener ownership must block startup');
  assert.strictEqual(unverifiedStartupTermination, false, 'an unverified starting process must not be signaled');

  let hungServerTerminationCount = 0;
  assert.strictEqual(await handoffExistingDashboard({
    inspect: async () => ({ state: 'owned', pid: 7334 }),
    terminate: () => { hungServerTerminationCount++; },
    wait: async () => {},
    timeoutMs: 5,
    pollMs: 1,
    logger
  }), false, 'a server that does not exit must block its replacement');
  assert.strictEqual(hungServerTerminationCount, 1, 'the verified process receives only one stop request');

  let startState = { state: 'starting', pid: 7332 };
  assert.strictEqual(await handoffExistingDashboard({
    inspect: async () => startState,
    terminate: () => { throw new Error('starting process without verified port ownership must not be killed'); },
    wait: async () => { startState = { state: 'none' }; },
    timeoutMs: 100,
    logger
  }), true, 'a startup process that exits before binding leaves the port safe to use');

  const watcher = createDevWatcher({
    projectDir: 'C:\\project',
    debounceMs: 80,
    watchDirectory,
    spawnServer,
    logger
  });
  assert.strictEqual(watchers.length, 2, 'root server-side files share one watcher; the fixed CPU helper uses the scripts directory watcher');
  const directoryWatcher = watchers[0];
  directoryWatcher.callback('change', 'config.json');
  directoryWatcher.callback('change', 'server.log');
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.strictEqual(children.length, 1, 'runtime/config file changes must not restart the server');

  directoryWatcher.callback('change', 'server.js');
  await new Promise(resolve => setTimeout(resolve, 25));
  directoryWatcher.callback('rename', 'maintenance.js');
  directoryWatcher.callback('change', 'temperature-manager.js');
  watchers[1].callback('change', 'cpu-temperature-provider.ps1');
  const restartDeadline = Date.now() + 2000;
  while (children.length < 2 && Date.now() < restartDeadline) await new Promise(resolve => setTimeout(resolve, 10));
  await new Promise(resolve => setTimeout(resolve, 110));
  assert.strictEqual(children.length, 2, 'rapid changes across relevant files should debounce into one restart');
  assert(events.indexOf('close:1') < events.indexOf('start:2'), 'replacement must start only after old child closes');

  await watcher.close();
  assert.strictEqual(children[1].exitCode, 0, 'stopping the watcher should stop its server child');
  console.log('PASS verified live-server handoff, unsafe-owner refusal, allowlisted watching, ignored runtime/config files, debounce, serialized restart, and shutdown');
  await testBinding();
  await testInterruptedStartup();
}

main().catch(error => { console.error(error); process.exitCode = 1; });
