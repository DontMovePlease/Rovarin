'use strict';

const os = require('os');
const fs = require('fs');

function createCpuUsageSampler(cpus = os.cpus) {
  let prevCpuTimes = cpus();
  function getCpuUsage() {
    const currentCpuTimes = cpus();
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
  getCpuUsage.reset = () => { prevCpuTimes = cpus(); };
  return getCpuUsage;
}

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
    } catch (_) {
      // Drive not present or unreadable, ignore
    }
  }
  return drives;
}

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

function parseGpuTelemetry(err, stdout, sampledAt = Date.now()) {
  if (err || !stdout || typeof stdout !== 'string') {
    const statusNote = err && err.code === 'ENOENT'
      ? 'Sensor unavailable (nvidia-smi not found on this PC)'
      : 'Sensor unavailable (nvidia-smi not responding)';
    return {
      available: false,
      statusNote,
      sampledAt
    };
  }

  const lines = stdout.trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const parsedGpus = [];

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
    const fields = lines[lineIndex].split(',').map(f => f.trim());
    if (fields.length < 7) continue;

    const hasLeadingIndex = /^\d+$/.test(fields[0]) && fields.length >= 8 && fields[1].length > 0;
    const name = hasLeadingIndex ? fields[1] : fields[0];
    const offset = hasLeadingIndex ? 1 : 0;

    const rawUtil = fields[offset + 1];
    const rawMemTotal = fields[offset + 3];
    const rawMemUsed = fields[offset + 4];
    const rawMemFree = fields[offset + 5];
    const rawTemp = fields[offset + 6];

    const validCore = name && name.length > 0
      && rawUtil !== '' && Number.isFinite(Number(rawUtil)) && Number(rawUtil) >= 0
      && rawMemTotal !== '' && Number.isFinite(Number(rawMemTotal)) && Number(rawMemTotal) >= 0
      && rawMemUsed !== '' && Number.isFinite(Number(rawMemUsed)) && Number(rawMemUsed) >= 0
      && rawMemFree !== '' && Number.isFinite(Number(rawMemFree)) && Number(rawMemFree) >= 0;

    if (!validCore) continue;

    const totalVram = parseFloat(rawMemTotal);
    const usedVram = parseFloat(rawMemUsed);
    const freeVram = parseFloat(rawMemFree);
    const util = parseFloat(rawUtil);
    const temp = rawTemp !== '' && Number.isFinite(Number(rawTemp)) ? parseFloat(rawTemp) : null;

    const clockGfx = fields[offset + 7] && Number.isFinite(Number(fields[offset + 7])) ? parseFloat(fields[offset + 7]) : null;
    const clockMem = fields[offset + 8] && Number.isFinite(Number(fields[offset + 8])) ? parseFloat(fields[offset + 8]) : null;
    const powerDraw = fields[offset + 9] && Number.isFinite(Number(fields[offset + 9])) ? parseFloat(fields[offset + 9]) : null;
    const fanSpeed = fields[offset + 10] && Number.isFinite(Number(fields[offset + 10])) ? parseFloat(fields[offset + 10]) : null;

    parsedGpus.push({
      index: hasLeadingIndex ? parseInt(fields[0], 10) : lineIndex,
      name: name || 'NVIDIA GeForce GPU',
      vendor: 'NVIDIA',
      available: true,
      utilizationPercent: util,
      temperatureC: temp,
      vramTotalMB: totalVram,
      vramUsedMB: usedVram,
      vramFreeMB: freeVram,
      vramPercent: totalVram > 0 ? Math.round((usedVram / totalVram) * 100) : 0,
      clockGraphicsMHz: clockGfx,
      clockMemoryMHz: clockMem,
      powerDrawW: powerDraw,
      fanSpeedPercent: fanSpeed,
      statusNote: 'Active (NVIDIA NVML)',
      sampledAt
    });
  }

  if (parsedGpus.length === 0) {
    return {
      available: false,
      statusNote: 'Sensor unavailable (nvidia-smi not responding)',
      sampledAt
    };
  }

  const primary = parsedGpus.find(g => (g.utilizationPercent || 0) > 0) || parsedGpus[0];
  return {
    ...primary,
    gpus: parsedGpus
  };
}

function sampleRamSnapshot(sampledAt = Date.now()) {
  const totalMem = os.totalmem();
  const freeMem = os.freemem();
  const usedMem = totalMem - freeMem;
  return {
    totalGB: Math.round((totalMem / (1024 ** 3)) * 10) / 10,
    usedGB: Math.round((usedMem / (1024 ** 3)) * 10) / 10,
    freeGB: Math.round((freeMem / (1024 ** 3)) * 10) / 10,
    usedPercent: Math.round((usedMem / totalMem) * 1000) / 10,
    sampledAt
  };
}

function assessHealth(cpu, ram, gpu, drives, latency) {
  const issues = [];
  let score = 100;

  if (cpu.overall > 90) {
    issues.push({ level: 'critical', text: `Heavy CPU load (${cpu.overall}%)` });
    score -= 25;
  } else if (cpu.overall > 75) {
    issues.push({ level: 'warning', text: `Elevated CPU load (${cpu.overall}%)` });
    score -= 10;
  }

  if (ram.usedPercent > 92) {
    issues.push({ level: 'critical', text: `High RAM pressure (${ram.usedPercent}%)` });
    score -= 25;
  } else if (ram.usedPercent > 82) {
    issues.push({ level: 'warning', text: `Elevated RAM usage (${ram.usedPercent}%)` });
    score -= 10;
  }

  if (gpu.available && gpu.temperatureC !== null) {
    if (gpu.temperatureC >= 85) {
      issues.push({ level: 'critical', text: `GPU running hot (${gpu.temperatureC}°C)` });
      score -= 20;
    } else if (gpu.temperatureC >= 78) {
      issues.push({ level: 'warning', text: `GPU warm (${gpu.temperatureC}°C)` });
      score -= 8;
    }
  }

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

  if (latency !== null && latency > 150) {
    issues.push({ level: 'warning', text: `High network latency (${latency} ms)` });
    score -= 5;
  }

  let rating = 'Healthy';
  let badgeColor = 'emerald';
  const hasCritical = issues.some(i => i.level === 'critical');
  const warningCount = issues.filter(i => i.level === 'warning').length;

  if (hasCritical || score < 60) {
    rating = 'Attention Needed';
    badgeColor = 'rose';
  } else if (warningCount > 0 || score < 85) {
    rating = warningCount === 1 ? '1 Advisory' : (warningCount > 1 ? `${warningCount} Advisories` : 'Advisory');
    badgeColor = 'amber';
  }

  return {
    score: Math.max(0, score),
    rating,
    badgeColor,
    advisoriesCount: warningCount + (hasCritical ? issues.filter(i => i.level === 'critical').length : 0),
    issues: issues.length > 0 ? issues : [{ level: 'optimal', text: 'All hardware systems running smoothly' }]
  };
}

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

module.exports = {
  createCpuUsageSampler,
  scanDrivesInfo,
  parseNetworkCounters,
  parsePingLatency,
  parseGpuTelemetry,
  sampleRamSnapshot,
  assessHealth,
  formatUptime
};
