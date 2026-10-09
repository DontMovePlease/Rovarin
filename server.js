const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const crypto = require('crypto');
const maintenance = require('./maintenance');
const { TemperatureManager } = require('./temperature-manager');
const { CpuTemperatureProvider } = require('./cpu-temperature-provider');
const { normalizeProcessRecords, isProcessSnapshotStale, ProcessDisplayCache } = require('./process-stats');
const { terminateProcess, processTree } = require('./process-termination');
const { AppManager } = require('./app-manager');
const { loadConfig, readConfig, validPin, writeConfig, generatePin, desktopTrust, configurationFile, dataDirectory } = require('./pin-manager');
const { bindServer, claimInstance, portCandidates } = require('./server-lifecycle');
const { EnhancedSupport, isLocalDesktopRequest } = require('./enhanced-support');
const { UninstallManager } = require('./uninstall-manager');
const { UpdateManager } = require('./update-manager');
const { createDiagnostics } = require('./diagnostics');
const { createLocalLifecycleClient } = require('./maintenance-service');

// Configuration
const PORT = process.env.PORT || 7331;
const IS_INSTALLED = fs.existsSync(path.join(__dirname, 'installation.json'));
const DATA_DIR = (() => { try { return dataDirectory(); } catch (_) {
  console.error('Saved development storage is invalid or inaccessible; server will not start.'); process.exit(1);
} })();
fs.mkdirSync(DATA_DIR, { recursive: true });
const CONFIG_FILE = (() => {
  try { return configurationFile(); }
  catch (_) { console.error('Saved access configuration is invalid or inaccessible; server will not start.'); process.exit(1); }
})();
const enhancedSupport = new EnhancedSupport({ stateDirectory: DATA_DIR });
const uninstallManager = new UninstallManager();
const updateManager = new UpdateManager({ configFile: CONFIG_FILE });
const localMaintenanceClient = createLocalLifecycleClient();
const appManager = new AppManager({ onChange: broadcastAppsStatus, stateDirectory: DATA_DIR });
let treeInFlight = false;
// Opaque compatibility identifiers retain existing clients and desktop trust.
const AUTH_COOKIE = 'pc_monitor_session';
// Keep operational auth messages bounded and non-sensitive; no HTTP/session tracing.
function authLog(tag) {
  if (['SERVER_INIT','REFRESH_PIN_CHANGED_OR_UNHEALTHY','REFRESH_PIN_FATAL_ERROR'].includes(tag))
    console.log('[Authentication] ' + tag);
}
authLog('SERVER_INIT');
const SESSION_TTL_MS = readBoundedDuration(process.env.PC_MONITOR_SESSION_TTL_MS, 90 * 24 * 60 * 60 * 1000, 1000, 90 * 24 * 60 * 60 * 1000);
const MAX_SESSIONS = 64;
const MAX_LEASES_PER_SESSION = 4;
const MAX_MONITORING_LEASES = 24;
const MAX_SSE_PER_SESSION = 4;
const MAX_SSE_CLIENTS = 16;
const sessions = new Map();
const loginAttempts = new Map();
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;

// Load or generate PIN for private access
let config;
try {
  config = loadConfig(CONFIG_FILE, { allowCreate: IS_INSTALLED || CONFIG_FILE === path.join(__dirname, 'config.json') });
} catch (_) {
  console.error('Saved access configuration is invalid or inaccessible; server will not start.'); process.exit(1);
}
// Explicit test/development override never changes the saved PIN.
let savedAccessPin = config.pin;
if (validPin(process.env.PC_MONITOR_PIN)) config.pin = process.env.PC_MONITOR_PIN;
let pinConfigHealthy = true;
let lastPinCheckTime = 0;
const PIN_CHECK_INTERVAL_MS = 1000;
let transientPinFailures = 0;

function refreshAccessPin(force = false) {
  const now = Date.now();
  if (!force && pinConfigHealthy && (now - lastPinCheckTime < PIN_CHECK_INTERVAL_MS)) {
    return true;
  }
  try {
    const saved = readConfig(CONFIG_FILE);
    lastPinCheckTime = now;
    transientPinFailures = 0;
    if (!pinConfigHealthy || saved.pin !== savedAccessPin) {
      if (saved.pin !== savedAccessPin) loginAttempts.clear(); // New local credential, new guess budget.
      authLog('REFRESH_PIN_CHANGED_OR_UNHEALTHY', { healthyBefore: pinConfigHealthy, pinMismatch: saved.pin !== savedAccessPin, activeSessions: sessions.size });
      for (const session of Array.from(sessions.values())) revokeSession(session, 'pin-changed-or-unhealthy');
      config = saved;
      if (validPin(process.env.PC_MONITOR_PIN)) config.pin = process.env.PC_MONITOR_PIN;
      savedAccessPin = saved.pin;
    }
    if (saved.requireDesktopPin !== config.requireDesktopPin || saved.desktopLocked !== config.desktopLocked) {
      if (saved.requireDesktopPin !== false || saved.desktopLocked) {
        for (const session of Array.from(sessions.values())) if (session.desktopAutomatic) revokeSession(session, 'desktop-auto-lock');
      }
      config.requireDesktopPin = saved.requireDesktopPin;
      config.desktopLocked = saved.desktopLocked;
    }
    config.requirePhoneRemovalPin=saved.requirePhoneRemovalPin===true;
    pinConfigHealthy = true;
    return true;
  } catch (err) {
    const isTransient = err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES' || err.code === 'EMFILE' || err.code === 'ENFILE');
    if (isTransient && pinConfigHealthy && validPin(savedAccessPin) && transientPinFailures < 3) {
      transientPinFailures++;
      lastPinCheckTime = now;
      authLog('REFRESH_PIN_TRANSIENT_ERROR', { error: err.message, code: err.code, transientPinFailures });
      return true;
    }
    transientPinFailures = 0;
    pinConfigHealthy = false;
    authLog('REFRESH_PIN_FATAL_ERROR', { error: err.message, code: err.code, activeSessions: sessions.size });
    for (const session of Array.from(sessions.values())) revokeSession(session, 'pin-fatal-error');
    return false;
  }
}

const bindingState = { status: 'starting', preferredPort: Number(PORT), defaultPort: 7331, actualPort: null, fallbackRequired: false };
let serverInstance;
try { portCandidates(PORT); serverInstance = claimInstance(DATA_DIR, PORT); serverInstance.write(bindingState); }
catch (_) { console.error('[Startup] Could not claim this server instance or preferred port is invalid. No second instance was started.'); process.exit(1); }
function cleanupPid() { try { serverInstance.cleanup(); } catch (_) {} }

process.on('exit', cleanupPid);
process.on('SIGINT', () => { cleanupPid(); process.exit(0); });
process.on('SIGTERM', () => { cleanupPid(); process.exit(0); });

// Find Tailscale IPv4 address
function getTailscaleIP() {
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if (addr.family === 'IPv4' || addr.family === 4) {
        // Tailscale CGNAT subnet is 100.64.0.0/10 (100.64.0.0 to 100.127.255.255)
        // or interface name includes 'tailscale'
        if (name.toLowerCase().includes('tailscale') || isTailscaleIP(addr.address)) {
          return addr.address;
        }
      }
    }
  }
  return null;
}

function readBoundedDuration(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= minimum && parsed <= maximum ? parsed : fallback;
}

function isTailscaleIP(ip) {
  if (!ip) return false;
  // Tailscale IPv6 (fd7a:115c:a1e0::/48)
  if (ip.toLowerCase().startsWith('fd7a:115c:a1e0:')) {
    return true;
  }
  // Tailscale IPv4 (100.64.0.0/10)
  const parts = ip.split('.').map(Number);
  if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) {
    return true;
  }
  return false;
}

function isAllowedClient(remoteAddress) {
  if (!remoteAddress) return false;
  // Normalize IPv6 mapped IPv4 addresses (e.g., ::ffff:127.0.0.1 or ::ffff:100.x.x.x)
  let cleanIp = remoteAddress;
  if (cleanIp.startsWith('::ffff:')) {
    cleanIp = cleanIp.slice(7);
  }
  // Localhost
  if (cleanIp === '127.0.0.1' || cleanIp === '::1' || cleanIp === 'localhost') {
    return true;
  }
  // Tailscale IP range
  if (isTailscaleIP(cleanIp)) {
    return true;
  }
  return false;
}

// Global System Info (cached)
let systemInfo = {
  hostname: os.hostname(),
  platform: 'Windows',
  windowsVersion: os.platform() === 'win32' ? 'Windows (build ' + os.release() + ')' : os.type() + ' ' + os.release(),
  arch: os.arch(),
  cpuModel: 'Intel Core',
  cpuCores: 0,
  cpuThreads: 0,
  gpuModels: [],
  tailscaleIP: getTailscaleIP()
};

let windowsCaptionDetected = false;
// Populate static system hardware info on startup
function initStaticInfo() {
  const cpus = os.cpus();
  if (cpus && cpus.length > 0) {
    systemInfo.cpuModel = cpus[0].model.trim();
    systemInfo.cpuThreads = cpus.length;
  }

  // Windows OS caption & CPU Cores via WMI
  const done = (err, stdout) => {
    if (err) return;
    try {
      const data = JSON.parse(stdout);
      if (typeof data.caption === 'string' && data.caption.trim()) { systemInfo.windowsVersion = data.caption.trim(); windowsCaptionDetected = true; }
      if (Number.isInteger(data.cores) && data.cores > 0) systemInfo.cpuCores = data.cores;
      if (Array.isArray(data.gpus)) systemInfo.gpuModels = data.gpus.filter(name => typeof name === 'string' && name.trim());
    } catch (_) {} // Optional startup discovery never blocks native counters.
  };
  try {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', "$ErrorActionPreference='Stop'; [pscustomobject]@{caption=(Get-CimInstance Win32_OperatingSystem).Caption;cores=[int]((Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum);gpus=@((Get-CimInstance Win32_VideoController).Name)} | ConvertTo-Json -Compress"], { windowsHide: true, timeout: 12000, maxBuffer: 1024 * 1024 }, done);
  } catch (error) { done(error, ''); }
}
initStaticInfo();

// Dynamic State & Ring Buffer History (30 dashboard samples at a 4s interval ≈ 2 min)
const HISTORY_MAX = 30;
const history = {
  timestamps: [],
  cpuUsage: [],
  gpuUsage: [],
  gpuTemp: [],
  ramUsagePercent: [],
  networkDownKB: [],
  networkUpKB: []
};

// Monitoring runs only while an authenticated client holds a live lease.
// Every profile declares requirements per sampler. The profile manager picks
// one effective cadence per sampler across all live clients.
const MONITORING_LEASE_TTL_MS = readBoundedDuration(process.env.PC_MONITORING_LEASE_TTL_MS, 45000, 1000, 120000);
const MONITORING_PROFILES = {
  dashboard: {
    cpuMs: 4000,
    ramMs: 4000,
    gpuMs: 4000,
    networkMs: 4000,
    drivesMs: 60000,
    latencyMs: 20000,
    temperatureMs: 20000,
    historyMs: 4000
  },
  'cpu-detail': { cpuMs: 1000 },
  'gpu-detail': { gpuMs: 2000 },
  'network-detail': { networkMs: 1000, latencyMs: 2000 },
  'storage-detail': { drivesMs: 15000 },
  processes: { processesMs: 5000 }
};
const SAMPLER_DEFINITIONS = {
  cpu: { profileKey: 'cpuMs', callback: sampleCpuMetrics },
  ram: { profileKey: 'ramMs', callback: sampleRamMetrics },
  gpu: { profileKey: 'gpuMs', callback: sampleGpu },
  network: { profileKey: 'networkMs', callback: sampleNetworkStats },
  drives: { profileKey: 'drivesMs', callback: sampleDriveMetrics },
  latency: { profileKey: 'latencyMs', callback: sampleLatency },
  temperature: { profileKey: 'temperatureMs', callback: sampleCpuTemperature },
  history: { profileKey: 'historyMs', callback: sampleHistoryMetrics },
  processes: { profileKey: 'processesMs', callback: sampleProcesses }
};
const AVAILABLE_MONITORING_PROFILES = Object.freeze(Object.keys(MONITORING_PROFILES));
const monitoringLeases = new Map();
const monitoringTimers = new Map();
const activeTelemetryJobs = new Map();
const diagnosticToolJobs = new Set();
const terminatingTelemetryJobs = new Map();
let leaseExpiryTimer = null;
let monitoringActive = false;
let monitoringGeneration = 0;
let cachedDrives = [];
let lastDriveScanAt = 0;
let lastCpuSampleAt = 0;
let currentCpuMetrics = null;
let currentRamMetrics = null;
let currentDriveMetrics = [];
const PROCESS_COMMAND_TIMEOUT_MS = 10000;
const PROCESS_SNAPSHOT_STALE_MS = 15000;
let processSnapshot = { processes: [], sampledAt: null, error: null };
let previousProcessCpuTimes = new Map();

// Kill (Step 8): one narrowly scoped, event-driven termination operation.
// Identity = pid + name + observed start time from the current process snapshot.
const MAX_KILL_BODY_BYTES = 1024;
const MAX_PROCESS_PID = 4194304; // Windows maximum PID (0x400000)
const PROCESS_IDENTITY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;
// The active server, its parent (dev watcher / launcher), and Windows system PIDs.
const PROTECTED_PROCESS_PIDS = new Set([process.pid, process.ppid].filter(pid => Number.isSafeInteger(pid) && pid > 0));
// Obvious Windows system-critical processes; Windows also denies these itself.
const CRITICAL_PROCESS_NAMES = new Set(['idle', 'system', 'smss', 'csrss', 'wininit', 'winlogon', 'lsass', 'services', 'rovarin', 'pcmonitor']);
let killInFlight = new Set();
const pendingTerminations = new Map();
const recentKills = new Map();
const MAX_RECENT_KILLS = 32;
const MAX_CONCURRENT_KILLS = 2;
const RECENT_KILL_TTL_MS = 60000;

const processDisplayCache = new ProcessDisplayCache();
function sampleProcesses() {
  if (!monitoringActive || !hasActiveMonitoringLease() || !effectiveSamplingInterval('processesMs')) return;
  runTelemetryCommand('processes', 'powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference='Stop'; $items=@(foreach($p in Get-Process){try{$id=$p.Id;$name=$p.ProcessName;$cpu=$null;$ram=$null;$startedAt=$null;$exePath=$null;try{$exePath=$p.Path}catch{};try{$cpu=$p.CPU}catch{};try{$ram=$p.WorkingSet64}catch{};try{$startedAt=$p.StartTime.ToUniversalTime().ToString('o')}catch{};if($null -ne $ram){[pscustomobject]@{Id=$id;ProcessName=$name;CPU=$cpu;WorkingSet64=$ram;StartedAt=$startedAt;ExecutablePath=$exePath}}}catch{}}); ConvertTo-Json -InputObject $items -Compress"
  ], { windowsHide: true, timeout: PROCESS_COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
    if (!effectiveSamplingInterval('processesMs')) return;
    const sampledAt = Date.now();
    if (err) {
      processSnapshot = { ...processSnapshot, error: err.killed ? 'timeout' : err.code === 'ENOENT' ? 'unavailable' : (err.code === 'EACCES' || err.code === 'EPERM' ? 'access-denied' : 'collector-failed') };
      broadcastProcessSnapshot();
      return;
    }
    let records;
    try {
      const parsed = JSON.parse(String(stdout || '').trim());
      if (!Array.isArray(parsed) && (!parsed || typeof parsed !== 'object' || !Number.isInteger(parsed.Id))) throw new Error('Invalid process data');
      records = Array.isArray(parsed) ? parsed : [parsed];
    } catch (_) {
      processSnapshot = { ...processSnapshot, error: 'malformed-data' };
      broadcastProcessSnapshot();
      return;
    }
    const logicalProcessors = Math.max(1, os.cpus().length);
    const normalized = normalizeProcessRecords(records, previousProcessCpuTimes, sampledAt, logicalProcessors);
    previousProcessCpuTimes = normalized.nextCpuTimes;
    const cachedLabels=processDisplayCache.cached(records);
    for(const item of normalized.processes){const key=item.pid+'|'+item.name+'|'+item.startedAt;item.displayName=cachedLabels.get(key)||item.name;item.hasFriendlyName=cachedLabels.metadataAvailable.has(key);item.displayGroup=cachedLabels.groupKeys.get(key)||null;}
    processSnapshot = { processes: normalized.processes.filter(item => !wasRecentlyKilled(item.pid, item.startedAt, item.name)).slice(0, 50), sampledAt, error: null };
    broadcastProcessSnapshot();
    const visibleIdentities=new Set(processSnapshot.processes.map(item=>item.pid+'|'+item.name+'|'+item.startedAt));
    processDisplayCache.enrich(records.filter(row=>visibleIdentities.has(row.Id+'|'+row.ProcessName+'|'+row.StartedAt))).then(labels=>{
      if(processSnapshot.sampledAt!==sampledAt)return;
      processSnapshot={...processSnapshot,processes:processSnapshot.processes.map(item=>({...item,displayName:labels.get(item.pid+'|'+item.name+'|'+item.startedAt)||item.name,hasFriendlyName:labels.metadataAvailable.has(item.pid+'|'+item.name+'|'+item.startedAt),displayGroup:labels.groupKeys.get(item.pid+'|'+item.name+'|'+item.startedAt)||null}))};
      broadcastProcessSnapshot();
    });
  });
}

function broadcastProcessSnapshot() {
  if (!refreshAccessPin()) return;
  if (!effectiveSamplingInterval('processesMs')) return;
  const payload = `event: processes\ndata: ${JSON.stringify({ ...processSnapshot, stale: isProcessSnapshotStale(processSnapshot.sampledAt, Date.now(), PROCESS_SNAPSHOT_STALE_MS) })}\n\n`;
  for (const [client, leaseId] of sseClients) {
    const lease = monitoringLeases.get(leaseId);
    if (!lease || !lease.profiles.has('processes')) continue;
    try { client.write(payload); } catch (_) { sseClients.delete(client); }
  }
}

// A terminated/exited process is dropped from the cached snapshot immediately so
// duplicate requests and connected clients converge without waiting for a resample.
function removeProcessFromSnapshot(pid, startedAt = null, name = null) {
  const matches = item => item.pid === pid && (startedAt === null || item.startedAt === startedAt) && (name === null || item.name === name);
  if (!processSnapshot.processes.some(matches)) return;
  processSnapshot = { ...processSnapshot, processes: processSnapshot.processes.filter(item => !matches(item)) };
  broadcastProcessSnapshot();
}

function killIdentityKey(pid, startedAt, name) {
  return JSON.stringify([pid, name, startedAt]);
}

function rememberKilledProcess(pid, startedAt, name) {
  const now = Date.now();
  recentKills.set(killIdentityKey(pid, startedAt, name), now);
  for (const [key, at] of recentKills) if (now - at > RECENT_KILL_TTL_MS) recentKills.delete(key);
  while (recentKills.size > MAX_RECENT_KILLS) recentKills.delete(recentKills.keys().next().value);
}

function wasRecentlyKilled(pid, startedAt, name) {
  const key = killIdentityKey(pid, startedAt, name);
  const at = recentKills.get(key);
  if (!Number.isFinite(at)) return false;
  if (Date.now() - at > RECENT_KILL_TTL_MS) { recentKills.delete(key); return false; }
  return true;
}

function pushHistory(entry) {
  history.timestamps.push(entry.timestamp);
  history.cpuUsage.push(entry.cpu);
  history.gpuUsage.push(entry.gpu);
  history.gpuTemp.push(entry.gpuTemp);
  history.ramUsagePercent.push(entry.ram);
  history.networkDownKB.push(entry.netDownKB);
  history.networkUpKB.push(entry.netUpKB);

  if (history.timestamps.length > HISTORY_MAX) {
    history.timestamps.shift();
    history.cpuUsage.shift();
    history.gpuUsage.shift();
    history.gpuTemp.shift();
    history.ramUsagePercent.shift();
    history.networkDownKB.shift();
    history.networkUpKB.shift();
  }
}

// CPU Delta calculation
let prevCpuTimes = os.cpus();
function getCpuUsage() {
  const currentCpuTimes = os.cpus();
  let idleDelta = 0;
  let totalDelta = 0;
  const perCore = [];

  for (let i = 0; i < currentCpuTimes.length; i++) {
    const cur = currentCpuTimes[i].times;
    const prev = prevCpuTimes[i] ? prevCpuTimes[i].times : cur;
    const coreIdle = cur.idle - prev.idle;
    const coreTotal = (cur.user - prev.user) +
                      (cur.nice - prev.nice) +
                      (cur.sys - prev.sys) +
                      (cur.irq - prev.irq) +
                      coreIdle;
    idleDelta += coreIdle;
    totalDelta += coreTotal;

    const corePercent = coreTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - coreIdle / coreTotal) * 100))) : 0;
    perCore.push(corePercent);
  }
  prevCpuTimes = currentCpuTimes;

  const overall = totalDelta > 0 ? Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10)) : 0;
  return { overall, perCore };
}

// Drive Storage detection (C:, D:, etc.)
function scanDrivesInfo() {
  const drives = [];
  const candidateLetters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  for (const letter of candidateLetters) {
    const rootPath = `${letter}:\\`;
    try {
      const stat = fs.statfsSync(rootPath);
      if (stat && stat.blocks > 0) {
        const totalBytes = stat.blocks * stat.bsize;
        const freeBytes = stat.bavail * stat.bsize;
        const usedBytes = totalBytes - freeBytes;
        const usedPercent = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0;
        drives.push({
          mount: `${letter}:`,
          totalGB: Math.round((totalBytes / (1024 ** 3)) * 10) / 10,
          freeGB: Math.round((freeBytes / (1024 ** 3)) * 10) / 10,
          usedGB: Math.round((usedBytes / (1024 ** 3)) * 10) / 10,
          usedPercent
        });
      }
    } catch (e) {
      // Drive not present or unreadable, ignore
    }
  }
  return drives;
}

function getDrivesInfo() {
  const refreshMs = effectiveSamplingInterval('drivesMs') || MONITORING_PROFILES.dashboard.drivesMs;
  if (!lastDriveScanAt || Date.now() - lastDriveScanAt >= refreshMs) {
    cachedDrives = scanDrivesInfo();
    lastDriveScanAt = Date.now();
  }
  return cachedDrives;
}

// Network Stats tracking via netstat -e
let prevNetSample = null;
let currentNetSpeed = { downSpeedKB: 0, upSpeedKB: 0, sampledAt: null };
let networkCollectionStatus = null;

function parseNetworkCounters(stdout) {
  // Windows netstat -e emits a title, column heading, then byte counters.
  // Ignore translated labels; never substitute a later packet counter row
  // when the byte row is malformed. A single counter row is also accepted.
  const lines = String(stdout || '').split(/\r?\n/).filter(line => line.trim());
  const row = (lines.length >= 3 ? lines[2] : lines[0] || '').match(/^\s*\S.*?\s+(\d+)\s+(\d+)\s*$/);
  if (!row) return null;
  const rx = Number(row[1]), tx = Number(row[2]);
  return Number.isSafeInteger(rx) && Number.isSafeInteger(tx) ? { rx, tx } : null;
}

function parsePingLatency(stdout) {
  // The unit and comparison operator are stable across Windows translations.
  const match = String(stdout || '').match(/[=<]\s*(\d+)\s*ms\b/i);
  return match ? Number(match[1]) : null;
}

function hasActiveMonitoringLease() {
  return monitoringLeases.size > 0;
}

// Track and guard every external telemetry command. If the last lease ends,
// running commands are terminated and callbacks from an old generation ignored.
function runTelemetryCommand(name, command, args, options, callback) {
  if (!monitoringActive || !hasActiveMonitoringLease() || activeTelemetryJobs.has(name) || terminatingTelemetryJobs.has(name) || diagnosticToolJobs.has(name)) return false;

  const job = { generation: monitoringGeneration, child: null };
  activeTelemetryJobs.set(name, job);
  const done = (err, stdout, stderr) => {
    if (activeTelemetryJobs.get(name) === job) activeTelemetryJobs.delete(name);
    if (terminatingTelemetryJobs.get(name) === job) terminatingTelemetryJobs.delete(name);
    if (job.generation !== monitoringGeneration || !monitoringActive || !hasActiveMonitoringLease()) return;
    callback(err, stdout, stderr);
  };

  try {
    job.child = execFile(command, args, { maxBuffer: 512 * 1024, ...options }, done);
  } catch (err) {
    done(err, '', '');
  }
  return true;
}

function sampleNetworkStats() {
  runTelemetryCommand('network', 'netstat', ['-e'], { windowsHide: true, timeout: 3000 }, (err, stdout) => {
    const counters = err ? null : parseNetworkCounters(stdout);
    networkCollectionStatus = err?.code === 'ENOENT' ? 'unavailable' : counters ? 'supported' : 'failed';
    if (!counters) { prevNetSample = null; currentNetSpeed = { downSpeedKB: 0, upSpeedKB: 0, sampledAt: null }; publishMetricsSnapshot(); return; }
    {
      const rxBytes = counters.rx;
      const txBytes = counters.tx;
      const now = Date.now();

      if (prevNetSample && !isNaN(rxBytes) && !isNaN(txBytes)) {
        const durationSec = Math.max(0.1, (now - prevNetSample.time) / 1000);
        const rxDiff = Math.max(0, rxBytes - prevNetSample.rx);
        const txDiff = Math.max(0, txBytes - prevNetSample.tx);
        currentNetSpeed = {
          downSpeedKB: Math.round((rxDiff / 1024 / durationSec) * 10) / 10,
          upSpeedKB: Math.round((txDiff / 1024 / durationSec) * 10) / 10,
          sampledAt: now
        };
      } else {
        currentNetSpeed.sampledAt = now;
      }
      prevNetSample = { rx: rxBytes, tx: txBytes, time: now };
      publishMetricsSnapshot();
    }
  });
}

// Network Latency ping (every ~4 seconds)
let currentLatencyMs = null;
let latencyStatus = 'Measuring';
let currentLatencySampledAt = null;
function sampleLatency() {
  runTelemetryCommand('latency', 'ping', ['-n', '1', '-w', '1000', '1.1.1.1'], { windowsHide: true, timeout: 2500 }, (err, stdout) => {
    if (err || !stdout) {
      currentLatencyMs = null;
      latencyStatus = 'Timeout / Unreachable';
      currentLatencySampledAt = Date.now();
      publishMetricsSnapshot();
      return;
    }
    const latency = parsePingLatency(stdout);
    if (latency !== null) {
      currentLatencyMs = latency;
      latencyStatus = `${currentLatencyMs} ms`;
    } else {
      currentLatencyMs = null;
      latencyStatus = 'Timeout';
    }
    currentLatencySampledAt = Date.now();
    publishMetricsSnapshot();
  });
}

// GPU Query via nvidia-smi. Optional operator override for hosts where the
// binary is not on PATH; the arguments stay fixed either way.
const NVIDIA_SMI_COMMAND = process.env.PC_MONITOR_NVIDIA_SMI_PATH || 'nvidia-smi';
let currentGpuData = {
  name: 'NVIDIA GPU',
  available: false,
  utilizationPercent: null,
  temperatureC: null,
  vramTotalMB: null,
  vramUsedMB: null,
  vramFreeMB: null,
  vramPercent: null,
  statusNote: 'Checking sensor...',
  sampledAt: null
};

function sampleGpu() {
  runTelemetryCommand('gpu', NVIDIA_SMI_COMMAND, [
    '--query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,temperature.gpu',
    '--format=csv,noheader,nounits'
  ], { windowsHide: true, timeout: 5000 }, (err, stdout) => {
    const fields = String(stdout || '').trim().split(/\r?\n/)[0].split(',').map(field => field.trim());
    const valid = fields.length >= 7 && fields[0] && [1, 3, 4, 5].every(index => fields[index] !== '' && Number.isFinite(Number(fields[index])) && Number(fields[index]) >= 0);
    if (err || !valid) {
      currentGpuData.available = false;
      // Distinguish a missing tool (typical on PCs without an NVIDIA GPU or
      // driver) from a tool that exists but failed to answer.
      currentGpuData.statusNote = err && err.code === 'ENOENT'
        ? 'Sensor unavailable (nvidia-smi not found on this PC)'
        : 'Sensor unavailable (nvidia-smi not responding)';
      currentGpuData.sampledAt = Date.now();
      temperatureManager.setUnavailable('gpu', 'NVIDIA NVML via nvidia-smi', currentGpuData.statusNote);
      publishMetricsSnapshot();
      return;
    }
    const parts = fields;
    if (parts.length >= 7) {
      const totalVram = parseFloat(parts[3]);
      const usedVram = parseFloat(parts[4]);
      const freeVram = parseFloat(parts[5]);
      currentGpuData = {
        name: parts[0] || 'NVIDIA GeForce GPU',
        available: true,
        utilizationPercent: parseFloat(parts[1]) || 0,
        temperatureC: parseFloat(parts[6]) || null,
        vramTotalMB: totalVram,
        vramUsedMB: usedVram,
        vramFreeMB: freeVram,
        vramPercent: totalVram > 0 ? Math.round((usedVram / totalVram) * 100) : 0,
        statusNote: 'Active (NVIDIA NVML)',
        sampledAt: Date.now()
      };
      temperatureManager.setReading('gpu', {
        available: true,
        temperatureC: currentGpuData.temperatureC,
        source: 'NVIDIA NVML via nvidia-smi',
        sampledAt: currentGpuData.sampledAt,
        note: currentGpuData.statusNote
      });
      publishMetricsSnapshot();
    } else {
      currentGpuData.available = false;
      currentGpuData.statusNote = 'Sensor returned malformed GPU telemetry';
      currentGpuData.sampledAt = Date.now();
      temperatureManager.setUnavailable('gpu', 'NVIDIA NVML via nvidia-smi', currentGpuData.statusNote);
      publishMetricsSnapshot();
    }
  });
}

// Isolated PORT 0 smoke servers never write or inherit the user's settings.
const cpuTemperatureProvider = new CpuTemperatureProvider({ settingsFile: Number(PORT) === 0 ? null : path.join(DATA_DIR, 'temperature-settings.json') });
const temperatureManager = new TemperatureManager({
  staleAfterMs: 45000,
  providers: {
    cpu: {
      source: cpuTemperatureProvider.snapshot().source,
      note: cpuTemperatureProvider.snapshot().note
    },
    gpu: {
      source: 'NVIDIA NVML via nvidia-smi',
      note: 'Waiting for NVIDIA temperature sample.'
    }
  }
});

function sampleCpuTemperature() {
  if (!monitoringActive || !hasActiveMonitoringLease()) return;
  cpuTemperatureProvider.sample(runTelemetryCommand, result => {
    if (result.status === 'available') temperatureManager.setReading('cpu', {
      available: true, temperatureC: result.temperatureC, sampledAt: result.sampledAt,
      source: result.source, note: result.note, suppressAlerts: result.sensorType === 'system-thermal-zone'
    });
    else temperatureManager.setUnavailable('cpu', result.source, result.note);
    diagnostics.invalidate();
    publishMetricsSnapshot();
  });
}

const diagnostics = createDiagnostics({
  rootDirectory: __dirname, PORT, NVIDIA_SMI_COMMAND,
  getState: () => ({ systemInfo, windowsCaptionDetected, currentGpuData, processSnapshot, networkCollectionStatus, currentNetSpeed, bindingState }),
  getServerPort: () => server.address().port,
  getTailscaleIP, isTailscaleIP, parseNetworkCounters,
  activeTelemetryJobs, terminatingTelemetryJobs, diagnosticToolJobs,
  cpuTemperatureProvider, temperatureManager, enhancedSupport
});

// Health Assessment Logic
function assessHealth(cpu, ram, gpu, drives, latency) {
  const issues = [];
  let score = 100;

  // CPU Assessment
  if (cpu.overall > 90) {
    issues.push({ level: 'critical', text: `Heavy CPU load (${cpu.overall}%)` });
    score -= 25;
  } else if (cpu.overall > 75) {
    issues.push({ level: 'warning', text: `Elevated CPU load (${cpu.overall}%)` });
    score -= 10;
  }

  // RAM Assessment
  if (ram.usedPercent > 92) {
    issues.push({ level: 'critical', text: `High RAM pressure (${ram.usedPercent}%)` });
    score -= 25;
  } else if (ram.usedPercent > 82) {
    issues.push({ level: 'warning', text: `Elevated RAM usage (${ram.usedPercent}%)` });
    score -= 10;
  }

  // GPU Temperature Assessment
  if (gpu.available && gpu.temperatureC !== null) {
    if (gpu.temperatureC >= 85) {
      issues.push({ level: 'critical', text: `GPU running hot (${gpu.temperatureC}°C)` });
      score -= 20;
    } else if (gpu.temperatureC >= 78) {
      issues.push({ level: 'warning', text: `GPU warm (${gpu.temperatureC}°C)` });
      score -= 8;
    }
  }

  // Storage Assessment (C: drive)
  const cDrive = drives.find(d => d.mount === 'C:');
  if (cDrive) {
    if (cDrive.usedPercent > 92) {
      issues.push({ level: 'critical', text: `Low disk space on C: (${cDrive.freeGB} GB free)` });
      score -= 20;
    } else if (cDrive.usedPercent > 85) {
      issues.push({ level: 'warning', text: `C: drive getting full (${cDrive.freeGB} GB free)` });
      score -= 8;
    }
  }

  // Latency Assessment
  if (latency !== null && latency > 150) {
    issues.push({ level: 'warning', text: `High network latency (${latency} ms)` });
    score -= 5;
  }

  let rating = 'Optimal';
  let badgeColor = 'emerald';
  if (score < 60) {
    rating = 'Attention Needed';
    badgeColor = 'rose';
  } else if (score < 85) {
    rating = 'Good';
    badgeColor = 'amber';
  }

  return {
    score: Math.max(0, score),
    rating,
    badgeColor,
    issues: issues.length > 0 ? issues : [{ level: 'optimal', text: 'All hardware systems running smoothly' }]
  };
}

// Uptime formatter
function formatUptime(seconds) {
  const days = Math.floor(seconds / (24 * 3600));
  seconds %= (24 * 3600);
  const hours = Math.floor(seconds / 3600);
  seconds %= 3600;
  const minutes = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);

  const parts = [];
  if (days > 0) parts.push(`${days}d`);
  if (hours > 0 || days > 0) parts.push(`${hours}h`);
  parts.push(`${minutes}m`);
  parts.push(`${secs}s`);
  return parts.join(' ');
}

// Latest state remains cached while the server is idle; no sampling timers run
// until a dashboard lease is created.
let latestMetrics = null;
const sseClients = new Map();

function sampleCpuMetrics() {
  if (!monitoringActive || !hasActiveMonitoringLease()) return;
  const cpu = getCpuUsage();
  lastCpuSampleAt = Date.now();
  currentCpuMetrics = {
    overall: cpu.overall,
    perCore: cpu.perCore,
    cores: systemInfo.cpuCores || cpu.perCore.length / 2,
    threads: cpu.perCore.length,
    model: systemInfo.cpuModel,
    sampledAt: lastCpuSampleAt
  };
  publishMetricsSnapshot();
}

function sampleRamMetrics() {
  if (!monitoringActive || !hasActiveMonitoringLease()) return;
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  currentRamMetrics = {
    totalGB: Math.round((totalMem / (1024 ** 3)) * 10) / 10,
    usedGB: Math.round((usedMem / (1024 ** 3)) * 10) / 10,
    freeGB: Math.round((freeMem / (1024 ** 3)) * 10) / 10,
    usedPercent: Math.round((usedMem / totalMem) * 1000) / 10,
    sampledAt: Date.now()
  };
  publishMetricsSnapshot();
}

function sampleDriveMetrics() {
  if (!monitoringActive || !hasActiveMonitoringLease()) return;
  currentDriveMetrics = getDrivesInfo();
  publishMetricsSnapshot();
}

function publishMetricsSnapshot() {
  if (!monitoringActive || !hasActiveMonitoringLease() || !currentCpuMetrics || !currentRamMetrics) return;
  const uptimeStr = formatUptime(os.uptime());
  const now = new Date();
  const timestampStr = now.toLocaleTimeString('en-US', { hour12: false });
  const isoTimestamp = now.toISOString();

  const temperatureSnapshot = temperatureManager.snapshot();
  const freshHealthGpu = {
    ...currentGpuData,
    temperatureC: temperatureSnapshot.readings.gpu.available ? temperatureSnapshot.readings.gpu.temperatureC : null
  };
  const health = assessHealth(currentCpuMetrics, currentRamMetrics, freshHealthGpu, currentDriveMetrics, currentLatencyMs);

  latestMetrics = {
    timestamp: timestampStr,
    isoTimestamp,
    system: systemInfo,
    uptime: uptimeStr,
    uptimeSeconds: Math.floor(os.uptime()),
    cpu: {
      ...currentCpuMetrics,
      temperatureC: temperatureSnapshot.readings.cpu.temperatureC,
      temperatureAvailable: temperatureSnapshot.readings.cpu.available,
      temperatureStale: temperatureSnapshot.readings.cpu.stale,
      temperatureStatus: temperatureSnapshot.readings.cpu.status,
      temperatureSampledAt: temperatureSnapshot.readings.cpu.sampledAt,
      temperatureNote: temperatureSnapshot.readings.cpu.note,
      temperatureSource: temperatureSnapshot.readings.cpu.source,
      temperatureProvider: cpuTemperatureProvider.snapshot()
    },
    gpu: {
      ...currentGpuData,
      temperatureAvailable: temperatureSnapshot.readings.gpu.available,
      temperatureStale: temperatureSnapshot.readings.gpu.stale,
      temperatureStatus: temperatureSnapshot.readings.gpu.status,
      temperatureSource: temperatureSnapshot.readings.gpu.source,
      temperatureSampledAt: temperatureSnapshot.readings.gpu.sampledAt,
      temperatureNote: temperatureSnapshot.readings.gpu.note
    },
    ram: currentRamMetrics,
    drives: currentDriveMetrics,
    network: {
      downSpeedKB: currentNetSpeed.downSpeedKB,
      upSpeedKB: currentNetSpeed.upSpeedKB,
      sampledAt: currentNetSpeed.sampledAt,
      latencyMs: currentLatencyMs,
      latencyStatus,
      latencySampledAt: currentLatencySampledAt
    },
    health,
    temperatureAlerts: temperatureSnapshot.alerts
  };

  broadcastSSE(latestMetrics);
}

// Keep dashboard history at its own baseline cadence even while one metric is
// being sampled faster by a focused profile.
function sampleHistoryMetrics() {
  if (!monitoringActive || !hasActiveMonitoringLease() || !latestMetrics) return;
  const timestampStr = new Date().toLocaleTimeString('en-US', { hour12: false });
  pushHistory({
    timestamp: timestampStr,
    cpu: currentCpuMetrics.overall,
    gpu: currentGpuData.available ? (currentGpuData.utilizationPercent || 0) : 0,
    gpuTemp: currentGpuData.available ? (currentGpuData.temperatureC || 0) : 0,
    ram: currentRamMetrics.usedPercent,
    netDownKB: currentNetSpeed.downSpeedKB,
    netUpKB: currentNetSpeed.upSpeedKB
  });
  publishMetricsSnapshot();
}

// SSE connection pool. Values associate a stream with the lease whose expiry
// should close it, while keeping the existing event payload unchanged.
function broadcastAppsStatus(status) {
  if (!refreshAccessPin()) return;
  for(const [client,leaseId] of sseClients){const lease=monitoringLeases.get(leaseId);if(!lease||lease.expiresAt<=Date.now())continue;try{client.write('event: apps-operation\ndata: '+JSON.stringify(status)+'\n\n');}catch(_){sseClients.delete(client);}}
}
function broadcastSSE(data) {
  if (!refreshAccessPin()) return;
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients.keys()) {
    try {
      client.write(payload);
    } catch (e) {
      sseClients.delete(client);
    }
  }
}

function effectiveSamplingInterval(profileKey) {
  if (profileKey === 'temperatureMs' && cpuTemperatureProvider.mode === 'off') return null;
  const intervals = [];
  monitoringLeases.forEach(lease => lease.profiles.forEach(profileName => {
    const interval = MONITORING_PROFILES[profileName]?.[profileKey];
    if (Number.isFinite(interval) && interval > 0) intervals.push(interval);
  }));
  return intervals.length ? Math.min(...intervals) : null;
}

function getEffectiveSamplingIntervals() {
  const profileKeys = new Set(Object.values(MONITORING_PROFILES).flatMap(profile => Object.keys(profile)));
  return Object.fromEntries(Array.from(profileKeys, profileKey => [profileKey, effectiveSamplingInterval(profileKey)]));
}

function updateManagedTimer(name, definition) {
  const interval = effectiveSamplingInterval(definition.profileKey);
  const existing = monitoringTimers.get(name);
  if (existing && existing.interval === interval) return;
  if (existing) clearInterval(existing.handle);
  monitoringTimers.delete(name);
  if (!interval && name === 'processes') {
    const job = activeTelemetryJobs.get(name);
    if (job?.child) {
      activeTelemetryJobs.delete(name);
      terminatingTelemetryJobs.set(name, job);
      try { job.child.kill(); } catch (_) {}
    }
    processSnapshot = { processes: [], sampledAt: null, error: null };
    previousProcessCpuTimes = new Map();
  }
  if (monitoringActive && interval) {
    if (name === 'processes' && !existing) definition.callback();
    const handle = setInterval(() => {
      if (monitoringActive && hasActiveMonitoringLease()) definition.callback();
    }, interval);
    monitoringTimers.set(name, { handle, interval });
    // A newly requested faster cadence should return a fresh value promptly.
    if (existing && interval < existing.interval) definition.callback();
  }
}

function reconcileMonitoringSchedule() {
  if (!monitoringLeases.size) {
    stopMonitoring();
    return;
  }
  Object.entries(SAMPLER_DEFINITIONS).forEach(([name, definition]) => updateManagedTimer(name, definition));
}

function startMonitoring() {
  if (monitoringActive || !monitoringLeases.size) return;
  monitoringActive = true;
  monitoringGeneration++;
  prevCpuTimes = os.cpus();
  currentCpuMetrics = null;
  currentRamMetrics = null;
  currentDriveMetrics = [];
  prevNetSample = null;
  processSnapshot = { processes: [], sampledAt: null, error: null };
  previousProcessCpuTimes = new Map();
  currentNetSpeed = { downSpeedKB: 0, upSpeedKB: 0, sampledAt: null };
  currentGpuData = {
    name: 'NVIDIA GPU', available: false, utilizationPercent: null,
    temperatureC: null, vramTotalMB: null, vramUsedMB: null,
    vramFreeMB: null, vramPercent: null, statusNote: 'Refreshing sensor…', sampledAt: null
  };
  temperatureManager.reset();
  temperatureManager.setUnavailable(
    'cpu',
    cpuTemperatureProvider.snapshot().source,
    cpuTemperatureProvider.snapshot().note
  );
  currentLatencyMs = null;
  latencyStatus = 'Measuring';
  currentLatencySampledAt = null;
  lastDriveScanAt = 0;
  lastCpuSampleAt = 0;

  // Publish a useful initial snapshot immediately, then begin the slower sensors.
  sampleCpuMetrics();
  sampleRamMetrics();
  sampleDriveMetrics();
  sampleGpu();
  sampleNetworkStats();
  sampleLatency();
  sampleCpuTemperature();
  reconcileMonitoringSchedule();
}

function stopMonitoring() {
  if (!monitoringActive && monitoringTimers.size === 0 && activeTelemetryJobs.size === 0) return;
  monitoringActive = false;
  cpuTemperatureProvider.cancel();
  monitoringGeneration++;
  monitoringTimers.forEach(timer => clearInterval(timer.handle));
  monitoringTimers.clear();

  activeTelemetryJobs.forEach((job, name) => {
    if (job.child) {
      terminatingTelemetryJobs.set(name, job);
      try { job.child.kill(); } catch (_) {}
    }
  });
  activeTelemetryJobs.clear();
  processSnapshot = { processes: [], sampledAt: null, error: null };
  previousProcessCpuTimes = new Map();

  // An idle server should not keep stale event streams attached.
  sseClients.forEach((_, client) => {
    try { client.end(); } catch (_) {}
  });
  sseClients.clear();
}

function createMonitoringLease(sessionId, profiles = ['dashboard']) {
  const ownLeases = Array.from(monitoringLeases.values()).filter(lease => lease.sessionId === sessionId).length;
  if (ownLeases >= MAX_LEASES_PER_SESSION || monitoringLeases.size >= MAX_MONITORING_LEASES) return null;
  const leaseId = crypto.randomBytes(18).toString('hex');
  monitoringLeases.set(leaseId, { sessionId, profiles: new Set(profiles), expiresAt: Date.now() + MONITORING_LEASE_TTL_MS });
  if (!monitoringActive) startMonitoring();
  else reconcileMonitoringSchedule();
  scheduleLeaseExpiry();
  return leaseId;
}

function touchMonitoringLease(leaseId, sessionId) {
  const lease = monitoringLeases.get(leaseId);
  if (!lease || lease.sessionId !== sessionId) return false;
  if (lease.expiresAt <= Date.now()) {
    removeMonitoringLease(leaseId);
    return false;
  }
  lease.expiresAt = Date.now() + MONITORING_LEASE_TTL_MS;
  scheduleLeaseExpiry();
  return true;
}

function ensureRequestLease(req, parsedUrl) {
  const providedId = req.headers['x-monitor-lease'] || parsedUrl.searchParams.get('lease');
  if (providedId) return touchMonitoringLease(String(providedId), req.authSession.id) ? String(providedId) : null;

  // Keep existing GET API clients compatible. A no-token client gets a
  // per-address lease which expires unless it keeps polling/streaming.
  const legacyId = `legacy:${req.authSession.id}`;
  if (!monitoringLeases.has(legacyId)) {
    if (monitoringLeases.size >= MAX_MONITORING_LEASES) return null;
    monitoringLeases.set(legacyId, { sessionId: req.authSession.id, profiles: new Set(['dashboard']), expiresAt: Date.now() + MONITORING_LEASE_TTL_MS });
    if (!monitoringActive) startMonitoring();
    else reconcileMonitoringSchedule();
    scheduleLeaseExpiry();
  } else {
    touchMonitoringLease(legacyId, req.authSession.id);
  }
  return legacyId;
}

function removeMonitoringLease(leaseId) {
  if (!monitoringLeases.delete(leaseId)) return false;
  sseClients.forEach((clientLeaseId, client) => {
    if (clientLeaseId === leaseId) {
      sseClients.delete(client);
      try { client.end(); } catch (_) {}
    }
  });
  if (!monitoringLeases.size) stopMonitoring();
  else reconcileMonitoringSchedule();
  scheduleLeaseExpiry();
  return true;
}

function expireMonitoringLeases() {
  leaseExpiryTimer = null;
  const now = Date.now();
  const expiredIds = [];
  monitoringLeases.forEach((lease, id) => { if (lease.expiresAt <= now) expiredIds.push(id); });
  expiredIds.forEach(removeMonitoringLease);
  scheduleLeaseExpiry();
}

function scheduleLeaseExpiry() {
  clearTimeout(leaseExpiryTimer);
  leaseExpiryTimer = null;
  if (!monitoringLeases.size) return;
  const nextExpiry = Math.min(...Array.from(monitoringLeases.values(), lease => lease.expiresAt));
  leaseExpiryTimer = setTimeout(expireMonitoringLeases, Math.max(1, nextExpiry - Date.now()));
  if (leaseExpiryTimer.unref) leaseExpiryTimer.unref();
}

function getMonitoringStatus() {
  return {
    active: monitoringActive,
    leaseCount: monitoringLeases.size,
    leaseTtlMs: MONITORING_LEASE_TTL_MS,
    profiles: AVAILABLE_MONITORING_PROFILES,
    leases: Array.from(monitoringLeases.values(), lease => ({ profiles: Array.from(lease.profiles), expiresInMs: Math.max(0, lease.expiresAt - Date.now()) })),
    effectiveIntervals: getEffectiveSamplingIntervals(),
    unavailableSamplers: [],
    timers: Object.fromEntries(Array.from(monitoringTimers, ([name, timer]) => [name, timer.interval])),
    activeCommands: Array.from(activeTelemetryJobs.keys()),
    terminatingCommands: Array.from(terminatingTelemetryJobs.keys()),
    lastCoreSampleAt: lastCpuSampleAt || null
  };
}

// Helper: parse cookies
function parseCookies(request) {
  const list = {};
  const rc = request.headers.cookie;
  if (!rc) return list;
  rc.split(';').forEach(cookie => {
    const separator = cookie.indexOf('=');
    if (separator < 1) return;
    const name = cookie.slice(0, separator).trim();
    try { list[name] = decodeURIComponent(cookie.slice(separator + 1).trim()); }
    catch (_) { /* Ignore malformed cookie values without aborting the request. */ }
  });
  return list;
}

function safeEqualPin(candidate) {
  if (typeof candidate !== 'string' || candidate.length > 128) return false;
  const expected = Buffer.from(config.pin, 'utf8');
  const supplied = Buffer.from(candidate, 'utf8');
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function issueSession(req, res, desktopAutomatic = false) {
  for (const session of Array.from(sessions.values())) if (session.expiresAt <= Date.now()) revokeSession(session, 'issueSession-expired');
  if (sessions.size >= MAX_SESSIONS) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Login is temporarily unavailable.' })); return; }
  const token = crypto.randomBytes(32).toString('base64url');
  sessions.set(token, { id: crypto.randomBytes(16).toString('hex'), expiresAt: Date.now() + SESSION_TTL_MS, desktopAutomatic });
  const secure = req.socket.encrypted ? '; Secure' : '';
  res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': [
    `auth_pin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
    `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
  ] });
  res.end(JSON.stringify({ success: true }));
}

async function nativeRemovalRequest(req){
  if(!isLocalDesktopRequest(req))return false;
  const supplied=req.headers['x-pc-monitor-desktop'];
  if(typeof supplied!=='string'||supplied.length!==44||!/^[A-Za-z0-9+/]{43}=$/.test(supplied))return false;
  const key=await desktopTrust();return Boolean(key&&crypto.timingSafeEqual(Buffer.from(key),Buffer.from(supplied)));
}
async function removalPolicy(req){
  const native=await nativeRemovalRequest(req);
  if(!getAuthenticatedSession(req)||!refreshAccessPin(true))throw Error('authentication-required');
  return {requirePhoneRemovalPin:config.requirePhoneRemovalPin===true,requirePin:!native&&config.requirePhoneRemovalPin===true,native};
}
function verifyRemovalPin(req,pin,reply){
  const rate=loginRateState(req);
  if(rate.state.lockedUntil>rate.now){reply(429,{success:false,code:'pin-locked',error:'Too many attempts. Try again shortly.'});return false;}
  if(!validPin(pin)){reply(401,{success:false,code:'pin-required',error:'Enter your current Rovarin PIN.'});return false;}
  if(!safeEqualPin(pin)){rate.state.failures++;if(rate.state.failures>=LOGIN_FAILURE_LIMIT)rate.state.lockedUntil=Date.now()+LOGIN_LOCK_MS;reply(rate.state.lockedUntil?429:401,{success:false,code:'invalid-pin',error:'PIN not accepted.'});return false;}
  loginAttempts.delete(rate.key);return true;
}
function getAuthenticatedSession(req) {
  if (!refreshAccessPin()) {
    if (req) req.authFailureReason = 'pin-config-unhealthy';
    return null;
  }
  const token = parseCookies(req)[AUTH_COOKIE];
  if (!token) {
    if (req) req.authFailureReason = 'no-session-cookie';
    return null;
  }
  if (token.length > 128) {
    if (req) req.authFailureReason = 'cookie-too-long';
    return null;
  }
  const session = sessions.get(token);
  if (!session) {
    if (req) req.authFailureReason = `session-not-found(activeSessions=${sessions.size})`;
    return null;
  }
  if (session.expiresAt <= Date.now()) {
    if (req) req.authFailureReason = 'session-expired';
    sessions.delete(token);
    for (const [id, lease] of monitoringLeases) if (lease.sessionId === session.id) removeMonitoringLease(id);
    return null;
  }
  if (req) req.authFailureReason = 'authenticated';
  return session;
}

function revokeSession(session, reason = 'unspecified') {
  if (!session) return;
  authLog('REVOKE_SESSION', { reason, sessionId: session.id, activeBefore: sessions.size });
  for (const [token, existing] of sessions) if (existing.id === session.id) sessions.delete(token);
  for (const [id, lease] of monitoringLeases) if (lease.sessionId === session.id) removeMonitoringLease(id);
}

function loginRateState(req) {
  const key = req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  let state = loginAttempts.get(key);
  if (!state || now - state.windowStart > 10 * 60 * 1000 || (state.lockedUntil && state.lockedUntil <= now)) {
    state = { failures: 0, windowStart: now, lockedUntil: 0 };
    loginAttempts.set(key, state);
  }
  if (loginAttempts.size > 256) {
    for (const [ip, entry] of loginAttempts) if (entry.lockedUntil <= now && now - entry.windowStart > 10 * 60 * 1000) loginAttempts.delete(ip);
    while (loginAttempts.size > 256) loginAttempts.delete(loginAttempts.keys().next().value);
  }
  return { key, state, now };
}

function readRequestBody(req, maxBytes, callback) {
  let body = '';
  let tooLarge = false;
  let completed = false;
  const finish = (error, value) => { if (!completed) { completed = true; callback(error, value); } };
  req.on('data', chunk => {
    if (tooLarge) return;
    body += chunk.toString('utf8');
    if (Buffer.byteLength(body, 'utf8') > maxBytes) {
      tooLarge = true;
      req.resume();
      finish(new Error('too_large'));
    }
  });
  req.on('end', () => { if (!tooLarge) finish(null, body); });
  req.on('error', () => { if (!tooLarge) finish(new Error('read_error')); });
}

function sameOriginRequest(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') {
    authLog('SAME_ORIGIN_REJECT', { reqId: req.reqId, reason: 'sec-fetch-site-cross-site', ip: req.socket.remoteAddress });
    return false;
  }
  const origin = req.headers.origin;
  if (!origin) return true;
  if (origin === 'null') {
    const referer = req.headers.referer;
    if (referer) {
      try {
        const parsedReferer = new URL(referer);
        const requestHost = String(req.headers.host || '').toLowerCase();
        const ok = (parsedReferer.protocol === 'http:' || parsedReferer.protocol === 'https:') && parsedReferer.host.toLowerCase() === requestHost;
        if (!ok) {
          authLog('SAME_ORIGIN_REJECT', { reqId: req.reqId, reason: 'referer-host-mismatch', referer, requestHost, ip: req.socket.remoteAddress });
        }
        return ok;
      } catch (err) {
        authLog('SAME_ORIGIN_REJECT', { reqId: req.reqId, reason: 'invalid-referer-url', referer, error: err.message, ip: req.socket.remoteAddress });
        return false;
      }
    }
    return true;
  }
  try {
    const parsedOrigin = new URL(origin);
    const requestHost = String(req.headers.host || '').toLowerCase();
    const ok = (parsedOrigin.protocol === 'http:' || parsedOrigin.protocol === 'https:') && parsedOrigin.host.toLowerCase() === requestHost;
    if (!ok) {
      authLog('SAME_ORIGIN_REJECT', { reqId: req.reqId, reason: 'host-mismatch', origin, requestHost, ip: req.socket.remoteAddress });
    }
    return ok;
  } catch (err) {
    authLog('SAME_ORIGIN_REJECT', { reqId: req.reqId, reason: 'invalid-origin-url', origin, error: err.message, ip: req.socket.remoteAddress });
    return false;
  }
}

// MIME types for static assets
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};
const PUBLIC_FILES = new Set(['index.html', 'login.html', 'app.css', 'maintenance.css', 'processes.css', 'desktop.css', 'app.js', 'maintenance.js', 'processes.js', 'login.js', 'diagnostics.js', 'diagnostics.css', 'enhanced-support.js', 'uninstall.js', 'apps.js', 'apps.css', 'app-leftovers.js']);

let dashboardAssetSignature = '';
let dashboardAssetRevision = '';
function getDashboardAssetRevision() {
  const files = Array.from(PUBLIC_FILES).sort();
  const publicDir = path.join(__dirname, 'public');
  const signature = files.map(file => {
    const stat = fs.lstatSync(path.join(publicDir, file));
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid dashboard asset');
    return `${file}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  }).join('|');
  if (signature !== dashboardAssetSignature) {
    const hash = crypto.createHash('sha256');
    for (const file of files) hash.update(file).update(fs.readFileSync(path.join(publicDir, file)));
    dashboardAssetRevision = hash.digest('hex');
    dashboardAssetSignature = signature;
  }
  return dashboardAssetRevision;
}

let nextReqId = 1;

// HTTP Server
const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
  const secureCookieFlag = req.socket.encrypted ? '; Secure' : '';
  res.setHeader('Set-Cookie', `auth_pin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieFlag}`);
  const clientIP = req.socket.remoteAddress;
  const reqId = nextReqId++;
  req.reqId = reqId;

  // Tailscale and local isolation check
  if (!isAllowedClient(clientIP)) {
    console.warn(`[Security] Rejected connection from unauthorized network: ${clientIP}`);
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied: Connections permitted only from Tailscale or Localhost.');
    return;
  }

  // Parse URL safely
  let parsedUrl;
  try { parsedUrl = new URL(req.url, 'http://localhost'); }
  catch (_) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad Request'); return; }
  const pathname = parsedUrl.pathname;

  const isLoginPost = req.method === 'POST' && pathname === '/api/login';
  const isDebugLogPost = req.method === 'POST' && pathname === '/api/debug/client-log';
  const isDesktopPost = req.method === 'POST' && ['/api/desktop/auth', '/api/desktop/security', '/api/desktop/updates', '/api/desktop/maintenance'].includes(pathname);
  const isLogoutPost = req.method === 'POST' && pathname === '/api/logout';
  const isMaintenancePost = req.method === 'POST' && pathname === '/api/maintenance/run';
  const isMonitoringLeasePost = req.method === 'POST' && pathname === '/api/monitoring/lease';
  const isTreePreviewPost = req.method === 'POST' && pathname === '/api/processes/tree';
  const isProcessTreePost = req.method === 'POST' && pathname === '/api/processes/kill-tree';
  const isAppsPost = req.method === 'POST' && ['/api/apps/removal-security', '/api/apps/uninstall', '/api/apps/quick-launch', '/api/apps/launch', '/api/apps/startup/toggle', '/api/apps/leftovers/scan', '/api/apps/leftovers/delete', '/api/apps/leftovers/cancel'].includes(pathname);
  const isProcessKillPost = req.method === 'POST' && ['/api/processes/kill','/api/processes/kill-tree','/api/processes/tree'].includes(pathname);
  const isTemperatureSettingsPost = req.method === 'POST' && pathname === '/api/temperature/settings';
  const isEnhancedInstallPost = req.method === 'POST' && pathname === '/api/temperature/enhanced/install';
  const isUninstallPost = req.method === 'POST' && pathname === '/api/system/uninstall';

  const shouldTraceReq = pathname === '/' || pathname.startsWith('/api/') || pathname === '/login.html' || pathname === '/login.js' || pathname === '/app.js' || pathname === '/apps.js' || pathname === '/processes.js';
  if (shouldTraceReq && !pathname.startsWith('/api/stream') && !isDebugLogPost) {
    authLog('HTTP_REQ_START', {
      reqId,
      method: req.method,
      path: pathname,
      ip: clientIP,
      host: req.headers.host || 'none',
      origin: req.headers.origin || 'none',
      secFetchSite: req.headers['sec-fetch-site'] || 'none',
      hasAuthCookie: Boolean(req.headers.cookie && req.headers.cookie.includes(AUTH_COOKIE)),
      activeSessions: sessions.size
    });
    res.on('finish', () => {
      authLog('HTTP_REQ_END', {
        reqId,
        method: req.method,
        path: pathname,
        ip: clientIP,
        status: res.statusCode,
        authReason: req.authFailureReason || 'n/a',
        activeSessions: sessions.size
      });
    });
  }

  if (isDebugLogPost) {
    readRequestBody(req, 8192, (err, body) => {
      if (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false })); return; }
      try {
        const data = JSON.parse(body);
        authLog('CLIENT_TELEMETRY', {
          clientEvent: data.event || 'unknown',
          url: data.url || '',
          page: data.page || '',
          visibility: data.visibility || '',
          reason: data.reason || '',
          detail: typeof data.detail === 'object' ? JSON.stringify(data.detail) : String(data.detail || '')
        });
      } catch (_) {}
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    });
    return;
  }

  if (req.method !== 'GET' && !isDesktopPost && !isLoginPost && !isLogoutPost && !isMaintenancePost && !isMonitoringLeasePost && !isProcessKillPost && !isTemperatureSettingsPost && !isEnhancedInstallPost && !isUninstallPost && !isAppsPost) {
    res.writeHead(405, { 'Content-Type': 'text/plain' });
    res.end('Method Not Allowed.');
    return;
  }

  if ((isDesktopPost || isLoginPost || isLogoutPost || isMaintenancePost || isMonitoringLeasePost || isProcessKillPost || isTemperatureSettingsPost || isEnhancedInstallPost || isUninstallPost || isAppsPost) && !sameOriginRequest(req)) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, error: 'Cross-origin request rejected.' }));
    return;
  }

  if (isDesktopPost) {
    const reply = (status, value) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (!isLocalDesktopRequest(req)) { reply(403, { success: false, error: 'Native desktop access required.' }); return; }
    const supplied = req.headers['x-pc-monitor-desktop'];
    if (typeof supplied !== 'string' || supplied.length !== 44 || !/^[A-Za-z0-9+/]{43}=$/.test(supplied)) { reply(401, { success: false, error: 'Native desktop access required.' }); return; }
    desktopTrust().then(key => {
      if (!key || !crypto.timingSafeEqual(Buffer.from(key), Buffer.from(supplied))) { reply(401, { success: false, error: 'Native desktop access required.' }); return; }
      readRequestBody(req, 512, (err, body) => {
        let data; try { data = JSON.parse(body); } catch (_) {}
        if (err || !data || typeof data !== 'object' || Array.isArray(data)) { reply(400, { success: false, error: 'Invalid request.' }); return; }
        if (!refreshAccessPin(true)) { reply(503, { success: false, error: 'Access configuration unavailable.' }); return; }
        if (pathname === '/api/desktop/auth') {
          if (Object.keys(data).length) { reply(400, { success: false, error: 'Invalid request.' }); return; }
          if (config.requireDesktopPin !== false || config.desktopLocked) { reply(401, { success: false, error: 'Enter your Rovarin PIN.' }); return; }
          if (getAuthenticatedSession(req)) { reply(200, { success: true }); return; }
          issueSession(req, res, true); return;
        }
        const session = getAuthenticatedSession(req);
        if (!session) { reply(401, { success: false, error: 'Authentication required.' }); return; }
        if (pathname === '/api/desktop/updates') {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || parsedUrl.search || Object.keys(data).length !== 1 || !['status','check','automatic','preference','download','prepare','cancel'].includes(data.action)) { reply(400, { success: false, code: 'invalid-request', error: 'Fixed update action required.' }); return; }
          if (data.action === 'status') { try { reply(200, { success: true, ...updateManager.status() }); } catch (_) { reply(503, { success: false, error: 'Update settings unavailable.' }); } return; }
          if (appManager.busy || appManager.blocked || appManager.leftovers.busy || treeInFlight || killInFlight.size || uninstallManager.busy || enhancedSupport.status().installing) { reply(409, { success: false, code: 'operation-running', error: 'Wait for the current operation to finish.' }); return; }
          if (data.action === 'prepare') {
            maintenance.getStatus(status => {
              if (!getAuthenticatedSession(req)) { reply(401, { success: false, error: 'Authentication required.' }); return; }
              try {
                if (status.isRunning || appManager.busy || appManager.blocked || appManager.leftovers.busy || treeInFlight || killInFlight.size || uninstallManager.busy || enhancedSupport.status().installing) throw new Error('operation-running');
                reply(200, { success: true, ...updateManager.reserve() });
              } catch (_) { reply(409, { success: false, error: 'Verified update handoff unavailable. Finish other operations first.' }); }
            }); return;
          }
          if (data.action === 'cancel') { try { reply(200, { success: true, ...updateManager.cancel() }); } catch (_) { reply(503, { success: false, error: 'Update settings unavailable.' }); } return; }
          if (data.action === 'preference') {
            if (updateManager.busy) { reply(409, { success: false, code: 'update-busy', error: 'An update operation is running.' }); return; }
            try { reply(200, { success: true, ...updateManager.preference() }); } catch (_) { reply(503, { success: false, error: 'Update preference could not be saved.' }); } return;
          }
          if (data.action === 'download') {
            if (!updateManager.installed() || updateManager.busy) { reply(409, { success: false, code: 'update-unavailable', error: 'Update installation requires an idle installed native copy.' }); return; }
            maintenance.getStatus(status => {
              if (!getAuthenticatedSession(req)) { reply(401, { success: false, error: 'Authentication required.' }); return; }
              if (status.isRunning || appManager.busy || appManager.blocked || appManager.leftovers.busy || treeInFlight || killInFlight.size || uninstallManager.busy || enhancedSupport.status().installing || updateManager.busy) { reply(409, { success: false, error: 'Wait for the current operation to finish.' }); return; }
              updateManager.download().catch(() => {}); reply(202, { success: true });
            }); return;
          }
          updateManager.check(data.action === 'automatic').then(status => reply(200, { success: true, ...status })).catch(() => reply(503, { success: false, error: 'Update check unavailable.' })); return;
        }
        if (pathname === '/api/desktop/maintenance') {
          if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '') || parsedUrl.search || Object.keys(data).length !== 1 || !['status', 'enable', 'disable'].includes(data.action)) {
            reply(400, { success: false, code: 'invalid-request', error: 'Fixed maintenance action required.' });
            return;
          }
          if (data.action === 'status') {
            localMaintenanceClient.status().then(status => reply(200, { success: true, ...status })).catch(() => reply(503, { success: false, error: 'Maintenance settings unavailable.' }));
            return;
          }
          if (appManager.busy || appManager.blocked || appManager.leftovers.busy || treeInFlight || killInFlight.size || uninstallManager.busy || enhancedSupport.status().installing || updateManager.busy) {
            reply(409, { success: false, code: 'operation-running', error: 'Wait for the current operation to finish.' });
            return;
          }
          if (data.action === 'enable') {
            localMaintenanceClient.provision().then(res => reply(200, { success: res.enabled, ...res })).catch(() => reply(503, { success: false, error: 'Could not enable administrator maintenance.' }));
            return;
          }
          if (data.action === 'disable') {
            localMaintenanceClient.revoke().then(res => reply(200, { success: !res.enabled, ...res })).catch(() => reply(503, { success: false, error: 'Could not disable administrator maintenance.' }));
            return;
          }
        }
        const fields = Object.keys(data);
        if (data.action === 'status' && fields.length === 1) { reply(200, { success: true, requireDesktopPin: config.requireDesktopPin !== false }); return; }
        try {
          if (data.action === 'lock' && fields.length === 1) {
            writeConfig(CONFIG_FILE, { ...readConfig(CONFIG_FILE), desktopLocked: true });
            refreshAccessPin(true); revokeSession(session, 'desktop-manual-lock');
            reply(200, { success: true }); return;
          }
          if (data.action === 'preference' && fields.length === 3 && fields.every(k => ['action', 'requireDesktopPin', 'confirmed'].includes(k)) && typeof data.requireDesktopPin === 'boolean' && data.confirmed === true) {
            writeConfig(CONFIG_FILE, { ...readConfig(CONFIG_FILE), requireDesktopPin: data.requireDesktopPin, desktopLocked: false });
            refreshAccessPin(true);
            if (data.requireDesktopPin) revokeSession(session, 'desktop-pin-required-changed');
            reply(200, { success: true, requireDesktopPin: data.requireDesktopPin }); return;
          }
          if (data.action === 'rotate' && fields.length === 2 && data.confirmed === true) {
            const saved = readConfig(CONFIG_FILE), pin = generatePin(saved.pin);
            writeConfig(CONFIG_FILE, { ...saved, pin, desktopLocked: true });
            refreshAccessPin(true);
            reply(200, { success: true, pin }); return;
          }
        } catch (_) { reply(503, { success: false, error: 'Security settings could not be saved.' }); return; }
        reply(400, { success: false, error: 'Invalid request.' });
      });
    }).catch(() => { if (!res.writableEnded) reply(503, { success: false, error: 'Native desktop trust unavailable.' }); });
    return;
  }

  if (isLoginPost) {
    const rate = loginRateState(req);
    authLog('LOGIN_POST_ATTEMPT', {
      ip: req.socket.remoteAddress,
      host: req.headers.host || 'none',
      origin: req.headers.origin || 'none',
      cookiePresent: Boolean(req.headers.cookie && req.headers.cookie.includes(AUTH_COOKIE)),
      activeSessions: sessions.size
    });
    if (rate.state.lockedUntil > rate.now) {
      authLog('LOGIN_RATE_LOCKED', { lockedUntil: rate.state.lockedUntil });
      res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((rate.state.lockedUntil - rate.now) / 1000)) });
      res.end(JSON.stringify({ success: false, error: 'Too many attempts. Try again shortly.' }));
      return;
    }
    readRequestBody(req, 1024, (err, body) => {
      if (err) {
        authLog('LOGIN_BODY_ERROR', { error: err.message });
        res.writeHead(err.message === 'too_large' ? 413 : 400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid request body.' }));
        return;
      }
      let data;
      try { data = JSON.parse(body); } catch (_) { data = null; }
      const validShape = data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 1 && typeof data.pin === 'string';
      // Recheck after reading the body: concurrent slow requests cannot step
      // past a lockout activated by another request, or use a replaced PIN.
      refreshAccessPin(true);
      if (rate.state.lockedUntil > Date.now()) {
        authLog('LOGIN_RATE_LOCKED_AFTER_BODY');
        res.writeHead(429, { 'Content-Type': 'application/json', 'Retry-After': String(Math.ceil((rate.state.lockedUntil - Date.now()) / 1000)) });
        res.end(JSON.stringify({ success: false, error: 'Too many attempts. Try again shortly.' })); return;
      }
      if (!pinConfigHealthy || !validShape || !validPin(data.pin) || !safeEqualPin(data.pin)) {
        rate.state.failures++;
        if (rate.state.failures >= LOGIN_FAILURE_LIMIT) rate.state.lockedUntil = Date.now() + LOGIN_LOCK_MS;
        authLog('LOGIN_REJECTED', {
          pinConfigHealthy,
          validShape,
          validPin: validPin(data && data.pin),
          failures: rate.state.failures,
          locked: Boolean(rate.state.lockedUntil)
        });
        res.writeHead(rate.state.lockedUntil ? 429 : 401, { 'Content-Type': 'application/json', ...(rate.state.lockedUntil ? { 'Retry-After': String(Math.ceil(LOGIN_LOCK_MS / 1000)) } : {}) });
        res.end(JSON.stringify({ success: false, error: rate.state.lockedUntil ? 'Too many attempts. Try again shortly.' : 'Invalid PIN.' }));
        return;
      }
      loginAttempts.delete(rate.key);
      if (config.desktopLocked) {
        try { writeConfig(CONFIG_FILE, { ...readConfig(CONFIG_FILE), desktopLocked: false }); refreshAccessPin(true); }
        catch (_) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Access configuration unavailable.' })); return; }
      }
      if (sessions.size >= MAX_SESSIONS) {
        for (const [token, session] of sessions) if (session.expiresAt <= Date.now()) revokeSession(session, 'login-cleanup-expired');
      }
      if (sessions.size >= MAX_SESSIONS) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Login is temporarily unavailable.' })); return; }
      const token = crypto.randomBytes(32).toString('base64url');
      const session = { id: crypto.randomBytes(16).toString('hex'), expiresAt: Date.now() + SESSION_TTL_MS };
      sessions.set(token, session);
      const secure = req.socket.encrypted ? '; Secure' : '';
      authLog('LOGIN_SUCCESS', {
        ip: req.socket.remoteAddress,
        sessionId: session.id,
        activeSessions: sessions.size,
        cookieAttrs: `Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
      });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Set-Cookie': [
        `auth_pin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`,
        `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure}`
      ] });
      res.end(JSON.stringify({ success: true }));
    });
    return;
  }

  const session = getAuthenticatedSession(req);
  req.authSession = session;
  if (isLogoutPost) {
    if (!session) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Authentication required.' })); return; }
    if (session.desktopAutomatic) {
      try { writeConfig(CONFIG_FILE, { ...readConfig(CONFIG_FILE), desktopLocked: true }); refreshAccessPin(true); }
      catch (_) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Could not lock Rovarin.' })); return; }
    }
    revokeSession(session, 'user-logout');
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': [
      `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieFlag}`,
      `auth_pin=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secureCookieFlag}`
    ] });
    res.end(JSON.stringify({ success: true }));
    return;
  }

  const isStaticAsset = ['/app.css', '/maintenance.css', '/processes.css', '/app.js', '/maintenance.js', '/processes.js', '/apps.js', '/apps.css', '/app-leftovers.js', '/login.js'].includes(pathname);

  // Reuse authenticated lease traffic to detect UI edits without another poller.
  if (session && pathname === '/api/monitoring/lease') {
    try { res.setHeader('X-PC-Monitor-UI-Revision', getDashboardAssetRevision()); }
    catch (_) { /* A partial source save must not interrupt monitoring. */ }
  }

  // If not authenticated and not a public asset, require PIN entry
  if (!session && !isStaticAsset) {
    if (pathname.startsWith('/api/')) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authentication required. Enter PIN.' }));
      return;
    }

    // Serve login page
    const loginHtmlPath = path.join(__dirname, 'public', 'login.html');
    if (fs.existsSync(loginHtmlPath)) {
      res.setHeader('Content-Type', 'text/html; charset=UTF-8');
      // Non-secret input mode prevents a legacy PIN prefix becoming an auth attempt.
      // No value/hash is rendered; unhealthy configuration leaves manual entry.
      const pinMode = refreshAccessPin(true) ? String(config.pin.length) : 'manual';
      res.setHeader('Cache-Control', 'no-store');
      let loginHtml = fs.readFileSync(loginHtmlPath, 'utf8').replace(
        '<meta name="rovarin-pin-mode" content="manual">',
        '<meta name="rovarin-pin-mode" content="' + pinMode + '">'
      );
      try {
        const revision = getDashboardAssetRevision();
        loginHtml = loginHtml.replace(/(href|src)="\/([a-z-]+\.(?:css|js))(?:\?[^" ]*)?"/g,
          (match, attribute, asset) => PUBLIC_FILES.has(asset) ? `${attribute}="/${asset}?v=${revision}"` : match);
      } catch (_) {}
      res.end(loginHtml);
      return;
    }
  }

  if (pathname === '/api/updates') {
    if (parsedUrl.search) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Unexpected parameters.' })); return; }
    try {
      const status = updateManager.status();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ currentVersion: status.currentVersion, latestVersion: status.latestVersion, state: status.state, message: status.message }));
    } catch (_) { res.writeHead(503, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Update settings unavailable.' })); } return;
  }
  if (pathname.startsWith('/api/apps')) {
    const reply=(status,data)=>{if(!res.destroyed&&!res.writableEnded){res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(data));}};
    if(pathname==='/api/apps/removal-security'&&!parsedUrl.search){
      if(req.method==='GET'){removalPolicy(req).then(value=>reply(200,value),()=>reply(503,{success:false,error:'Security policy unavailable.'}));return;}
      if(req.method==='POST'){
        if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){reply(415,{success:false,error:'JSON required.'});return;}
        readRequestBody(req,512,async(error,body)=>{
          let data;try{data=JSON.parse(body);}catch(_){}
          if(error||!data||Array.isArray(data)||!Object.keys(data).every(key=>['requirePhoneRemovalPin','pin'].includes(key))||typeof data.requirePhoneRemovalPin!=='boolean'||('pin' in data&&!validPin(data.pin))){reply(400,{success:false,error:'Invalid removal preference.'});return;}
          try{
            const policy=await removalPolicy(req);
            if(!policy.native&&policy.requirePhoneRemovalPin&&!data.requirePhoneRemovalPin&&!verifyRemovalPin(req,data.pin,reply))return;
            writeConfig(CONFIG_FILE,{...readConfig(CONFIG_FILE),requirePhoneRemovalPin:data.requirePhoneRemovalPin});
            config.requirePhoneRemovalPin=data.requirePhoneRemovalPin;
            reply(200,{...policy,requirePhoneRemovalPin:data.requirePhoneRemovalPin,requirePin:!policy.native&&data.requirePhoneRemovalPin});
          }catch(_){reply(503,{success:false,error:'Security preference could not be saved.'});}
        });return;
      }
    }
    if(pathname==='/api/apps/status'&&req.method==='GET'&&parsedUrl.search==='?check=1'){appManager.reconcile(()=>Boolean(getAuthenticatedSession(req))).then(data=>reply(200,data),()=>reply(503,{success:false,code:'verification-unavailable',error:'Windows removal verification is unavailable.'}));return;}
    if(pathname==='/api/apps/status'&&req.method==='GET'&&!parsedUrl.search){reply(200,appManager.status());return;}
    if(pathname==='/api/apps'&&req.method==='GET'&&(!parsedUrl.search||parsedUrl.search==='?refresh=1')){appManager.inventory(parsedUrl.search==='?refresh=1').then(data=>reply(200,data),()=>reply(503,{success:false,code:'inventory-unavailable',error:'Windows application inventory is unavailable.'}));return;}
    if(pathname==='/api/apps/icon'&&req.method==='GET'){
      const id=parsedUrl.searchParams.get('id');
      if(!id||typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)){reply(400,{success:false,code:'invalid-id',error:'Invalid application ID.'});return;}
      const icon=appManager.getIcon(id);
      if(!icon){res.writeHead(404,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Not Found');return;}
      res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'private, max-age=3600','Content-Length':icon.length});
      res.end(icon);return;
    }
    if(['/api/apps/leftovers/scan','/api/apps/leftovers/delete','/api/apps/leftovers/cancel'].includes(pathname)&&req.method==='POST'&&!parsedUrl.search){
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){reply(415,{success:false,code:'invalid-content-type',error:'JSON required.'});return;}
      readRequestBody(req,1024,async(err,body)=>{
        let data;try{data=JSON.parse(body);}catch(_){}
        const action=pathname.split('/').pop(),keys=action==='scan'?['receiptId']:action==='delete'?['scanId','confirmation']:['scanId'];
        if(err||!data||Array.isArray(data)||(Object.keys(data).length<keys.length||Object.keys(data).length>keys.length+(action==='delete'?1:0))||!keys.every(k=>k in data)||!Object.keys(data).every(k=>keys.includes(k)||(action==='delete'&&k==='pin'))||typeof data[action==='scan'?'receiptId':'scanId']!=='string'||!/^[a-f0-9]{32}$/.test(data[action==='scan'?'receiptId':'scanId'])||(action==='delete'&&(('pin' in data&&!validPin(data.pin))||data.confirmation!=='delete-leftovers'))){reply(400,{success:false,code:'invalid-request',error:'A valid cleanup preview is required.'});return;}
        const authorized=()=>Boolean(getAuthenticatedSession(req));
        if(!authorized()){reply(401,{success:false,code:'authentication-required',error:'Authentication required.'});return;}
        if(action==='delete'){
          let policy;try{policy=await removalPolicy(req);}catch(_){reply(503,{success:false,error:'Security policy unavailable.'});return;}
          if(policy.requirePin&&!verifyRemovalPin(req,data.pin,reply))return;
        }
        try{
          if(appManager.busy||appManager.blocked||appManager.leftovers.busy||uninstallManager.busy||updateManager.busy)throw Error('operation-running');
          if(action==='cancel'){reply(200,appManager.leftovers.cancel(data.scanId));return;}
          await appManager.inventory(true);
          const maintenanceState=action==='delete'?await new Promise(resolve=>maintenance.getStatus(resolve)):null;
          if(maintenanceState?.isRunning||enhancedSupport.status().installing||treeInFlight||killInFlight.size)throw Error('operation-running');
          if(!authorized())throw Error('authentication-required');
          if(appManager.busy||appManager.blocked||appManager.leftovers.busy||uninstallManager.busy||updateManager.busy)throw Error('operation-running');
          const rows=[...appManager.rows.values()];
          if(action==='scan')reply(200,{success:true,preview:await appManager.leftovers.scan(data.receiptId,rows,authorized)});
          else reply(202,appManager.leftovers.startDelete(data.scanId,rows,authorized));
        }catch(e){const code=e.message;reply(code==='authentication-required'?401:code==='not-found'?404:409,{success:false,code,error:code==='not-found'?'This preview expired. Scan again.':code==='application-present'?'The application is installed again. Cleanup was refused.':code==='operation-running'?'Wait for the current operation to finish.':'Cleanup could not be safely verified. Scan again later.'});}
      });return;
    }
    if(pathname==='/api/apps/quick-launch'&&req.method==='GET'&&!parsedUrl.search){
      (async()=>{
        if(!appManager.cache)try{await appManager.inventory();}catch(_){}
        reply(200,appManager.getQuickLaunch());
      })();
      return;
    }
    if(pathname==='/api/apps/quick-launch'&&req.method==='POST'&&!parsedUrl.search){
      if(!getAuthenticatedSession(req)){reply(401,{success:false,code:'authentication-required',error:'Authentication required.'});return;}
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){reply(415,{success:false,code:'invalid-content-type',error:'JSON required.'});return;}
      readRequestBody(req,2048,(err,body)=>{
        let data;try{data=JSON.parse(body);}catch(_){}
        if(err||!data||typeof data!=='object'||!['pin','unpin'].includes(data.action)){reply(400,{success:false,code:'invalid-request',error:'Invalid quick launch request.'});return;}
        try {
          if(data.action==='pin'){
            const result=appManager.pinApp(data.id);
            reply(200,result);
          }else{
            const result=appManager.unpinApp({id:data.id,locator:data.locator});
            reply(200,result);
          }
        }catch(e){
          const code=e.message||'operation-failed';
          const status=code==='not-found'?404:code==='limit-reached'||code==='already-pinned'||code==='unsupported'?409:400;
          reply(status,{success:false,code,error:e.message});
        }
      });
      return;
    }
    if(pathname==='/api/apps/launch'&&req.method==='POST'&&!parsedUrl.search){
      if(!getAuthenticatedSession(req)){reply(401,{success:false,code:'authentication-required',error:'Authentication required.'});return;}
      if(appManager.busy||appManager.blocked||appManager.leftovers.busy||uninstallManager.busy||updateManager.busy){reply(409,{success:false,code:'operation-running',error:'Wait for the current operation to finish.'});return;}
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){reply(415,{success:false,code:'invalid-content-type',error:'JSON required.'});return;}
      readRequestBody(req,1024,async(err,body)=>{
        let data;try{data=JSON.parse(body);}catch(_){}
        if(err||!data||typeof data.id!=='string'||!/^[a-f0-9]{64}$/.test(data.id)){reply(400,{success:false,code:'invalid-request',error:'Application ID required.'});return;}
        try {
          const result=await appManager.launch(data.id);
          reply(200,result);
        }catch(e){
          const code=e.code||e.message||'launch-failed';
          const status=code==='not-found'?404:code==='cancelled'?409:code==='access-denied'?403:code==='unsupported'?409:500;
          reply(status,{success:false,code,error:e.message});
        }
      });
      return;
    }
    if(pathname==='/api/apps/startup'&&req.method==='GET'&&(!parsedUrl.search||parsedUrl.search==='?refresh=1')){
      appManager.startupInventory(parsedUrl.search==='?refresh=1').then(data=>reply(200,data),()=>reply(503,{success:false,code:'startup-unavailable',error:'Windows startup inventory is unavailable.'}));
      return;
    }
    if(pathname==='/api/apps/startup/icon'&&req.method==='GET'){
      const id=parsedUrl.searchParams.get('id');
      if(!id||typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id)){reply(400,{success:false,code:'invalid-id',error:'Invalid item ID.'});return;}
      const icon=appManager.getStartupIcon(id);
      if(!icon){res.writeHead(404,{'Content-Type':'text/plain','Cache-Control':'no-store'});res.end('Not Found');return;}
      res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'private, max-age=3600','Content-Length':icon.length});
      res.end(icon);return;
    }
    if(pathname==='/api/apps/startup/toggle'&&req.method==='POST'&&!parsedUrl.search){
      if(!getAuthenticatedSession(req)){reply(401,{success:false,code:'authentication-required',error:'Authentication required.'});return;}
      if(appManager.busy||appManager.blocked||appManager.leftovers.busy||uninstallManager.busy||updateManager.busy){reply(409,{success:false,code:'operation-running',error:'Wait for the current operation to finish.'});return;}
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){reply(415,{success:false,code:'invalid-content-type',error:'JSON required.'});return;}
      readRequestBody(req,1024,async(err,body)=>{
        let data;try{data=JSON.parse(body);}catch(_){}
        if(err||!data||Array.isArray(data)||Object.keys(data).length!==4||!Object.keys(data).every(k=>['id','enabled','pin','confirmation'].includes(k))||typeof data.id!=='string'||!/^[a-f0-9]{64}$/.test(data.id)||(typeof data.enabled!=='boolean'&&data.enabled!=='restore')||!validPin(data.pin)||data.confirmation!=='change-startup'){reply(400,{success:false,code:'invalid-request',error:'Reviewed startup action and current PIN required.'});return;}
        if(!getAuthenticatedSession(req)){reply(401,{success:false,code:'authentication-required',error:'Authentication required.'});return;}
        const rate=loginRateState(req);if(rate.state.lockedUntil>rate.now){reply(429,{success:false,code:'pin-locked',error:'Too many attempts. Try again shortly.'});return;}
        if(!safeEqualPin(data.pin)){rate.state.failures++;if(rate.state.failures>=LOGIN_FAILURE_LIMIT)rate.state.lockedUntil=Date.now()+LOGIN_LOCK_MS;reply(rate.state.lockedUntil?429:401,{success:false,code:'invalid-pin',error:'PIN not accepted.'});return;}
        loginAttempts.delete(rate.key);
        try {
          const result=await appManager.toggleStartup(data.id,data.enabled);
          reply(200,result);
        }catch(e){
          const code=e.code||e.message||'operation-failed';
          const status=code==='not-found'?404:code==='elevation-required'?403:409;
          reply(status,{success:false,code,error:e.message});
        }
      });
      return;
    }
    if(pathname==='/api/apps/uninstall'&&req.method==='POST'&&!parsedUrl.search){
      if(appManager.busy||appManager.blocked||appManager.leftovers.busy||uninstallManager.busy||updateManager.busy||treeInFlight||killInFlight.size){reply(409,{success:false,code:'operation-running',error:'Wait for the active system operation. If an uninstaller is still running, complete it on the PC before restarting Rovarin.'});return;}
      if(!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type']||'')){reply(415,{success:false,code:'invalid-content-type',error:'JSON required.'});return;}
      readRequestBody(req,4096,async(error,body)=>{
        let data;try{data=JSON.parse(body);}catch(_){}
        if(error||!data||Array.isArray(data)||(Object.keys(data).length!==3&&Object.keys(data).length!==4)||!Object.keys(data).every(k=>['ids','batch','pin','confirmation'].includes(k))||('pin' in data&&!validPin(data.pin))||data.confirmation!=='uninstall-apps'||typeof data.batch!=='boolean'||!Array.isArray(data.ids)||!data.ids.length||data.ids.length>20||new Set(data.ids).size!==data.ids.length||data.ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||(!data.batch&&data.ids.length!==1)){reply(400,{success:false,code:'invalid-request',error:'A reviewed app selection and current PIN are required.'});return;}
        if(!getAuthenticatedSession(req)){reply(401,{success:false,code:'authentication-required',error:'Authentication required.'});return;}
        let policy;try{policy=await removalPolicy(req);}catch(_){reply(503,{success:false,error:'Security policy unavailable.'});return;}
        if(policy.requirePin&&!verifyRemovalPin(req,data.pin,reply))return;

        maintenance.getStatus(async status=>{
          if(status.isRunning||enhancedSupport.status().installing||updateManager.busy||uninstallManager.busy){reply(409,{success:false,code:'operation-running',error:'Wait for the current system operation.'});return;}
          try{const result=await appManager.start(data.ids,data.batch,()=>Boolean(getAuthenticatedSession(req)));reply(202,result);}catch(e){reply(e.message==='authentication-required'?401:409,{success:false,code:e.message,error:'Uninstall was not accepted. Refresh the list and review the selected apps again.'});}
        });
      });return;
    }
    reply(400,{success:false,code:'invalid-request',error:'Unexpected operation or parameters.'});
    return;
  }
  if((appManager.busy||appManager.blocked||appManager.leftovers.busy)&&req.method==='POST'&&(isMaintenancePost||isProcessKillPost||isUninstallPost||isEnhancedInstallPost)){res.writeHead(409,{'Content-Type':'application/json'});res.end(JSON.stringify({success:false,code:'operation-running',error:'An application removal or cleanup is active or unconfirmed.'}));return;}
  // ── Maintenance API Endpoints ──────────────────────────────────────────────

  if ((uninstallManager.busy || (updateManager.busy && ['downloading','verifying','handoff'].includes(updateManager.state) && (isMaintenancePost || isEnhancedInstallPost || isProcessKillPost || isTemperatureSettingsPost))) && req.method === 'POST' && !isUninstallPost) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: false, code: updateManager.busy ? 'update-in-progress' : 'uninstall-in-progress', error: 'An installation operation is being prepared. Other system actions are temporarily blocked.' })); return;
  }
  if (pathname === '/api/system/uninstall') {
    const reply = (status, data) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } };
    if (parsedUrl.search) { reply(400, { success: false, code: 'invalid-request', error: 'Unexpected parameters.' }); return; }
    if (!isUninstallPost) { reply(200, uninstallManager.status()); return; }
    if (uninstallManager.busy || updateManager.busy) { reply(409, { success: false, code: 'uninstall-in-progress', error: 'Uninstall is already being prepared.' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { reply(415, { success: false, code: 'invalid-content-type', error: 'JSON required.' }); return; }
    readRequestBody(req, 512, (error, body) => {
      let data; try { data = JSON.parse(body); } catch (_) {}
      if (error || !data || Array.isArray(data) || Object.keys(data).length !== 3 ||
          !Object.keys(data).every(key => ['pin', 'confirmation', 'removeData'].includes(key)) ||
          !validPin(data.pin) || data.confirmation !== 'uninstall-pc-monitor' || typeof data.removeData !== 'boolean') {
        reply(error?.message === 'too_large' ? 413 : 400, { success: false, code: 'invalid-request', error: 'Current PIN, explicit confirmation and data policy required.' }); return;
      }
      if (!getAuthenticatedSession(req)) { reply(401, { success: false, code: 'authentication-required', error: 'Authentication required.' }); return; }
      const rate = loginRateState(req);
      if (rate.state.lockedUntil > rate.now) { res.setHeader('Retry-After', String(Math.ceil((rate.state.lockedUntil - rate.now) / 1000))); reply(429, { success: false, code: 'pin-locked', error: 'Too many attempts. Try again shortly.' }); return; }
      if (!safeEqualPin(data.pin)) {
        rate.state.failures++;
        if (rate.state.failures >= LOGIN_FAILURE_LIMIT) rate.state.lockedUntil = Date.now() + LOGIN_LOCK_MS;
        reply(rate.state.lockedUntil ? 429 : 401, { success: false, code: 'invalid-pin', error: 'PIN not accepted. Try again later if locked.' }); return;
      }
      loginAttempts.delete(rate.key);
      if (!uninstallManager.status().available) { reply(409, { success: false, code: 'installed-only', error: 'Uninstall is only available in an installed Windows copy. The development project cannot be removed.' }); return; }
      // Reserve before the asynchronous status check; do not interrupt maintenance.
      if (uninstallManager.busy) { reply(409, { success: false, code: 'uninstall-in-progress', error: 'Uninstall is already being prepared.' }); return; }
      uninstallManager.busy = true;
      maintenance.getStatus(async status => {
        if (status.isRunning || enhancedSupport.status().installing) { uninstallManager.busy = false; reply(409, { success: false, code: 'operation-running', error: 'Wait for the current operation to finish before uninstalling.' }); return; }
        let handoff;
        try {
          // prepare owns the same single-flight reservation synchronously.
          uninstallManager.busy = false;
          handoff = await uninstallManager.prepare(data.removeData);
          if (!getAuthenticatedSession(req) || res.destroyed) { await handoff.abort(); reply(401, { success: false, code: 'authentication-required', error: 'Authentication required.' }); return; }
          let sent = false;
          res.once('close', () => { if (!sent) handoff.abort().catch(() => {}); });
          res.once('finish', async () => {
            sent = true;
            if (!getAuthenticatedSession(req)) { await handoff.abort().catch(() => {}); return; }
            try { await handoff.commit(); }
            catch (_) { console.error('[Uninstall] Handoff commit unconfirmed. Server retained; use Windows Installed apps.'); return; }
            // Reuse existing cancellation/lease cleanup, then exit. The helper
            // waits on this exact process; it never terminates another process.
            sessions.clear(); monitoringLeases.clear(); stopMonitoring(); cleanupPid();
            server.close(); server.closeAllConnections();
            const exitTimer = setTimeout(() => process.exit(0), 2000);
            const finishExit = () => {
              if (terminatingTelemetryJobs.size === 0) { clearTimeout(exitTimer); process.exit(0); }
              else setTimeout(finishExit, 25);
            };
            finishExit();
          });
          reply(202, { success: true, code: 'uninstall-accepted', message: 'Uninstall accepted. Rovarin will become unreachable. Check Windows Apps if removal does not complete.' });
        } catch (_) { await handoff?.abort().catch(() => {}); uninstallManager.busy = false; reply(503, { success: false, code: 'handoff-unavailable', error: 'Could not safely start uninstall. Rovarin is still running; use Windows Installed apps.' }); }
      });
    });
    return;
  }

  if (pathname === '/api/temperature/enhanced' || isEnhancedInstallPost) {
    const reply = (status, data) => { if (!res.destroyed && !res.writableEnded) { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); } };
    if (parsedUrl.search) { reply(400, { success: false, code: 'invalid-request', error: 'Unexpected parameters.' }); return; }
    const local = isLocalDesktopRequest(req);
    if (!isEnhancedInstallPost) { enhancedSupport.detectDriver().then(()=>{ if(!getAuthenticatedSession(req)){reply(401,{success:false,code:'authentication-required'});return;} reply(200, { ...enhancedSupport.status(cpuTemperatureProvider.settings().observations.enhanced), localDesktop: local }); }); return; }
    if (!local) { reply(403, { success: false, code: 'local-only', error: 'Install Enhanced support from the Rovarin desktop dashboard.' }); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { reply(415, { success: false, code: 'invalid-content-type', error: 'JSON required.' }); return; }
    readRequestBody(req, 128, (error, body) => {
      let data; try { data = JSON.parse(body); } catch (_) {}
      if (error || !data || Array.isArray(data) || Object.keys(data).length) { reply(400, { success: false, code: 'invalid-request', error: 'Send an empty JSON object.' }); return; }
      if (!getAuthenticatedSession(req)) { reply(401, { success: false, code: 'authentication-required', error: 'Authentication required.' }); return; }
      enhancedSupport.install().then(result => {
        diagnostics.invalidate();
        if (result.success && !result.rebootRequired) {
          // Recheck using the existing sampler only, preserving the chosen mode.
          cpuTemperatureProvider.retryAt = 0;
          if (monitoringActive && cpuTemperatureProvider.mode === 'enhanced') sampleCpuTemperature();
        }
        if (!getAuthenticatedSession(req)) { reply(401, { success: false, code: 'authentication-required', error: 'Authentication required.' }); return; }
        reply(result.success ? 200 : result.code === 'install-in-progress' ? 409 : 503, result);
      }).catch(() => reply(503, { success: false, code: 'install-failed', error: 'Enhanced installation failed.' }));
    });
    return;
  }

  if (pathname === '/api/temperature/settings') {
    const reply = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(data)); };
    if (parsedUrl.search) { reply(400, { success: false, code: 'invalid-request', error: 'Unexpected parameters.' }); return; }
    if (!isTemperatureSettingsPost) { reply(200, cpuTemperatureProvider.settings()); return; }
    if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) { reply(415, { success: false, code: 'invalid-content-type', error: 'JSON required.' }); return; }
    readRequestBody(req, 1024, (error, body) => {
      let data; try { data = JSON.parse(body); } catch (_) {}
      if (error || !data || Array.isArray(data) || Object.keys(data).length !== 1 || !cpuTemperatureProvider.settings().modes.includes(data.mode)) {
        reply(error?.message === 'too_large' ? 413 : 400, { success: false, code: 'invalid-request', error: 'Choose enhanced, thermal-zone, or off.' }); return;
      }
      if (!getAuthenticatedSession(req)) { reply(401, { success: false, code: 'authentication-required', error: 'Authentication required.' }); return; }
      try { cpuTemperatureProvider.setMode(data.mode); }
      catch (_) { reply(503, { success: false, code: 'settings-unavailable', error: 'Could not save temperature settings.' }); return; }
      const job = activeTelemetryJobs.get('cpu-temperature');
      if (job?.child) {
        activeTelemetryJobs.delete('cpu-temperature'); terminatingTelemetryJobs.set('cpu-temperature', job);
        try { job.child.kill(); } catch (_) {}
      }
      temperatureManager.clearReading('cpu');
      temperatureManager.setUnavailable('cpu', cpuTemperatureProvider.snapshot().source, cpuTemperatureProvider.snapshot().note);
      diagnostics.invalidate();
      reconcileMonitoringSchedule();
      if (monitoringActive) sampleCpuTemperature();
      publishMetricsSnapshot();
      reply(200, { success: true, code: 'temperature-mode-saved', settings: cpuTemperatureProvider.settings() });
    });
    return;
  }

  // Read-only, authenticated compatibility report. No lease or sampler changes.
  if (pathname === '/api/diagnostics') {
    if (parsedUrl.search && parsedUrl.search !== '?refresh=1') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Unexpected diagnostics parameters.' }));
      return;
    }
    diagnostics.get(parsedUrl.search === '?refresh=1').then(data => {
      if (res.destroyed || res.writableEnded) return;
      if (!getAuthenticatedSession(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Authentication required.' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8' });
      res.end(JSON.stringify(data));
    }).catch(() => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Diagnostics could not be completed. Try again.' }));
    });
    return;
  }

  // Read-only scheduler diagnostics; this route deliberately does not acquire a lease.
  if (req.method === 'GET' && pathname === '/api/monitoring/status') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-cache, no-store' });
    res.end(JSON.stringify(getMonitoringStatus()));
    return;
  }

  // POST /api/monitoring/lease — acquire, renew, or release a short-lived dashboard lease.
  if (isMonitoringLeasePost) {
    let body = '';
    let tooLarge = false;
    req.on('data', chunk => {
      if (tooLarge) return;
      body += chunk.toString();
      if (body.length > 4096 && !tooLarge) {
        tooLarge = true;
        body = '';
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Request body too large.' }));
      }
    });
    req.on('end', () => {
      if (tooLarge) return;
      if (!getAuthenticatedSession(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, code: 'authentication-required', error: 'Authentication required.' })); return; }
      let data;
      try { data = body ? JSON.parse(body) : {}; }
      catch (_) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid JSON body.' }));
        return;
      }

      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.action !== 'string') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid request body.' }));
        return;
      }

      if (data.action === 'acquire') {
        if (Object.keys(data).some(key => key !== 'action')) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Unexpected request fields.' })); return; }
        const leaseId = createMonitoringLease(req.authSession.id);
        if (!leaseId) { res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ success: false, error: 'Monitoring lease limit reached.' })); return; }
        res.writeHead(201, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: true, leaseId, expiresInMs: MONITORING_LEASE_TTL_MS }));
        return;
      }

      if (data.action === 'set-profile') {
        if (Object.keys(data).some(key => !['action', 'leaseId', 'profile'].includes(key))) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Unexpected request fields.' })); return; }
        if (typeof data.leaseId !== 'string' || !data.leaseId) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'A leaseId is required.' }));
          return;
        }
        if (!AVAILABLE_MONITORING_PROFILES.includes(data.profile)) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, error: 'Unknown monitoring profile.', profiles: AVAILABLE_MONITORING_PROFILES }));
          return;
        }
        if (!touchMonitoringLease(data.leaseId, req.authSession.id)) {
          res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ success: false, expired: true, error: 'Monitoring lease expired.' }));
          return;
        }
        const lease = monitoringLeases.get(data.leaseId);
        lease.profiles = data.profile === 'dashboard'
          ? new Set(['dashboard'])
          : new Set(['dashboard', data.profile]);
        if (data.profile === 'storage-detail') lastDriveScanAt = 0;
        reconcileMonitoringSchedule();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({
          success: true,
          profile: data.profile,
          effectiveIntervals: getEffectiveSamplingIntervals(),
          timers: Object.fromEntries(Array.from(monitoringTimers, ([name, timer]) => [name, timer.interval]))
        }));
        return;
      }

      if (typeof data.leaseId !== 'string' || !data.leaseId) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'A leaseId is required.' }));
        return;
      }

      if (Object.keys(data).some(key => !['action', 'leaseId'].includes(key))) { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Unexpected request fields.' })); return; }

      if (data.action === 'heartbeat') {
        if (!touchMonitoringLease(data.leaseId, req.authSession.id)) {
          res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ success: false, expired: true, error: 'Monitoring lease expired.' }));
          return;
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: true, expiresInMs: MONITORING_LEASE_TTL_MS }));
        return;
      }

      if (data.action === 'release') {
        const lease = monitoringLeases.get(data.leaseId);
        if (!lease || lease.sessionId !== req.authSession.id) { res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ success: false, expired: true, error: 'Monitoring lease expired.' })); return; }
        removeMonitoringLease(data.leaseId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: true }));
        return;
      }

      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: 'Unknown lease action.' }));
    });
    return;
  }

  // GET /api/maintenance/status — current task state + admin flag + history
  if (req.method === 'GET' && pathname === '/api/maintenance/status') {
    maintenance.getStatus((status) => {
      if (!getAuthenticatedSession(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Authentication required.' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ ...status, isLocal: isLocalDesktopRequest(req) }));
    });
    return;
  }

  // GET /api/maintenance/history — recent maintenance results
  if (req.method === 'GET' && pathname === '/api/maintenance/history') {
    maintenance.getStatus((status) => {
      if (!getAuthenticatedSession(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Authentication required.' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ history: status.history || [] }));
    });
    return;
  }

  // POST /api/maintenance/run — start an allowlisted maintenance action
  if (req.method === 'POST' && pathname === '/api/maintenance/run') {
    readRequestBody(req, 4096, (bodyError, body) => {
      if (!getAuthenticatedSession(req)) { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Authentication required.' })); return; }
      if (bodyError) { res.writeHead(bodyError.message === 'too_large' ? 413 : 400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Invalid request body.' })); return; }
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) { parsed = null; }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => !['action', 'confirmed', 'pin'].includes(key)) || typeof parsed.action !== 'string' || (Object.hasOwn(parsed, 'confirmed') && parsed.confirmed !== true) || (Object.hasOwn(parsed, 'pin') && (typeof parsed.pin !== 'string' || !validPin(parsed.pin)))) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Invalid request body.' })); return;
      }
      const actionId = parsed.action;
      if (!Object.prototype.hasOwnProperty.call(maintenance.ACTIONS, actionId)) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Unknown maintenance action.' })); return;
      }

      if (maintenance.ACTIONS[actionId].requiresAdmin && parsed.confirmed !== true) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ success: false, error: 'Confirm this maintenance action before requesting administrator approval.' })); return;
      }

      const isLocal = isLocalDesktopRequest(req);
      if (maintenance.ACTIONS[actionId].requiresAdmin) {
        if (!isLocal && typeof parsed.pin !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ success: false, code: 'pin-required', error: 'Enter your Rovarin PIN to authorize administrator maintenance.' }));
          return;
        }
        if (typeof parsed.pin === 'string') {
          const rate = loginRateState(req);
          if (rate.state.lockedUntil > rate.now) {
            res.setHeader('Retry-After', String(Math.ceil((rate.state.lockedUntil - rate.now) / 1000)));
            res.writeHead(429, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, code: 'pin-locked', error: 'Too many attempts. Try again shortly.' }));
            return;
          }
          if (!safeEqualPin(parsed.pin)) {
            rate.state.failures++;
            if (rate.state.failures >= LOGIN_FAILURE_LIMIT) rate.state.lockedUntil = Date.now() + LOGIN_LOCK_MS;
            res.writeHead(rate.state.lockedUntil ? 429 : 401, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: false, code: 'invalid-pin', error: 'PIN not accepted.' }));
            return;
          }
          loginAttempts.delete(rate.key);
        }
      }

      const result = maintenance.runAction(actionId, () => {}, () => {}, { isLocal });
      if (!result.success) {
        res.writeHead(409, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
    });
    return;
  }

  // ── End Maintenance API ────────────────────────────────────────────────────

  // Endpoint: Current metrics JSON
  if (pathname === '/api/metrics') {
    if (!ensureRequestLease(req, parsedUrl)) {
      res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Monitoring lease expired.' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'application/json; charset=UTF-8',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    res.end(JSON.stringify({
      metrics: latestMetrics,
      history
    }));
    return;
  }

  // POST /api/processes/kill — terminate one observed process. Requires the same
  // session + processes-profile lease as GET /api/processes, an application/json
  // body of exactly { pid, name, startedAt }, and identity verification against
  // the current server-side snapshot before any process is signalled.
  if (isProcessKillPost) {
    const killLeaseId = String(req.headers['x-monitor-lease'] || parsedUrl.searchParams.get('lease') || '');
    const killLease = killLeaseId ? monitoringLeases.get(killLeaseId) : null;
    if (killLease && killLease.expiresAt <= Date.now()) removeMonitoringLease(killLeaseId);
    if (!killLease || killLease.sessionId !== req.authSession.id || killLease.expiresAt <= Date.now() || !killLease.profiles.has('processes')) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: false, code: 'profile-required', error: 'The processes monitoring profile is required.' }));
      return;
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      res.writeHead(415, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: false, code: 'invalid-content-type', error: 'Content-Type must be application/json.' }));
      return;
    }
    readRequestBody(req, MAX_KILL_BODY_BYTES, (bodyError, body) => {
      const failKill = (status, code, message) => {
        res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: false, code, error: message }));
      };
      if (bodyError) return failKill(bodyError.message === 'too_large' ? 413 : 400, 'invalid-request', 'Invalid request body.');
      let parsed;
      try { parsed = JSON.parse(body); } catch (_) { parsed = null; }
      const validShape = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.keys(parsed).length === (isProcessTreePost ? 4 : 3)
        && Object.keys(parsed).every(key => ['pid','name','startedAt', ...(isProcessTreePost ? ['confirmed'] : [])].includes(key))
        && (!isProcessTreePost || parsed.confirmed === true)
        && Number.isSafeInteger(parsed.pid) && parsed.pid >= 1 && parsed.pid <= MAX_PROCESS_PID
        && typeof parsed.name === 'string' && parsed.name.length >= 1 && parsed.name.length <= 128
        && typeof parsed.startedAt === 'string' && PROCESS_IDENTITY_PATTERN.test(parsed.startedAt);
      if (!validShape) {
        return failKill(400, 'invalid-request', 'A valid PID, process name, and observed start time are required.');
      }
      const { pid, name, startedAt } = parsed;

      // Self-protection: the active server, its parent (dev watcher/launcher),
      // and system PIDs are never terminable through this endpoint.
      if (PROTECTED_PROCESS_PIDS.has(pid) || pid < 5) {
        return failKill(403, 'protected-process', 'The Rovarin server process cannot be terminated.');
      }
      if (CRITICAL_PROCESS_NAMES.has(name.toLowerCase())) {
        return failKill(403, 'protected-process', 'This Windows system process is protected.');
      }
      if (treeInFlight) return failKill(409, 'kill-busy', 'A process-tree operation is active.');
      if ((isProcessTreePost || isTreePreviewPost) && killInFlight.size) return failKill(409, 'kill-busy', 'Wait for the active termination.');
      if (killInFlight.has(pid)) {
        const pending = pendingTerminations.get(pid);
        if (pending && pending.startedAt === startedAt && pending.name === name) {
          pending.promise.then(result => {
            if (res.destroyed || res.writableEnded) return;
            res.writeHead(result.success ? 200 : 409, { 'Content-Type': 'application/json; charset=UTF-8' });
            res.end(JSON.stringify(result.success ? { ...result, code: 'already-terminated' } : result));
          });
          return;
        }
        return failKill(409, 'kill-in-progress', 'A termination request for this process is already being processed.');
      }
      if (wasRecentlyKilled(pid, startedAt, name)) {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ success: true, code: 'already-terminated', pid, name }));
        return;
      }
      if (isProcessSnapshotStale(processSnapshot.sampledAt, Date.now(), PROCESS_SNAPSHOT_STALE_MS)) {
        return failKill(409, 'stale-process', processSnapshot.sampledAt
          ? 'The process list is stale; refresh and try again.'
          : 'No process sample is available yet.');
      }

      // Existence probe first (signal 0 never terminates): distinguishes
      // already-exited from stale identity before any identity comparison.
      try {
        process.kill(pid, 0);
      } catch (probeError) {
        if (probeError.code === 'ESRCH') {
          removeProcessFromSnapshot(pid);
          return failKill(410, 'already-exited', 'The process has already exited.');
        }
        if (probeError.code === 'EPERM') return failKill(403, 'access-denied', 'Windows denied access to this process.');
        return failKill(500, 'server-error', 'The process could not be verified.');
      }

      // Identity check: pid + name + observed start time must all still match the
      // snapshot the user selected from. Any mismatch (PID reuse, missing or
      // inaccessible start time) refuses the operation instead of risking the
      // wrong process.
      const observed = processSnapshot.processes.find(item => item.pid === pid);
      if (!observed || !observed.startedAt || observed.startedAt !== startedAt || observed.name !== name) {
        return failKill(409, 'stale-process', 'The process changed since it was observed; refresh the list.');
      }

      if (!getAuthenticatedSession(req)) return failKill(401, 'authentication-required', 'Authentication required.');
      if (killInFlight.size >= MAX_CONCURRENT_KILLS) return failKill(429, 'kill-busy', 'Two termination requests are already active. Try again shortly.');
      // The fixed native helper verifies creation time and terminates through
      // the SAME held Windows handle. Cached identity alone never authorizes it.
      if(isTreePreviewPost){
        treeInFlight=true;
        processTree({pid,name,startedAt},'preview',Array.from(PROTECTED_PROCESS_PIDS)).then(result=>{treeInFlight=false;if(res.destroyed||res.writableEnded)return;res.writeHead(result.success?200:409,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify(result));});return;
      }
      if(isProcessTreePost){
        treeInFlight=true;
        console.log('[System management] Process-tree termination requested.');
        processTree({pid,name,startedAt},'terminate',Array.from(PROTECTED_PROCESS_PIDS)).then(result=>{
          treeInFlight=false;for(const item of result.results||[])if(item.code==='terminated')removeProcessFromSnapshot(item.pid);
          sampleProcesses();
          if(res.destroyed||res.writableEnded)return;res.writeHead(result.success?200:409,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end(JSON.stringify({...result,target:{pid,name,startedAt},error:result.success?undefined:'Some targets could not be safely terminated. Review the detailed results.'}));
        });return;
      }
      console.log('[System management] Single-process termination requested.');
      killInFlight.add(pid);
      let resolvePending;
      const promise = new Promise(resolve => { resolvePending = resolve; });
      pendingTerminations.set(pid, { startedAt, name, promise });
      const complete = outcome => {
        const success = outcome.success;
        if (success) { rememberKilledProcess(pid, startedAt, name); removeProcessFromSnapshot(pid, startedAt, name); }
        if (outcome.code === 'already-exited' || outcome.code === 'stale-process') removeProcessFromSnapshot(pid, startedAt, name);
        const result = success ? { success: true, code: 'terminated', pid, name, verified: true } : {
          success: false, code: outcome.code, error: ({
            'already-exited': 'The process has already exited.',
            'stale-process': 'The process identity changed; no termination was performed.',
            'access-denied': 'Windows denied access to this process.',
            'termination-unconfirmed': 'Process termination could not be confirmed. No further signal was sent.'
          })[outcome.code] || 'The process could not be terminated.'
        };
        killInFlight.delete(pid);
        pendingTerminations.delete(pid);
        resolvePending(result);
        if (res.destroyed || res.writableEnded) return;
        res.writeHead(success ? 200 : outcome.code === 'access-denied' ? 403 : outcome.code === 'already-exited' ? 410 : 409, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      };
      terminateProcess({ pid, name, startedAt }, undefined, Array.from(PROTECTED_PROCESS_PIDS)).then(outcome=>{complete(outcome);sampleProcesses();});
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/processes') {
    const leaseId = String(req.headers['x-monitor-lease'] || parsedUrl.searchParams.get('lease') || '');
    const lease = leaseId ? monitoringLeases.get(leaseId) : null;
    if (lease && lease.expiresAt <= Date.now()) removeMonitoringLease(leaseId);
    if (!lease || lease.sessionId !== req.authSession.id || lease.expiresAt <= Date.now() || !lease.profiles.has('processes')) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'The processes monitoring profile is required.' }));
      return;
    }
    const stale = isProcessSnapshotStale(processSnapshot.sampledAt, Date.now(), PROCESS_SNAPSHOT_STALE_MS);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-cache, no-store, must-revalidate' });
    res.end(JSON.stringify({ ...processSnapshot, stale }));
    return;
  }

  // Endpoint: Real-time Server-Sent Events (SSE)
  if (pathname === '/api/stream') {
    const leaseId = ensureRequestLease(req, parsedUrl);
    if (!leaseId) {
      res.writeHead(410, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'Monitoring lease expired.' }));
      return;
    }
    const streamLease = monitoringLeases.get(leaseId);
    const sessionStreams = Array.from(sseClients.values()).filter(id => monitoringLeases.get(id)?.sessionId === req.authSession.id).length;
    if (!streamLease || sseClients.size >= MAX_SSE_CLIENTS || sessionStreams >= MAX_SSE_PER_SESSION) {
      res.writeHead(429, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ success: false, error: 'Live stream connection limit reached.' }));
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    });
    authLog('SSE_CONNECT', { reqId, ip: clientIP, leaseId, activeStreams: sseClients.size + 1 });
    res.write(`data: ${JSON.stringify(latestMetrics)}\n\n`);
    sseClients.set(res, leaseId);

    if (streamLease.profiles.has('processes')) {
      const stale = isProcessSnapshotStale(processSnapshot.sampledAt, Date.now(), PROCESS_SNAPSHOT_STALE_MS);
      res.write(`event: processes\ndata: ${JSON.stringify({ ...processSnapshot, stale })}\n\n`);
    }

    res.on('close', () => {
      sseClients.delete(res);
      authLog('SSE_CLOSE', { ip: clientIP, leaseId, remainingStreams: sseClients.size });
    });
    return;
  }

  // Serve static files from public/
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch (_) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad Request'); return; }
  const publicDir = path.resolve(__dirname, 'public');
  const relativePath = decodedPath === '/' || decodedPath === '\\' ? 'index.html' : decodedPath.replace(/^[/\\]+/, '');
  const filePath = path.resolve(publicDir, relativePath);
  const ext = path.extname(filePath).toLowerCase();
  const relativeCheck = path.relative(publicDir, filePath);

  if (relativeCheck === '..' || relativeCheck.startsWith(`..${path.sep}`) || path.isAbsolute(relativeCheck)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }
  if (!PUBLIC_FILES.has(relativeCheck.split(path.sep).join('/'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('404 Not Found');
    return;
  }

  fs.lstat(filePath, (err, stats) => {
    if (err || !stats.isFile() || stats.isSymbolicLink()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('404 Not Found');
      return;
    }

    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    if (relativeCheck === 'index.html') {
      try {
        const revision = getDashboardAssetRevision();
        const html = fs.readFileSync(filePath, 'utf8')
          .replace('</head>', `<meta name="pc-monitor-ui-revision" content="${revision}">\n</head>`)
          .replace(/(href|src)="\/([a-z-]+\.(?:css|js))(?:\?[^" ]*)?"/g,
            (match, attribute, asset) => PUBLIC_FILES.has(asset) ? `${attribute}="/${asset}?v=${revision}"` : match);
        res.setHeader('X-PC-Monitor-UI-Revision', revision);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(html);
      } catch (_) {
        res.writeHead(503, { 'Content-Type': 'text/plain; charset=UTF-8' });
        res.end('Dashboard update in progress. Please reload shortly.');
      }
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// Event-driven local credential change notification, not a polling loop.
// Request/broadcast checks also enforce revocation if a filesystem event is lost.
const pinWatcher = fs.watch(path.dirname(CONFIG_FILE), (event, filename) => {
  if (!filename || String(filename) === 'config.json') refreshAccessPin(true);
});
pinWatcher.on('error', () => { pinConfigHealthy = false; for (const session of Array.from(sessions.values())) revokeSession(session, 'pinWatcher-error'); });
pinWatcher.unref();
process.on('exit', () => pinWatcher.close());

// Start listening
bindServer(server, PORT, bindingState, () => {
  try { serverInstance.write(bindingState); } catch (_) { console.error('[Startup] Could not record the active server port.'); server.close(() => process.exit(1)); return; }
  const boundPort = server.address().port;
  const tailscaleIp = getTailscaleIP() || '100.x.x.x (Tailscale not connected)';
  console.log(`\n======================================================`);
  console.log(`🚀 Rovarin Dashboard is running!`);
  console.log(`🔒 Tailscale access: http://${tailscaleIp}:${boundPort} (PIN required)`);
  console.log(`💻 Localhost access: http://127.0.0.1:${boundPort}`);
  console.log(`======================================================\n`);
}, error => {
  try { serverInstance.write({ ...bindingState, status: 'failed', errorCode: error.code || 'BIND_FAILED' }); } catch (_) {}
  console.error(`[Startup] Binding failed (${error.code || 'BIND_FAILED'}). Preferred port ${PORT}; attempted ports: ${(bindingState.attempts || []).join(', ')}.`);
  process.exit(1);
});

server.headersTimeout = 10_000;
server.requestTimeout = 15_000;
server.keepAliveTimeout = 5_000;
server.maxHeadersCount = 100;
