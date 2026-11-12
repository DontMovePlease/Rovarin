'use strict';
// Linux process inventory + termination for the Rovarin Linux prototype.
// Sources: /proc/<pid>/stat (name, utime/stime, starttime), /proc/<pid>/status
// (VmRSS), /proc/stat btime. CLK_TCK is 100 on Linux (verified on the test VM
// with `getconf CLK_TCK`). Identity is PID + technical name + startedAt, exactly
// as on Windows; a kill is refused unless all three still match a fresh /proc
// read. Termination is SIGTERM only, followed by exit verification — there is
// no SIGKILL escalation in this prototype, and no process-tree termination
// (that endpoint returns 501).
const fs = require('fs');

const CLK_TCK = 100;
const PROCESS_SNAPSHOT_STALE_MS = 15000;
const MAX_PID = (() => {
  try {
    const v = Number(fs.readFileSync('/proc/sys/kernel/pid_max', 'utf8').trim());
    if (Number.isSafeInteger(v) && v > 0) return v;
  } catch (_) {}
  return 4194304;
})();

// Linux critical/system processes. The Rovarin server itself is protected by
// PID (own pid + parent pid), not by name.
const CRITICAL_PROCESS_NAMES = new Set([
  'systemd', 'kthreadd', 'init', 'rovarin', 'rovarin-linux'
]);

function bootTimeSeconds() {
  try {
    for (const line of fs.readFileSync('/proc/stat', 'utf8').split('\n')) {
      if (line.startsWith('btime ')) return Number(line.split(/\s+/)[1]);
    }
  } catch (_) {}
  return Math.floor(Date.now() / 1000 - require('os').uptime());
}

// Parse one /proc/<pid>/stat. Returns null for kernel threads we cannot read
// or for malformed entries. comm may contain spaces/parens, so split on the
// LAST ')'.
function readProcStat(pid) {
  let raw;
  try { raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); } catch (_) { return null; }
  const close = raw.lastIndexOf(')');
  if (close < 0) return null;
  const comm = raw.slice(raw.indexOf('(') + 1, close);
  let name = comm;
  try {
    const exeBase = fs.readlinkSync(`/proc/${pid}/exe`).split('/').pop();
    if (exeBase && !exeBase.endsWith(' (deleted)')) name = exeBase;
  } catch (_) {}
  const rest = raw.slice(close + 2).split(/\s+/);
  if (rest.length < 20) return null;
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]), stime = Number(rest[12]), startTicks = Number(rest[19]);
  if (![utime, stime, startTicks].every(Number.isFinite)) return null;
  let rssKB = null;
  try {
    const m = fs.readFileSync(`/proc/${pid}/status`, 'utf8').match(/^VmRSS:\s*(\d+)\s*kB/m);
    if (m) rssKB = Number(m[1]);
  } catch (_) {}
  const ramMB = (rssKB !== null && Number.isFinite(rssKB)) ? Math.round((rssKB / 1024) * 10) / 10 : null;
  return {
    pid, ppid: Number.isSafeInteger(ppid) ? ppid : null, name,
    cpuSeconds: (utime + stime) / CLK_TCK,
    ramMB,
    startedAt: new Date((bootTimeSeconds() + startTicks / CLK_TCK) * 1000).toISOString()
  };
}

function createLinuxProcesses() {
  let previousCpuTimes = new Map();
  let snapshot = { processes: [], totalCount: 0, accessibleCount: 0, sampledAt: null, error: null };

  function sample() {
    const sampledAt = Date.now();
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number); } catch (_) {
      snapshot = { ...snapshot, error: 'unavailable' };
      return snapshot;
    }
    const logicalProcessors = Math.max(1, require('os').cpus().length);
    const nextCpuTimes = new Map();
    const processes = [];
    for (const pid of pids) {
      const rec = readProcStat(pid);
      if (!rec || !rec.startedAt) continue;
      const prev = previousCpuTimes.get(pid);
      const same = prev && prev.name === rec.name && prev.startedAt === rec.startedAt && rec.cpuSeconds >= prev.cpuSeconds;
      const cpuPercent = (!prev || !same)
        ? null
        : Math.round(Math.max(0, Math.min(100, ((rec.cpuSeconds - prev.cpuSeconds) / Math.max(0.001, (sampledAt - prev.sampledAt) / 1000)) * (100 / logicalProcessors))) * 10) / 10;
      nextCpuTimes.set(pid, { name: rec.name, startedAt: rec.startedAt, cpuSeconds: rec.cpuSeconds, sampledAt });
      processes.push({
        name: rec.name, pid: rec.pid, cpuPercent, ramMB: rec.ramMB, startedAt: rec.startedAt,
        displayName: rec.name, hasFriendlyName: false, displayGroup: null
      });
    }
    previousCpuTimes = nextCpuTimes;
    processes.sort((a, b) => ((b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)) || ((b.ramMB ?? -1) - (a.ramMB ?? -1)));
    snapshot = {
      processes: processes.slice(0, 2048),
      totalCount: pids.length,
      accessibleCount: processes.length,
      sampledAt,
      error: null
    };
    return snapshot;
  }

  function getSnapshot() { return snapshot; }

  function isStale(now = Date.now()) {
    return !snapshot.sampledAt || now - snapshot.sampledAt > PROCESS_SNAPSHOT_STALE_MS;
  }

  function removeFromSnapshot(pid, startedAt, name) {
    snapshot = {
      ...snapshot,
      processes: snapshot.processes.filter(p => !(p.pid === pid && (!startedAt || p.startedAt === startedAt) && (!name || p.name === name)))
    };
  }

  function isProtected(pid, name) {
    if (pid === 1 || pid === process.pid || pid === process.ppid || pid < 1) return 'protected-process';
    if (typeof name === 'string' && CRITICAL_PROCESS_NAMES.has(name.toLowerCase())) return 'protected-process';
    if (typeof name === 'string' && /^\[.*\]$/.test(name)) return 'protected-process'; // kernel thread
    return null;
  }

  // Terminate one observed process. Revalidates PID + name + startedAt against
  // a fresh /proc read immediately before signalling. SIGTERM, then poll for
  // exit for up to 2 s. Never signals a PID that no longer matches.
  async function killProcess({ pid, name, startedAt }) {
    const protectedCode = isProtected(pid, name);
    if (protectedCode) return { success: false, code: protectedCode, error: 'This system process is protected.' };
    let probe;
    try { process.kill(pid, 0); } catch (err) {
      if (err.code === 'ESRCH') { removeFromSnapshot(pid); return { success: false, code: 'already-exited', error: 'The process has already exited.' }; }
      if (err.code === 'EPERM') return { success: false, code: 'access-denied', error: 'Linux denied access to this process.' };
      return { success: false, code: 'server-error', error: 'The process could not be verified.' };
    }
    probe = readProcStat(pid);
    if (!probe || probe.name !== name || probe.startedAt !== startedAt) {
      return { success: false, code: 'stale-process', error: 'The process changed since it was observed; refresh the list.' };
    }
    try { process.kill(pid, 'SIGTERM'); } catch (err) {
      if (err.code === 'ESRCH') { removeFromSnapshot(pid); return { success: false, code: 'already-exited', error: 'The process has already exited.' }; }
      if (err.code === 'EPERM') return { success: false, code: 'access-denied', error: 'Linux denied access to this process.' };
      return { success: false, code: 'server-error', error: 'The process could not be terminated.' };
    }
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      try { process.kill(pid, 0); } catch (err) {
        if (err.code === 'ESRCH') { removeFromSnapshot(pid, startedAt, name); return { success: true, code: 'terminated', pid, name, verified: true }; }
        return { success: false, code: 'termination-unconfirmed', error: 'Process termination could not be confirmed. No further signal was sent.' };
      }
      await new Promise(r => setTimeout(r, 100));
    }
    // Still present after SIGTERM + 2 s. Do not escalate: report honestly.
    const still = readProcStat(pid);
    if (!still) return { success: false, code: 'termination-unconfirmed', error: 'The process is still addressable but its identity could not be read. No further signal was sent.' };
    return { success: false, code: 'still-running', error: 'The process did not exit after SIGTERM. No further signal was sent.' };
  }

  // Explore or terminate a verified process tree via /proc parent links.
  async function processTree(identity, mode = 'preview', protectedPids = []) {
    const { pid, name, startedAt } = identity || {};
    if (!Number.isSafeInteger(pid) || pid <= 0 || !name || !startedAt) {
      return { success: false, code: 'stale-process', results: [], remaining: [] };
    }
    if (isProtected(pid, name) || protectedPids.includes(pid)) {
      return { success: false, code: 'protected-process', results: [], remaining: [] };
    }
    let targetStat = readProcStat(pid);
    if (!targetStat) {
      try { process.kill(pid, 0); } catch (e) {
        if (e.code === 'ESRCH') return { success: false, code: 'already-exited', results: [], remaining: [] };
        if (e.code === 'EPERM') return { success: false, code: 'access-denied', results: [], remaining: [] };
      }
      return { success: false, code: 'stale-process', results: [], remaining: [] };
    }
    if (targetStat.name !== name || targetStat.startedAt !== startedAt) {
      return { success: false, code: 'stale-process', results: [], remaining: [] };
    }

    let pids = [];
    try { pids = fs.readdirSync('/proc').filter(n => /^\d+$/.test(n)).map(Number); } catch (_) {
      return { success: false, code: 'tree-unavailable', results: [], remaining: [] };
    }

    const byParent = new Map();
    const allRecords = new Map();
    allRecords.set(pid, targetStat);

    for (const p of pids) {
      if (p === pid) continue;
      const stat = readProcStat(p);
      if (!stat || stat.ppid === null) continue;
      allRecords.set(p, stat);
      if (!byParent.has(stat.ppid)) byParent.set(stat.ppid, []);
      byParent.get(stat.ppid).push(stat);
    }

    const members = [{ pid: targetStat.pid, name: targetStat.name, startedAt: targetStat.startedAt, depth: 0 }];
    const queue = [{ pid: targetStat.pid, depth: 0 }];
    const seen = new Set([targetStat.pid]);

    while (queue.length > 0 && members.length < 512) {
      const current = queue.shift();
      const children = byParent.get(current.pid) || [];
      for (const child of children) {
        if (!seen.has(child.pid) && !isProtected(child.pid, child.name) && !protectedPids.includes(child.pid)) {
          seen.add(child.pid);
          const member = { pid: child.pid, name: child.name, startedAt: child.startedAt, depth: current.depth + 1 };
          members.push(member);
          queue.push(member);
          if (members.length >= 512) break;
        }
      }
    }

    if (mode === 'preview') {
      return {
        success: true,
        code: 'tree-preview',
        members: members.map(m => ({ pid: m.pid, name: m.name, startedAt: m.startedAt, code: 'verified' })),
        count: members.length
      };
    }

    if (mode === 'terminate') {
      // Sort deepest descendants first so children exit before their parents
      members.sort((a, b) => b.depth - a.depth);
      const results = [];
      const remaining = [];

      for (const item of members) {
        if (isProtected(item.pid, item.name) || protectedPids.includes(item.pid)) {
          results.push({ pid: item.pid, name: item.name, code: 'protected-process' });
          remaining.push(item);
          continue;
        }
        const outcome = await killProcess(item);
        if (outcome.success) {
          results.push({ pid: item.pid, name: item.name, code: 'terminated', verified: true });
        } else if (outcome.code === 'already-exited') {
          results.push({ pid: item.pid, name: item.name, code: 'already-exited' });
        } else {
          results.push({ pid: item.pid, name: item.name, code: outcome.code || 'failed', error: outcome.error });
          remaining.push(item);
        }
      }

      if (remaining.length === 0) {
        return { success: true, code: 'tree-terminated', verified: true, results, remaining: [] };
      }
      return { success: false, code: 'tree-partial', results, remaining };
    }

    return { success: false, code: 'tree-unavailable', results: [], remaining: [] };
  }

  return { sample, getSnapshot, isStale, removeFromSnapshot, killProcess, processTree, isProtected, MAX_PID, PROCESS_SNAPSHOT_STALE_MS };
}

module.exports = { createLinuxProcesses, readProcStat, bootTimeSeconds, CRITICAL_PROCESS_NAMES };

