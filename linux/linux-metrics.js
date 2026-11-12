'use strict';
// Linux metrics samplers for the Rovarin Linux prototype.
// Sources (all stdlib + /proc + one fixed optional CLI each):
//   CPU    os.cpus() deltas            (same math as Windows getCpuUsage())
//   RAM    os.totalmem()/os.freemem()
//   Drives fs.statfsSync() over real mounts from /proc/mounts
//   Net    /proc/net/dev byte counters (non-loopback), delta rates
//   Latency ping -c 1 -W 1 1.1.1.1     (fixed args; Linux flags, not Windows -n/-w)
//   GPU    nvidia-smi, if installed    (same CLI as Windows; absent -> unavailable)
//   Temp   /sys/class/thermal + /sys/class/hwmon; honest "unavailable" if none.
//          A thermal-zone reading is NEVER presented as CPU package temperature:
//          it is labelled system-thermal-zone and excluded from CPU alerts,
//          exactly as AGENTS.md requires for the Windows thermal-zone mode.
// No polling happens here on its own: the server calls these samplers only while
// a monitoring lease is active, mirroring the Windows lease model.
const os = require('os');
const fs = require('fs');
const { execFile } = require('child_process');
const platform = require('./platform');

const HISTORY_MAX = 30;
const decodeMount = value => value.replace(/\\(040|011|012|134)/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
const DISK_FSTYPES = new Set(['ext4', 'xfs', 'btrfs', 'overlay', 'ntfs', 'exfat', 'vfat', 'apfs', 'f2fs', 'zfs']);

function formatUptime(totalSeconds) {
  const s = Math.floor(totalSeconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  return `${m}m ${sec}s`;
}

function validTemperature(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= -20 && value <= 125;
}

// Fixed kernel interfaces only; no commands, timers or client-selected paths.
// Intel drivers often expose no utilization counter: frequency is not a substitute.
function readDrmGpus(readFs = fs) {
  const read = file => { try { return readFs.readFileSync(file, 'utf8').trim(); } catch (_) { return ''; } };
  const list = dir => { try { return readFs.readdirSync(dir).slice(0, 64); } catch (_) { return []; } };
  const numeric = file => { const text=read(file);return /^\d+$/.test(text)&&Number.isSafeInteger(Number(text))?Number(text):null; };
  const devices=[];
  for(const card of list('/sys/class/drm').filter(n=>/^card\d+$/.test(n)).slice(0,16)) {
    const base='/sys/class/drm/'+card+'/device',vendor=read(base+'/vendor').toLowerCase();
    if(!['0x1002','0x8086'].includes(vendor))continue;
    const amd=vendor==='0x1002',busy=numeric(base+'/gpu_busy_percent');
    let total=amd?numeric(base+'/mem_info_vram_total'):numeric(base+'/mem_info_lmem_total');
    let used=amd?numeric(base+'/mem_info_vram_used'):numeric(base+'/mem_info_lmem_used');
    let temperatureC=null;
    let clockGraphicsMHz=numeric(base+'/gt_act_freq_mhz') || numeric('/sys/class/drm/'+card+'/gt_act_freq_mhz');
    let powerDrawW=null;
    let fanSpeedRpm=null;

    for(const hwmon of list(base+'/hwmon').filter(n=>/^hwmon\d+$/.test(n)).slice(0,16)){
      const dir=base+'/hwmon/'+hwmon,chip=read(dir+'/name');
      if(!(amd?/^amdgpu$/:/^(i915|xe)$/).test(chip))continue;
      // GPU edge/package only; do not confuse memory/hotspot readings with it.
      const label=read(dir+'/temp1_label');
      if(!label||/^(edge|gpu|package)$/i.test(label)){
        const raw=numeric(dir+'/temp1_input');if(raw!==null&&validTemperature(raw/1000))temperatureC=raw/1000;
      }
      if(clockGraphicsMHz===null){
        const rawFreq=numeric(dir+'/freq1_input');
        if(rawFreq!==null&&rawFreq>0) clockGraphicsMHz=Math.round(rawFreq/1000000);
      }
      if(powerDrawW===null){
        const rawPower=numeric(dir+'/power1_average') || numeric(dir+'/power1_input');
        if(rawPower!==null&&rawPower>0) powerDrawW=Math.round((rawPower/1000000)*10)/10;
      }
      if(fanSpeedRpm===null){
        const rawFan=numeric(dir+'/fan1_input');
        if(rawFan!==null&&rawFan>=0) fanSpeedRpm=rawFan;
      }
    }
    const utilizationPercent=busy!==null&&busy<=100?busy:null;
    const validVram=total!==null&&total>0&&used!==null&&used<=total;
    const name=(amd?'AMD':'Intel')+' graphics'+(read(base+'/device').match(/^0x[\da-f]{4}$/i)?' ('+read(base+'/device')+')':'');
    devices.push({
      index: devices.length,
      name,
      vendor: amd ? 'AMD' : 'Intel',
      available: utilizationPercent!==null||temperatureC!==null||validVram,
      utilizationPercent,
      temperatureC,
      vramTotalMB: validVram?total/1048576:null,
      vramUsedMB: validVram?used/1048576:null,
      vramFreeMB: validVram?(total-used)/1048576:null,
      vramPercent: validVram?Math.round(used/total*100):null,
      clockGraphicsMHz: clockGraphicsMHz || null,
      powerDrawW: powerDrawW || null,
      fanSpeedPercent: null,
      fanSpeedRpm: fanSpeedRpm !== null ? fanSpeedRpm : null,
      statusNote: 'Linux DRM sysfs; unsupported counters remain unavailable',
      sampledAt: Date.now()
    });
  }
  return devices;
}

function readDrmGpu(readFs = fs) {
  const devices = readDrmGpus(readFs);
  if (!devices.length) return null;
  const primary = devices.find(d => d.available) || devices[0];
  return { ...primary, gpus: devices };
}

// Read every usable Linux temperature input. Returns the best CPU-ish reading,
// or null. Preference: a sensor whose label/type names the CPU/package/cores;
// otherwise the first thermal zone (labelled system-thermal-zone, never CPU).
function readLinuxTemperature(readFs = fs) {
  const fs = readFs;
  const candidates = [];
  // /sys/class/thermal/thermal_zone*/{type,temp} — temp is millidegrees C.
  try {
    for (const zone of fs.readdirSync('/sys/class/thermal')) {
      if (!zone.startsWith('thermal_zone')) continue;
      try {
        const type = fs.readFileSync(`/sys/class/thermal/${zone}/type`, 'utf8').trim();
        const raw = Number(fs.readFileSync(`/sys/class/thermal/${zone}/temp`, 'utf8').trim());
        const value = raw / 1000;
        if (!validTemperature(value)) continue;
        const cpuish = /cpu|package|x86_pkg|core|k10temp|zen/i.test(type);
        candidates.push({ name: `thermal zone ${type}`, sensorType: 'system-thermal-zone', value, rank: cpuish ? 1 : 3 });
      } catch (_) {}
    }
  } catch (_) {}
  // /sys/class/hwmon/hwmon*/temp*_input (+ temp*_label) — millidegrees C.
  try {
    for (const hwmon of fs.readdirSync('/sys/class/hwmon')) {
      let chip = '';
      try { chip = fs.readFileSync(`/sys/class/hwmon/${hwmon}/name`, 'utf8').trim(); } catch (_) {}
      let entries = [];
      try { entries = fs.readdirSync(`/sys/class/hwmon/${hwmon}`); } catch (_) {}
      for (const file of entries) {
        const m = file.match(/^temp(\d+)_input$/);
        if (!m) continue;
        try {
          let label = '';
          try { label = fs.readFileSync(`/sys/class/hwmon/${hwmon}/temp${m[1]}_label`, 'utf8').trim(); } catch (_) {}
          const raw = Number(fs.readFileSync(`/sys/class/hwmon/${hwmon}/${file}`, 'utf8').trim());
          const value = raw / 1000;
          if (!validTemperature(value)) continue;
          // A GPU's "Core" or "Package" label is not proof of a CPU sensor.
          const cpuish = /^(coretemp|k10temp|k8temp|zenpower|cpu_thermal)$/i.test(chip)
            && (!label || /^(Package id \d+|Core \d+|Tctl|Tdie|CPU|Package)$/i.test(label));
          candidates.push({ name: label || `${chip} temp${m[1]}`, sensorType: cpuish ? 'cpu-candidate' : 'system-thermal-zone', value, rank: cpuish ? 0 : 2 });
        } catch (_) {}
      }
    }
  } catch (_) {}
  candidates.sort((a, b) => a.rank - b.rank || b.value - a.value);
  return candidates[0] || null;
}

function cpuCoresPhysical() {
  try {
    const m = fs.readFileSync('/proc/cpuinfo', 'utf8').match(/^cpu cores\s*:\s*(\d+)/m);
    if (m) return Number(m[1]);
  } catch (_) {}
  return os.cpus().length;
}

function createLinuxMetrics({ onUpdate } = {}) {
  let disposed = false;
  const children = new Set();
  function runHelper(file, args, options, callback) {
    if (disposed) return;
    const child = execFile(file, args, options, (...result) => {
      children.delete(child);
      if (!disposed) callback(...result);
    });
    children.add(child);
  }
  function dispose() {
    disposed = true;
    for (const child of children) child.kill();
    children.clear();
  }
  const cpus = os.cpus();
  const systemInfo = {
    hostname: os.hostname(),
    platform: 'Linux',
    osVersion: platform.distroPrettyName() + ' (' + os.type() + ' ' + os.release() + ')',
    distro: platform.distroPrettyName(),
    kernel: os.release(),
    arch: os.arch(),
    cpuModel: (cpus[0] && cpus[0].model.trim()) || 'Unknown CPU',
    cpuCores: cpuCoresPhysical(),
    cpuThreads: cpus.length,
    gpuModels: [],
    tailscaleIP: platform.getTailscaleIP()
  };

  let prevCpuTimes = os.cpus();
  let currentCpuMetrics = null;
  let currentRamMetrics = null;
  let currentDriveMetrics = [];
  let lastDriveScanAt = 0;
  let cachedDrives = [];
  let prevNetSample = null;
  let currentNetSpeed = { downSpeedKB: 0, upSpeedKB: 0, sampledAt: null };
  let networkCollectionStatus = null;
  let currentLatencyMs = null;
  let latencyStatus = 'Measuring';
  let currentLatencySampledAt = null;
  let latestMetrics = null;
  const history = { timestamps: [], cpuUsage: [], gpuUsage: [], gpuTemp: [], ramUsagePercent: [], networkDownKB: [], networkUpKB: [] };

  // Default name says "no GPU" until nvidia-smi actually finds one, so the
  // dashboard never labels a GPU-less machine "NVIDIA GPU". sampleGpu
  // overwrites name with the real model when a GPU is detected.
  let gpuData = {
    name: 'No GPU detected', available: false, utilizationPercent: null, temperatureC: null,
    vramTotalMB: null, vramUsedMB: null, vramFreeMB: null, vramPercent: null,
    statusNote: 'Checking sensor...', sampledAt: null
  };
  let gpuInFlight = false;
  let latencyInFlight = false;

  // Temperature state. mode 'thermal-zone' (default) or 'off'. There is no
  // LibreHardwareMonitor/PawnIO 'enhanced' mode on Linux.
  const temperature = {
    mode: 'thermal-zone',
    cpu: { available: false, temperatureC: null, source: 'Linux thermal zones / hwmon', status: 'unavailable', note: 'Waiting for a temperature sample.', sampledAt: null, sensorName: null, sensorType: null, stale: false },
    gpu: { available: false, temperatureC: null, source: 'NVIDIA NVML via nvidia-smi', status: 'unavailable', note: 'Waiting for a GPU temperature sample.', sampledAt: null, stale: false }
  };

  function getCpuUsage() {
    const current = os.cpus();
    let idleDelta = 0, totalDelta = 0;
    const perCore = [];
    for (let i = 0; i < current.length; i++) {
      const cur = current[i].times;
      const prev = (prevCpuTimes[i] && prevCpuTimes[i].times) || cur;
      const coreIdle = cur.idle - prev.idle;
      const coreTotal = (cur.user - prev.user) + (cur.nice - prev.nice) + (cur.sys - prev.sys) + (cur.irq - prev.irq) + coreIdle;
      idleDelta += coreIdle;
      totalDelta += coreTotal;
      perCore.push(coreTotal > 0 ? Math.max(0, Math.min(100, Math.round((1 - coreIdle / coreTotal) * 100))) : 0);
    }
    prevCpuTimes = current;
    const overall = totalDelta > 0 ? Math.max(0, Math.min(100, Math.round((1 - idleDelta / totalDelta) * 1000) / 10)) : 0;
    return { overall, perCore };
  }

  function sampleCpu() {
    const cpu = getCpuUsage();
    currentCpuMetrics = { overall: cpu.overall, perCore: cpu.perCore, cores: systemInfo.cpuCores, threads: cpu.perCore.length, model: systemInfo.cpuModel, sampledAt: Date.now() };
    publish();
  }

  function sampleRam() {
    const total = os.totalmem(), free = os.freemem(), used = total - free;
    currentRamMetrics = {
      totalGB: Math.round((total / (1024 ** 3)) * 10) / 10,
      usedGB: Math.round((used / (1024 ** 3)) * 10) / 10,
      freeGB: Math.round((free / (1024 ** 3)) * 10) / 10,
      usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
      sampledAt: Date.now()
    };
    publish();
  }

  function scanDrives() {
    const drives = [];
    const seenDevices = new Set();
    let mounts = [];
    try {
      mounts = fs.readFileSync('/proc/mounts', 'utf8').split('\n').filter(Boolean).map(line => {
        const parts = line.split(/\s+/);
        return { device: decodeMount(parts[0]), mount: decodeMount(parts[1]), fstype: parts[2] };
      });
    } catch (_) { mounts = [{ device: '', mount: '/', fstype: 'overlay' }]; }
    for (const m of mounts) {
      if (!DISK_FSTYPES.has(m.fstype)) continue;
      if (m.device && seenDevices.has(m.device)) continue;
      try {
        const stat = fs.statfsSync(m.mount);
        if (!stat || stat.blocks <= 0) continue;
        if (m.device) seenDevices.add(m.device);
        const totalBytes = stat.blocks * stat.bsize;
        const freeBytes = stat.bavail * stat.bsize;
        const usedBytes = totalBytes - freeBytes;
        drives.push({
          mount: m.mount,
          totalGB: Math.round((totalBytes / (1024 ** 3)) * 10) / 10,
          freeGB: Math.round((freeBytes / (1024 ** 3)) * 10) / 10,
          usedGB: Math.round((usedBytes / (1024 ** 3)) * 10) / 10,
          usedPercent: totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 1000) / 10 : 0
        });
      } catch (_) {}
    }
    if (drives.length === 0) {
      try {
        const stat = fs.statfsSync('/');
        const totalBytes = stat.blocks * stat.bsize, freeBytes = stat.bavail * stat.bsize;
        drives.push({ mount: '/', totalGB: Math.round((totalBytes / (1024 ** 3)) * 10) / 10, freeGB: Math.round((freeBytes / (1024 ** 3)) * 10) / 10, usedGB: Math.round(((totalBytes - freeBytes) / (1024 ** 3)) * 10) / 10, usedPercent: totalBytes > 0 ? Math.round(((totalBytes - freeBytes) / totalBytes) * 1000) / 10 : 0 });
      } catch (_) {}
    }
    return drives;
  }

  function sampleDrives(force) {
    if (force || !lastDriveScanAt || Date.now() - lastDriveScanAt >= 60000) {
      cachedDrives = scanDrives();
      lastDriveScanAt = Date.now();
    }
    currentDriveMetrics = cachedDrives;
    publish();
  }

  function readNetCounters() {
    let rx = 0, tx = 0, found = false;
    try {
      for (const line of fs.readFileSync('/proc/net/dev', 'utf8').split('\n')) {
        const m = line.match(/^\s*([^:]+):\s*(\d+)(?:\s+\d+){7}\s+(\d+)/);
        if (!m || m[1] === 'lo') continue;
        rx += Number(m[2]); tx += Number(m[3]); found = true;
      }
    } catch (_) { return null; }
    return found ? { rx, tx } : null;
  }

  function sampleNetwork() {
    const counters = readNetCounters();
    networkCollectionStatus = counters ? 'supported' : 'unavailable';
    if (!counters) { prevNetSample = null; currentNetSpeed = { downSpeedKB: 0, upSpeedKB: 0, sampledAt: null }; publish(); return; }
    const now = Date.now();
    if (prevNetSample) {
      const durationSec = Math.max(0.1, (now - prevNetSample.time) / 1000);
      currentNetSpeed = {
        downSpeedKB: Math.round((Math.max(0, counters.rx - prevNetSample.rx) / 1024 / durationSec) * 10) / 10,
        upSpeedKB: Math.round((Math.max(0, counters.tx - prevNetSample.tx) / 1024 / durationSec) * 10) / 10,
        sampledAt: now
      };
    } else {
      currentNetSpeed.sampledAt = now;
    }
    prevNetSample = { rx: counters.rx, tx: counters.tx, time: now };
    publish();
  }

  function sampleLatency() {
    if (latencyInFlight) return;
    latencyInFlight = true;
    runHelper('ping', ['-c', '1', '-W', '1', '1.1.1.1'], { timeout: 2500, maxBuffer: 64 * 1024 }, (err, stdout) => {
      latencyInFlight = false;
      const m = String(stdout || '').match(/time[=<]\s*([\d.]+)\s*ms/i);
      if (err || !m) {
        currentLatencyMs = null;
        latencyStatus = 'Timeout / Unreachable';
      } else {
        currentLatencyMs = Number(m[1]);
        latencyStatus = `${currentLatencyMs} ms`;
      }
      currentLatencySampledAt = Date.now();
      publish();
    });
  }

  function sampleGpu() {
    if (gpuInFlight) return;
    const drmGpus = readDrmGpus();
    if (!platform.toolAvailable('nvidia-smi')) {
      if (drmGpus.length > 0) {
        const primary = drmGpus.find(d => d.available) || drmGpus[0];
        gpuData = { ...primary, gpus: drmGpus };
        systemInfo.gpuModels = drmGpus.map(d => d.name);
        temperature.gpu = { ...temperature.gpu, available: primary.temperatureC !== null, temperatureC: primary.temperatureC, status: primary.temperatureC !== null ? 'available' : 'unavailable', note: primary.statusNote, sampledAt: primary.sampledAt };
        publish();
        return;
      }
      gpuData = { ...gpuData, available: false, gpus: [], statusNote: 'Sensor unavailable (nvidia-smi not found on this system)', sampledAt: Date.now() };
      temperature.gpu = { ...temperature.gpu, available: false, temperatureC: null, status: 'unavailable', note: gpuData.statusNote, sampledAt: Date.now() };
      publish();
      return;
    }
    gpuInFlight = true;
    runHelper('nvidia-smi', ['--query-gpu=index,name,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,temperature.gpu,clocks.current.graphics,clocks.current.memory,power.draw,fan.speed', '--format=csv,noheader,nounits'], { timeout: 5000, maxBuffer: 64 * 1024 }, (err, stdout) => {
      gpuInFlight = false;
      const lines = String(stdout || '').trim().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
      const nvidiaGpus = [];

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

        const valid = name && name.length > 0
          && rawUtil !== '' && Number.isFinite(Number(rawUtil)) && Number(rawUtil) >= 0
          && rawMemTotal !== '' && Number.isFinite(Number(rawMemTotal)) && Number(rawMemTotal) >= 0
          && rawMemUsed !== '' && Number.isFinite(Number(rawMemUsed)) && Number(rawMemUsed) >= 0
          && rawMemFree !== '' && Number.isFinite(Number(rawMemFree)) && Number(rawMemFree) >= 0;

        if (!valid) continue;

        const totalVram = parseFloat(rawMemTotal);
        const usedVram = parseFloat(rawMemUsed);
        const freeVram = parseFloat(rawMemFree);
        const util = parseFloat(rawUtil);
        const temp = rawTemp !== '' && Number.isFinite(Number(rawTemp)) ? parseFloat(rawTemp) : null;

        const clockGfx = fields[offset + 7] && Number.isFinite(Number(fields[offset + 7])) ? parseFloat(fields[offset + 7]) : null;
        const clockMem = fields[offset + 8] && Number.isFinite(Number(fields[offset + 8])) ? parseFloat(fields[offset + 8]) : null;
        const powerDraw = fields[offset + 9] && Number.isFinite(Number(fields[offset + 9])) ? parseFloat(fields[offset + 9]) : null;
        const fanSpeed = fields[offset + 10] && Number.isFinite(Number(fields[offset + 10])) ? parseFloat(fields[offset + 10]) : null;

        nvidiaGpus.push({
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
          fanSpeedRpm: null,
          statusNote: 'Active (NVIDIA NVML)',
          sampledAt: Date.now()
        });
      }

      if (err || nvidiaGpus.length === 0) {
        if (drmGpus.length > 0) {
          const primary = drmGpus.find(d => d.available) || drmGpus[0];
          gpuData = { ...primary, gpus: drmGpus };
          systemInfo.gpuModels = drmGpus.map(d => d.name);
          temperature.gpu = { ...temperature.gpu, available: primary.temperatureC !== null, temperatureC: primary.temperatureC, status: primary.temperatureC !== null ? 'available' : 'unavailable', note: primary.statusNote, sampledAt: primary.sampledAt };
          publish();
          return;
        }
        gpuData = { ...gpuData, available: false, gpus: [], statusNote: err && err.code === 'ENOENT' ? 'Sensor unavailable (nvidia-smi not found on this system)' : 'Sensor unavailable (nvidia-smi not responding)', sampledAt: Date.now() };
        temperature.gpu = { ...temperature.gpu, available: false, temperatureC: null, status: 'unavailable', note: gpuData.statusNote, sampledAt: Date.now() };
        publish();
        return;
      }

      const allGpus = [...nvidiaGpus, ...drmGpus];
      const primary = allGpus.find(g => (g.utilizationPercent || 0) > 0) || allGpus[0];
      gpuData = {
        ...primary,
        gpus: allGpus
      };
      systemInfo.gpuModels = allGpus.map(g => g.name);
      temperature.gpu = { ...temperature.gpu, available: primary.temperatureC !== null, temperatureC: primary.temperatureC, status: primary.temperatureC !== null ? 'available' : 'unavailable', note: primary.statusNote, sampledAt: Date.now() };
      publish();
    });
  }

  function sampleTemperature() {
    if (temperature.mode === 'off') {
      temperature.cpu = { ...temperature.cpu, available: false, temperatureC: null, status: 'disabled', note: 'Temperature monitoring is disabled.', sampledAt: Date.now() };
      publish();
      return;
    }
    const reading = readLinuxTemperature();
    if (!reading) {
      temperature.cpu = { ...temperature.cpu, available: false, temperatureC: null, status: 'unavailable', note: 'No CPU temperature sensor is exposed by this Linux system (no thermal zones, hwmon sensors, or lm-sensors).', sensorName: null, sensorType: null, sampledAt: Date.now() };
    } else {
      const isCpu = reading.sensorType === 'cpu-candidate';
      temperature.cpu = {
        available: true, temperatureC: Math.round(reading.value * 10) / 10,
        source: 'Linux thermal zones / hwmon', status: 'available',
        note: isCpu ? 'CPU-specific hwmon driver/label; hardware accuracy is not independently verified.' : 'Experimental firmware/ACPI reading; may not represent CPU package temperature. CPU alerts are disabled.',
        sensorName: reading.name, sensorType: reading.sensorType, sampledAt: Date.now(), stale: false
      };
    }
    publish();
  }

  function assessHealth(cpu, ram, gpu, drives, latency) {
    const issues = [];
    let score = 100;
    if (cpu.overall > 90) { issues.push({ level: 'critical', text: `Heavy CPU load (${cpu.overall}%)` }); score -= 25; }
    else if (cpu.overall > 75) { issues.push({ level: 'warning', text: `Elevated CPU load (${cpu.overall}%)` }); score -= 10; }
    if (ram.usedPercent > 92) { issues.push({ level: 'critical', text: `High RAM pressure (${ram.usedPercent}%)` }); score -= 25; }
    else if (ram.usedPercent > 82) { issues.push({ level: 'warning', text: `Elevated RAM usage (${ram.usedPercent}%)` }); score -= 10; }
    if (gpu.available && gpu.temperatureC !== null) {
      if (gpu.temperatureC >= 85) { issues.push({ level: 'critical', text: `GPU running hot (${gpu.temperatureC}°C)` }); score -= 20; }
      else if (gpu.temperatureC >= 78) { issues.push({ level: 'warning', text: `GPU warm (${gpu.temperatureC}°C)` }); score -= 8; }
    }
    // Linux: health covers the root filesystem (Windows covers C:). Only a
    // genuine CPU-package sensor may feed CPU temperature alerts; a
    // system-thermal-zone reading never does.
    const root = drives.find(d => d.mount === '/') || drives[0];
    if (root) {
      if (root.usedPercent > 92) { issues.push({ level: 'critical', text: `Low disk space on ${root.mount} (${root.freeGB} GB free)` }); score -= 20; }
      else if (root.usedPercent > 85) { issues.push({ level: 'warning', text: `${root.mount} getting full (${root.freeGB} GB free)` }); score -= 8; }
    }
    if (temperature.cpu.available && temperature.cpu.sensorType === 'cpu-candidate' && temperature.cpu.temperatureC !== null) {
      if (temperature.cpu.temperatureC >= 90) { issues.push({ level: 'critical', text: `CPU running hot (${temperature.cpu.temperatureC}°C)` }); score -= 20; }
      else if (temperature.cpu.temperatureC >= 80) { issues.push({ level: 'warning', text: `CPU warm (${temperature.cpu.temperatureC}°C)` }); score -= 8; }
    }
    if (latency !== null && latency > 150) { issues.push({ level: 'warning', text: `High network latency (${latency} ms)` }); score -= 5; }
    const hasCritical = issues.some(i => i.level === 'critical');
    const warningCount = issues.filter(i => i.level === 'warning').length;
    let rating = 'Healthy', badgeColor = 'emerald';
    if (hasCritical || score < 60) { rating = 'Attention Needed'; badgeColor = 'rose'; }
    else if (warningCount > 0 || score < 85) { rating = warningCount === 1 ? '1 Advisory' : (warningCount > 1 ? `${warningCount} Advisories` : 'Advisory'); badgeColor = 'amber'; }
    return { score: Math.max(0, score), rating, badgeColor, issues };
  }

  function publish() {
    if (disposed) return;
    if (!currentCpuMetrics || !currentRamMetrics) return;
    const now = new Date();
    const freshHealthGpu = { ...gpuData, temperatureC: temperature.gpu.available ? temperature.gpu.temperatureC : null };
    latestMetrics = {
      timestamp: now.toLocaleTimeString('en-US', { hour12: false }),
      isoTimestamp: now.toISOString(),
      system: systemInfo,
      uptime: formatUptime(os.uptime()),
      uptimeSeconds: Math.floor(os.uptime()),
      cpu: {
        ...currentCpuMetrics,
        temperatureC: temperature.cpu.temperatureC,
        temperatureAvailable: temperature.cpu.available,
        temperatureStale: temperature.cpu.stale,
        temperatureStatus: temperature.cpu.status,
        temperatureSampledAt: temperature.cpu.sampledAt,
        temperatureNote: temperature.cpu.note,
        temperatureSource: temperature.cpu.source,
        temperatureProvider: temperatureSnapshot()
      },
      gpu: {
        ...gpuData,
        temperatureAvailable: temperature.gpu.available,
        temperatureStale: temperature.gpu.stale,
        temperatureStatus: temperature.gpu.status,
        temperatureSource: temperature.gpu.source,
        temperatureSampledAt: temperature.gpu.sampledAt,
        temperatureNote: temperature.gpu.note
      },
      ram: currentRamMetrics,
      drives: currentDriveMetrics,
      network: { downSpeedKB: currentNetSpeed.downSpeedKB, upSpeedKB: currentNetSpeed.upSpeedKB, sampledAt: currentNetSpeed.sampledAt, latencyMs: currentLatencyMs, latencyStatus, latencySampledAt: currentLatencySampledAt },
      health: assessHealth(currentCpuMetrics, currentRamMetrics, freshHealthGpu, currentDriveMetrics, currentLatencyMs),
      temperatureAlerts: []
    };
    if (typeof onUpdate === 'function') { try { onUpdate(latestMetrics); } catch (_) {} }
  }

  function sampleHistory() {
    if (!latestMetrics) return;
    const timestampStr = new Date().toLocaleTimeString('en-US', { hour12: false });
    history.timestamps.push(timestampStr);
    history.cpuUsage.push(currentCpuMetrics.overall);
    history.gpuUsage.push(gpuData.available ? (gpuData.utilizationPercent || 0) : 0);
    history.gpuTemp.push(gpuData.available ? (gpuData.temperatureC || 0) : 0);
    history.ramUsagePercent.push(currentRamMetrics.usedPercent);
    history.networkDownKB.push(currentNetSpeed.downSpeedKB);
    history.networkUpKB.push(currentNetSpeed.upSpeedKB);
    for (const key of Object.keys(history)) if (history[key].length > HISTORY_MAX) history[key].shift();
  }

  function temperatureSnapshot() {
    return {
      mode: temperature.mode,
      provider: temperature.mode === 'off' ? null : 'Linux thermal zones / hwmon',
      source: temperature.cpu.source,
      status: temperature.cpu.status,
      code: temperature.cpu.available ? 'available' : (temperature.mode === 'off' ? 'disabled' : 'no-sensors'),
      note: temperature.cpu.note,
      temperatureC: temperature.cpu.temperatureC,
      sensorName: temperature.cpu.sensorName,
      sensorType: temperature.cpu.sensorType,
      sampledAt: temperature.cpu.sampledAt
    };
  }

  function setTemperatureMode(mode) {
    if (!['thermal-zone', 'off'].includes(mode)) throw new Error('invalid-mode');
    temperature.mode = mode;
    temperature.cpu = { ...temperature.cpu, available: false, temperatureC: null, status: 'unavailable', note: mode === 'off' ? 'Temperature monitoring is disabled.' : 'Waiting for a temperature sample.', sampledAt: null, sensorName: null, sensorType: null };
    sampleTemperature();
    return temperatureSettings();
  }

  function temperatureSettings() {
    return { mode: temperature.mode, modes: ['thermal-zone', 'off'], enhancedAvailable: false, enhancedVersion: null, provider: temperatureSnapshot(), observations: {} };
  }

  // Prime the synchronous samplers once so /api/metrics has data as soon as a
  // lease exists; async samplers (latency/GPU) fill in on their own cadence.
  sampleCpu(); sampleRam(); sampleDrives(true); sampleNetwork(); sampleTemperature();

  return {
    systemInfo,
    getLatest: () => latestMetrics ? { metrics: latestMetrics, history } : null,
    getHistory: () => history,
    getTemperature: () => ({ mode: temperature.mode, cpu: { ...temperature.cpu }, gpu: { ...temperature.gpu } }),
    temperatureSettings,
    setTemperatureMode,
    getGpuData: () => ({ ...gpuData }),
    getNetworkStatus: () => networkCollectionStatus,
    dispose, sampleCpu, sampleRam, sampleDrives, sampleNetwork, sampleLatency, sampleGpu, sampleTemperature, sampleHistory,
    forceDriveScan: () => { lastDriveScanAt = 0; sampleDrives(true); }
  };
}

module.exports = { createLinuxMetrics, readLinuxTemperature, readDrmGpu, readDrmGpus, formatUptime };
