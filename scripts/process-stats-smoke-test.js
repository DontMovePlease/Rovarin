'use strict';

const assert = require('assert');
const crypto = require('crypto');
const os = require('os');
const { spawn, execFile } = require('child_process');
const path = require('path');
const { calculateCpuPercent, parseCpuSeconds, isSameProcessInstance, normalizeProcessRecords, isProcessSnapshotStale } = require('../process-stats');

assert.strictEqual(calculateCpuPercent(1, null, 5000, 12), 0, 'new processes should begin at zero without a prior sample');
assert.strictEqual(calculateCpuPercent(1.5, 1, 5000, 12), 0.8, 'CPU should be normalized to total machine capacity');
assert.strictEqual(calculateCpuPercent(7, 1, 5000, 12), 10, 'multi-core process time should be normalized across logical processors');
assert.strictEqual(calculateCpuPercent(100, 0, 1000, 12), 100, 'percentages should be capped at 100% total machine capacity');
assert.strictEqual(calculateCpuPercent(0.5, 1, 5000, 12), 0, 'counter reset should not create a negative spike');
assert.strictEqual(calculateCpuPercent(1, 1, 0, 12), 0, 'zero elapsed time should not produce NaN or infinity');
assert.strictEqual(calculateCpuPercent(NaN, 1, 5000, 12), 0, 'malformed CPU data should be ignored');
assert.strictEqual(parseCpuSeconds(null), null, 'inaccessible/null CPU counters must remain unavailable');
assert.strictEqual(parseCpuSeconds(''), null, 'empty CPU counters must remain unavailable');
assert.strictEqual(parseCpuSeconds('1.25'), 1.25, 'numeric PowerShell counters should parse');
assert.strictEqual(parseCpuSeconds(-1), null, 'negative CPU counters must be rejected');

const priorInstance = { pid: 42, name: 'worker', startedAt: '2026-09-29T12:00:00.0000000Z', cpuSeconds: 1 };
assert.strictEqual(isSameProcessInstance({ ...priorInstance }, priorInstance), true, 'matching PID, name, and start time identify the same process');
assert.strictEqual(isSameProcessInstance({ ...priorInstance, startedAt: '2026-09-29T12:00:05.0000000Z' }, priorInstance), false, 'same-name PID reuse must reset the baseline');
assert.strictEqual(isSameProcessInstance({ ...priorInstance, startedAt: null }, priorInstance), false, 'missing start time must not reuse an old baseline');
const previousTimes = new Map([
  [42, { ...priorInstance, sampledAt: 1000 }],
  [99, { pid: 99, name: 'exited', startedAt: '2026-09-29T11:00:00.0000000Z', cpuSeconds: 3, sampledAt: 1000 }]
]);
const normalizedSample = normalizeProcessRecords([
  { Id: 42, ProcessName: 'worker', CPU: 10, WorkingSet64: 1024 * 1024, StartedAt: '2026-09-29T12:01:00.0000000Z' },
  { Id: 43, ProcessName: 'protected', CPU: null, WorkingSet64: 2 * 1024 * 1024, StartedAt: null },
  { Id: 'bad', ProcessName: 'malformed', CPU: 'NaN', WorkingSet64: 100, StartedAt: 'x' },
  null
], previousTimes, 6000, 12);
assert.strictEqual(normalizedSample.processes.length, 2, 'bad and missing records should not break a snapshot');
assert.strictEqual(normalizedSample.processes.find(item => item.pid === 42).cpuPercent, 0, 'reused PID must start a fresh CPU baseline');
assert.strictEqual(normalizedSample.processes.find(item => item.pid === 43).cpuPercent, null, 'inaccessible CPU should remain unavailable');
assert.strictEqual(normalizedSample.nextCpuTimes.has(99), false, 'processes that exited must lose their old CPU baseline');
assert.strictEqual(normalizedSample.nextCpuTimes.has(43), false, 'inaccessible start time must not keep an unsafe baseline');
assert.strictEqual(normalizedSample.processes.find(item => item.pid === 42).startedAt, '2026-09-29T12:01:00.0000000Z', 'observed start time must be exposed for kill identity verification');
assert.strictEqual(normalizedSample.processes.find(item => item.pid === 43).startedAt, null, 'inaccessible start time must remain unavailable rather than guessed');
assert.strictEqual(isProcessSnapshotStale(null, 10000, 15000), true, 'a missing first sample must be stale');
assert.strictEqual(isProcessSnapshotStale(1000, 16001, 15000), true, 'old process samples must be stale');
assert.strictEqual(isProcessSnapshotStale(1000, 16000, 15000), false, 'sample exactly at the freshness boundary remains current');

const root = path.resolve(__dirname, '..');
const pin = String(crypto.randomInt(100000000000, 999999999999));
let serverProcess;
let output = '';
let baseUrl = null;

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
  assert.strictEqual(response.status, 200, 'valid PIN should authenticate the process-monitor client');
  const cookies = response.headers.getSetCookie ? response.headers.getSetCookie() : [response.headers.get('set-cookie') || ''];
  const sessionCookie = cookies.find(cookie => cookie.startsWith('pc_monitor_session='));
  assert(sessionCookie, 'login should return the normal authenticated session cookie');
  return sessionCookie.split(';')[0];
}

async function getStatus(cookie) {
  const response = await request('/api/monitoring/status', { cookie });
  assert.strictEqual(response.status, 200);
  return response.json();
}

function sampleServerResources() {
  return new Promise((resolve, reject) => {
    const command = `$p=Get-Process -Id ${serverProcess.pid} -ErrorAction Stop; [pscustomobject]@{CpuSeconds=$p.CPU;WorkingSetBytes=$p.WorkingSet64}|ConvertTo-Json -Compress`;
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {
      windowsHide: true, timeout: 5000, encoding: 'utf8'
    }, (error, stdout) => {
      if (error) return reject(error);
      try { resolve({ ...JSON.parse(stdout), at: Date.now() }); }
      catch (_) { reject(new Error('Unable to parse process resource sample.')); }
    });
  });
}

function describeResourceDelta(start, end) {
  const elapsedSeconds = Math.max(0.001, (end.at - start.at) / 1000);
  const cpuSeconds = Math.max(0, Number(end.CpuSeconds) - Number(start.CpuSeconds));
  const oneCorePercent = cpuSeconds / elapsedSeconds * 100;
  return {
    cpuOneCorePercent: Math.round(oneCorePercent * 10) / 10,
    cpuMachinePercent: Math.round(oneCorePercent / Math.max(1, os.cpus().length) * 100) / 100,
    workingSetMB: Math.round(Number(end.WorkingSetBytes) / (1024 ** 2) * 10) / 10
  };
}

async function postLease(cookie, payload) {
  return request('/api/monitoring/lease', {
    method: 'POST', cookie,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function waitForSnapshot(cookie, leaseId, afterSampledAt = 0, timeoutMs = 12000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await request('/api/processes', { cookie, leaseId });
    assert.strictEqual(response.status, 200, 'active owner profile should read the cached snapshot');
    const snapshot = await response.json();
    if (snapshot.sampledAt > afterSampledAt) return snapshot;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out waiting for a process snapshot. ${output.slice(-1200)}`);
}

async function testProcessMonitoring() {
  await startServer();
  const cookie = await login();
  let leaseId = null;
  try {
    const idleStatus = await getStatus(cookie);
    assert.strictEqual(idleStatus.active, false, 'no lease must leave all monitoring inactive');
    assert.strictEqual(idleStatus.timers.processes, undefined, 'no lease must not run process sampling');
    assert(!idleStatus.activeCommands.includes('processes'));
    const idleStart = await sampleServerResources();
    await new Promise(resolve => setTimeout(resolve, 5000));
    const idleUsage = describeResourceDelta(idleStart, await sampleServerResources());

    const acquired = await postLease(cookie, { action: 'acquire' });
    assert.strictEqual(acquired.status, 201);
    leaseId = (await acquired.json()).leaseId;
    const dashboardStatus = await getStatus(cookie);
    assert.strictEqual(dashboardStatus.timers.processes, undefined, 'dashboard profile must not enumerate processes');
    const inactiveResponse = await request('/api/processes', { cookie, leaseId });
    assert.strictEqual(inactiveResponse.status, 403, 'dashboard profile must not expose process data');
    const dashboardStart = await sampleServerResources();
    await new Promise(resolve => setTimeout(resolve, 5000));
    const dashboardUsage = describeResourceDelta(dashboardStart, await sampleServerResources());

    const processesStart = await sampleServerResources();
    const profileResponse = await postLease(cookie, { action: 'set-profile', leaseId, profile: 'processes' });
    assert.strictEqual(profileResponse.status, 200);
    const activeStatus = await getStatus(cookie);
    assert.strictEqual(activeStatus.timers.processes, 5000, 'process profile should add one five-second timer');
    assert.strictEqual(activeStatus.timers.cpu, 4000, 'process monitoring must preserve dashboard CPU cadence');

    const first = await waitForSnapshot(cookie, leaseId);
    assert.strictEqual(first.stale, false, 'fresh samples should not be reported as stale');
    assert(Array.isArray(first.processes) && first.processes.length > 0, 'Windows process collection should return process entries');
    assert(first.processes.length <= 50, 'the cached snapshot should remain bounded');
    assert(first.processes.some(item => item.cpuPercent !== null), 'at least accessible processes should expose calculated CPU percentages');
    for (const item of first.processes) {
      assert.strictEqual(typeof item.name, 'string');
      assert(Number.isInteger(item.pid) && item.pid > 0);
      assert(typeof item.ramMB === 'number' && Number.isFinite(item.ramMB) && item.ramMB >= 0);
      assert(item.cpuPercent === null || (Number.isFinite(item.cpuPercent) && item.cpuPercent >= 0 && item.cpuPercent <= 100));
      assert(item.startedAt === null || (typeof item.startedAt === 'string' && item.startedAt.length > 0), 'start-time identity must be a string or null');
      assert.deepStrictEqual(Object.keys(item).sort(), ['cpuPercent', 'displayGroup', 'displayName', 'hasFriendlyName', 'name', 'pid', 'ramMB', 'startedAt'], 'only technical identity, metrics and safe display metadata should be returned');
    }
    for(const item of first.processes){assert.equal(typeof item.displayName,'string');assert.equal(typeof item.hasFriendlyName,'boolean');assert(item.displayGroup===null||/^[a-f0-9]{64}$/.test(item.displayGroup),'group metadata must be opaque, never an executable path');}
    for (let index = 1; index < first.processes.length; index++) {
      assert((first.processes[index - 1].cpuPercent ?? -1) >= (first.processes[index].cpuPercent ?? -1), 'default order should be CPU descending');
    }

    const second = await waitForSnapshot(cookie, leaseId, first.sampledAt);
    const sampleInterval = second.sampledAt - first.sampledAt;
    assert(sampleInterval >= 4500 && sampleInterval <= 9000, `process samples should be near five seconds apart (got ${sampleInterval}ms)`);
    const processesUsage = describeResourceDelta(processesStart, await sampleServerResources());

    const streamResponse = await request(`/api/stream?lease=${encodeURIComponent(leaseId)}`, { cookie });
    assert.strictEqual(streamResponse.status, 200);
    const reader = streamResponse.body.getReader();
    let streamText = '';
    const streamDeadline = Date.now() + 3000;
    while (!streamText.includes('event: processes') && Date.now() < streamDeadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ timeout: true }), Math.max(1, streamDeadline - Date.now())))
      ]);
      if (chunk.timeout || chunk.done) break;
      streamText += Buffer.from(chunk.value).toString('utf8');
    }
    assert.match(streamText, /event: processes/, 'process-profile SSE should include a process snapshot');
    await reader.cancel();

    const dashboardAgain = await postLease(cookie, { action: 'set-profile', leaseId, profile: 'dashboard' });
    assert.strictEqual(dashboardAgain.status, 200);
    const returnedToDashboard = await getStatus(cookie);
    assert.strictEqual(returnedToDashboard.timers.processes, undefined, 'leaving Processes should stop the process timer');
    assert.strictEqual((await request('/api/processes', { cookie, leaseId })).status, 403, 'process data must be unavailable after the profile ends');

    const released = await postLease(cookie, { action: 'release', leaseId });
    assert.strictEqual(released.status, 200);
    leaseId = null;
    const afterRelease = await getStatus(cookie);
    assert.strictEqual(afterRelease.active, false, 'releasing the final lease must stop continuous monitoring');
    assert.strictEqual(afterRelease.timers.processes, undefined, 'no process timer may remain after lease release');
    assert(!afterRelease.activeCommands.includes('processes'), 'no process enumeration command may remain active after release');
    console.log(`PASS process lease lifecycle, cached API, ${sampleInterval}ms cadence, bounded data, CPU sanity, and SSE`);
    console.log(`[resource] Node CPU % (one core / total machine), RSS MB — idle ${idleUsage.cpuOneCorePercent}/${idleUsage.cpuMachinePercent}, ${idleUsage.workingSetMB}; dashboard ${dashboardUsage.cpuOneCorePercent}/${dashboardUsage.cpuMachinePercent}, ${dashboardUsage.workingSetMB}; processes ${processesUsage.cpuOneCorePercent}/${processesUsage.cpuMachinePercent}, ${processesUsage.workingSetMB}`);
  } finally {
    if (leaseId) await postLease(cookie, { action: 'release', leaseId }).catch(() => {});
  }
}

async function main() {
  try {
    await testProcessMonitoring();
    console.log('PASS process CPU deltas, total-machine normalization, invalid counters, PID reuse, and adaptive process monitoring');
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
