'use strict';

// Phase 2 hardware audit: GPU telemetry must degrade cleanly on PCs where
// nvidia-smi is missing or fails, without touching real NVIDIA hardware.
// PC_MONITOR_NVIDIA_SMI_PATH points the sampler at a nonexistent binary
// (ENOENT) and at node.exe (exits non-zero on the sampler arguments).

const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const { spawn } = require('child_process');
const path = require('path');

const root = path.resolve(__dirname, '..');
const pin = String(crypto.randomInt(100000000000, 999999999999));

let serverProcess = null;
let output = '';
let stopping = false;

function startServer(extraEnv, diagnosticsFixture = false) {
  return new Promise((resolve, reject) => {
    output = '';
    stopping = false;
    serverProcess = spawn(process.execPath, [...(diagnosticsFixture ? ['--require', './scripts/diagnostics-test-tools.js'] : ['--require', './scripts/cpu-temperature-test-tools.js']), 'server.js'], {
      cwd: root,
      env: { ...process.env, PORT: '0', PC_MONITOR_PIN: pin, PC_MONITOR_CPU_TEMPERATURE_FIXTURE: 'pawnio-missing', ...extraEnv },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let baseUrl = null;
    const timer = setTimeout(() => reject(new Error(`Server did not start in time. ${output.slice(-1200)}`)), 15000);
    const inspect = chunk => {
      output += chunk.toString();
      const match = output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);
      if (match && !baseUrl) {
        baseUrl = `http://127.0.0.1:${match[1]}`;
        clearTimeout(timer);
        resolve(baseUrl);
      }
    };
    serverProcess.stdout.on('data', inspect);
    serverProcess.stderr.on('data', inspect);
    serverProcess.on('error', reject);
    serverProcess.on('exit', code => {
      if (!stopping) {
        clearTimeout(timer);
        reject(new Error(`Server exited unexpectedly (${code}). ${output.slice(-1200)}`));
      }
    });
  });
}

async function stopServer() {
  if (!serverProcess) return;
  stopping = true;
  const proc = serverProcess;
  serverProcess = null;
  if (proc.exitCode === null && proc.signalCode === null) {
    const exited = new Promise(resolve => proc.once('exit', resolve));
    proc.kill();
    await exited;
  }
}

async function request(baseUrl, route, { method = 'GET', cookie, body, headers = {} } = {}) {
  return fetch(`${baseUrl}${route}`, {
    method,
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body
  });
}

async function login(baseUrl) {
  const response = await request(baseUrl, '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pin })
  });
  assert.strictEqual(response.status, 200, 'test PIN should authenticate');
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  const cookieHeader = cookies.find(value => value.startsWith('pc_monitor_session='));
  assert(cookieHeader, 'session cookie should be set');
  return cookieHeader.split(';')[0];
}

async function acquireLease(baseUrl, cookie) {
  const response = await request(baseUrl, '/api/monitoring/lease', {
    method: 'POST',
    cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'acquire' })
  });
  assert.strictEqual(response.status, 201, 'dashboard lease should be created');
  const payload = await response.json();
  assert(payload.leaseId, 'lease id should be returned');
  return payload.leaseId;
}

async function fetchMetrics(baseUrl, cookie, leaseId) {
  const response = await request(baseUrl, '/api/metrics', {
    cookie,
    headers: { 'X-Monitor-Lease': leaseId }
  });
  assert.strictEqual(response.status, 200, 'metrics should be served while the lease is live');
  const payload = await response.json();
  return payload.metrics;
}

async function waitFor(getValue, isReady, describe, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    last = await getValue();
    if (isReady(last)) return last;
    await new Promise(resolve => setTimeout(resolve, 400));
  }
  throw new Error(`Timed out waiting for ${describe}. Last value: ${JSON.stringify(last)}`);
}

async function runCase({ label, binaryPath, expectedNote }) {
  const baseUrl = await startServer({ PC_MONITOR_NVIDIA_SMI_PATH: binaryPath });
  try {
    const cookie = await login(baseUrl);
    const leaseId = await acquireLease(baseUrl, cookie);

    const metrics = await waitFor(
      () => fetchMetrics(baseUrl, cookie, leaseId),
      m => m && m.gpu && m.gpu.sampledAt && expectedNote.test(m.gpu.statusNote || ''),
      `${label}: GPU failure note`
    );

    assert.strictEqual(metrics.gpu.available, false, `${label}: GPU must report unavailable`);
    assert.match(metrics.gpu.statusNote, expectedNote, `${label}: status note should identify the failure mode`);
    assert.strictEqual(metrics.gpu.temperatureAvailable, false, `${label}: GPU temperature must not read as available`);
    assert.strictEqual(metrics.gpu.temperatureStatus, 'unavailable', `${label}: GPU temperature status should be unavailable`);

    // CPU temperature stays optional and explained, even without any probe.
    assert.strictEqual(metrics.cpu.temperatureAvailable, false, 'CPU temperature must stay unavailable');
    assert.strictEqual(metrics.cpu.temperatureStatus, 'unavailable', 'CPU temperature status should be unavailable');
    assert(metrics.cpu.temperatureNote && metrics.cpu.temperatureNote.length > 0, 'CPU temperature note should explain the unavailability');
    assert.strictEqual(metrics.temperatureAlerts.current.cpu.level, 'unavailable', 'CPU temperature alert level should be unavailable');

    // Health assessment must survive the GPU failure instead of crashing.
    assert(metrics.health, 'health assessment should exist');
    assert.strictEqual(typeof metrics.health.score, 'number', 'health score should be computed');
    assert.strictEqual(typeof metrics.health.rating, 'string', 'health rating should be computed');

    const firstGpuSampledAt = metrics.gpu.sampledAt;
    const firstCpuSampledAt = metrics.cpu.sampledAt;

    // A second sample cycle (dashboard cadence is 4 s per sampler): repeated
    // failures must keep flowing through the lease-driven sampler without
    // crashing the server or wedging the other samplers.
    const later = await waitFor(
      () => fetchMetrics(baseUrl, cookie, leaseId),
      m => m && m.gpu.sampledAt && m.gpu.sampledAt > firstGpuSampledAt && m.cpu.sampledAt > firstCpuSampledAt,
      `${label}: repeated sample cycle`
    );
    assert.match(later.gpu.statusNote, expectedNote, `${label}: repeated failures keep the same note`);
    assert.strictEqual(later.gpu.available, false, `${label}: GPU stays unavailable across cycles`);
    assert.strictEqual(serverProcess.exitCode, null, `${label}: server process must stay alive`);

    const status = await (await request(baseUrl, '/api/monitoring/status', { cookie })).json();
    assert.strictEqual(status.active, true, 'monitoring should stay active');
    assert.strictEqual(status.timers.gpu, 4000, 'GPU sampling remains lease-driven at the dashboard cadence');

    return { firstGpuSampledAt, laterCpuSampledAt: later.cpu.sampledAt };
  } finally {
    await stopServer();
  }
}

async function testDiagnostics(mode) {
  const baseUrl = await startServer({ PC_MONITOR_DIAGNOSTICS_FIXTURE: mode, PC_MONITOR_NVIDIA_SMI_PATH: 'nvidia-smi' }, true);
  try {
    assert.strictEqual((await request(baseUrl, '/api/diagnostics')).status, 401);
    const cookie = await login(baseUrl);
    assert.strictEqual((await request(baseUrl, '/api/diagnostics?command=anything', { cookie })).status, 400);
    assert.strictEqual((await request(baseUrl, '/api/diagnostics', { cookie, method: 'POST' })).status, 405);
    const responses = await Promise.all(Array.from({ length: 5 }, () => request(baseUrl, '/api/diagnostics', { cookie })));
    const data = await Promise.all(responses.map(response => { assert.strictEqual(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/); return response.json(); }));
    assert(data.every(item => item.generatedAt === data[0].generatedAt), 'concurrent requests share one diagnostic check');
    const report = data[0];
    assert.strictEqual(report.overall.status, 'supported', 'optional tool failures do not make core application unhealthy');
    const checks = Object.fromEntries(report.checks.map(check => [check.id, check]));
    for (const id of ['windows', 'os-architecture', 'node-runtime', 'server-version', 'server-port', 'default-port', 'tailscale', 'tailscale-status', 'tailscale-ip', 'nvidia-gpu', 'nvidia-smi', 'gpu-telemetry', 'cpu-temperature', 'cpu-telemetry', 'ram-telemetry', 'storage-telemetry', 'network-telemetry', 'process-monitoring', 'permissions']) {
      assert(checks[id], `check ${id} is present`);
      assert(['supported', 'unavailable', 'failed'].includes(checks[id].status));
    }
    assert.strictEqual(checks['cpu-temperature'].status, 'unavailable');
    assert.strictEqual(checks['server-port'].value, Number(new URL(baseUrl).port));
    assert.deepStrictEqual(checks['default-port'].value, { requested: false, used: false });
    assert.strictEqual(checks['server-version'].value, require('../package.json').version);
    assert(!JSON.stringify(report).includes(pin), 'PIN must not appear in diagnostics');
    assert.doesNotMatch(JSON.stringify(report), /secret-|cookie|session|C:\\\\private|commandLine/i);
    const expected = ['missing', 'throws'].includes(mode) ? 'unavailable' : ['failed', 'malformed'].includes(mode) ? 'failed' : 'supported';
    assert.strictEqual(checks['gpu-telemetry'].status, expected);
    assert.strictEqual(checks['network-telemetry'].status, expected);
    assert.strictEqual(checks['process-monitoring'].status, expected);
    if (mode === 'supported') {
      assert.strictEqual(checks['nvidia-gpu'].value, 'NVIDIA Test GPU');
      assert.strictEqual(checks['tailscale-status'].value, 'Running');
      assert.strictEqual(checks['tailscale-ip'].value, '100.64.1.2');
      assert.strictEqual(checks.permissions.value, 'Standard user');
    }
    if (mode === 'offline' || mode === 'recheck') assert.strictEqual(checks['tailscale-status'].status, 'unavailable', 'a retained IP cannot imply connected when Tailscale needs login');
    const before = output.match(/DIAGNOSTICS_TEST_TOOL:/g).length;
    assert.strictEqual((await request(baseUrl, '/api/diagnostics', { cookie })).status, 200);
    assert.strictEqual(output.match(/DIAGNOSTICS_TEST_TOOL:/g).length, before, 'cached requests spawn no new tools');
    if (mode === 'recheck') {
      assert.strictEqual((await request(baseUrl, '/api/diagnostics?refresh=1')).status, 401);
      assert.strictEqual((await request(baseUrl, '/api/diagnostics?refresh=1&refresh=1', {cookie})).status, 400);
      await new Promise(resolve => setTimeout(resolve, 5100));
      const refreshed = await Promise.all(Array.from({length: 5}, () => request(baseUrl, '/api/diagnostics?refresh=1', {cookie}).then(response => response.json())));
      assert(refreshed.every(item => item.generatedAt === refreshed[0].generatedAt));
      assert.notStrictEqual(refreshed[0].generatedAt, report.generatedAt);
      assert.strictEqual(refreshed[0].checks.find(item => item.id === 'tailscale-status').value, 'Running');
      const after = output.match(/DIAGNOSTICS_TEST_TOOL:/g).length;
      await request(baseUrl, '/api/diagnostics?refresh=1', {cookie});
      assert.strictEqual(output.match(/DIAGNOSTICS_TEST_TOOL:/g).length, after, 're-check bursts use bounded shared cache');
    }
    const monitoring = await (await request(baseUrl, '/api/monitoring/status', { cookie })).json();
    assert.strictEqual(monitoring.active, false);
    assert.deepStrictEqual(monitoring.timers, {});
    assert.deepStrictEqual(monitoring.activeCommands, []);
    await request(baseUrl, '/api/logout', { cookie, method: 'POST' });
    assert.strictEqual((await request(baseUrl, '/api/diagnostics', { cookie })).status, 401);
    console.log(`PASS diagnostics ${mode}: authorization, safe output, shared checks, cache, and zero telemetry timers`);
  } finally { await stopServer(); }
}

async function testDiagnosticsUI() {
  const vm = require('vm');
  const elements = new Map();
  const windowEvents = new Map();
  function element() {
    return { children: [], events: new Map(), value: '', textContent: '', hidden: false,
      append(...items) { this.children.push(...items); }, replaceChildren() { this.children = []; },
      addEventListener(name, callback) { this.events.set(name, callback); },
      focus() {}, select() {}, setSelectionRange() {} };
  }
  const get = id => { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); };
  const data = { generatedAt: new Date().toISOString(), overall: { title: 'Compatible', summary: 'Optional capabilities.', supported: 1, unavailable: 1, failed: 0 }, checks: [
    { label: 'GPU', status: 'supported', summary: 'Available', value: 'Test GPU' },
    { label: '<img src=x onerror=alert(1)>', status: 'unavailable', summary: 'Unsupported CPU temperature' }
  ] };
  let calls = 0, copied = '', replaced = '', status = 200, copyAllowed = true;
  const context = { document: { visibilityState: 'visible', getElementById: get, createElement: element,
    addEventListener() {}, execCommand: () => copyAllowed },
    window: { isSecureContext: true, addEventListener: (name, callback) => windowEvents.set(name, callback), location: { replace: route => { replaced = route; } } },
    navigator: { clipboard: { writeText: async text => { copied = text; } } },
    fetch: async () => { calls++; return { status, ok: status === 200, json: async () => data }; }
  };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'public', 'diagnostics.js'), 'utf8'), context);
  assert.strictEqual(calls, 0, 'loading dashboard does not run diagnostic checks');
  await get('refreshDiagnostics').events.get('click')();
  assert.strictEqual(get('diagnosticsChecks').children.length, 2);
  assert.strictEqual(get('diagnosticsChecks').children[1].children[0].textContent, data.checks[1].label, 'values are rendered as text, never HTML');
  await get('copyDiagnostics').events.get('click')();
  assert.match(copied, /Rovarin compatibility report/);
  assert.match(copied, /GPU: supported · Test GPU/);
  assert.match(copied, /unavailable/);
  context.window.isSecureContext = false;
  await get('copyDiagnostics').events.get('click')();
  assert.strictEqual(get('diagnosticsReportDetails').open, true, 'HTTP copy uses visible selectable text');
  copyAllowed = false;
  await get('copyDiagnostics').events.get('click')();
  assert.match(get('diagnosticsFeedback').textContent, /Select and copy/);
  status = 503;
  await get('refreshDiagnostics').events.get('click')();
  assert.strictEqual(get('diagnosticsReport').value, copied, 'failed refresh preserves last successful report');
  status = 401;
  await get('refreshDiagnostics').events.get('click')();
  assert.strictEqual(replaced, '/', 'expired authentication returns to login');
  get('diagnosticsPage').hidden = true;
  const before = calls;
  await get('refreshDiagnostics').events.get('click')();
  assert.strictEqual(calls, before, 'hidden Diagnostics page does not fetch');
  assert(windowEvents.has('pc-monitor-pagechange'));
  get('diagnosticsPage').hidden = false;
  let completeRefresh;
  context.fetch = () => new Promise(resolve => { completeRefresh = resolve; });
  const refreshing = get('refreshDiagnostics').events.get('click')();
  assert.strictEqual(get('cpuTemperatureMode').disabled, true, 'selection is locked while a pending report could overwrite it');
  assert.strictEqual(get('saveTemperatureMode').disabled, true);
  completeRefresh({ status: 200, ok: true, json: async () => ({ ...data, temperatureSettings: { mode: 'enhanced' } }) }); await refreshing;
  get('cpuTemperatureMode').value = 'off';
  let posted;
  context.fetch = async (_route, options) => {
    if (options?.method === 'POST') { posted = JSON.parse(options.body); assert.strictEqual(get('refreshDiagnostics').disabled, true); return { status: 200, ok: true, json: async () => ({ success: true, settings: { mode: 'off' } }) }; }
    return { status: 200, ok: true, json: async () => ({ ...data, temperatureSettings: { mode: 'off' } }) };
  };
  await get('saveTemperatureMode').events.get('click')();
  assert.deepStrictEqual(posted, { mode: 'off' }); assert.strictEqual(get('cpuTemperatureMode').value, 'off'); assert.strictEqual(get('cpuTemperatureMode').disabled, false);
  console.log('PASS temperature selector save, pending-report interaction guard and post-save reconciliation');
  console.log('PASS diagnostics UI logic: safe rendering, structured report, secure/HTTP/manual copy, errors, authentication, hidden-page guard');
}

async function testCollectorFailures(kind) {
  const baseUrl = await startServer({ PC_MONITOR_DIAGNOSTICS_FIXTURE: 'collector-' + kind, PC_MONITOR_NVIDIA_SMI_PATH: 'nvidia-smi' }, true);
  try {
    const cookie = await login(baseUrl);
    const report = await (await request(baseUrl, '/api/diagnostics', { cookie })).json();
    const checks = Object.fromEntries(report.checks.map(check => [check.id, check]));
    const expected = ['missing', 'throws'].includes(kind) ? 'unavailable' : kind === 'localized' ? 'supported' : 'failed';
    for (const id of ['network-telemetry', 'process-monitoring', 'tailscale-status']) assert.strictEqual(checks[id].status, expected, id + ' ' + kind);
    assert.strictEqual(checks['gpu-telemetry'].status, 'supported', 'unrelated GPU tool remains usable');
    const idle = await (await request(baseUrl, '/api/monitoring/status', { cookie })).json();
    assert.deepStrictEqual(idle.timers, {}, 'diagnostics alone starts no telemetry');
    const leaseId = await acquireLease(baseUrl, cookie);
    const profile = await request(baseUrl, '/api/monitoring/lease', { cookie, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'set-profile', leaseId, profile: 'processes' }) });
    assert.strictEqual(profile.status, 200);
    const sample = await waitFor(async () => (await request(baseUrl, '/api/processes', { cookie, headers: { 'X-Monitor-Lease': leaseId } })).json(), data => kind === 'localized' ? data.sampledAt > 0 : !!data.error, 'controlled process failure');
    if (kind === 'localized') { assert.strictEqual(sample.error, null); assert.strictEqual(sample.processes[0].ramMB, 1); }
    else assert.strictEqual(sample.error, ['missing', 'throws'].includes(kind) ? 'unavailable' : kind === 'timeout' ? 'timeout' : ['empty', 'malformed'].includes(kind) ? 'malformed-data' : 'collector-failed');
    const metrics = await fetchMetrics(baseUrl, cookie, leaseId);
    assert(metrics.cpu.sampledAt && metrics.ram.sampledAt, 'native CPU/RAM unaffected');
    if (kind !== 'localized') assert.notStrictEqual(metrics.system.windowsVersion, 'Microsoft Windows 11', 'failed edition detection must not invent a Windows edition');
    const gpu = await waitFor(() => fetchMetrics(baseUrl, cookie, leaseId), data => data.gpu.available, 'unrelated GPU sampler');
    assert.strictEqual(gpu.gpu.available, true);
    if (kind === 'localized') { assert.strictEqual(gpu.network.latencyMs, 1); assert.strictEqual(gpu.system.windowsVersion, 'Microsoft Windows 11 Professionnel'); }
    assert.strictEqual(serverProcess.exitCode, null);
    await request(baseUrl, '/api/monitoring/lease', { cookie, method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'release', leaseId }) });
    const stopped = await (await request(baseUrl, '/api/monitoring/status', { cookie })).json();
    assert.deepStrictEqual(stopped.timers, {}); assert.deepStrictEqual(stopped.activeCommands, []);
    console.log('PASS collector ' + kind + ': diagnostic status, native/GPU isolation, profile guards, and idle cleanup');
  } finally { await stopServer(); }
}

function testLocaleParsers() {
  const vm = require('vm');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const context = {};
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function parseNetworkCounters'), source.indexOf('function hasActiveMonitoringLease')), context);
  for (const label of ['Bytes', 'Octets', 'Empfangene Bytes', '字节']) {
    assert.deepStrictEqual(JSON.parse(JSON.stringify(context.parseNetworkCounters(`Statistics\n Received Sent\n ${label}\t123\t456\n Packets 9 10`))), { rx: 123, tx: 456 });
  }
  assert.strictEqual(context.parseNetworkCounters('Title\nReceived Sent\nBytes bad bad\nPackets 9 10'), null, 'malformed byte counters cannot be replaced with packet counters');
  assert.strictEqual(context.parseNetworkCounters('Bytes 9999999999999999999 1'), null);
  assert.strictEqual(context.parseNetworkCounters(''), null);
  for (const [text, value] of [['temps<1 ms', 1], ['Zeit=25ms', 25], ['时间=9ms', 9], ['Request timed out', null]]) assert.strictEqual(context.parsePingLatency(text), value);
  console.log('PASS localized network/ping parsing and malformed/unsafe counter rejection');
  const gpuSource = source.slice(source.indexOf('function sampleGpu()'), source.indexOf('// Isolated PORT 0 smoke servers'));
  for (const stdout of ['', 'garbage', 'NVIDIA, broken, 1, nope, 1, 1, 50']) {
    const state = { available: true };
    const gpuContext = { currentGpuData: state, NVIDIA_SMI_COMMAND: 'test-only', runTelemetryCommand(_name, _command, _args, _options, done) { done(null, stdout); }, temperatureManager: { setUnavailable() {}, setReading() { throw new Error('Malformed GPU sample cannot be a reading'); } }, publishMetricsSnapshot() {} };
    vm.runInNewContext(gpuSource + '\nsampleGpu();', gpuContext);
    assert.strictEqual(state.available, false);
    assert(state.sampledAt);
  }
  console.log('PASS empty/short/nonnumeric GPU telemetry is unavailable rather than active with invalid values');
}

async function testCommandTimeouts() {
  const vm = require('vm');
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const context = { execFile: require('child_process').execFile, monitoringActive: true, monitoringGeneration: 1, hasActiveMonitoringLease: () => true, activeTelemetryJobs: new Map(), terminatingTelemetryJobs: new Map(), diagnosticToolJobs: new Set() };
  vm.createContext(context);
  vm.runInContext(source.slice(source.indexOf('function runTelemetryCommand'), source.indexOf('function sampleNetworkStats')), context);
  const diagnosticsSource = fs.readFileSync(path.join(root, 'diagnostics.js'), 'utf8');
  vm.runInContext(diagnosticsSource.slice(diagnosticsSource.indexOf('function runDiagnosticCommand'), diagnosticsSource.indexOf('async function runDiagnosticTelemetryProbe')), context);
  const diagnostic = await context.runDiagnosticCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], 200);
  assert.strictEqual(diagnostic.status, 'failed', 'a genuinely hanging disposable executable times out');
  let callbacks = 0;
  const finished = new Promise(resolve => {
    assert.strictEqual(context.runTelemetryCommand('fixture', process.execPath, ['-e', 'setInterval(()=>{},1000)'], { windowsHide: true, timeout: 200 }, error => { callbacks++; assert(error.killed); resolve(); }), true);
    assert.strictEqual(context.runTelemetryCommand('fixture', process.execPath, ['-e', ''], { timeout: 200 }, () => { throw new Error('Overlapping command ran'); }), false);
  });
  await finished;
  assert.strictEqual(callbacks, 1);
  assert.strictEqual(context.activeTelemetryJobs.size, 0);
  context.monitoringActive = false;
  assert.strictEqual(context.runTelemetryCommand('fixture', process.execPath, ['-e', ''], { timeout: 200 }, () => {}), false);
  console.log('PASS real disposable command timeouts, non-overlap guard, completion cleanup, and inactive monitoring refusal');
}

(async () => {
  const missingBinary = path.join(root, '__rovarin_missing_nvidia_smi__.exe');
  assert(!fs.existsSync(missingBinary), 'the simulated missing binary path must not exist');

  await runCase({
    label: 'missing nvidia-smi',
    binaryPath: missingBinary,
    expectedNote: /^Sensor unavailable \(nvidia-smi not found on this PC\)$/
  });
  console.log('PASS missing nvidia-smi degrades GPU telemetry cleanly without crashing the server');

  await runCase({
    label: 'failing nvidia-smi',
    binaryPath: process.execPath,
    expectedNote: /^Sensor unavailable \(nvidia-smi not responding\)$/
  });
  console.log('PASS failing nvidia-smi command keeps the generic unavailable note');

  console.log('PASS CPU temperature stays cleanly unavailable with an explanatory note');
  console.log('PASS health assessment and lease-driven sampling survive repeated sensor failures');
  for (const mode of ['supported', 'missing', 'failed', 'malformed', 'throws', 'offline', 'recheck']) await testDiagnostics(mode);
  await testDiagnosticsUI();
  testLocaleParsers();
  await testCommandTimeouts();
  for (const kind of ['missing', 'failed', 'timeout', 'malformed', 'empty', 'throws', 'localized']) await testCollectorFailures(kind);
})().catch(async err => {
  await stopServer();
  console.error('FAIL', err);
  process.exit(1);
});
