'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const source = fs.readFileSync(path.join(__dirname, '..', 'diagnostics.js'), 'utf8');

function fixture(mode = 'supported') {
  let now = Date.now(), calls = [], driverChecks = 0;
  const state = {
    systemInfo: { gpuModels: ['NVIDIA fixture'], windowsVersion: 'Windows fixture' }, windowsCaptionDetected: true,
    currentGpuData: { sampledAt: null, available: false, statusNote: '' },
    processSnapshot: { error: null, sampledAt: null }, networkCollectionStatus: null,
    currentNetSpeed: { sampledAt: null }, bindingState: { status: 'listening', preferredPort: 7331, fallbackRequired: false }
  };
  const settings = { observations: {}, enhancedAssetsAvailable: false, enhancedVersion: '0.9.6' };
  const active = new Map(), terminating = new Map(), probes = new Set();
  class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const module = { exports: {} };
  const childProcess = { execFile(command, args, options, done) {
    calls.push(command);
    assert.strictEqual(options.windowsHide, true); assert(options.timeout > 0 && options.timeout <= 5000);
    assert.strictEqual(options.maxBuffer, 512 * 1024); assert.strictEqual(options.encoding, 'utf8'); assert(!options.shell);
    if (mode === 'throws') throw Object.assign(new Error('private fixture exception'), { code: 'ENOENT' });
    let error = mode === 'missing' ? { code: 'ENOENT' } : mode === 'timeout' ? { code: 'ETIMEDOUT' } : null;
    let output = command.includes('tailscale') ? JSON.stringify({ BackendState: 'Running', Self: { TailscaleIPs: ['100.64.1.2'], UserID: 'private-fixture-account' }, Peers: ['private-fixture-peer'] }) : command === 'nvidia-smi' ? 'NVIDIA fixture, 1, 2, 6144, 1024, 5120, 55' : command === 'netstat' ? 'bytes 100 200' : JSON.stringify({ admin: false, processCollector: true });
    if (mode === 'malformed') output = 'unreadable fixture';
    setImmediate(() => done(error, output));
  } };
  const builtins = { os: { cpus: () => [{}], totalmem: () => 16 * 1024 ** 3, release: () => 'fixture-build', type: () => 'Windows_NT', machine: () => 'x86_64' }, fs: { existsSync: () => false, statfsSync: () => ({ blocks: 1 }) }, path, child_process: childProcess };
  vm.runInNewContext(source, { module, exports: module.exports, require: name => name === './package.json' ? require('../package.json') : builtins[name], process: { platform: 'win32', arch: 'x64', version: 'fixture-node', env: {} }, Date: Clock });
  const diagnostics = module.exports.createDiagnostics({
    rootDirectory: path.resolve(__dirname, '..'), PORT: 7331, NVIDIA_SMI_COMMAND: 'nvidia-smi',
    getState: () => state, getServerPort: () => 7331, getTailscaleIP: () => null, isTailscaleIP: ip => ip === '100.64.1.2',
    parseNetworkCounters: text => text === 'bytes 100 200' ? { received: 100, sent: 200 } : null,
    activeTelemetryJobs: active, terminatingTelemetryJobs: terminating, diagnosticToolJobs: probes,
    cpuTemperatureProvider: { settings: () => settings, snapshot: () => ({ status: 'unavailable', mode: 'off', note: 'Optional fixture sensor', sensorName: null }) },
    temperatureManager: { snapshot: () => ({ readings: { cpu: { available: false } } }) },
    enhancedSupport: { detectDriver: async () => { driverChecks++; }, status: () => ({ driverInstalled: false }) }
  });
  return { diagnostics, state, calls, active, terminating, probes, advance: ms => now += ms, now: () => now, driverChecks: () => driverChecks };
}

async function test() {
  const root = path.resolve(__dirname, '..');
  const policy = JSON.parse(fs.readFileSync(path.join(root, 'scripts/release-public-files.json'), 'utf8'));
  assert(policy.includes('diagnostics.js'));
  assert(policy.includes('scripts/diagnostics-smoke-test.js'));
  const build = fs.readFileSync(path.join(root, 'packaging/build.ps1'), 'utf8');
  assert(build.match(/\$rootFiles = @\(([^\r\n]+)\)/)[1].includes("'diagnostics.js'"), 'installed payload includes the module');
  assert(require('./dev-watcher').WATCHED_SERVER_FILES.has('diagnostics.js'));
  console.log('PASS diagnostics module is included in watcher, packaged source and explicit publication policy');

  const f = fixture(), first = f.diagnostics.get();
  assert.strictEqual(first, f.diagnostics.get(true), 'concurrent normal/refresh requests share one report');
  const report = await first, check = id => report.checks.find(x => x.id === id);
  assert.strictEqual(report.overall.status, 'supported'); assert.strictEqual(check('server-version').value, require('../package.json').version);
  assert.strictEqual(check('tailscale-status').value, 'Running'); assert.strictEqual(check('permissions').value, 'Standard user');
  assert.strictEqual(check('gpu-telemetry').status, 'supported'); assert.strictEqual(check('network-telemetry').status, 'supported');
  assert(!JSON.stringify(report).includes('private-fixture')); assert.strictEqual(f.probes.size, 0); assert.strictEqual(f.driverChecks(), 1);
  const count = f.calls.length; f.advance(4900); assert.strictEqual(await f.diagnostics.get(true), report); assert.strictEqual(f.calls.length, count);
  f.advance(100); const refreshed = await f.diagnostics.get(true); assert.notStrictEqual(refreshed, report);
  f.advance(29999); assert.strictEqual(await f.diagnostics.get(), refreshed); f.advance(1); assert.notStrictEqual(await f.diagnostics.get(), refreshed);
  f.state.bindingState = { ...f.state.bindingState, preferredPort: 7332 }; f.state.processSnapshot = { error: 'unavailable' };
  f.diagnostics.invalidate(); const changed = await f.diagnostics.get(); assert.strictEqual(changed.binding.preferredPort, 7332); assert.strictEqual(changed.checks.find(x => x.id === 'process-monitoring').status, 'unavailable');
  console.log('PASS shared in-flight report, 30-second cache, 5-second explicit refresh, invalidation, live-state reads, existing report fields and private-output filtering');
  const busy = fixture(); busy.active.set('gpu', {}); busy.terminating.set('network', {});
  const busyReport = await busy.diagnostics.get(); assert(!busy.calls.includes('nvidia-smi')); assert(!busy.calls.includes('netstat')); assert.strictEqual(busy.probes.size, 0);
  assert(busyReport.checks.find(x => x.id === 'gpu-telemetry').summary.includes('no duplicate'));
  busy.active.clear(); busy.terminating.clear(); busy.diagnostics.invalidate(); await busy.diagnostics.get(); assert(busy.calls.includes('nvidia-smi')); assert(busy.calls.includes('netstat'));
  console.log('PASS telemetry/terminating job coordination, no duplicate GPU/network probes, and probe ownership released');
  for (const mode of ['missing', 'timeout', 'malformed', 'throws']) {
    const failed = fixture(mode), data = await failed.diagnostics.get(); assert.strictEqual(failed.probes.size, 0);
    assert.strictEqual(data.checks.find(x => x.id === 'gpu-telemetry').status, ['missing', 'throws'].includes(mode) ? 'unavailable' : 'failed');
    assert.strictEqual(data.overall.status, 'supported', 'optional failures do not fail core compatibility');
    assert(!JSON.stringify(data).includes('private fixture'));
  }
  console.log('PASS missing/timeout/malformed/synchronous command failures remain bounded, truthful and secret-free');
}
if (require.main === module) test().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = test;
