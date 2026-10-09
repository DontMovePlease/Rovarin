'use strict';

const fs = require('fs');
const path = require('path');
const { spawn, execFile } = require('child_process');

const WATCHED_SERVER_FILES = new Set([
  'server.js', 'diagnostics.js', 'maintenance-service.js',
  'server-lifecycle.js',
  'pin-manager.js',
  'process-termination.js', 'app-manager.js', 'leftover-manager.js',
  'scripts/app-leftovers.ps1', 'scripts/app-leftovers.cs',
  'scripts/terminate-process.ps1', 'scripts/process-tree.ps1', 'scripts/process-tree.cs', 'scripts/app-manager.ps1', 'scripts/app-uninstall.cs', 'scripts/app-metadata.cs', 'scripts/process-display.ps1', 'scripts/application-display.ps1',
  'enhanced-support.js',
  'uninstall-manager.js', 'update-manager.js', 'scripts/installed-update.ps1',
  'maintenance.js',
  'scripts/empty-recycle-bin.ps1', 'scripts/maintenance-elevated.cs',
  'temperature-manager.js',
  'cpu-temperature-provider.js',
  'scripts/cpu-temperature-provider.ps1',
  'process-stats.js'
]);
const RESTART_DEBOUNCE_MS = 450;
const TERMINATION_TIMEOUT_MS = 5000;
const HANDOFF_POLL_MS = 150;

function runWindowsCommand(command, args, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    execFile(command, args, { windowsHide: true, timeout: timeoutMs, encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        error.message += stderr ? `: ${stderr.trim()}` : '';
        return reject(error);
      }
      resolve(stdout);
    });
  });
}

async function getProcessImageName(pid) {
  const output = await runWindowsCommand('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `(Get-Process -Id ${pid} -ErrorAction SilentlyContinue).ProcessName`
  ], 5000);
  const processName = output.trim().toLowerCase();
  return processName ? `${processName}.exe` : null;
}

async function getPortListenerPids(port) {
  const output = await runWindowsCommand('netstat.exe', ['-ano', '-p', 'tcp']);
  const pids = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*TCP\s+(\S+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i);
    if (match && match[1].endsWith(`:${port}`)) pids.push(Number(match[2]));
  }
  return [...new Set(pids)];
}

async function terminateDashboardProcess(pid) {
  await runWindowsCommand('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Stop-Process -Id ${pid} -Force -ErrorAction Stop`
  ], 10_000);
}

async function inspectExistingDashboard(projectDir) {
  if (process.platform !== 'win32') return { state: 'unsafe', reason: 'the managed listener handoff is supported on Windows only' };

  const dataDir = require('../pin-manager').dataDirectory(projectDir);
  const pidFile = path.join(dataDir, 'server.pid');
  let pid = null;
  let port = 7331;
  try {
    const value = fs.readFileSync(pidFile, 'utf8').trim();
    if (/^[1-9]\d*$/.test(value)) pid = Number(value);
  } catch (error) {
    if (error.code !== 'ENOENT') return { state: 'unsafe', reason: 'server.pid could not be read' };
  }

  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'server-state.json'), 'utf8'));
    if (!Number.isSafeInteger(state.pid) || state.pid < 1 || (state.status === 'listening' && (!Number.isInteger(state.actualPort) || state.actualPort < 1 || state.actualPort > 65535))) return { state: 'unsafe', reason: 'runtime ownership/port metadata is invalid' };
    if (pid !== null && pid !== state.pid) return { state: 'unsafe', reason: 'PID and runtime metadata disagree' };
    pid = state.pid;
    port = state.actualPort || state.preferredPort;
    if (!Number.isInteger(port) || port < 1 || port > 65535) return { state: 'unsafe', reason: 'runtime port is invalid' };
  } catch (error) { if (error.code !== 'ENOENT') return { state: 'unsafe', reason: 'runtime metadata could not be read' }; }
  if (pid === null) {
    try {
      const owner = JSON.parse(fs.readFileSync(path.join(dataDir, 'server.instance.json'), 'utf8'));
      if (!Number.isSafeInteger(owner.pid) || owner.pid < 1) return { state: 'unsafe', reason: 'instance owner is invalid' };
      pid = owner.pid;
    } catch (error) { if (error.code !== 'ENOENT') return { state: 'unsafe', reason: 'instance ownership could not be read' }; }
  }

  let listeners;
  try { listeners = await getPortListenerPids(port); }
  catch (_) { return { state: 'unsafe', reason: 'the recorded port listener could not be verified' }; }

  if (pid === null) {
    // An unrelated preferred-port owner is never terminated. The server will
    // claim its own instance lock and try the deterministic fallback range.
    return { state: 'none' };
  }

  let imageName;
  try { imageName = await getProcessImageName(pid); }
  catch (_) { return { state: 'unsafe', reason: 'the process recorded in server.pid could not be verified' }; }
  if (!imageName) return { state: 'none' }; // stale runtime files self-heal on startup

  if (listeners.length === 0) {
    if (!imageName) return { state: 'none' };
    if (imageName === 'node.exe') return { state: 'starting', pid };
    return { state: 'none' };
  }
  if (listeners.length !== 1 || listeners[0] !== pid || imageName !== 'node.exe') {
    return { state: 'unsafe', reason: 'the PID file, Node process, and recorded port listener do not all match' };
  }
  return { state: 'owned', pid, port };
}

async function handoffExistingDashboard({
  projectDir = path.resolve(__dirname, '..'),
  inspect = () => inspectExistingDashboard(projectDir),
  terminate = terminateDashboardProcess,
  wait = ms => new Promise(resolve => setTimeout(resolve, ms)),
  timeoutMs = TERMINATION_TIMEOUT_MS,
  pollMs = HANDOFF_POLL_MS,
  logger = console
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let state = await inspect();
  if (state.state === 'none') return true;
  if (state.state === 'unsafe') {
    logger.error(`[dev] Cannot safely take over the dashboard listener: ${state.reason}. The existing process was left untouched.`);
    return false;
  }

  if (state.state === 'starting') {
    logger.log(`[dev] Waiting for the existing dashboard process ${state.pid} to finish starting…`);
    while (Date.now() < deadline && state.state === 'starting') {
      await wait(pollMs);
      state = await inspect();
    }
    if (state.state === 'none') return true;
    if (state.state === 'unsafe') {
      logger.error(`[dev] Cannot safely take over the dashboard listener: ${state.reason}. The existing process was left untouched.`);
      return false;
    }
    if (state.state === 'starting') {
      logger.error(`[dev] Could not verify that dashboard process ${state.pid} owns its recorded port; it was left untouched.`);
      return false;
    }
  }

  const previousPid = state.pid;
  logger.log(`[dev] Stopping the verified dashboard process ${previousPid} before starting development mode…`);
  try { await terminate(previousPid); }
  catch (error) {
    logger.error(`[dev] Could not stop dashboard process ${previousPid} (${error.message}); no replacement was started.`);
    return false;
  }

  while (Date.now() < deadline) {
    await wait(pollMs);
    state = await inspect();
    if (state.state === 'none') return true;
    if (state.state === 'unsafe' || state.pid !== previousPid) {
      logger.error('[dev] Dashboard listener ownership changed during handoff; no replacement was started.');
      return false;
    }
  }

  logger.error(`[dev] Could not confirm dashboard process ${previousPid} and its listener stopped; no replacement was started.`);
  return false;
}

function createDevWatcher({
  projectDir = path.resolve(__dirname, '..'),
  debounceMs = RESTART_DEBOUNCE_MS,
  watchDirectory = fs.watch,
  spawnServer = (scriptPath, cwd) => spawn(process.execPath, [scriptPath], { cwd, stdio: 'inherit', windowsHide: false }),
  logger = console
} = {}) {
  let serverChild = null;
  let debounceTimer = null;
  let restarting = false;
  let queuedRestart = false;
  let stopping = false;
  const watchers = [];

  function launchServer() {
    if (stopping || serverChild) return;
    const scriptPath = path.join(projectDir, 'server.js');
    const child = spawnServer(scriptPath, projectDir);
    serverChild = child;
    logger.log(`[dev] Started server process ${child.pid || '(starting)'}.`);
    child.once('error', error => logger.error(`[dev] Server process failed to start: ${error.message}`));
    child.once('close', (code, signal) => {
      if (serverChild === child) serverChild = null;
      if (!stopping && !restarting) logger.warn(`[dev] Server exited (${signal || code}); it will remain stopped until a watched source file changes.`);
    });
  }

  function stopChild(child) {
    return new Promise(resolve => {
      let settled = false;
      let forceTimer = null;
      let finalTimer = null;
      const finish = (stopped) => {
        if (settled) return;
        settled = true;
        clearTimeout(forceTimer);
        clearTimeout(finalTimer);
        resolve(stopped);
      };
      child.once('close', () => finish(true));
      if (child.exitCode !== null || child.signalCode !== null) return finish(true);
      logger.log('[dev] Stopping the previous server before starting its replacement…');
      try { child.kill(); } catch (_) {}
      forceTimer = setTimeout(() => {
        if (child.exitCode !== null || child.signalCode !== null) return finish(true);
        try { child.kill('SIGKILL'); } catch (_) {}
        finalTimer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), TERMINATION_TIMEOUT_MS);
      }, TERMINATION_TIMEOUT_MS);
    });
  }

  async function restartServer() {
    if (stopping) return;
    if (restarting) { queuedRestart = true; return; }
    restarting = true;
    const previous = serverChild;
    if (previous) {
      const stopped = await stopChild(previous);
      if (!stopped) {
        logger.error('[dev] Could not confirm the old server stopped. Replacement was not started to avoid a duplicate listener.');
        restarting = false;
        return;
      }
      if (serverChild === previous) serverChild = null;
    }
    if (!stopping) launchServer();
    restarting = false;
    if (queuedRestart && !stopping) {
      queuedRestart = false;
      scheduleRestart();
    }
  }

  function scheduleRestart() {
    if (stopping) return;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      restartServer().catch(error => logger.error(`[dev] Restart failed: ${error.message}`));
    }, debounceMs);
  }

  const mtimeCache = new Map();
  function getFileMtime(relativeName) {
    try {
      return fs.statSync(path.join(projectDir, relativeName)).mtimeMs;
    } catch (_) {
      return null;
    }
  }
  for (const file of WATCHED_SERVER_FILES) {
    const m = getFileMtime(file);
    if (m !== null) mtimeCache.set(file, m);
  }

  function onFileChange(_eventType, filename) {
    const name = filename == null ? '' : filename.toString();
    if (!WATCHED_SERVER_FILES.has(name)) return;
    const currentMtime = getFileMtime(name);
    if (currentMtime !== null && mtimeCache.has(name) && mtimeCache.get(name) === currentMtime) {
      return;
    }
    if (currentMtime !== null) {
      mtimeCache.set(name, currentMtime);
    }
    scheduleRestart();
  }

  for (const directory of new Set(Array.from(WATCHED_SERVER_FILES, file => path.dirname(path.join(projectDir, file))))) {
    const watcher = watchDirectory(directory, { persistent: true }, (event, filename) => {
      const relative = filename == null ? '' : path.relative(projectDir, path.join(directory, filename.toString())).split(path.sep).join('/');
      onFileChange(event, relative);
    });
    watcher.on('error', error => logger.error(`[dev] Source watcher error for ${directory}: ${error.message}`));
    watchers.push(watcher);
  }

  launchServer();
  logger.log(`[dev] Watching ${Array.from(WATCHED_SERVER_FILES).join(', ')}; debounce ${debounceMs} ms.`);

  async function close() {
    if (stopping) return;
    stopping = true;
    clearTimeout(debounceTimer);
    watchers.forEach(watcher => watcher.close());
    if (serverChild) {
      const child = serverChild;
      const stopped = await stopChild(child);
      if (stopped && serverChild === child) serverChild = null;
    }
  }

  return { close, scheduleRestart };
}

if (require.main === module) {
  handoffExistingDashboard().then(ready => {
    if (!ready) {
      process.exitCode = 1;
      return;
    }
    const watcher = createDevWatcher();
    console.log(`[dev] Watcher process ${process.pid}.`);
    let closing = false;
    const shutdown = signal => {
      if (closing) return;
      closing = true;
      console.log(`[dev] ${signal}: stopping watcher and server.`);
      watcher.close().finally(() => process.exit(0));
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  }).catch(error => {
    console.error(`[dev] Could not prepare the development server: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { createDevWatcher, handoffExistingDashboard, inspectExistingDashboard, WATCHED_SERVER_FILES, RESTART_DEBOUNCE_MS };
