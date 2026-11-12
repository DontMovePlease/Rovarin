'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT_SERVER_FILES = Object.freeze([
  'power-controls.js',
  'server.js',
  'diagnostics.js',
  'maintenance-service.js',
  'server-lifecycle.js',
  'pin-manager.js',
  'process-termination.js',
  'app-manager.js',
  'leftover-manager.js',
  'enhanced-support.js',
  'uninstall-manager.js',
  'update-manager.js',
  'maintenance.js',
  'temperature-manager.js',
  'cpu-temperature-provider.js',
  'process-stats.js',
  'hardware-telemetry.js',
  'web-assets.js'
]);

const SCRIPT_RUNTIME_FILES = Object.freeze([
  'scripts/power-control.ps1',
  'scripts/app-leftovers.ps1',
  'scripts/app-leftovers.cs',
  'scripts/terminate-process.ps1',
  'scripts/process-tree.ps1',
  'scripts/process-tree.cs',
  'scripts/app-manager.ps1',
  'scripts/app-uninstall.cs',
  'scripts/app-metadata.cs',
  'scripts/process-display.ps1',
  'scripts/application-display.ps1',
  'scripts/installed-update.ps1',
  'scripts/empty-recycle-bin.ps1',
  'scripts/maintenance-elevated.cs',
  'scripts/startup-tasks.ps1',
  'scripts/native-startup.ps1',
  'scripts/startup-elevated.cs',
  'scripts/standby-runtime.ps1',
  'scripts/cpu-temperature-provider.ps1'
]);

const WATCHED_SERVER_FILES = new Set([...ROOT_SERVER_FILES, 'package.json', ...SCRIPT_RUNTIME_FILES]);

// Content identity excludes configuration, credentials and frontend-only edits.
function runtimeFingerprint(root = __dirname) {
  const hash = crypto.createHash('sha256');
  const files = [...ROOT_SERVER_FILES, 'package.json'].sort();
  for (const name of files) {
    hash.update(name); hash.update('\0'); hash.update(fs.readFileSync(path.join(root, name))); hash.update('\0');
  }
  for (const rel of SCRIPT_RUNTIME_FILES) {
    const full = path.join(root, rel);
    if (fs.existsSync(full)) {
      hash.update(rel); hash.update('\0'); hash.update(fs.readFileSync(full)); hash.update('\0');
    }
  }
  return hash.digest('hex');
}

function readRuntimeMetadata(dataDir, defaultPort = DEFAULT_PORT) {
  const pidFile = path.join(dataDir, 'server.pid');
  let pid = null;
  let port = defaultPort;
  let status = null;
  let sourceFingerprint = null;
  try {
    const value = fs.readFileSync(pidFile, 'utf8').trim();
    if (/^[1-9]\d*$/.test(value)) pid = Number(value);
  } catch (error) {
    if (error.code !== 'ENOENT') return { valid: false, reason: 'server.pid could not be read' };
  }

  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'server-state.json'), 'utf8'));
    if (!Number.isSafeInteger(state.pid) || state.pid < 1 || (state.status === 'listening' && (!Number.isInteger(state.actualPort) || state.actualPort < 1 || state.actualPort > 65535))) {
      return { valid: false, reason: 'runtime ownership/port metadata is invalid' };
    }
    if (pid !== null && pid !== state.pid) return { valid: false, reason: 'PID and runtime metadata disagree' };
    pid = state.pid;
    port = state.actualPort || state.preferredPort;
    status = state.status || null;
    sourceFingerprint = typeof state.sourceFingerprint === 'string' ? state.sourceFingerprint : null;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { valid: false, reason: 'runtime port is invalid' };
  } catch (error) {
    if (error.code !== 'ENOENT') return { valid: false, reason: 'runtime metadata could not be read' };
  }

  try {
    const owner = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.instance.json'), 'utf8'));
    if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return { valid: false, reason: 'instance owner is invalid' };
    if (pid !== null && pid !== owner.pid) return { valid: false, reason: 'instance and runtime metadata disagree' };
    pid = owner.pid;
  } catch (error) {
    if (error.code !== 'ENOENT') return { valid: false, reason: 'instance ownership could not be read' };
  }

  return { valid: true, pid, port, status, sourceFingerprint };
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
// Private transport for the native per-user supervisor. Public clients can never
// select a channel or supply a forwarded address: the supervisor writes this
// fixed preamble outside HTTP after accepting the actual network connection.
function createStandbyBridge(httpServer, options) {
  const net=require('net');
  const secret=Buffer.from(options.secret||'','base64');
  if(process.platform!=='win32'||secret.length!==32||!/^Rovarin\.backend\.[a-f0-9]{32}$/.test(options.pipe))throw Error('Invalid native transport');
  let draining=false,mutating=0,lastActivity=Date.now(),lastControl=Date.now();
  const authenticated=new WeakSet();
  const fingerprint=runtimeFingerprint();
  const listener=net.createServer(socket=>{
    let data=Buffer.alloc(0);const timer=setTimeout(()=>socket.destroy(),5000);
    const read=chunk=>{
      data=Buffer.concat([data,chunk]);
      if(data.length>65536){socket.destroy();return;}
      if(data.length<34)return;
      const length=data[33];if(length<1||length>64){socket.destroy();return;}
      if(data.length<34+length)return;
      if(!crypto.timingSafeEqual(secret,data.subarray(0,32))){socket.destroy();return;}
      const channel=data[32],ip=data.subarray(34,34+length).toString('utf8');
      if(!net.isIP(ip)){socket.destroy();return;}
      socket.removeListener('data',read);clearTimeout(timer);
      const remaining=data.subarray(34+length);
      if(channel===0){
        socket.pause();
        if(draining){socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');return;}
        Object.defineProperty(socket,'remoteAddress',{value:ip});
        Object.defineProperty(socket,'remoteFamily',{value:net.isIP(ip)===6?'IPv6':'IPv4'});
        if(remaining.length)socket.unshift(remaining);
        httpServer.emit('connection',socket);
        socket.resume();
      }else if(channel===1){
        let text=remaining.toString('utf8');
        const respond=()=>{
          if(!text.includes('\n'))return;
          socket.removeAllListeners('data');
          try{
            const request=JSON.parse(text.split('\n')[0]);
            lastControl=Date.now();
            if(!['status','drain','restore'].includes(request.action))throw Error();
            if(request.action==='restore'){
              if(draining)throw Error();
              const result=options.restore(request);socket.end(JSON.stringify(result)+'\n');return;
            }
            const busy=options.busy(request.retire===true);
            const idle=Date.now()-lastActivity>=options.timeoutMs;
            let snapshot;
            if(request.action==='drain'&&!busy&&!mutating&&idle){snapshot=options.snapshot();draining=true;}
            const result={pid:process.pid,busy:busy||mutating>0,idle,draining,sourceFingerprint:fingerprint};
            if(draining)Object.assign(result,snapshot);
            socket.end(JSON.stringify(result)+'\n');
            if(draining)setTimeout(()=>options.stop(),100).unref();
          }catch(_){socket.end('{"error":"unavailable"}\n');}
        };
        socket.on('data',chunk=>{text+=chunk.toString('utf8');if(text.length>8192)socket.destroy();else respond();});
        socket.setTimeout(5000,()=>socket.destroy());respond();
      }else socket.destroy();
    };
    socket.once('close',()=>clearTimeout(timer));socket.on('error',()=>{});socket.on('data',read);
  });
  // A crashed supervisor must not leave an idle orphan, but work always wins.
  const watchdog=setInterval(()=>{
    try{if(Date.now()-lastControl>60000&&Date.now()-lastActivity>=options.timeoutMs&&!mutating&&!options.busy())options.stop();}catch(_){}
  },5000);watchdog.unref();
  return {
    listen(callback){listener.listen('\\\\.\\pipe\\'+options.pipe,callback);},
    request(req,res){
      if(draining){res.writeHead(503,{'Retry-After':'1'});res.end();return false;}
      // Finite reads (inventory/diagnostics included) must finish before drain.
      // SSE lifetime is governed by its authenticated renewable monitoring lease.
      if(!(req.method==='GET'&&req.url.split('?')[0]==='/api/stream')){
        mutating++;let done=false;const finish=()=>{if(!done){done=true;mutating--;}};
        res.once('finish',finish);res.once('close',finish);
      }
      return true;
    },
    touch(req){if(!authenticated.has(req)){authenticated.add(req);lastActivity=Date.now();}},
    close(){listener.close();},
    retire(){
      const tag=crypto.createHmac('sha256',secret).update('retire:'+fingerprint).digest('hex');
      fs.writeSync(process.stdout.fd,'ROVARIN-STANDBY-RETIRE '+tag+'\n');
      listener.close();
    }
  };
}
module.exports = {
  DEFAULT_PORT,
  FALLBACK_COUNT,
  ROOT_SERVER_FILES,
  SCRIPT_RUNTIME_FILES,
  WATCHED_SERVER_FILES,
  portCandidates,
  bindServer,
  claimInstance,
  runtimeFingerprint,
  readRuntimeMetadata,
  createStandbyBridge
};

if (require.main === module && process.argv[2] === '--runtime-files') {
  console.log(JSON.stringify({ root: [...ROOT_SERVER_FILES, 'package.json'], scripts: SCRIPT_RUNTIME_FILES, public: require('./web-assets').PACKAGED_PUBLIC_FILES }));
}
if (require.main === module && process.argv[2] === '--runtime-fingerprint') {
  try { console.log(runtimeFingerprint()); } catch (_) { console.error('Backend identity unavailable.'); process.exitCode = 1; }
}
