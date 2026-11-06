'use strict';
// Rovarin Linux prototype server — EXPERIMENTAL, not a release.
// Reuses the canonical public/ frontend unchanged and serves the same core API
// shapes the frontend expects. Windows-only capabilities return HTTP 501 with
// {"error":"unsupported_on_linux"} and NEVER spawn powershell.exe or any
// Windows command: this file contains no Windows code path at all.
//
// Security boundary (same as Windows): loopback/Tailscale-only clients, PIN
// login (POST body only, scrypt, per-IP lockout), HttpOnly in-memory sessions,
// same-origin checks on state-changing routes, no telemetry without a live
// monitoring lease. Config lives at ~/.config/rovarin-linux/config.json
// (scrypt-linux-v1, 0600). The server NEVER creates credentials at startup;
// first-run setup is POST /api/setup from loopback only, while no config
// file exists.
//
// Usage: node server-linux.js            (tries ports 7331-7335)
//        PORT=7331 node server-linux.js  (single port; PORT=0 = ephemeral, tests)
//        ROVARIN_LINUX_CONFIG_DIR=/path  (override config dir, tests only)
// Zero npm dependencies: Node stdlib + /proc + stock Linux tools only.
const http = require('http');
const os = require('os');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const platform = require('./platform');
const auth = require('./linux-auth');
const { createLinuxMetrics } = require('./linux-metrics');
const { createLinuxProcesses } = require('./linux-processes');

if (!platform.isLinux) {
  console.error('Rovarin Linux prototype requires Linux (process.platform=' + process.platform + '). Refusing to start.');
  process.exit(1);
}

const ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const VERSION = '0.6.0-linux-prototype';
const LEASE_TTL_MS = 45000;
const MAX_SESSIONS_LEASES = 24;
const MAX_LEASES_PER_SESSION = 4;
const MAX_SSE_CLIENTS = 16;
const MAX_SSE_PER_SESSION = 4;
const PROCESS_IDENTITY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,7})?(?:Z|[+-]\d{2}:\d{2})$/;

// ---- Static asset allowlist: only files that actually exist in public/ ----
const MIME_TYPES = {
  '.html': 'text/html; charset=UTF-8', '.css': 'text/css; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8', '.json': 'application/json; charset=UTF-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=UTF-8'
};
// Reviewed canonical frontend assets only; never auto-publish arbitrary files.
const PUBLIC_FILES = new Set(['rovarin-icon.png', 'rovarin-touch.png', 'liquid-bootstrap.js', 'liquid-glass.css', 'liquid-glass.js', 'liquid-shaders.js', 'three-glass.module.js', 'power.js', 'power.css', 'index.html', 'login.html', 'app.css', 'maintenance.css', 'processes.css', 'desktop.css', 'app.js', 'maintenance.js', 'processes.js', 'pin-lifecycle.js', 'pin-lifecycle.css', 'login.js', 'diagnostics.js', 'diagnostics.css', 'enhanced-support.js', 'uninstall.js', 'apps.js', 'apps.css', 'app-leftovers.js']);
const STATIC_ASSET_PATHS = new Set([...PUBLIC_FILES].filter(f => f === 'rovarin-icon.png' || f === 'rovarin-touch.png' || f.endsWith('.css') || f.endsWith('.js')).map(f => '/' + f));

// ---- Monitoring leases / samplers (Windows MONITORING_PROFILES, verbatim) ----
const MONITORING_PROFILES = {
  dashboard: { cpuMs: 4000, ramMs: 4000, gpuMs: 4000, networkMs: 4000, drivesMs: 60000, latencyMs: 20000, temperatureMs: 20000, historyMs: 4000 },
  'cpu-detail': { cpuMs: 1000 },
  'gpu-detail': { gpuMs: 2000 },
  'network-detail': { networkMs: 1000, latencyMs: 2000 },
  'storage-detail': { drivesMs: 15000 },
  processes: { processesMs: 5000 }
};
const AVAILABLE_PROFILES = Object.keys(MONITORING_PROFILES);

const metrics = createLinuxMetrics({ onUpdate: broadcastMetrics });
const procManager = createLinuxProcesses();

const monitoringLeases = new Map();
const monitoringTimers = new Map();
const sseClients = new Map();
let leaseSweeper = null;

function hasActiveLease() { return monitoringLeases.size > 0; }

function effectiveIntervals() {
  const out = {};
  for (const lease of monitoringLeases.values()) {
    if (lease.expiresAt <= Date.now()) continue;
    for (const profile of lease.profiles) {
      const def = MONITORING_PROFILES[profile] || {};
      for (const [key, ms] of Object.entries(def)) {
        if (!out[key] || ms < out[key]) out[key] = ms;
      }
    }
  }
  return out;
}

const SAMPLERS = {
  cpu: { key: 'cpuMs', run: () => metrics.sampleCpu() },
  ram: { key: 'ramMs', run: () => metrics.sampleRam() },
  gpu: { key: 'gpuMs', run: () => metrics.sampleGpu() },
  network: { key: 'networkMs', run: () => metrics.sampleNetwork() },
  drives: { key: 'drivesMs', run: () => metrics.sampleDrives(false) },
  latency: { key: 'latencyMs', run: () => metrics.sampleLatency() },
  temperature: { key: 'temperatureMs', run: () => metrics.sampleTemperature() },
  history: { key: 'historyMs', run: () => metrics.sampleHistory() },
  processes: { key: 'processesMs', run: () => { procManager.sample(); broadcastProcesses(); } }
};

function reconcileSchedule() {
  const eff = effectiveIntervals();
  for (const [name, sampler] of Object.entries(SAMPLERS)) {
    const interval = eff[sampler.key] || null;
    const existing = monitoringTimers.get(name);
    if (!interval) {
      if (existing) { clearInterval(existing.timer); monitoringTimers.delete(name); }
      continue;
    }
    if (existing && existing.interval === interval) continue;
    if (existing) clearInterval(existing.timer);
    const timer = setInterval(() => {
      if (!hasActiveLease() || !effectiveIntervals()[sampler.key]) return;
      try { sampler.run(); } catch (_) {}
    }, interval);
    timer.unref();
    monitoringTimers.set(name, { timer, interval });
    // Sample immediately on (re)activation so the dashboard is not stale.
    try { sampler.run(); } catch (_) {}
  }
  if (!hasActiveLease()) {
    for (const [name, t] of monitoringTimers) { clearInterval(t.timer); monitoringTimers.delete(name); }
  }
}

function removeLease(leaseId) {
  monitoringLeases.delete(leaseId);
  for (const [res, id] of sseClients) if (id === leaseId) { try { res.end(); } catch (_) {} sseClients.delete(res); }
  reconcileSchedule();
}

function touchLease(leaseId, sessionId) {
  const lease = monitoringLeases.get(leaseId);
  if (!lease || lease.sessionId !== sessionId || lease.expiresAt <= Date.now()) return false;
  lease.expiresAt = Date.now() + LEASE_TTL_MS;
  return true;
}

function createLease(sessionId) {
  const mine = [...monitoringLeases.values()].filter(l => l.sessionId === sessionId).length;
  if (monitoringLeases.size >= MAX_SESSIONS_LEASES || mine >= MAX_LEASES_PER_SESSION) return null;
  const leaseId = crypto.randomBytes(16).toString('hex');
  monitoringLeases.set(leaseId, { sessionId, profiles: new Set(['dashboard']), expiresAt: Date.now() + LEASE_TTL_MS });
  reconcileSchedule();
  return leaseId;
}

function ensureRequestLease(req, parsedUrl) {
  const leaseId = String(req.headers['x-monitor-lease'] || parsedUrl.searchParams.get('lease') || '');
  if (!leaseId) return null;
  const lease = monitoringLeases.get(leaseId);
  if (!lease) return null;
  if (lease.expiresAt <= Date.now()) { removeLease(leaseId); return null; }
  if (!req.authSession || lease.sessionId !== req.authSession.id) return null;
  return leaseId;
}

// ---- SSE broadcast ----
function broadcastMetrics(data) {
  if (sseClients.size === 0) return;
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of [...sseClients.keys()]) {
    try { if (!res.write(payload)) res.destroy(); } catch (_) { res.destroy(); sseClients.delete(res); }
  }
}
function broadcastProcesses() {
  const snap = procManager.getSnapshot();
  const stale = procManager.isStale();
  const payload = `event: processes\ndata: ${JSON.stringify({ ...snap, stale })}\n\n`;
  for (const [res, leaseId] of [...sseClients]) {
    const lease = monitoringLeases.get(leaseId);
    if (!lease || !lease.profiles.has('processes')) continue;
    try { if (!res.write(payload)) res.destroy(); } catch (_) { res.destroy(); sseClients.delete(res); }
  }
}

// ---- Helpers ----
function json(res, status, value, extraHeaders) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store', ...(extraHeaders || {}) });
  res.end(JSON.stringify(value));
}
function readBody(req, maxBytes, cb) {
  let chunks = [], bytes = 0, done = false;
  function finish(err) {
    if (done) return;
    done = true;
    const body = err ? '' : Buffer.concat(chunks).toString('utf8');
    chunks = [];
    Promise.resolve().then(() => {
      // A slow body must not keep authorization captured before logout/rotation.
      if (req.authSession && auth.getSession(req)?.id !== req.authSession.id) {
        json(req.res, 401, { error: 'Authentication required.' }); return;
      }
      return cb(err, body);
    }).catch(() => {
      // Request event callbacks run outside the synchronous request guard.
      if (!req.res.headersSent) json(req.res, 500, { error: 'server-error' });
      else req.res.destroy();
    });
  }
  req.on('data', chunk => {
    if (done) return;
    bytes += chunk.length;
    if (bytes > maxBytes) { finish(new Error('too_large')); return; }
    chunks.push(chunk);
  });
  req.on('end', () => finish(null));
  req.on('aborted', () => finish(new Error('read-error')));
  req.on('error', () => finish(new Error('read-error')));
}
function sameOriginRequest(req) {
  const origin = req.headers.origin;
  const referer = req.headers.referer;
  const host = String(req.headers.host || '').toLowerCase();
  const check = value => {
    try {
      const u = new URL(value);
      return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.toLowerCase() === host;
    } catch (_) { return false; }
  };
  if (origin) return check(origin);
  if (referer) return check(referer);
  return true; // no Origin/Referer (e.g. curl from the local machine): allowed
}
function unsupported(res) {
  json(res, 501, { error: 'unsupported_on_linux', message: 'This capability is Windows-only and is not available in the Linux prototype.' });
}

// ---- HTTP server ----
// The whole handler is wrapped so a bug in one route returns 500 instead of
// crashing the server process (an uncaught throw in a request handler kills
// Node; the diagnostics route once did exactly that — fixed, and guarded).
const server = http.createServer((req, res) => {
  try {
    handleRequest(req, res);
  } catch (err) {
    console.error('Rovarin Linux: uncaught request error:', err && err.stack || err);
    if (!res.destroyed && !res.writableEnded) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=UTF-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ error: 'server-error' }));
    }
  }
});

function handleRequest(req, res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'; form-action 'self'");
  res.setHeader('Cache-Control', 'no-store');
  const clientIP = req.socket.remoteAddress;

  if (!platform.isAllowedClient(clientIP)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Access Denied: Connections permitted only from Tailscale or Localhost.');
    return;
  }
  let parsedUrl;
  try { parsedUrl = new URL(req.url, 'http://localhost'); }
  catch (_) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad Request'); return; }
  const pathname = parsedUrl.pathname;

  const POST_ROUTES = new Set([
    '/api/setup', '/api/login', '/api/logout', '/api/monitoring/lease',
    '/api/processes/kill', '/api/processes/tree', '/api/processes/kill-tree',
    '/api/temperature/settings', '/api/temperature/enhanced/install',
    '/api/power/run', '/api/maintenance/run', '/api/apps/uninstall',
    '/api/apps/quick-launch', '/api/apps/launch', '/api/apps/startup/toggle',
    '/api/apps/leftovers/scan', '/api/apps/leftovers/delete', '/api/apps/leftovers/cancel',
    '/api/apps/removal-security', '/api/system/uninstall'
  ]);
  if (req.method === 'POST' && !POST_ROUTES.has(pathname) && !pathname.startsWith('/api/desktop/')) {
    res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('Method Not Allowed.'); return;
  }
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'text/plain' }); res.end('Method Not Allowed.'); return;
  }
  if (req.method === 'POST' && !sameOriginRequest(req)) {
    json(res, 403, { success: false, error: 'Cross-origin request rejected.' }); return;
  }

  // ---- First-run setup: loopback-only, only while no config file exists ----
  if (pathname === '/api/setup') {
    if (req.method === 'GET') {
      const cfg = auth.loadConfig();
      json(res, 200, { setupRequired: !cfg.exists, configured: cfg.exists && cfg.healthy });
      return;
    }
    if (!platform.isLoopback(clientIP)) { json(res, 403, { success: false, error: 'PIN setup is only available from this machine.' }); return; }
    // Loopback peer alone is insufficient against DNS rebinding during setup.
    let setupHost;
    try { setupHost = new URL('http://' + req.headers.host).hostname; } catch (_) {}
    if (!['localhost', '127.0.0.1', '[::1]'].includes(setupHost)) {
      json(res, 403, { error: 'Use a loopback host for local setup.' }); return;
    }
    readBody(req, 1024, (err, body) => {
      if (err) { json(res, err.message === 'too_large' ? 413 : 400, { success: false, error: 'Invalid request body.' }); return; }
      let data; try { data = JSON.parse(body); } catch (_) { data = null; }
      if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).sort().join(',') !== 'confirmPin,pin') {
        json(res, 400, { success: false, error: 'Send exactly { pin, confirmPin }.' }); return;
      }
      try {
        const result = auth.setupPin(data.pin, data.confirmPin);
        json(res, 201, { success: true, length: result.length });
      } catch (e) {
        json(res, e.code === 'setup-complete' ? 409 : 400, { success: false, code: e.code || 'invalid-pin', error: e.message });
      }
    });
    return;
  }

  // ---- Login ----
  if (req.method === 'POST' && pathname === '/api/login') {
    const rate = auth.loginRateState(clientIP);
    if (rate.state.lockedUntil > rate.now) {
      json(res, 429, { success: false, error: 'Too many attempts. Try again shortly.' }, { 'Retry-After': String(Math.ceil((rate.state.lockedUntil - rate.now) / 1000)) });
      return;
    }
    readBody(req, 1024, (err, body) => {
      if (err) { json(res, err.message === 'too_large' ? 413 : 400, { success: false, error: 'Invalid request body.' }); return; }
      let data; try { data = JSON.parse(body); } catch (_) { data = null; }
      const currentRate = auth.loginRateState(clientIP);
      if (currentRate.state.lockedUntil > currentRate.now) {
        json(res, 429, { success: false, error: 'Too many attempts. Try again shortly.' }); return;
      }
      const cfg = auth.loadConfig();
      if (!cfg.healthy) {
        // Fail closed: missing/corrupt credentials never auto-regenerate.
        json(res, 503, { success: false, code: cfg.exists ? 'credential-unavailable' : 'setup-required', error: cfg.exists ? 'Saved access configuration is temporarily unavailable.' : 'Create a PIN first (POST /api/setup from this machine).' });
        return;
      }
      const validShape = data && typeof data === 'object' && !Array.isArray(data) && Object.keys(data).length === 1 && typeof data.pin === 'string';
      if (!validShape || !auth.verifyPin(data.pin, cfg.credential)) {
        const state = auth.recordLoginFailure(clientIP);
        const locked = state.lockedUntil > Date.now();
        json(res, locked ? 429 : 401, { success: false, error: locked ? 'Too many attempts. Try again shortly.' : 'Invalid PIN.' }, locked ? { 'Retry-After': '60' } : {});
        return;
      }
      auth.clearLoginFailures(clientIP);
      const issued = auth.issueSession();
      if (!issued) { json(res, 503, { success: false, error: 'Login is temporarily unavailable.' }); return; }
      json(res, 200, { success: true }, { 'Set-Cookie': auth.sessionCookie(issued.token, auth.SESSION_TTL_MS / 1000) });
    });
    return;
  }

  const session = auth.getSession(req);
  req.authSession = session;

  if (req.method === 'POST' && pathname === '/api/logout') {
    if (!session) { json(res, 401, { success: false, error: 'Authentication required.' }); return; }
    auth.revokeSession(session.token);
    for (const [leaseId, lease] of [...monitoringLeases]) if (lease.sessionId === session.id) removeLease(leaseId);
    json(res, 200, { success: true }, { 'Set-Cookie': auth.clearSessionCookie() });
    return;
  }

  // ---- Unauthenticated: APIs 401, static assets served, everything else -> login page ----
  if (!session) {
    if (pathname.startsWith('/api/')) { json(res, 401, { error: 'Authentication required. Enter PIN.' }); return; }
    if (STATIC_ASSET_PATHS.has(pathname)) { serveStatic(req, res, pathname.slice(1)); return; }
    serveLoginPage(res);
    return;
  }

  // ---- Authenticated routes ----

  // Windows-only surface: 501, never executed. (Checked before any other
  // handling so a Windows-only path can never fall through to a Linux action.)
  if (pathname.startsWith('/api/apps')
    || pathname.startsWith('/api/maintenance')
    || pathname.startsWith('/api/desktop')
    || pathname === '/api/updates'
    || pathname === '/api/system/uninstall'
    || pathname.startsWith('/api/power')
    || pathname === '/api/temperature/enhanced'
    || pathname === '/api/temperature/enhanced/install') {
    unsupported(res);
    return;
  }

  if (req.method === 'GET' && pathname === '/api/monitoring/status') {
    json(res, 200, {
      platform: 'linux', version: VERSION, activeLeases: monitoringLeases.size,
      activeStreams: sseClients.size,
      timers: Object.fromEntries([...monitoringTimers].map(([n, t]) => [n, t.interval])),
      effectiveIntervals: effectiveIntervals(),
      networkCollectionStatus: metrics.getNetworkStatus()
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/monitoring/lease') {
    readBody(req, 4096, (err, body) => {
      if (err) { json(res, err.message === 'too_large' ? 413 : 400, { success: false, error: 'Invalid request body.' }); return; }
      let data; try { data = body ? JSON.parse(body) : {}; } catch (_) { json(res, 400, { success: false, error: 'Invalid JSON body.' }); return; }
      if (!data || typeof data !== 'object' || Array.isArray(data) || typeof data.action !== 'string') {
        json(res, 400, { success: false, error: 'Invalid request body.' }); return;
      }
      if (data.action === 'acquire') {
        if (Object.keys(data).some(k => k !== 'action')) { json(res, 400, { success: false, error: 'Unexpected request fields.' }); return; }
        const leaseId = createLease(session.id);
        if (!leaseId) { json(res, 429, { success: false, error: 'Monitoring lease limit reached.' }); return; }
        json(res, 201, { success: true, leaseId, expiresInMs: LEASE_TTL_MS });
        return;
      }
      if (data.action === 'set-profile') {
        if (Object.keys(data).some(k => !['action', 'leaseId', 'profile'].includes(k))) { json(res, 400, { success: false, error: 'Unexpected request fields.' }); return; }
        if (typeof data.leaseId !== 'string' || !data.leaseId) { json(res, 400, { success: false, error: 'A leaseId is required.' }); return; }
        if (!AVAILABLE_PROFILES.includes(data.profile)) { json(res, 400, { success: false, error: 'Unknown monitoring profile.', profiles: AVAILABLE_PROFILES }); return; }
        if (!touchLease(data.leaseId, session.id)) { json(res, 410, { success: false, expired: true, error: 'Monitoring lease expired.' }); return; }
        const lease = monitoringLeases.get(data.leaseId);
        lease.profiles = data.profile === 'dashboard' ? new Set(['dashboard']) : new Set(['dashboard', data.profile]);
        if (data.profile === 'storage-detail') metrics.forceDriveScan();
        reconcileSchedule();
        json(res, 200, { success: true, profile: data.profile, effectiveIntervals: effectiveIntervals(), timers: Object.fromEntries([...monitoringTimers].map(([n, t]) => [n, t.interval])) });
        return;
      }
      if (typeof data.leaseId !== 'string' || !data.leaseId) { json(res, 400, { success: false, error: 'A leaseId is required.' }); return; }
      if (Object.keys(data).some(k => !['action', 'leaseId'].includes(k))) { json(res, 400, { success: false, error: 'Unexpected request fields.' }); return; }
      if (data.action === 'heartbeat') {
        if (!touchLease(data.leaseId, session.id)) { json(res, 410, { success: false, expired: true, error: 'Monitoring lease expired.' }); return; }
        json(res, 200, { success: true, expiresInMs: LEASE_TTL_MS });
        return;
      }
      if (data.action === 'release') {
        const lease = monitoringLeases.get(data.leaseId);
        if (!lease || lease.sessionId !== session.id) { json(res, 410, { success: false, expired: true, error: 'Monitoring lease expired.' }); return; }
        removeLease(data.leaseId);
        json(res, 200, { success: true });
        return;
      }
      json(res, 400, { success: false, error: 'Unknown lease action.' });
    });
    return;
  }

  if (pathname === '/api/metrics') {
    if (!ensureRequestLease(req, parsedUrl)) { json(res, 410, { error: 'Monitoring lease expired.' }); return; }
    const snap = metrics.getLatest();
    if (!snap) { json(res, 503, { error: 'Metrics not ready yet.' }); return; }
    json(res, 200, snap);
    return;
  }

  if (pathname === '/api/temperature') {
    if (req.method !== 'GET') { json(res, 405, { success: false, error: 'Use GET for temperature readings.' }); return; }
    json(res, 200, metrics.getTemperature());
    return;
  }

  if (pathname === '/api/temperature/settings') {
    if (req.method === 'GET') { json(res, 200, metrics.temperatureSettings()); return; }
    readBody(req, 1024, (err, body) => {
      if (err) { json(res, err.message === 'too_large' ? 413 : 400, { success: false, code: 'invalid-request', error: 'Invalid request body.' }); return; }
      let data; try { data = JSON.parse(body); } catch (_) { data = null; }
      if (!data || Array.isArray(data) || Object.keys(data).length !== 1 || typeof data.mode !== 'string') {
        json(res, 400, { success: false, code: 'invalid-request', error: 'Choose thermal-zone or off.' }); return;
      }
      if (data.mode === 'enhanced') { unsupported(res); return; } // LibreHardwareMonitor/PawnIO is Windows-only
      try { metrics.setTemperatureMode(data.mode); }
      catch (_) { json(res, 400, { success: false, code: 'invalid-request', error: 'Choose thermal-zone or off.' }); return; }
      json(res, 200, { success: true, code: 'temperature-mode-saved', settings: metrics.temperatureSettings() });
    });
    return;
  }

  if (pathname === '/api/diagnostics') {
    if (parsedUrl.search && parsedUrl.search !== '?refresh=1') { json(res, 400, { error: 'Unexpected diagnostics parameters.' }); return; }
    const temp = metrics.getTemperature();
    const procCount = procManager.getSnapshot().processes.length;
    const gpu = metrics.getGpuData();
    const drives = (metrics.getLatest() && metrics.getLatest().metrics.drives) || [];
    const tailscaleIP = platform.getTailscaleIP();
    const cpuCount = os.cpus().length;
    const totalGB = Math.round(os.totalmem() / 1024 ** 3 * 10) / 10;
    // Same check shape as the Windows collector (id/label/status/summary/value/required)
    // so the shared frontend's diagnostics renderer can display this report.
    const check = (id, label, status, summary, value, required) =>
      ({ id, label, status, summary, ...(value === undefined || value === null ? {} : { value }), required: !!required });
    const checks = [
      check('os', 'Operating system', 'supported', 'Linux distribution detected.', platform.distroPrettyName(), true),
      check('os-architecture', 'OS architecture', 'supported', 'Native machine architecture; Node runtime architecture: ' + os.arch() + '.', os.arch()),
      check('node-runtime', 'Node.js runtime', 'supported', 'Current server runtime.', process.version, true),
      check('server-version', 'Rovarin version', 'supported', 'Linux prototype version.', VERSION, true),
      check('server-port', 'Server port', 'supported', 'Preferred port: ' + preferredPort + '; active port: ' + (actualPort || preferredPort) + '; fallback required: ' + ((actualPort || preferredPort) !== 7331 ? 'yes' : 'no') + '.', actualPort || preferredPort, true),
      check('tailscale', 'Tailscale', tailscaleIP ? 'supported' : 'unavailable', tailscaleIP ? 'Tailscale connected; remote access available.' : 'Tailscale not connected; remote access needs Tailscale.'),
      check('cpu-temperature', 'CPU temperature', temp.cpu.available ? 'supported' : 'unavailable', temp.cpu.note || 'CPU temperature sensor status.', temp.cpu.temperatureC),
      check('gpu', 'NVIDIA GPU', gpu.available ? 'supported' : 'unavailable', gpu.statusNote || (gpu.available ? 'NVIDIA hardware detected.' : 'NVIDIA hardware could not be confirmed.'), gpu.name),
      check('cpu-telemetry', 'CPU telemetry', cpuCount ? 'supported' : 'failed', 'Native CPU counters; logical processors: ' + cpuCount + '.', cpuCount, true),
      check('ram-telemetry', 'RAM telemetry', totalGB > 0 ? 'supported' : 'failed', 'Native system memory counters.', totalGB + ' GB', true),
      check('storage-telemetry', 'Storage telemetry', drives.length ? 'supported' : 'failed', drives.length ? 'Local filesystem capacity readable.' : 'Local filesystem capacity could not be read.', null, true),
      check('network-telemetry', 'Network telemetry', metrics.getNetworkStatus() === 'supported' ? 'supported' : 'unavailable', 'Network traffic sampling from /proc/net/dev.'),
      // The /proc collector itself is always available; the count is only
      // populated once the Processes profile runs a collection, so an empty
      // snapshot is not a failure.
      check('process-monitoring', 'Process monitoring', 'supported', 'Process enumeration from /proc; collection runs only in the Processes profile.', procCount || null, true),
      check('windows-apps', 'Installed applications', 'unavailable', 'Installed-application inventory uses Windows registry/AppX and is not available on Linux.'),
      check('windows-maintenance', 'Maintenance actions', 'unavailable', 'Maintenance actions (DISM, SFC, netsh) are Windows-only and are not available on Linux.')
    ];
    const requiredFailed = checks.filter(c => c.required && c.status !== 'supported').length;
    json(res, 200, {
      platform: 'linux', version: VERSION, distro: platform.distroPrettyName(),
      kernel: os.release(), node: process.version, arch: os.arch(),
      hostname: os.hostname(), uptimeSeconds: Math.floor(os.uptime()),
      tailscaleIP,
      tools: {
        ps: platform.toolAvailable('ps'), df: platform.toolAvailable('df'),
        ping: platform.toolAvailable('ping'), sensors: platform.toolAvailable('sensors'),
        'nvidia-smi': platform.toolAvailable('nvidia-smi'),
        systemctl: platform.toolAvailable('systemctl'), loginctl: platform.toolAvailable('loginctl'),
        tailscale: platform.toolAvailable('tailscale')
      },
      temperature: temp, gpu,
      networkCollectionStatus: metrics.getNetworkStatus(),
      drives,
      processCount: procCount, processesSampledAt: procManager.getSnapshot().sampledAt,
      windowsOnlyEndpoints: ['/api/apps/*', '/api/maintenance/*', '/api/desktop/*', '/api/updates', '/api/system/uninstall', '/api/power/*', '/api/temperature/enhanced'],
      generatedAt: new Date().toISOString(),
      overall: {
        status: requiredFailed ? 'failed' : 'supported',
        title: requiredFailed ? 'Core compatibility needs attention' : 'Core monitoring compatible',
        summary: requiredFailed ? 'One or more core capabilities could not be confirmed.' : 'Optional unavailable or failing capabilities do not make the application unhealthy.',
        supported: checks.filter(c => c.status === 'supported').length,
        unavailable: checks.filter(c => c.status === 'unavailable').length,
        failed: checks.filter(c => c.status === 'failed').length
      },
      checks,
      temperatureSettings: metrics.temperatureSettings(),
      temperatureProvider: { ...temp.cpu, mode: temp.mode }
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/processes') {
    const leaseId = ensureRequestLease(req, parsedUrl);
    const lease = leaseId ? monitoringLeases.get(leaseId) : null;
    if (!lease || !lease.profiles.has('processes')) {
      json(res, 403, { error: 'The processes monitoring profile is required.' }); return;
    }
    const snap = procManager.getSnapshot();
    json(res, 200, { ...snap, stale: procManager.isStale() });
    return;
  }

  if (pathname === '/api/processes/tree' || pathname === '/api/processes/kill-tree') {
    unsupported(res); // no /proc process-tree termination in this prototype
    return;
  }

  if (req.method === 'POST' && pathname === '/api/processes/kill') {
    const leaseId = String(req.headers['x-monitor-lease'] || parsedUrl.searchParams.get('lease') || '');
    const lease = leaseId ? monitoringLeases.get(leaseId) : null;
    if (!lease || lease.sessionId !== session.id || lease.expiresAt <= Date.now() || !lease.profiles.has('processes')) {
      json(res, 403, { success: false, code: 'profile-required', error: 'The processes monitoring profile is required.' }); return;
    }
    if (!String(req.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
      json(res, 415, { success: false, code: 'invalid-content-type', error: 'Content-Type must be application/json.' }); return;
    }
    readBody(req, 1024, async (err, body) => {
      if (err) { json(res, err.message === 'too_large' ? 413 : 400, { success: false, code: 'invalid-request', error: 'Invalid request body.' }); return; }
      let parsed; try { parsed = JSON.parse(body); } catch (_) { parsed = null; }
      const validShape = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && Object.keys(parsed).length === 3
        && Object.keys(parsed).every(k => ['pid', 'name', 'startedAt'].includes(k))
        && Number.isSafeInteger(parsed.pid) && parsed.pid >= 1 && parsed.pid <= procManager.MAX_PID
        && typeof parsed.name === 'string' && parsed.name.length >= 1 && parsed.name.length <= 128
        && typeof parsed.startedAt === 'string' && PROCESS_IDENTITY_PATTERN.test(parsed.startedAt);
      if (!validShape) { json(res, 400, { success: false, code: 'invalid-request', error: 'A valid PID, process name, and observed start time are required.' }); return; }
      if (procManager.isStale()) {
        json(res, 409, { success: false, code: 'stale-process', error: procManager.getSnapshot().sampledAt ? 'The process list is stale; refresh and try again.' : 'No process sample is available yet.' });
        return;
      }
      const protectedCode = procManager.isProtected(parsed.pid, parsed.name);
      if (!protectedCode && !procManager.getSnapshot().processes.some(p => p.pid === parsed.pid && p.name === parsed.name && p.startedAt === parsed.startedAt)) {
        json(res, 409, { success: false, code: 'stale-process', error: 'The process was not observed; refresh the list.' }); return;
      }
      const result = await procManager.killProcess(parsed);
      if (result.success) { json(res, 200, result); return; }
      const status = { 'protected-process': 403, 'access-denied': 403, 'already-exited': 410, 'stale-process': 409, 'still-running': 409, 'termination-unconfirmed': 409 }[result.code] || 409;
      json(res, status, result);
    });
    return;
  }

  if (pathname === '/api/stream') {
    const leaseId = ensureRequestLease(req, parsedUrl);
    if (!leaseId) { json(res, 410, { error: 'Monitoring lease expired.' }); return; }
    const sessionStreams = [...sseClients.values()].filter(id => monitoringLeases.get(id)?.sessionId === session.id).length;
    if (sseClients.size >= MAX_SSE_CLIENTS || sessionStreams >= MAX_SSE_PER_SESSION) {
      json(res, 429, { success: false, error: 'Live stream connection limit reached.' }); return;
    }
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
    const latest = metrics.getLatest();
    if (latest) res.write(`data: ${JSON.stringify(latest.metrics)}\n\n`);
    const lease = monitoringLeases.get(leaseId);
    if (lease && lease.profiles.has('processes')) {
      const snap = procManager.getSnapshot();
      res.write(`event: processes\ndata: ${JSON.stringify({ ...snap, stale: procManager.isStale() })}\n\n`);
    }
    sseClients.set(res, leaseId);
    res.on('close', () => sseClients.delete(res));
    return;
  }

  // ---- Static frontend (canonical public/, unchanged) ----
  let decodedPath;
  try { decodedPath = decodeURIComponent(pathname); }
  catch (_) { res.writeHead(400, { 'Content-Type': 'text/plain' }); res.end('Bad Request'); return; }
  const relativePath = decodedPath === '/' || decodedPath === '\\' ? 'index.html' : decodedPath.replace(/^[/\\]+/, '');
  if (!PUBLIC_FILES.has(relativePath.split(path.sep).join('/'))) {
    res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 Not Found'); return;
  }
  serveStatic(req, res, relativePath);
}

function serveLoginPage(res) {
  try {
    const cfg = auth.loadConfig();
    const pinMode = cfg.healthy ? String(cfg.credential.length) : 'manual';
    const html = fs.readFileSync(path.join(PUBLIC_DIR, 'login.html'), 'utf8')
      .replace('<meta name="rovarin-pin-setup" content="false">', '<meta name="rovarin-pin-setup" content="false">')
      .replace('<meta name="rovarin-pin-mode" content="manual">', `<meta name="rovarin-pin-mode" content="${pinMode}">`);
    res.setHeader('Content-Type', 'text/html; charset=UTF-8');
    res.setHeader('Cache-Control', 'no-store');
    res.writeHead(200);
    res.end(html);
  } catch (_) {
    res.writeHead(503, { 'Content-Type': 'text/plain' }); res.end('Login unavailable.');
  }
}

function serveStatic(req, res, relativePath) {
  const filePath = path.resolve(PUBLIC_DIR, relativePath);
  const rel = path.relative(PUBLIC_DIR, filePath);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' }); res.end('Forbidden'); return;
  }
  fs.lstat(filePath, (err, stats) => {
    if (res.destroyed || res.writableEnded) return;
    if (err || !stats.isFile() || stats.isSymbolicLink()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('404 Not Found'); return;
    }
    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    if (relativePath === 'index.html') {
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' });
      fs.createReadStream(filePath).pipe(res);
      return;
    }
    const tag = 'W/"' + stats.size + '-' + stats.mtimeMs + '-' + stats.ctimeMs + '"';
    res.setHeader('ETag', tag);
    res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
    if (req.headers['if-none-match'] === tag) { res.writeHead(304); res.end(); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ---- Startup: port fallback 7331-7335 (PORT env overrides; 0 = ephemeral) ----
const preferredPort = process.env.PORT ? Number(process.env.PORT) : 7331;
let actualPort = null; // bound port once listening (diagnostics reports it)
const candidates = Number.isInteger(preferredPort) && process.env.PORT
  ? [preferredPort]
  : [7331, 7332, 7333, 7334, 7335];

leaseSweeper = setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [id, lease] of [...monitoringLeases]) {
    if (lease.expiresAt <= now || !auth.isSessionActive(lease.sessionId)) { removeLease(id); changed = true; }
  }
  if (changed) reconcileSchedule();
}, 5000);
leaseSweeper.unref();

function tryBind(index) {
  if (index >= candidates.length) {
    console.error('Rovarin Linux: no port available in ' + JSON.stringify(candidates));
    process.exit(1);
  }
  const port = candidates[index];
  server.once('error', err => {
    if (err.code === 'EADDRINUSE' && !process.env.PORT) { tryBind(index + 1); return; }
    console.error('Rovarin Linux: failed to listen:', err.message);
    process.exit(1);
  });
  server.listen(port, '0.0.0.0', () => {
    const actual = server.address().port;
    actualPort = actual;
    console.log(`Rovarin Linux prototype ${VERSION} listening on http://127.0.0.1:${actual} (platform linux, loopback/Tailscale only)`);
    // Only report a fallback when the default 7331-7335 candidate list was
    // actually tried. With an explicit PORT (including PORT=0 ephemeral) the
    // bound port is the requested one, not a fallback for an occupied 7331.
    if (!process.env.PORT && actual !== 7331) console.log(`Note: preferred port 7331 unavailable; using fallback ${actual}.`);
    const cfg = auth.loadConfig();
    if (!cfg.exists) console.log('No PIN configured yet. Stop with Ctrl+C, then run node linux/rovarin.js setup in a terminal (hidden input, first run only).');
    else if (!cfg.healthy) console.log('WARNING: saved PIN configuration is missing or corrupt — login will fail closed (503) until it is fixed by hand.');
  });
}
let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  clearInterval(leaseSweeper);
  for (const id of [...monitoringLeases.keys()]) removeLease(id);
  metrics.dispose();
  server.close();
  server.closeAllConnections();
}
process.once('SIGTERM', shutdown);
process.once('SIGINT', shutdown);
tryBind(0);
