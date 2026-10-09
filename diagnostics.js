'use strict';

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// Read-only compatibility reporting. The server retains authentication, HTTP
// routing, leases and the telemetry job registry; this module creates no timers.
// getState reads current snapshots at the same points as the original collector.
function createDiagnostics({
  rootDirectory, PORT, NVIDIA_SMI_COMMAND, getState, getServerPort,
  getTailscaleIP, isTailscaleIP, parseNetworkCounters,
  activeTelemetryJobs, terminatingTelemetryJobs, diagnosticToolJobs,
  cpuTemperatureProvider, temperatureManager, enhancedSupport
}) {
  // On-demand compatibility checks: one shared request, cached for 30 seconds.
  // No monitoring lease, sampler, or background diagnostics timer is created.
  let diagnosticsInFlight = null;
  let diagnosticsCache = null;
  const DIAGNOSTICS_CACHE_MS = 30000;
  function diagnosticCheck(id, label, status, summary, value = null, required = false) {
    return { id, label, status, summary, ...(value === null ? {} : { value }), required };
  }

  function runDiagnosticCommand(command, args, timeout = 3500) {
    return new Promise(resolve => {
      const done = (error, stdout) => resolve({
        status: error ? (error.code === 'ENOENT' ? 'unavailable' : 'failed') : 'supported',
        stdout: error ? '' : String(stdout || '')
      });
      try {
        execFile(command, args, { windowsHide: true, timeout, maxBuffer: 512 * 1024, encoding: 'utf8' }, done);
      } catch (error) { done(error, ''); }
    });
  }

  async function runDiagnosticTelemetryProbe(name, command, args, timeout) {
    if (activeTelemetryJobs.has(name) || terminatingTelemetryJobs.has(name)) return { status: 'unavailable', stdout: '', busy: true };
    diagnosticToolJobs.add(name);
    try { return await runDiagnosticCommand(command, args, timeout); }
    finally { diagnosticToolJobs.delete(name); }
  }

  async function collectTailscaleDiagnostic() {
    const interfaceIp = getTailscaleIP();
    const installedPath = path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Tailscale', 'tailscale.exe');
    const command = fs.existsSync(installedPath) ? installedPath : 'tailscale.exe';
    const result = await runDiagnosticCommand(command, ['status', '--json']);
    let state = null;
    let ipv4 = interfaceIp;
    let connectionStatus = 'unavailable';
    let summary = 'Tailscale CLI is not available; remote connection status is unconfirmed.';
    if (result.status === 'supported') {
      try {
        const data = JSON.parse(result.stdout);
        state = typeof data.BackendState === 'string' ? data.BackendState : null;
        const ips = data.Self?.TailscaleIPs || data.TailscaleIPs;
        if (Array.isArray(ips)) ipv4 = ips.find(ip => typeof ip === 'string' && /^100\.\d+\.\d+\.\d+$/.test(ip) && isTailscaleIP(ip)) || ipv4;
        connectionStatus = state === 'Running' ? 'supported' : state ? 'unavailable' : 'failed';
        summary = state === 'Running' ? 'Tailscale is running. Peer connectivity is not tested.' : state ? 'Tailscale is installed but is not running or signed in.' : 'Tailscale returned an unrecognized status.';
        // Only allowlisted states are exposed, never peer/account data.
        if (!['Running', 'Stopped', 'NeedsLogin', 'NeedsMachineAuth', 'Starting', 'NoState', 'InUseOtherUser'].includes(state)) state = 'Unknown';
      } catch (_) { connectionStatus = 'failed'; summary = 'Tailscale returned unreadable status data.'; }
    } else if (result.status === 'failed') {
      connectionStatus = 'failed'; summary = 'Tailscale status query failed or timed out.';
    } else if (interfaceIp) {
      summary = 'A Tailscale-range interface address exists; connection status is unconfirmed.';
    }
    return [
      diagnosticCheck('tailscale', 'Tailscale availability', result.status, result.status === 'supported' ? 'Tailscale CLI responded.' : 'Tailscale CLI is missing or could not respond.'),
      diagnosticCheck('tailscale-status', 'Tailscale connection', connectionStatus, summary, state),
      diagnosticCheck('tailscale-ip', 'Tailscale IPv4', ipv4 ? 'supported' : 'unavailable', ipv4 ? 'Detected private Tailscale address.' : 'No Tailscale IPv4 address detected.', ipv4)
    ];
  }

  async function collectNvidiaDiagnostic() {
    const { systemInfo, currentGpuData } = getState();
    const detected = systemInfo.gpuModels.filter(name => /nvidia/i.test(name));
    let toolStatus, telemetryStatus, name = detected.join(', ') || null;
    let probeBusy = false;
    if (currentGpuData.sampledAt && Date.now() - currentGpuData.sampledAt < DIAGNOSTICS_CACHE_MS) {
      toolStatus = /not found/.test(currentGpuData.statusNote) ? 'unavailable' : currentGpuData.available ? 'supported' : 'failed';
      telemetryStatus = currentGpuData.available ? 'supported' : toolStatus === 'unavailable' ? 'unavailable' : 'failed';
      if (currentGpuData.available) name = currentGpuData.name;
    } else {
      const result = await runDiagnosticTelemetryProbe('gpu', NVIDIA_SMI_COMMAND, [
        '--query-gpu=name,utilization.gpu,utilization.memory,memory.total,memory.used,memory.free,temperature.gpu',
        '--format=csv,noheader,nounits'
      ], 5000);
      probeBusy = result.busy === true;
      toolStatus = result.status;
      const fields = result.stdout.trim().split(/\r?\n/)[0].split(',').map(item => item.trim());
      telemetryStatus = result.status === 'supported'
        ? fields.length >= 7 && fields[0] && fields.slice(1).every(item => item !== '' && Number.isFinite(Number(item))) ? 'supported' : 'failed'
        : result.status;
      if (telemetryStatus === 'supported') name = fields[0];
    }
    return [
      diagnosticCheck('nvidia-gpu', 'NVIDIA GPU', name ? 'supported' : 'unavailable', name ? 'NVIDIA hardware detected.' : 'NVIDIA hardware could not be confirmed; it may be absent or detection unavailable.', name),
      diagnosticCheck('nvidia-smi', 'nvidia-smi', toolStatus, probeBusy ? 'An NVIDIA telemetry query is already in progress; check again after the cache expires.' : toolStatus === 'supported' ? 'NVIDIA tool detected.' : toolStatus === 'unavailable' ? 'Optional NVIDIA tool is missing.' : 'NVIDIA tool query failed or timed out.'),
      diagnosticCheck('gpu-telemetry', 'GPU telemetry', telemetryStatus, probeBusy ? 'Waiting for the active telemetry query; no duplicate query was started.' : telemetryStatus === 'supported' ? 'NVIDIA load, VRAM, and temperature data available.' : telemetryStatus === 'unavailable' ? 'Optional GPU telemetry is unavailable.' : 'NVIDIA telemetry query failed or returned invalid data.')
    ];
  }

  async function collectWindowsToolsDiagnostic() {
    if (process.platform !== 'win32') return [
      diagnosticCheck('process-monitoring', 'Process monitoring', 'unavailable', 'This collector requires Windows PowerShell.'),
      diagnosticCheck('permissions', 'Administrator access', 'unavailable', 'Windows elevation is not applicable.')
    ];
    const result = await runDiagnosticCommand('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      "$ErrorActionPreference='Stop'; $identity=[Security.Principal.WindowsIdentity]::GetCurrent(); $principal=New-Object Security.Principal.WindowsPrincipal($identity); [pscustomobject]@{admin=$principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator);processCollector=[bool](Get-Command Get-Process -ErrorAction Stop)} | ConvertTo-Json -Compress"
    ], 5000);
    let data = null;
    try { if (result.status === 'supported') data = JSON.parse(result.stdout); } catch (_) {}
    const status = result.status === 'supported' && !data ? 'failed' : result.status;
    const { processSnapshot } = getState();
    const processStatus = processSnapshot.error === 'unavailable' ? 'unavailable' : processSnapshot.error ? 'failed' : processSnapshot.sampledAt || data?.processCollector === true ? 'supported' : status === 'supported' ? 'failed' : status;
    return [
      diagnosticCheck('process-monitoring', 'Process monitoring', processStatus, processStatus === 'supported' ? 'PowerShell process collector is available; enumeration runs only in the Processes profile.' : 'Process collector unavailable or its last collection failed.'),
      diagnosticCheck('permissions', 'Administrator access', typeof data?.admin === 'boolean' ? 'supported' : status === 'supported' ? 'failed' : status, typeof data?.admin === 'boolean' ? data.admin ? 'Server is elevated.' : 'Standard user; administrator-only maintenance requires elevation.' : 'Server elevation could not be determined.', typeof data?.admin === 'boolean' ? data.admin ? 'Administrator' : 'Standard user' : null)
    ];
  }

  async function collectNetworkDiagnostic() {
    const { networkCollectionStatus, currentNetSpeed } = getState();
    if (networkCollectionStatus === 'supported' && currentNetSpeed.sampledAt && Date.now() - currentNetSpeed.sampledAt < DIAGNOSTICS_CACHE_MS)
      return diagnosticCheck('network-telemetry', 'Network telemetry', 'supported', 'Recent network traffic sample available.');
    if (process.platform !== 'win32')
      return diagnosticCheck('network-telemetry', 'Network telemetry', 'unavailable', 'Windows netstat collector required.');
    const result = await runDiagnosticTelemetryProbe('network', 'netstat', ['-e'], 3000);
    const status = result.status === 'supported' && !parseNetworkCounters(result.stdout) ? 'failed' : result.status;
    return diagnosticCheck('network-telemetry', 'Network telemetry', status, result.busy ? 'Network sampling is in progress; no duplicate command was started.' : status === 'supported' ? 'Windows network byte counters available. Internet latency is not tested here.' : 'Network byte counters unavailable or unreadable.');
  }

  async function collectDiagnostics() {
    const [tailscale, nvidia, windowsTools, network] = await Promise.all([
      collectTailscaleDiagnostic(), collectNvidiaDiagnostic(), collectWindowsToolsDiagnostic(), collectNetworkDiagnostic(), enhancedSupport.detectDriver()
    ]);
    const { systemInfo, windowsCaptionDetected, bindingState } = getState();
    const actualPort = getServerPort();
    const windows = process.platform === 'win32';
    let cpus = [], totalMemory = 0, storageStatus = 'unavailable';
    try { cpus = os.cpus(); } catch (_) {}
    try { totalMemory = os.totalmem(); } catch (_) {}
    try { const stat = fs.statfsSync(path.parse(rootDirectory).root); storageStatus = stat.blocks > 0 ? 'supported' : 'failed'; } catch (_) { storageStatus = 'failed'; }
    const checks = [
      diagnosticCheck('windows', 'Windows version / edition', windows ? 'supported' : 'unavailable', windowsCaptionDetected ? 'Detected Windows edition; build ' + os.release() : 'Edition unconfirmed; native OS release shown.', windowsCaptionDetected ? systemInfo.windowsVersion : os.type() + ' ' + os.release(), true),
      diagnosticCheck('os-architecture', 'OS architecture', 'supported', 'Native machine architecture; Node runtime architecture: ' + process.arch, os.machine()),
      diagnosticCheck('node-runtime', 'Node.js runtime', 'supported', 'Current server runtime.', process.version, true),
      diagnosticCheck('server-version', 'Rovarin version', 'supported', 'Version declared in package.json.', require('./package.json').version),
      diagnosticCheck('server-port', 'Server port', bindingState.status === 'listening' ? 'supported' : 'failed', 'Preferred port: ' + bindingState.preferredPort + '; active port: ' + actualPort + '; fallback required: ' + (bindingState.fallbackRequired ? 'yes' : 'no') + '.', actualPort, true),
      diagnosticCheck('default-port', 'Default port 7331', 'supported', 'Requested: ' + (Number(PORT) === 7331 ? 'yes' : 'no') + '; used: ' + (actualPort === 7331 ? 'yes' : 'no') + '.', { requested: Number(PORT) === 7331, used: actualPort === 7331 }),
      ...tailscale, ...nvidia,
      ...cpuTemperatureDiagnostics(),
      diagnosticCheck('cpu-telemetry', 'CPU telemetry', cpus.length ? 'supported' : 'failed', 'Native CPU counters; logical processors: ' + cpus.length + '.', cpus.length, true),
      diagnosticCheck('ram-telemetry', 'RAM telemetry', totalMemory > 0 ? 'supported' : 'failed', 'Native system memory counters.', Math.round(totalMemory / 1024 ** 3 * 10) / 10 + ' GB', true),
      diagnosticCheck('storage-telemetry', 'Storage telemetry', storageStatus, storageStatus === 'supported' ? 'Local filesystem capacity readable; individual inaccessible drives may be omitted.' : 'Local filesystem capacity could not be read.', null, true),
      network, ...windowsTools
    ];
    const failures = checks.filter(check => check.required && check.status !== 'supported').length;
    return { generatedAt: new Date().toISOString(), overall: {
      status: failures ? 'failed' : 'supported',
      title: failures ? 'Core compatibility needs attention' : 'Core monitoring compatible',
      summary: failures ? 'One or more core capabilities could not be confirmed.' : 'Optional unavailable or failing capabilities do not make the application unhealthy.',
      supported: checks.filter(check => check.status === 'supported').length,
      unavailable: checks.filter(check => check.status === 'unavailable').length,
      failed: checks.filter(check => check.status === 'failed').length
    }, checks, binding: { ...bindingState }, temperatureSettings: cpuTemperatureProvider.settings(), temperatureProvider: cpuTemperatureProvider.snapshot() };
  }

  function cpuTemperatureDiagnostics() {
    const state = cpuTemperatureProvider.snapshot(), settings = cpuTemperatureProvider.settings();
    const status = state.status === 'available' && temperatureManager.snapshot().readings.cpu.available ? 'supported' : state.status === 'failed' ? 'failed' : 'unavailable';
    const thermal = settings.observations['thermal-zone'];
    const enhanced = settings.observations.enhanced;
    const support = enhancedSupport.status(enhanced);
    return [
      diagnosticCheck('enhanced-driver', 'Enhanced hardware support (PawnIO)', support.driverInstalled === true ? 'supported' : support.driverStatus === 'failed' ? 'failed' : 'unavailable', support.driverInstalled === true ? 'Driver installed; this does not guarantee compatible CPU sensors.' : support.driverInstalled === false ? 'Optional driver not installed; core monitoring remains usable.' : 'Optional driver detection unavailable or failed.', support.driverInstalled === null ? 'Unconfirmed' : support.driverInstalled ? 'Installed' : 'Not installed'),
      diagnosticCheck('enhanced-installation', 'Enhanced installation result', support.result?.success ? 'supported' : support.result ? 'failed' : 'unavailable', support.result?.message || support.result?.error || 'No Rovarin installation result recorded.', support.result?.code || 'Not attempted'),
      diagnosticCheck('cpu-temperature', state.mode === 'thermal-zone' ? 'System thermal zone' : 'CPU temperature', status, state.note, state.sensorName ? state.sensorName + ' · ' + state.temperatureC + '°C' : state.status),
      diagnosticCheck('temperature-mode', 'Temperature mode', 'supported', 'Optional, lease-driven sampling at 20 seconds; Off stops this sampler.', state.mode),
      diagnosticCheck('enhanced-temperature-provider', 'Enhanced provider assets', settings.enhancedAssetsAvailable ? 'supported' : 'unavailable', 'Official LibreHardwareMonitor ' + settings.enhancedVersion + ' (MPL-2.0); CPU-only helper. Assets do not guarantee sensor access.', settings.enhancedAssetsAvailable ? 'Bundled ' + settings.enhancedVersion : 'Missing'),
      diagnosticCheck('enhanced-cpu-sensors', 'Enhanced CPU sensors', enhanced?.status === 'available' ? 'supported' : enhanced?.status === 'failed' ? 'failed' : 'unavailable', enhanced?.note || 'Not sampled; requires Enhanced mode with an active lease.', enhanced?.sensorName || enhanced?.status || 'Not sampled'),
      diagnosticCheck('cpu-temperature-sensor', 'Selected temperature sensor', status, state.sensorType === 'system-thermal-zone' ? 'ACPI firmware zone; not verified as CPU package. CPU alerts disabled.' : state.note, state.sensorName),
      diagnosticCheck('thermal-zone', 'Windows thermal-zone capability', thermal?.status === 'available' ? 'supported' : thermal?.status === 'failed' ? 'failed' : 'unavailable', 'Experimental ACPI/CIM source; only probed when selected with a lease. May represent a broader system zone.', thermal?.status || 'Not sampled'),
      diagnosticCheck('temperature-permissions', 'Enhanced sensor access', enhanced?.pawnIoInstalled === false ? 'unavailable' : enhanced?.code === 'access-denied' ? 'failed' : typeof enhanced?.admin === 'boolean' ? 'supported' : 'unavailable', 'Enhanced CPU sensors require an installed PawnIO driver and may require elevation; last Enhanced probe shown. Rovarin does not install drivers.', enhanced?.pawnIoInstalled === false ? 'PawnIO not installed' : typeof enhanced?.admin === 'boolean' ? enhanced.admin ? 'Administrator' : 'Standard user' : 'Not sampled')
    ];
  }

  function getDiagnostics(refresh = false) {
    // Explicit setup re-checks share the existing collector and remain bounded.
    if (diagnosticsCache && Date.now() - Date.parse(diagnosticsCache.generatedAt) < (refresh ? 5000 : DIAGNOSTICS_CACHE_MS)) return Promise.resolve(diagnosticsCache);
    if (!diagnosticsInFlight) {
      diagnosticsInFlight = collectDiagnostics().then(data => (diagnosticsCache = data)).finally(() => { diagnosticsInFlight = null; });
    }
    return diagnosticsInFlight;
  }

  return { get: getDiagnostics, invalidate() { diagnosticsCache = null; } };
}

module.exports = { createDiagnostics };
