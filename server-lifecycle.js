'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Content identity excludes configuration, credentials and frontend-only edits.
function runtimeFingerprint(root = __dirname) {
  const hash = crypto.createHash('sha256');
  const files = fs.readdirSync(root).filter(name => name.endsWith('.js') || name === 'package.json').sort();
  for (const name of files) {
    hash.update(name); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, name))); hash.update('\0');
  }
  return hash.digest('hex');
}
const DEFAULT_PORT = 7331;
const FALLBACK_COUNT = 4;
function portCandidates(value = DEFAULT_PORT) {
  if (!/^\d+$/.test(String(value))) throw Object.assign(new Error('Invalid preferred port.'), { code: 'INVALID_PORT' });
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw Object.assign(new Error('Invalid preferred port.'), { code: 'INVALID_PORT' });
  return port === 0 ? [0] : Array.from({ length: Math.min(FALLBACK_COUNT + 1, 65536 - port) }, (_, i) => port + i);
}

function bindServer(server, value, state, onBound, onFailed) {
  let candidates;
  try { candidates = portCandidates(value); } catch (error) { onFailed(error); return; }
  let index = 0;
  state.preferredPort = candidates[0];
  state.defaultPort = DEFAULT_PORT;
  state.attempts = [];
  state.status = 'starting';
  function attempt() {
    const port = candidates[index];
    state.attempts.push(port);
    const failed = error => {
      server.removeListener('listening', ready);
      if (error.code === 'EADDRINUSE' && index + 1 < candidates.length) { index++; attempt(); return; }
      state.status = 'failed'; state.errorCode = error.code || 'BIND_FAILED';
      onFailed(error);
    };
    const ready = () => {
      server.removeListener('error', failed);
      state.actualPort = server.address().port;
      state.fallbackRequired = index > 0;
      state.status = 'listening'; state.errorCode = null;
      onBound(state);
    };
    server.once('error', failed);
    server.once('listening', ready);
    try { server.listen(port, '0.0.0.0'); }
    catch (error) { server.removeListener('error', failed); failed(error); }
  }
  attempt();
}

// Atomic instance ownership prevents two launchers from each falling back to a
// different port. PORT=0 isolated tests deliberately do not own runtime files.
function claimInstance(directory, preferredPort) {
  if (Number(preferredPort) === 0) return { write() {}, cleanup() {} };
  const lock = path.join(directory, 'server.instance.json');
  const pidFile = path.join(directory, 'server.pid');
  const stateFile = path.join(directory, 'server-state.json');
  const startupGuard = path.join(directory, 'server-start.lock');
  const token = crypto.randomBytes(16).toString('hex');
  const alive = pid => {
    try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
  };
  const read = file => { try { return fs.readFileSync(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
  // Serialize stale-record recovery too. A second startup fails safely instead
  // of racing to unlink a lock another startup has just replaced.
  // Publish a complete immutable record atomically. A crash before publication
  // leaves only an unused temporary file, never an empty blocking guard.
  const guardRecord = JSON.stringify({ pid: process.pid, token });
  const temporaryGuard = path.join(directory, `server-start.${token}.tmp`);
  const guards = [];
  let guardPath = startupGuard;
  fs.writeFileSync(temporaryGuard, guardRecord, { flag: 'wx' });
  try {
    for (let depth = 0; ; depth++) {
      if (depth >= 32) throw new Error('Startup recovery depth exceeded; ownership requires inspection.');
      try { fs.linkSync(temporaryGuard, guardPath); guards.push({ path: guardPath, record: guardRecord }); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const record = read(guardPath);
      if (record === null) { guardPath = startupGuard; guards.length = 0; continue; }
      let owner;
      try { owner = JSON.parse(record); } catch (_) { throw new Error('Startup guard ownership cannot be verified.'); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) throw new Error('Startup is already running or its ownership cannot be verified.');
      guards.push({ path: guardPath, record });
      // Contenders follow the same dead record to the same successor. They
      // never unlink the root until one owns a live successor and finishes the
      // critical section. A crashed recovery is recovered the same way.
      guardPath = path.join(directory, `server-start.${crypto.createHash('sha256').update(guardPath + record).digest('hex')}.lock`);
    }
  } catch (error) { fs.unlinkSync(temporaryGuard); throw error; }
  fs.unlinkSync(temporaryGuard);
  // A completed recovery may have retired the chain while we were reading it.
  // Only enter the critical section if every ancestor is still unchanged.
  if (guards.slice(0, -1).some(guard => read(guard.path) !== guard.record)) {
    const ownGuard = guards.at(-1);
    if (read(ownGuard.path) === guardRecord) fs.unlinkSync(ownGuard.path);
    throw new Error('Startup ownership changed; retry launch.');
  }
  try {
  const oldLock = read(lock);
  if (oldLock !== null) {
    let owner;
    try { owner = JSON.parse(oldLock); } catch (_) { throw new Error('Instance ownership cannot be verified.'); }
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1 || alive(owner.pid)) throw new Error('A Rovarin instance is already running or its ownership cannot be verified.');
    if (read(lock) !== oldLock) throw new Error('Instance ownership changed during startup.');
    fs.unlinkSync(lock);
  }
  const oldPid = read(pidFile);
  if (oldPid && /^[1-9]\d*$/.test(oldPid.trim()) && alive(Number(oldPid.trim()))) throw new Error('An existing server PID is still alive; no second instance was started.');
  // A forced stop can retain the old PID. Retire only a verified dead,
  // unchanged record while holding the startup guard, before publishing the
  // new starting state; otherwise launchers see mismatched generations.
  if (oldPid && /^[1-9]\d*$/.test(oldPid.trim())) {
    if (read(pidFile) !== oldPid) throw new Error('PID ownership changed during startup.');
    fs.unlinkSync(pidFile);
  }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token }), { flag: 'wx' });
  const owned = () => { try { return JSON.parse(read(lock)).token === token; } catch (_) { return false; } };
  return {
    write(state) {
      if (!owned()) throw new Error('Instance ownership was lost.');
      fs.writeFileSync(stateFile, JSON.stringify({ pid: process.pid, ...state }, null, 2));
      if (state.status === 'listening') fs.writeFileSync(pidFile, String(process.pid));
    },
    cleanup() {
      if (!owned()) return;
      if (read(pidFile)?.trim() === String(process.pid)) fs.unlinkSync(pidFile);
      // Retain only sanitized bind failure details for the local launcher.
      try { if (JSON.parse(read(stateFile)).status !== 'failed') fs.unlinkSync(stateFile); } catch (_) {}
      fs.unlinkSync(lock);
    }
  };
  } finally {
    for (const guard of guards) if (read(guard.path) === guard.record) fs.unlinkSync(guard.path);
  }
}
module.exports = { DEFAULT_PORT, FALLBACK_COUNT, portCandidates, bindServer, claimInstance, runtimeFingerprint };

if (require.main === module && process.argv[2] === '--runtime-fingerprint') {
  try { console.log(runtimeFingerprint()); } catch (_) { console.error('Backend identity unavailable.'); process.exitCode = 1; }
}
