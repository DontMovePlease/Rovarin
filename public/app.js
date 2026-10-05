// State and History Buffer
const MAX_POINTS = 30;
const loadedDashboardRevision = document.querySelector('meta[name="pc-monitor-ui-revision"]')?.content;
let dashboardUpdateReloading = false;
let dashboardRevisionCheckInFlight = false;
let lastDashboardRevisionCheck = 0;

function reloadForDashboardUpdate(response) {
  const revision = response.headers.get('X-PC-Monitor-UI-Revision');
  if (!response.ok || !loadedDashboardRevision || !revision || revision === loadedDashboardRevision ||
      dashboardUpdateReloading || window.pcMonitorUninstalling) return false;
  dashboardUpdateReloading = true;
  // A distinct document URL also avoids restoring an old home-screen page.
  const url = new URL(window.location.href);
  url.searchParams.set('ui', revision);
  releaseMonitoringLease();
  window.location.replace(url.href);
  return true;
}

async function checkDashboardUpdate() {
  if (!loadedDashboardRevision || !dashboardClientVisible() || window.pcMonitorUninstalling ||
      dashboardUpdateReloading || dashboardRevisionCheckInFlight || Date.now() - lastDashboardRevisionCheck < 5000) return;
  dashboardRevisionCheckInFlight = true;
  lastDashboardRevisionCheck = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await fetch('/', { credentials: 'same-origin', cache: 'no-store', signal: controller.signal });
    reloadForDashboardUpdate(response);
    await response.body?.cancel();
  } catch (_) { /* Offline phones retry on the next resume or lease heartbeat. */ }
  finally { clearTimeout(timeout); dashboardRevisionCheckInFlight = false; }
}
try { localStorage.removeItem('auth_pin'); } catch (_) {}
const CPU_DETAIL_WINDOW_MS = 60000;
const CPU_DETAIL_MAX_POINTS = 60;
const chartData = {
  cpu: [],
  gpu: [],
  gpuTemp: [],
  ram: [],
  netDown: [],
  netUp: []
};
const cpuDetailSamples = [];
const lastMetricSampleAt = { cpu: null, gpu: null, ram: null, network: null };
let latestDashboardMetrics = null;
const chartConfigs = {};
const chartInteractions = {};

// Guidance thresholds for this setup: Intel Core i7-10750H (Tjunction 100°C)
// and NVIDIA GeForce GTX 1660 Ti. These are caution bands, not guarantees.
function temperatureGuidance(part, value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return { label: 'Unavailable', level: 'sensor-na' };
  const temp = Number(value);
  if (part === 'cpu') {
    if (temp >= 95) return { label: 'Very high · near limit', level: 'temp-critical' };
    if (temp >= 85) return { label: 'High', level: 'temp-high' };
    if (temp < 35) return { label: 'Low / idle', level: 'temp-low' };
    return { label: 'Normal', level: 'temp-normal' };
  }
  if (temp >= 87) return { label: 'Very high', level: 'temp-critical' };
  if (temp >= 80) return { label: 'High', level: 'temp-high' };
  if (temp < 35) return { label: 'Low / idle', level: 'temp-low' };
  return { label: 'Normal', level: 'temp-normal' };
}

// Canvas references
const canvases = {
  cpu: document.getElementById('cpuChart'),
  cpuDetail: document.getElementById('cpuDetailChart'),
  gpu: document.getElementById('gpuChart'),
  ram: document.getElementById('ramChart'),
  net: document.getElementById('netChart')
};
const cpuDetailDialog = document.getElementById('cpuDetailDialog');
let cpuDetailActive = false;
let cpuDetailProfileReady = false;
let suppressCpuProfileRestore = false;

// Setup Retina High-DPI Canvas scaling
function initCanvas(canvas) {
  if (!canvas) return null;
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  return { ctx, width: rect.width, height: rect.height };
}

// Draw smooth sparkline chart on Canvas
function drawSparkline(canvasId, seriesList, options = {}) {
  const canvas = canvases[canvasId];
  if (!canvas) return;
  chartConfigs[canvasId] = { seriesList, options };
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return;

  // Resize canvas if needed
  if (canvas.width !== rect.width * dpr || canvas.height !== rect.height * dpr) {
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, rect.width, rect.height);

  const w = rect.width;
  const h = rect.height;
  const paddingBottom = 6;
  const paddingTop = 6;
  const plotH = h - paddingTop - paddingBottom;

  // Background grid lines (subtle)
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.05)';
  ctx.lineWidth = 1;
  ctx.setLineDash([2, 4]);
  ctx.beginPath();
  ctx.moveTo(0, paddingTop);
  ctx.lineTo(w, paddingTop);
  ctx.moveTo(0, paddingTop + plotH / 2);
  ctx.lineTo(w, paddingTop + plotH / 2);
  ctx.moveTo(0, h - paddingBottom);
  ctx.lineTo(w, h - paddingBottom);
  ctx.stroke();
  ctx.setLineDash([]);

  // Determine Max Value across series
  let maxVal = options.max || 100;
  if (!options.fixedMax) {
    let observedMax = 10;
    seriesList.forEach(s => {
      s.data.forEach(v => { if (v > observedMax) observedMax = v; });
    });
    maxVal = Math.max(10, Math.ceil(observedMax * 1.15));
  }

  seriesList.forEach(series => {
    const windowPoints = Math.max(2, Number(options.windowPoints) || MAX_POINTS);
    const data = series.data.slice(-windowPoints);
    if (!data || data.length < 2) return;

    const sampleTimes = series.sampleTimes?.slice(-windowPoints);
    const timeWindowMs = Number(options.timeWindowMs) || 0;
    const useTimeAxis = timeWindowMs > 0 && sampleTimes?.length === data.length;
    const windowStart = Date.now() - timeWindowMs;
    const points = data.map((value, index) => {
      const x = useTimeAxis
        ? Math.max(0, Math.min(w, ((sampleTimes[index] - windowStart) / timeWindowMs) * w))
        : ((windowPoints - data.length + index) * w) / (windowPoints - 1);
      const boundedValue = Math.max(0, Math.min(maxVal, value || 0));
      return { x, y: h - paddingBottom - (boundedValue / maxVal) * plotH };
    });

    // Draw gradient fill under curve
    if (series.fillColor) {
      ctx.beginPath();
      ctx.moveTo(points[0].x, h - paddingBottom);
      points.forEach((point, index) => {
        if (index === 0) ctx.lineTo(point.x, point.y);
        else ctx.lineTo(point.x, point.y);
      });
      ctx.lineTo(points[points.length - 1].x, h - paddingBottom);
      ctx.closePath();
      const grad = ctx.createLinearGradient(0, paddingTop, 0, h);
      grad.addColorStop(0, series.fillColor);
      grad.addColorStop(1, 'rgba(0, 0, 0, 0)');
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Draw Line
    ctx.beginPath();
    points.forEach((point, index) => {
      if (index === 0) ctx.moveTo(point.x, point.y);
      else ctx.lineTo(point.x, point.y);
    });
    ctx.strokeStyle = series.color;
    ctx.lineWidth = 2;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.shadowColor = series.color;
    ctx.shadowBlur = 0;
    ctx.stroke();
    ctx.shadowBlur = 0;
  });

  const interaction = chartInteractions[canvasId];
  if (interaction && interaction.selectedIndex !== null && seriesList[0]?.data?.length) {
    const windowPoints = Math.max(2, Number(options.windowPoints) || MAX_POINTS);
    const reference = seriesList[0].data.slice(-windowPoints);
    const sampleIndex = Math.max(0, Math.min(reference.length - 1, interaction.selectedIndex));
    interaction.selectedIndex = sampleIndex;
    const sampleTimes = seriesList[0].sampleTimes?.slice(-windowPoints);
    const timeWindowMs = Number(options.timeWindowMs) || 0;
    const useTimeAxis = timeWindowMs > 0 && sampleTimes?.length === reference.length;
    const x = useTimeAxis
      ? Math.max(0, Math.min(w, ((sampleTimes[sampleIndex] - (Date.now() - timeWindowMs)) / timeWindowMs) * w))
      : ((windowPoints - reference.length + sampleIndex) * w) / (windowPoints - 1);
    ctx.beginPath();
    ctx.moveTo(x, paddingTop);
    ctx.lineTo(x, h - paddingBottom);
    ctx.strokeStyle = 'rgba(226, 232, 240, 0.5)';
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.stroke();
    ctx.setLineDash([]);

    seriesList.forEach(series => {
      const value = series.data?.slice(-windowPoints)[sampleIndex];
      if (!Number.isFinite(Number(value))) return;
      const y = h - paddingBottom - (Math.max(0, Math.min(maxVal, Number(value))) / maxVal) * plotH;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fillStyle = series.color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(8, 12, 20, 0.9)';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    });
    updateChartTooltip(canvasId, sampleIndex, x, w);
  }

  ctx.restore();
}

function setupInteractiveCharts() {
  Object.entries(canvases).forEach(([id, canvas]) => {
    if (!canvas || chartInteractions[id]) return;
    const tooltip = document.createElement('div');
    tooltip.className = 'chart-tooltip';
    tooltip.setAttribute('aria-hidden', 'true');
    canvas.parentElement.appendChild(tooltip);
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${id.toUpperCase()} history graph. Touch, click, or use the arrow keys to inspect samples.`);
    chartInteractions[id] = { tooltip, selectedIndex: null };

    const selectFromPointer = (event) => {
      const config = chartConfigs[id];
      const samples = config?.seriesList?.[0]?.data;
      if (!samples?.length) return;
      const rect = canvas.getBoundingClientRect();
      const x = Math.max(0, Math.min(rect.width, event.clientX - rect.left));
      const windowPoints = Math.max(2, Number(config.options.windowPoints) || MAX_POINTS);
      const visibleCount = Math.min(samples.length, windowPoints);
      const sampleTimes = config.seriesList[0]?.sampleTimes?.slice(-windowPoints);
      const timeWindowMs = Number(config.options.timeWindowMs) || 0;
      if (timeWindowMs > 0 && sampleTimes?.length === visibleCount) {
        const targetTime = Date.now() - timeWindowMs + (x / rect.width) * timeWindowMs;
        let nearestIndex = 0;
        let nearestDistance = Infinity;
        sampleTimes.forEach((sampleTime, index) => {
          const distance = Math.abs(sampleTime - targetTime);
          if (distance < nearestDistance) {
            nearestDistance = distance;
            nearestIndex = index;
          }
        });
        chartInteractions[id].selectedIndex = nearestIndex;
      } else {
        const plotIndex = Math.round((x / rect.width) * (windowPoints - 1));
        const startOffset = windowPoints - visibleCount;
        chartInteractions[id].selectedIndex = Math.max(0, Math.min(visibleCount - 1, plotIndex - startOffset));
      }
      drawSparkline(id, config.seriesList, config.options);
    };

    canvas.addEventListener('pointermove', selectFromPointer);
    canvas.addEventListener('pointerdown', selectFromPointer);
    canvas.addEventListener('pointerleave', (event) => {
      if (event.pointerType === 'mouse' && !event.buttons) clearChartSelection(id);
    });
    canvas.addEventListener('keydown', (event) => {
      const length = chartConfigs[id]?.seriesList?.[0]?.data?.length || 0;
      if (event.key === 'Escape') {
        clearChartSelection(id);
        return;
      }
      if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
      event.preventDefault();
      if (!length) return;
      const current = chartInteractions[id].selectedIndex ?? length - 1;
      chartInteractions[id].selectedIndex = Math.max(0, Math.min(length - 1, current + (event.key === 'ArrowLeft' ? -1 : 1)));
      const config = chartConfigs[id];
      drawSparkline(id, config.seriesList, config.options);
    });
  });

  document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('.chart-container')) return;
    Object.keys(chartInteractions).forEach(clearChartSelection);
  });
}

function updateChartTooltip(id, sampleIndex, x, width) {
  const interaction = chartInteractions[id];
  const config = chartConfigs[id];
  if (!interaction || !config) return;
  const label = document.createElement('div');
  label.className = 'chart-tooltip-label';
  const windowPoints = Math.max(2, Number(config.options.windowPoints) || MAX_POINTS);
  const reference = config.seriesList[0].data.slice(-windowPoints);
  const age = reference.length - 1 - sampleIndex;
  const sampleTime = config.seriesList[0].sampleTimes?.slice(-windowPoints)[sampleIndex];
  label.textContent = sampleTime
    ? new Date(sampleTime).toLocaleTimeString()
    : age === 0 ? 'Latest sample' : `${age} sample${age === 1 ? '' : 's'} ago`;
  const rows = config.seriesList.map(series => {
    const value = Number(series.data.slice(-windowPoints)[sampleIndex]);
    if (!Number.isFinite(value)) return null;
    const row = document.createElement('div');
    row.textContent = `${series.name || 'Value'}: ${series.format === 'speed' ? formatSpeed(value) : `${value.toFixed(series.format === 'temperature' ? 0 : 1)}${series.format === 'temperature' ? ' °C' : '%'}`}`;
    row.style.color = series.color;
    return row;
  }).filter(Boolean);
  interaction.tooltip.replaceChildren(label, ...rows);
  interaction.tooltip.style.left = `${Math.max(14, Math.min(86, x / width * 100))}%`;
  interaction.tooltip.classList.add('visible');
  interaction.tooltip.setAttribute('aria-hidden', 'false');
}

function clearChartSelection(id) {
  const interaction = chartInteractions[id];
  const config = chartConfigs[id];
  if (!interaction || !config || interaction.selectedIndex === null) return;
  interaction.selectedIndex = null;
  interaction.tooltip.classList.remove('visible');
  interaction.tooltip.setAttribute('aria-hidden', 'true');
  drawSparkline(id, config.seriesList, config.options);
}

// Format speeds nicely
function formatSpeed(kb) {
  if (kb >= 1024) {
    return `${(kb / 1024).toFixed(2)} MB/s`;
  }
  return `${kb.toFixed(1)} KB/s`;
}

function isNewMetricSample(metric, sampledAt, fallbackTimestamp) {
  const numericTime = Number(sampledAt);
  const key = Number.isFinite(numericTime) && numericTime > 0
    ? numericTime
    : (fallbackTimestamp || null);
  if (key === null) return true;
  if (lastMetricSampleAt[metric] === key) return false;
  lastMetricSampleAt[metric] = key;
  return true;
}

function rememberCpuDetailSample(cpu) {
  const sampledAt = Number(cpu.sampledAt) || Date.now();
  cpuDetailSamples.push({
    sampledAt,
    overall: Number(cpu.overall) || 0,
    perCore: Array.isArray(cpu.perCore) ? cpu.perCore.slice() : []
  });
  const oldestAllowed = sampledAt - CPU_DETAIL_WINDOW_MS;
  while (cpuDetailSamples.length && cpuDetailSamples[0].sampledAt < oldestAllowed) cpuDetailSamples.shift();
  while (cpuDetailSamples.length > CPU_DETAIL_MAX_POINTS) cpuDetailSamples.shift();
}

// Update DOM with incoming metrics
function updateUI(data) {
  if (!data) return;
  latestDashboardMetrics = data;

  // Header & Host
  if (data.system) {
    document.getElementById('hostName').textContent = data.system.hostname || 'Windows PC';
    document.getElementById('osBadge').textContent = (data.system.windowsVersion || 'Windows').replace('Microsoft ', '');
    document.getElementById('tailscaleIpText').textContent = `Tailscale: ${data.system.tailscaleIP || 'N/A'}`;

    document.getElementById('specOs').textContent = data.system.windowsVersion || 'Windows 11';
    document.getElementById('specCpu').textContent = data.cpu.model || data.system.cpuModel;
    document.getElementById('specGpu').textContent = (data.system.gpuModels && data.system.gpuModels.length > 0)
      ? data.system.gpuModels.join(' + ')
      : (data.gpu.name || 'Dedicated GPU');
    document.getElementById('specArch').textContent = `${data.system.arch} (${data.cpu.cores} Cores / ${data.cpu.threads} Threads)`;
    document.getElementById('specHost').textContent = data.system.hostname || 'Windows PC';
    document.getElementById('specUptime').textContent = data.uptime || '--';
  }

  if (data.ram) {
    document.getElementById('specMemory').textContent = `${data.ram.totalGB} GB total · ${data.ram.freeGB} GB available`;
  }
  if (data.drives) {
    document.getElementById('specStorage').textContent = data.drives.length
      ? data.drives.map(drive => `${drive.mount} ${drive.freeGB}/${drive.totalGB} GB free`).join(' · ')
      : 'No drives detected';
  }

  document.getElementById('uptimeText').textContent = `Uptime: ${data.uptime}`;
  if (document.getElementById('lastUpdated')) document.getElementById('lastUpdated').textContent = data.timestamp;

  // PC Health Card
  const health = data.health;
  if (health) {
    const healthBadge = document.getElementById('healthBadge');
    healthBadge.textContent = health.rating;
    healthBadge.className = `health-status-badge ${health.badgeColor}`;

    const checklistEl = document.getElementById('healthChecklist');
    checklistEl.innerHTML = health.issues.map(item => `
      <div class="health-check-item">
        <span class="indicator ${item.level}"></span>
        <span>${item.text}</span>
      </div>
    `).join('');
  }

  // CPU
  const cpu = data.cpu;
  if (cpu) {
    document.getElementById('cpuUsageVal').textContent = cpu.overall;
    document.getElementById('cpuModelText').textContent = `${cpu.model} (${cpu.cores}C / ${cpu.threads}T)`;
    const cpuBar = document.getElementById('cpuProgressBar');
    cpuBar.style.width = `${Math.min(100, Math.max(0, cpu.overall))}%`;
    cpuBar.className = `progress-bar-fill ${cpu.overall > 85 ? 'bg-rose' : cpu.overall > 70 ? 'bg-amber' : 'bg-blue'}`;

    // Temperature sensor status
    const cpuTempBadge = document.getElementById('cpuTempBadge');
    const provider = cpu.temperatureProvider || {};
    const thermalZone = provider.mode === 'thermal-zone';
    const temperatureSource = document.getElementById('cpuTemperatureSource');
    if (temperatureSource) temperatureSource.textContent = provider.sensorName
      ? `${provider.sensorName} · ${provider.source}${thermalZone ? ' · Experimental; not verified CPU package' : ''}`
      : provider.note || cpu.temperatureNote || 'Optional temperature sensor';
    if (provider.mode === 'off') {
      cpuTempBadge.textContent = 'CPU temperature: Off';
      cpuTempBadge.title = provider.note;
      cpuTempBadge.className = 'card-badge sensor-na';
    } else if (thermalZone) {
      cpuTempBadge.textContent = cpu.temperatureAvailable ? `System thermal zone: ${cpu.temperatureC}°C` : cpu.temperatureStale ? `System thermal zone: ${cpu.temperatureC}°C — stale` : 'System thermal zone unavailable';
      cpuTempBadge.title = provider.note;
      cpuTempBadge.className = 'card-badge sensor-na';
    } else if (cpu.temperatureC !== null && cpu.temperatureStale) {
      cpuTempBadge.textContent = `${cpu.temperatureC}°C — stale`;
      cpuTempBadge.title = `Last validated CPU temperature; sampled ${cpu.temperatureSampledAt ? new Date(cpu.temperatureSampledAt).toLocaleString() : 'at an unknown time'}. ${cpu.temperatureSource || ''} ${cpu.temperatureNote || ''}`.trim();
      cpuTempBadge.className = 'card-badge sensor-na';
    } else if (cpu.temperatureAvailable && cpu.temperatureC !== null) {
      const guidance = temperatureGuidance('cpu', cpu.temperatureC);
      cpuTempBadge.textContent = `${cpu.temperatureC}°C · ${guidance.label}`;
      cpuTempBadge.title = `${cpu.temperatureNote || ''}${cpu.temperatureSource ? ` Source: ${cpu.temperatureSource}` : ''} Intel specifies a 100°C Tjunction limit for the i7-10750H.`;
      cpuTempBadge.className = `card-badge ${guidance.level}`;
    } else {
      cpuTempBadge.textContent = 'CPU temperature unavailable';
      cpuTempBadge.title = `${cpu.temperatureNote || 'No reliable CPU temperature provider is available.'}${cpu.temperatureSource ? ` Provider: ${cpu.temperatureSource}` : ''}`;
      cpuTempBadge.className = 'card-badge sensor-na';
    }

    // Per-core micro bars
    if (cpu.perCore && cpu.perCore.length > 0) {
      const coreGrid = document.getElementById('coreBarsGrid');
      coreGrid.innerHTML = cpu.perCore.map((load, idx) => `
        <div class="core-bar-wrapper">
          <div class="core-bar-track">
            <div class="core-bar-level" style="height: ${load}%; background: ${load > 85 ? 'var(--accent-rose)' : load > 65 ? 'var(--accent-amber)' : 'var(--accent-blue)'}"></div>
          </div>
          <span class="core-bar-label">${idx + 1}</span>
        </div>
      `).join('');
    }

    // SSE carries complete snapshots after several independent samplers run.
    // Use the CPU sample timestamp so unrelated updates never duplicate points.
    if (isNewMetricSample('cpu', cpu.sampledAt, data.isoTimestamp)) {
      chartData.cpu.push(cpu.overall);
      if (chartData.cpu.length > MAX_POINTS) chartData.cpu.shift();
      rememberCpuDetailSample(cpu);
      drawSparkline('cpu', [
        { data: chartData.cpu, name: 'CPU load', format: 'percent', color: '#66c7ff', fillColor: 'rgba(102, 199, 255, 0.14)' }
      ], { max: 100, fixedMax: true });
      if (cpuDetailActive) renderCpuDetail();
    }
  }

  // GPU
  const gpu = data.gpu;
  if (gpu) {
    const newGpuSample = isNewMetricSample('gpu', gpu.sampledAt, data.isoTimestamp);
    document.getElementById('gpuNameText').textContent = gpu.name || 'NVIDIA GPU';
    if (gpu.available) {
      document.getElementById('gpuUsageVal').textContent = gpu.utilizationPercent !== null ? gpu.utilizationPercent : '--';
      const gpuBar = document.getElementById('gpuProgressBar');
      gpuBar.style.width = `${gpu.utilizationPercent || 0}%`;

      const hasGpuTemp = gpu.temperatureC !== null && gpu.temperatureC !== undefined;
      const gpuTempFresh = gpu.temperatureAvailable && !gpu.temperatureStale && hasGpuTemp;
      const tempStr = hasGpuTemp ? `${gpu.temperatureC} °C${gpu.temperatureStale ? ' — stale' : ''}` : 'Temperature unavailable';
      const gpuGuidance = gpuTempFresh ? temperatureGuidance('gpu', gpu.temperatureC) : { label: gpu.temperatureStale ? 'Stale' : 'Unavailable', level: 'sensor-na' };
      const gpuBadge = document.getElementById('gpuTempBadge');
      gpuBadge.textContent = gpuTempFresh ? `${tempStr} · ${gpuGuidance.label}` : tempStr;
      gpuBadge.className = `card-badge ${gpuGuidance.level}`;
      gpuBadge.title = `${gpu.temperatureNote || ''}${gpu.temperatureSource ? ` Source: ${gpu.temperatureSource}.` : ''} Temperature guidance is informational; NVIDIA lists a maximum GPU temperature of 95°C and laptop cooling limits can be lower.`;
      document.getElementById('gpuTempChip').textContent = gpuTempFresh ? `${tempStr} · ${gpuGuidance.label}` : tempStr;

      document.getElementById('gpuVramUsed').textContent = gpu.vramUsedMB ? `${(gpu.vramUsedMB / 1024).toFixed(1)} GB` : '--';
      document.getElementById('gpuVramTotal').textContent = gpu.vramTotalMB ? `${(gpu.vramTotalMB / 1024).toFixed(1)} GB` : '--';

      if (newGpuSample) {
        chartData.gpu.push(gpu.utilizationPercent || 0);
        chartData.gpuTemp.push(gpu.temperatureC || 0);
      }
    } else {
      document.getElementById('gpuUsageVal').textContent = 'N/A';
      const staleTemperature = gpu.temperatureC !== null && gpu.temperatureC !== undefined && gpu.temperatureStale;
      const unavailableText = staleTemperature ? `${gpu.temperatureC} °C — stale` : 'Offline / Sleep';
      document.getElementById('gpuTempBadge').textContent = unavailableText;
      document.getElementById('gpuTempBadge').title = gpu.temperatureNote || 'GPU sensor is unavailable.';
      document.getElementById('gpuTempBadge').className = 'card-badge sensor-na';
      document.getElementById('gpuTempChip').textContent = unavailableText;
      if (newGpuSample) {
        chartData.gpu.push(0);
        chartData.gpuTemp.push(0);
      }
    }
    if (newGpuSample) {
      if (chartData.gpu.length > MAX_POINTS) chartData.gpu.shift();
      if (chartData.gpuTemp.length > MAX_POINTS) chartData.gpuTemp.shift();
      drawSparkline('gpu', [
        { data: chartData.gpu, name: 'GPU load', format: 'percent', color: '#8b92ee', fillColor: 'rgba(139, 146, 238, 0.12)' },
        ...(gpu.available && gpu.temperatureC !== null ? [{ data: chartData.gpuTemp, name: 'GPU temp', format: 'temperature', color: '#e8be70' }] : [])
      ], { max: 100, fixedMax: true });
    }
  }

  // RAM
  const ram = data.ram;
  if (ram) {
    document.getElementById('ramUsageVal').textContent = ram.usedPercent;
    document.getElementById('ramFreeBadge').textContent = `${ram.freeGB} GB Free`;
    document.getElementById('ramSubText').textContent = `${ram.usedGB} GB used of ${ram.totalGB} GB total`;
    const ramBar = document.getElementById('ramProgressBar');
    ramBar.style.width = `${ram.usedPercent}%`;
    ramBar.className = `progress-bar-fill ${ram.usedPercent > 90 ? 'bg-rose' : ram.usedPercent > 80 ? 'bg-amber' : 'bg-emerald'}`;

    document.getElementById('ramUsedGB').textContent = `${ram.usedGB} GB`;
    document.getElementById('ramAvailGB').textContent = `${ram.freeGB} GB`;
    document.getElementById('ramTotalGB').textContent = `${ram.totalGB} GB`;

    if (isNewMetricSample('ram', ram.sampledAt, data.isoTimestamp)) {
      chartData.ram.push(ram.usedPercent);
      if (chartData.ram.length > MAX_POINTS) chartData.ram.shift();
      drawSparkline('ram', [
        { data: chartData.ram, name: 'RAM use', format: 'percent', color: '#60d6ab', fillColor: 'rgba(96, 214, 171, 0.12)' }
      ], { max: 100, fixedMax: true });
    }
  }

  // Network
  const net = data.network;
  if (net) {
    document.getElementById('netDownSpeed').textContent = formatSpeed(net.downSpeedKB || 0);
    document.getElementById('netUpSpeed').textContent = formatSpeed(net.upSpeedKB || 0);
    document.getElementById('latencyBadge').textContent = net.latencyStatus;
    document.getElementById('netLatencyText').textContent = net.latencyMs !== null ? `${net.latencyMs} ms` : net.latencyStatus;

    if (isNewMetricSample('network', net.sampledAt, data.isoTimestamp)) {
      chartData.netDown.push(net.downSpeedKB || 0);
      chartData.netUp.push(net.upSpeedKB || 0);
      if (chartData.netDown.length > MAX_POINTS) chartData.netDown.shift();
      if (chartData.netUp.length > MAX_POINTS) chartData.netUp.shift();

      drawSparkline('net', [
        { data: chartData.netDown, name: 'Download', format: 'speed', color: '#60d6ab', fillColor: 'rgba(96, 214, 171, 0.1)' },
        { data: chartData.netUp, name: 'Upload', format: 'speed', color: '#66c7ff' }
      ], { fixedMax: false });
    }
  }

  // Storage / Drives
  const drives = data.drives;
  if (drives && drives.length > 0) {
    document.getElementById('drivesSummaryBadge').textContent = `${drives.length} ${drives.length === 1 ? 'Drive' : 'Drives'} Active`;
    const drivesListEl = document.getElementById('drivesList');
    drivesListEl.innerHTML = drives.map(drive => {
      const colorClass = drive.usedPercent > 90 ? 'bg-rose' : drive.usedPercent > 80 ? 'bg-amber' : 'bg-blue';
      return `
        <div class="drive-item">
          <div class="drive-top">
            <span class="drive-letter">${drive.mount} (${drive.usedPercent}%)</span>
            <span class="drive-stats">${drive.freeGB} GB free of ${drive.totalGB} GB</span>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill ${colorClass}" style="width: ${drive.usedPercent}%;"></div>
          </div>
        </div>
      `;
    }).join('');
  }
}

function updateCpuDetailCores(perCore) {
  const container = document.getElementById('cpuDetailCores');
  const countLabel = document.getElementById('cpuDetailCoreCount');
  if (!container || !countLabel) return;
  const values = Array.isArray(perCore) ? perCore : [];
  countLabel.textContent = values.length ? `${values.length} threads` : 'Unavailable';

  if (Number(container.dataset.coreCount) !== values.length) {
    container.replaceChildren();
    values.forEach((_, index) => {
      const row = document.createElement('div');
      row.className = 'cpu-detail-core';
      row.setAttribute('role', 'listitem');
      const name = document.createElement('span');
      name.className = 'cpu-detail-core-label';
      name.textContent = `Thread ${index + 1}`;
      const track = document.createElement('span');
      track.className = 'cpu-detail-core-track';
      const fill = document.createElement('span');
      fill.className = 'cpu-detail-core-fill';
      track.appendChild(fill);
      const value = document.createElement('span');
      value.className = 'cpu-detail-core-value';
      row.append(name, track, value);
      container.appendChild(row);
    });
    container.dataset.coreCount = String(values.length);
  }

  values.forEach((load, index) => {
    const row = container.children[index];
    if (!row) return;
    const value = Math.max(0, Math.min(100, Number(load) || 0));
    row.querySelector('.cpu-detail-core-fill').style.width = `${value}%`;
    row.querySelector('.cpu-detail-core-fill').style.background = value > 85
      ? 'linear-gradient(90deg, #f59e0b, #fb7185)'
      : 'linear-gradient(90deg, #66c7ff, #818cf8)';
    row.querySelector('.cpu-detail-core-value').textContent = `${Math.round(value)}%`;
  });
}

function updateCpuDetailSampleState() {
  const state = document.getElementById('cpuDetailSampleState');
  if (!state || !cpuDetailDialog?.open) return;
  const latest = cpuDetailSamples[cpuDetailSamples.length - 1];
  if (!latest) {
    state.textContent = 'Waiting for the first CPU sample…';
    return;
  }
  const ageMs = Math.max(0, Date.now() - latest.sampledAt);
  if (ageMs > 5000) {
    state.textContent = 'CPU data is stale · waiting for telemetry to reconnect';
  } else if (cpuDetailProfileReady) {
    state.textContent = `Live · 1-second sampling · ${cpuDetailSamples.length} recent samples`;
  } else {
    state.textContent = 'Connecting focused CPU sampling…';
  }
}

function renderCpuDetail() {
  if (!cpuDetailDialog?.open) return;
  const latest = cpuDetailSamples[cpuDetailSamples.length - 1];
  const current = document.getElementById('cpuDetailCurrent');
  if (latest && current) current.textContent = latest.overall.toFixed(1);
  updateCpuDetailCores(latest?.perCore || []);

  const samples = cpuDetailSamples.slice(-CPU_DETAIL_MAX_POINTS);
  drawSparkline('cpuDetail', [{
    data: samples.map(sample => sample.overall),
    sampleTimes: samples.map(sample => sample.sampledAt),
    name: 'Overall CPU',
    format: 'percent',
    color: '#66c7ff',
    fillColor: 'rgba(56, 189, 248, 0.2)'
  }], {
    max: 100,
    fixedMax: true,
    windowPoints: CPU_DETAIL_MAX_POINTS,
    timeWindowMs: CPU_DETAIL_WINDOW_MS
  });
  updateCpuDetailSampleState();
}

function openCpuDetail() {
  if (!cpuDetailDialog || cpuDetailDialog.open || cpuDetailActive || !dashboardClientVisible()) return;
  cpuDetailActive = true;
  cpuDetailProfileReady = false;
  cpuDetailDialog.showModal();
  renderCpuDetail();
  const state = document.getElementById('cpuDetailSampleState');
  if (state) state.textContent = 'Requesting focused CPU sampling…';
  setMonitoringProfile('cpu-detail').then(success => {
    if (!cpuDetailActive) return;
    cpuDetailProfileReady = success;
    if (!success && state) state.textContent = monitoringLeaseId
      ? 'Focused sampling is reconnecting…'
      : 'Waiting for the dashboard monitoring lease…';
    updateCpuDetailSampleState();
  });
}

function closeCpuDetail() {
  if (cpuDetailDialog?.open) cpuDetailDialog.close();
}

document.getElementById('openCpuDetailButton')?.addEventListener('click', openCpuDetail);
document.getElementById('closeCpuDetailButton')?.addEventListener('click', closeCpuDetail);
cpuDetailDialog?.addEventListener('click', event => {
  if (event.target === cpuDetailDialog) closeCpuDetail();
});
cpuDetailDialog?.addEventListener('close', () => {
  const wasActive = cpuDetailActive;
  cpuDetailActive = false;
  cpuDetailProfileReady = false;
  clearChartSelection('cpuDetail');
  const shouldRestore = wasActive && !suppressCpuProfileRestore && dashboardClientVisible() && monitoringLeaseId;
  suppressCpuProfileRestore = false;
  if (shouldRestore) setMonitoringProfile('dashboard');
});

function getSystemSpecsText(data) {
  const system = data.system || {};
  const cpu = data.cpu || {};
  const gpu = data.gpu || {};
  const ram = data.ram || {};
  const drives = data.drives || [];
  const gpuNames = system.gpuModels && system.gpuModels.length ? system.gpuModels.join(' + ') : (gpu.name || 'Unknown');
  const storage = drives.length
    ? drives.map(drive => `${drive.mount}: ${drive.freeGB} GB free of ${drive.totalGB} GB (${drive.usedPercent}% used)`).join('\n')
    : 'No drives detected';
  const cpuTemperature = cpu.temperatureC !== null && cpu.temperatureStale
    ? `${cpu.temperatureC} °C (stale)`
    : cpu.temperatureAvailable && cpu.temperatureC !== null ? `${cpu.temperatureC} °C` : 'Unavailable';
  const gpuTemperature = gpu.temperatureC !== null && gpu.temperatureStale
    ? `${gpu.temperatureC} °C (stale)`
    : gpu.temperatureAvailable && gpu.temperatureC !== null ? `${gpu.temperatureC} °C` : 'Unavailable';
  const network = data.network || {};

  return [
    'PC specifications',
    `Computer: ${system.hostname || 'Windows PC'}`,
    `Operating system: ${system.windowsVersion || 'Unknown'}`,
    `Processor: ${cpu.model || system.cpuModel || 'Unknown'} (${cpu.cores || '?'} cores / ${cpu.threads || '?'} threads)`,
    `CPU load: ${cpu.overall ?? 'N/A'}% · ${cpu.temperatureProvider?.mode === 'thermal-zone' ? 'System thermal zone (experimental)' : 'CPU temperature'}: ${cpu.temperatureProvider?.mode === 'off' ? 'Off' : cpuTemperature}`,
    `Graphics: ${gpuNames}`,
    `GPU load: ${gpu.available ? `${gpu.utilizationPercent ?? 'N/A'}%` : 'Unavailable'} · GPU temperature: ${gpuTemperature}`,
    `Video memory: ${gpu.vramUsedMB != null && gpu.vramTotalMB != null ? `${(gpu.vramUsedMB / 1024).toFixed(1)} GB used of ${(gpu.vramTotalMB / 1024).toFixed(1)} GB` : 'Unavailable'}`,
    `Memory: ${ram.totalGB ?? 'N/A'} GB total · ${ram.usedGB ?? 'N/A'} GB used · ${ram.freeGB ?? 'N/A'} GB available`,
    `Storage:\n${storage}`,
    `Architecture: ${system.arch || 'Unknown'}`,
    `Network latency: ${network.latencyStatus || 'unavailable'}`,
    `Uptime: ${data.uptime || 'Unknown'}`,
    'Connection security: WireGuard / Tailscale'
  ].join('\n');
}

async function copySystemSpecs() {
  const status = document.getElementById('specsCopyStatus');
  const button = document.getElementById('copySpecsButton');
  if (!latestDashboardMetrics) {
    status.textContent = 'Specs are still loading';
    return;
  }

  const text = getSystemSpecsText(latestDashboardMetrics);
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const input = document.createElement('textarea');
      input.value = text;
      input.setAttribute('readonly', '');
      input.style.position = 'fixed';
      input.style.opacity = '0';
      document.body.appendChild(input);
      input.select();
      const copied = document.execCommand('copy');
      input.remove();
      if (!copied) throw new Error('Clipboard permission unavailable');
    }
    status.textContent = 'Copied';
    button.classList.add('copied');
    window.setTimeout(() => {
      status.textContent = '';
      button.classList.remove('copied');
    }, 1800);
  } catch (_) {
    status.textContent = 'Copy blocked by browser';
  }
}

document.getElementById('copySpecsButton')?.addEventListener('click', copySystemSpecs);

// Connect to Server-Sent Events (SSE) stream with graceful fallback
let eventSource = null;
let pollInterval = null;
let pollController = null;
let reconnectTimer = null;
let leaseHeartbeatTimer = null;
let desktopClientVisible = true;
function dashboardClientVisible() { return desktopClientVisible && document.visibilityState === 'visible'; }
let leaseHeartbeatInFlight = false;
let monitoringLeaseId = null;
let dashboardSessionStarting = false;
let desiredMonitoringProfile = 'dashboard';
let appliedMonitoringProfile = null;
let currentAppPage = 'dashboardPage';
let profileRequestQueue = Promise.resolve();
let profileRequestPending = false;
const supportedMonitoringProfiles = new Set(['dashboard', 'cpu-detail', 'gpu-detail', 'network-detail', 'storage-detail', 'processes']);
const reconnectBanner = document.getElementById('reconnectBanner');
let authRedirecting = false;

function redirectToLogin() {
  if (authRedirecting) return;
  authRedirecting = true;
  stopLeaseHeartbeat();
  closeDashboardConnections();
  window.location.replace('/');
}

function connectStream() {
  if (window.pcMonitorUninstalling) return;
  if (!dashboardClientVisible() || eventSource) return;
  clearTimeout(reconnectTimer);
  const streamUrl = monitoringLeaseId
    ? `/api/stream?lease=${encodeURIComponent(monitoringLeaseId)}`
    : '/api/stream';
  const source = new EventSource(streamUrl);
  eventSource = source;

  source.onopen = () => {
    if (eventSource !== source) return;
    reconnectBanner.style.display = 'none';
    stopPolling();
    window.dispatchEvent(new CustomEvent('pc-monitor-stream-state', { detail: { connected: true } }));
    updateCpuDetailSampleState();
  };

  source.addEventListener('apps-operation', event=>{if(eventSource===source){try{window.dispatchEvent(new CustomEvent('rovarin-apps-operation',{detail:JSON.parse(event.data)}));}catch(_){}}});
  source.addEventListener('processes', event => {
    if (eventSource !== source) return;
    try { window.dispatchEvent(new CustomEvent('pc-monitor-processes', { detail: JSON.parse(event.data) })); } catch (_) {}
  });

  source.onmessage = (event) => {
    if (eventSource !== source) return;
    reconnectBanner.style.display = 'none';
    try {
      const data = JSON.parse(event.data);
      if (data) updateUI(data);
    } catch (e) {
      console.error('Failed to parse SSE payload:', e);
    }
  };

  source.onerror = () => {
    if (eventSource !== source) return;
    source.close();
    eventSource = null;
    window.dispatchEvent(new CustomEvent('pc-monitor-stream-state', { detail: { connected: false } }));
    if (!dashboardClientVisible()) return;
    reconnectBanner.style.display = 'block';
    const sampleState = document.getElementById('cpuDetailSampleState');
    if (cpuDetailActive && sampleState) sampleState.textContent = 'Connection interrupted · keeping the latest CPU samples';
    startPolling();
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connectStream, 4000);
  };
}

function stopPolling() {
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
  if (pollController) pollController.abort();
  pollController = null;
}

function stopLeaseHeartbeat() {
  if (leaseHeartbeatTimer) clearInterval(leaseHeartbeatTimer);
  leaseHeartbeatTimer = null;
}

function closeDashboardConnections() {
  stopPolling();
  clearTimeout(reconnectTimer);
  reconnectTimer = null;
  if (eventSource) eventSource.close();
  eventSource = null;
  window.dispatchEvent(new CustomEvent('pc-monitor-stream-state', { detail: { connected: false } }));
}

async function acquireMonitoringLease() {
  if (window.pcMonitorUninstalling) return false;
  if (monitoringLeaseId) return true;
  try {
    const res = await fetch('/api/monitoring/lease', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'acquire' })
    });
    if (res.status === 401) { redirectToLogin(); return false; }
    if (!res.ok) return false;
    const data = await res.json();
    if (window.pcMonitorUninstalling) return false;
    monitoringLeaseId = data.leaseId || null;
    if (monitoringLeaseId) appliedMonitoringProfile = 'dashboard';
    return !!monitoringLeaseId;
  } catch (_) {
    return false;
  }
}

async function heartbeatMonitoringLease() {
  if (window.pcMonitorUninstalling) return;
  if (!monitoringLeaseId || !dashboardClientVisible() || leaseHeartbeatInFlight) return;
  leaseHeartbeatInFlight = true;
  try {
    const res = await fetch('/api/monitoring/lease', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ action: 'heartbeat', leaseId: monitoringLeaseId })
    });
    if (reloadForDashboardUpdate(res)) return;
    if (res.status === 410) {
      closeDashboardConnections();
      stopLeaseHeartbeat();
      monitoringLeaseId = null;
      appliedMonitoringProfile = null;
      await startDashboardSession();
      return;
    }
    if (res.status === 401) { redirectToLogin(); return; }
    if (appliedMonitoringProfile !== desiredMonitoringProfile && !profileRequestPending) {
      await setMonitoringProfile(desiredMonitoringProfile);
    }
  } catch (_) {
    // The server expires this lease automatically if the phone cannot heartbeat.
  } finally {
    leaseHeartbeatInFlight = false;
  }
}

function startLeaseHeartbeat() {
  if (window.pcMonitorUninstalling) return;
  stopLeaseHeartbeat();
  if (monitoringLeaseId) leaseHeartbeatTimer = setInterval(heartbeatMonitoringLease, 15000);
  if (monitoringLeaseId && currentAppPage === 'processesPage' && desiredMonitoringProfile !== 'processes') setMonitoringProfile('processes');
}

// Focused views can request a profile through this helper without adding a
// second lease or sampler loop. The server keeps the dashboard baseline active.
function setMonitoringProfile(profile = 'dashboard') {
  if (window.pcMonitorUninstalling) return Promise.resolve(false);
  if (!supportedMonitoringProfiles.has(profile)) return Promise.resolve(false);
  desiredMonitoringProfile = profile;
  if (!monitoringLeaseId) return Promise.resolve(false);
  if (appliedMonitoringProfile === profile && !profileRequestPending) return Promise.resolve(true);

  const leaseId = monitoringLeaseId;
  const requestProfile = async () => {
    if (monitoringLeaseId !== leaseId || desiredMonitoringProfile !== profile) return false;
    if (appliedMonitoringProfile === profile) return true;
    try {
      const res = await fetch('/api/monitoring/lease', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'set-profile', leaseId, profile })
      });
      if (res.status === 410) {
        stopLeaseHeartbeat();
        closeDashboardConnections();
        monitoringLeaseId = null;
        appliedMonitoringProfile = null;
        window.setTimeout(() => startDashboardSession(), 0);
        return false;
      }
      if (res.status === 401) { redirectToLogin(); return false; }
      if (!res.ok) return false;
      const result = await res.json();
      if (result.success === true && result.profile === profile) {
        appliedMonitoringProfile = profile;
        return true;
      }
    } catch (_) {}
    return false;
  };

  const queuedRequest = profileRequestQueue.catch(() => false).then(requestProfile);
  profileRequestQueue = queuedRequest;
  profileRequestPending = true;
  queuedRequest.finally(() => {
    if (profileRequestQueue === queuedRequest) profileRequestPending = false;
  });
  return queuedRequest;
}

window.setMonitoringProfile = setMonitoringProfile;
Object.defineProperty(window, 'monitoringLeaseId', { get: () => monitoringLeaseId });

const appPageHistory = ['dashboardPage'];
let appPageHistoryIndex = 0;
function updatePageHistoryControls() {
  const back = document.getElementById('nativeBackButton');
  const forward = document.getElementById('nativeForwardButton');
  if (back) back.disabled = appPageHistoryIndex === 0;
  if (forward) forward.disabled = appPageHistoryIndex === appPageHistory.length - 1;
}
function showAppPage(pageId, recordHistory = true) {
  const nextPage = ['processesPage', 'appsPage', 'maintenancePage', 'diagnosticsPage'].includes(pageId) ? pageId : 'dashboardPage';
  if (recordHistory && appPageHistory[appPageHistoryIndex] !== nextPage) {
    appPageHistory.splice(appPageHistoryIndex + 1);
    appPageHistory.push(nextPage);
    if (appPageHistory.length > 100) appPageHistory.shift();
    appPageHistoryIndex = appPageHistory.length - 1;
  }
  updatePageHistoryControls();
  currentAppPage = nextPage;
  const sectionTitle = { dashboardPage: 'Dashboard', processesPage: 'Processes', appsPage: 'Applications', maintenancePage: 'Maintenance', diagnosticsPage: 'Settings' }[nextPage];
  document.getElementById('appSectionTitle').textContent = sectionTitle;
  document.title = 'Rovarin · ' + sectionTitle;
  // Phone content scrolls below the chrome, not behind the status bar.
  document.querySelector('.dashboard-container')?.scrollTo(0, 0);
  phoneScrollPosition = 0;
  phoneScrollTravel = 0;
  document.querySelectorAll('.app-page').forEach(page => {
    const active = page.id === nextPage;
    page.hidden = !active;
    page.classList.toggle('is-active', active);
  });
  document.querySelectorAll('.page-nav-button').forEach(button => {
    const active = button.dataset.page === nextPage;
    button.classList.toggle('is-active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  const settingsButton = document.getElementById('nativeSettingsButton');
  settingsButton.classList.toggle('is-active', nextPage === 'diagnosticsPage');
  if (nextPage === 'diagnosticsPage') settingsButton.setAttribute('aria-current', 'page');
  else settingsButton.removeAttribute('aria-current');
  if (nextPage === 'processesPage' && !monitoringLeaseId) startDashboardSession();
  setMonitoringProfile(nextPage === 'processesPage' ? 'processes' : 'dashboard');
  window.dispatchEvent(new CustomEvent('pc-monitor-pagechange', { detail: { page: nextPage } }));
}

// Only presentation moves: one dashboard, no new telemetry or lease work.
const phoneChromeQuery = matchMedia('(max-width: 699px)');
const phoneScrollPane = document.querySelector('.dashboard-container');
const phonePageSurface = document.querySelector('.phone-page-surface');
const phoneMenu = document.querySelector('.native-app-bar');
function isPhoneSurface() {
  return phoneChromeQuery.matches && !document.documentElement.classList.contains('native-shell');
}
function syncPhoneSurface() {
  // Keep navigation outside the scrolling content on every presentation.
  phonePageSurface.insertBefore(phoneMenu, phoneScrollPane);
}
syncPhoneSurface();
function finishPhoneDrawerDrag() {
  document.body.classList.remove('phone-drawer-dragging');
  document.body.style.removeProperty('--phone-drawer-offset');
  document.body.style.removeProperty('--phone-drawer-progress');
}
let phoneDrawerSwipe = null;
document.addEventListener('touchstart', event => {
  phoneDrawerSwipe = null;
  finishPhoneDrawerDrag();
  if (!isPhoneSurface() || event.touches.length !== 1) return;
  const target = event.target instanceof Element ? event.target : null;
  const open = document.body.classList.contains('sidebar-expanded');
  if (!target || (target.closest('input, textarea, select, button, a, canvas, video, [role="slider"], .processes-table') && !target.closest('#sidebarBackdrop') && !(open && target.closest('#appSidebar')))) return;
  if (!target.closest(open ? '.phone-page-surface, #appSidebar' : '.dashboard-container')) return;
  const point = event.touches[0];
  phoneDrawerSwipe = { x: point.clientX, y: point.clientY, open, horizontal: false, width: document.getElementById('appSidebar').getBoundingClientRect().width, time: performance.now() };
}, { passive: true });
document.addEventListener('touchmove', event => {
  if (!phoneDrawerSwipe) return;
  if (event.touches.length !== 1) { phoneDrawerSwipe = null; finishPhoneDrawerDrag(); return; }
  const swipe = phoneDrawerSwipe;
  const point = event.touches[0];
  const dx = point.clientX - swipe.x;
  const dy = point.clientY - swipe.y;
  if (!swipe.horizontal && Math.abs(dy) > 12 && Math.abs(dy) >= Math.abs(dx)) { phoneDrawerSwipe = null; return; }
  if (!swipe.horizontal && (swipe.open ? dx < -12 : dx > 12) && Math.abs(dx) > Math.abs(dy) * 1.4) swipe.horizontal = true;
  if (!swipe.horizontal) return;
  if (event.cancelable) event.preventDefault();
  const offset = Math.max(0, Math.min(swipe.width, (swipe.open ? swipe.width : 0) + dx));
  document.body.classList.add('phone-drawer-dragging');
  document.body.style.setProperty('--phone-drawer-offset', offset + 'px');
  document.body.style.setProperty('--phone-drawer-progress', String(offset / swipe.width));
}, { passive: false });
document.addEventListener('touchend', event => {
  const swipe = phoneDrawerSwipe;
  phoneDrawerSwipe = null;
  if (!swipe || !swipe.horizontal) return;
  if (event.touches.length || event.changedTouches.length !== 1) { finishPhoneDrawerDrag(); return; }
  const point = event.changedTouches[0];
  const dx = point.clientX - swipe.x;
  const intentional = (swipe.open ? dx < 0 : dx > 0) && Math.abs(dx) > Math.abs(point.clientY - swipe.y) * 1.4;
  const committed = intentional && (Math.abs(dx) > swipe.width * .3 || (Math.abs(dx) > 28 && Math.abs(dx) / Math.max(16, performance.now() - swipe.time) > .5));
  if (event.cancelable) event.preventDefault();
  setSidebarOpen(committed ? !swipe.open : swipe.open);
}, { passive: false });
document.addEventListener('touchcancel', () => { phoneDrawerSwipe = null; finishPhoneDrawerDrag(); }, { passive: true });
function setSidebarOpen(open) {
  finishPhoneDrawerDrag();
  document.body.classList.toggle('sidebar-expanded', open);
  document.getElementById('sidebarToggle').setAttribute('aria-expanded', String(open));
  document.getElementById('sidebarToggle').setAttribute('aria-label', open ? 'Close navigation' : 'Open navigation');
  document.querySelectorAll('.app-page').forEach(page => { page.inert = open && isPhoneSurface(); });
  document.getElementById('appSidebar').inert = !open && matchMedia('(max-width: 699px)').matches;
  // Keep the mobile backdrop mounted so its closing fade can finish. CSS
  // disables its hit testing immediately; desktop never needs an overlay.
  document.getElementById('sidebarBackdrop').hidden = !matchMedia('(max-width: 699px)').matches;
  if (!matchMedia('(max-width: 699px)').matches) { try { localStorage.setItem('pc-monitor-sidebar-expanded', String(open)); } catch (_) {} }
}
document.getElementById('sidebarToggle')?.addEventListener('click', () => setSidebarOpen(!document.body.classList.contains('sidebar-expanded')));
document.getElementById('sidebarBackdrop')?.addEventListener('click', () => setSidebarOpen(false));
document.addEventListener('keydown', event => { if (event.key === 'Escape') setSidebarOpen(false); });
matchMedia('(max-width: 699px)').addEventListener('change', event => {
  syncPhoneSurface();
  let expanded = false;
  if (!event.matches) { try { expanded = localStorage.getItem('pc-monitor-sidebar-expanded') === 'true'; } catch (_) {} }
  setSidebarOpen(expanded);
});
try { if (!matchMedia('(max-width: 699px)').matches) setSidebarOpen(localStorage.getItem('pc-monitor-sidebar-expanded') === 'true'); } catch (_) {}
if (matchMedia('(max-width: 699px)').matches) setSidebarOpen(false);
document.querySelectorAll('.page-nav-button[data-page]').forEach(button => button.addEventListener('click', () => {
  showAppPage(button.dataset.page);
  if (matchMedia('(max-width: 699px)').matches) setSidebarOpen(false);
}));
// One-time phone setup sheet after the first successful phone entry; presentation only.
// MOBILE-ONBOARDING:BEGIN
const mobileOnboardingSeenKey = 'rovarin.mobileOnboardingSeen';
function mobileOnboardingVariant(userAgent, platform, touchPoints) {
  const ua = userAgent || '';
  const ios = /iPad|iPhone|iPod/.test(ua) || (platform === 'MacIntel' && touchPoints > 1);
  if (ios && /Safari\//.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser/.test(ua)) return 'ios';
  if (/Android/.test(ua) && /Chrome\//.test(ua) && !/EdgA\/|SamsungBrowser|Vivaldi|OPR\/|HuaweiBrowser|MiuiBrowser/.test(ua)) return 'android';
  return 'generic';
}
const mobileOnboardingSteps = {
  ios: ['Tap the Share button', 'Tap "Add to Home Screen"', 'Tap Add'],
  android: ['Open the browser menu', 'Choose "Add to Home screen" or "Install app"', 'Confirm'],
  generic: ['Open your browser menu', 'Choose "Add to Home screen" (or "Install app")', 'Confirm']
};
function mobileOnboardingState() {
  const native = !!window.chrome?.webview || document.documentElement.classList.contains('native-shell');
  const mobileDevice = /iPhone|iPad|iPod|Android/.test(navigator.userAgent || '') ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const phone = !native && mobileDevice && matchMedia('(max-width: 699px)').matches;
  let seen = false;
  try { seen = localStorage.getItem(mobileOnboardingSeenKey) === 'true'; } catch (_) {}
  let standalone = matchMedia('(display-mode: standalone)').matches;
  if (!standalone && navigator.standalone === true) standalone = true;
  const variant = mobileOnboardingVariant(navigator.userAgent || '', navigator.platform || '', navigator.maxTouchPoints || 0);
  return { show: phone && !seen, native, standalone, variant, steps: mobileOnboardingSteps[variant] };
}
function maybeShowMobileOnboarding() {
  try {
    const state = mobileOnboardingState();
    const dialog = document.getElementById('mobileOnboardingDialog');
    if (!state.show || !dialog || dialog.open) return false;
    const steps = document.getElementById('mobileOnboardingSteps');
    const install = document.getElementById('mobileOnboardingInstall');
    const dismiss = document.getElementById('mobileOnboardingDismiss');
    steps.replaceChildren(...state.steps.map(text => { const li = document.createElement('li'); li.textContent = text; return li; }));
    install.hidden = state.standalone;
    dialog.showModal();
    dialog.addEventListener('close', () => { try { localStorage.setItem(mobileOnboardingSeenKey, 'true'); } catch (_) {} }, { once: true });
    dismiss.addEventListener('click', () => dialog.close(), { once: true });
    return true;
  } catch (_) { return false; }
}
// MOBILE-ONBOARDING:END
const nativeSecurity = !!window.chrome?.webview;
document.getElementById('nativeSecurityControls').hidden = !nativeSecurity;
function showSecuritySettings(security) {
  document.getElementById('updatesSettingsPanel').hidden = true;
  document.getElementById('updatesSettingsTab').setAttribute('aria-selected', 'false');
  document.getElementById('securitySettingsPanel').hidden = !security;
  document.getElementById('generalSettingsPanel').hidden = security;
  document.getElementById('securitySettingsTab').setAttribute('aria-selected', String(security));
  document.getElementById('generalSettingsTab').setAttribute('aria-selected', String(!security));
}
document.getElementById('securitySettingsTab').addEventListener('click', () => {
  showSecuritySettings(true);
  if (nativeSecurity) window.chrome.webview.postMessage('security-status');
});
document.getElementById('generalSettingsTab').addEventListener('click', () => showSecuritySettings(false));
document.getElementById('desktopPinPreference').addEventListener('click', event => { event.preventDefault(); if (nativeSecurity) window.chrome.webview.postMessage('security-preference'); });
document.getElementById('generateDesktopPin').addEventListener('click', () => { if (nativeSecurity) window.chrome.webview.postMessage('security-rotate'); });
if (nativeSecurity) window.chrome.webview.addEventListener('message', event => {
  if (event.data?.kind !== 'security-state' || typeof event.data.requireDesktopPin !== 'boolean') return;
  document.getElementById('desktopPinPreference').checked = event.data.requireDesktopPin;
  document.getElementById('desktopPinPreference').disabled = false;
});
const updateElement = id => document.getElementById(id);
updateElement('nativeUpdateControls').hidden = !nativeSecurity;
updateElement('remoteUpdateHint').hidden = nativeSecurity;
let lastUpdateStatus = null;
function renderUpdateStatus(status) {
  lastUpdateStatus = status;
  updateElement('updateCurrentVersion').textContent = status.currentVersion || '—';
  updateElement('updateLatestVersion').textContent = status.latestVersion ? ' · Latest: ' + status.latestVersion : '';
  updateElement('updateStatus').textContent = status.message || 'Update check unavailable.';
  updateElement('updateReleaseSummary').textContent = status.releaseNotes || '';
  if (!nativeSecurity) return;
  updateElement('autoCheckUpdates').checked = status.autoCheck !== false;
  updateElement('autoCheckUpdates').disabled = !!status.busy;
  updateElement('checkUpdates').disabled = !!status.busy;
  updateElement('installUpdate').hidden = !status.available;
  updateElement('installUpdate').disabled = !!status.busy || !status.installed;
  updateElement('updateLater').hidden = !status.available;
  updateElement('viewUpdateNotes').hidden = !status.releaseUrl;
  if (!status.installed) updateElement('updateStatus').textContent += ' Install updates through an installed Windows copy; the development project is not replaced.';
}
updateElement('updatesSettingsTab').addEventListener('click', () => {
  showSecuritySettings(false);
  updateElement('generalSettingsPanel').hidden = true;
  updateElement('generalSettingsTab').setAttribute('aria-selected', 'false');
  updateElement('updatesSettingsPanel').hidden = false;
  updateElement('updatesSettingsTab').setAttribute('aria-selected', 'true');
  if (nativeSecurity) window.chrome.webview.postMessage('updates-status');
  else fetch('/api/updates').then(r => r.ok ? r.json() : Promise.reject()).then(renderUpdateStatus).catch(() => { updateElement('updateStatus').textContent = 'Sign in again to view the installed version.'; });
});
for (const [id, action] of [['checkUpdates','check'],['installUpdate','install'],['autoCheckUpdates','preference'],['viewUpdateNotes','notes']]) {
  updateElement(id).addEventListener('click', event => {
    if (id === 'autoCheckUpdates') event.preventDefault();
    if (nativeSecurity) {
      updateElement('checkUpdates').disabled = true;
      updateElement('installUpdate').disabled = true;
      updateElement('autoCheckUpdates').disabled = true;
      if (action === 'check' || action === 'install') updateElement('updateStatus').textContent = action === 'check' ? 'Checking official GitHub releases…' : 'Waiting for native update confirmation…';
      window.chrome.webview.postMessage('updates-' + action);
    }
  });
}
updateElement('updateLater').addEventListener('click', () => { updateElement('installUpdate').hidden = true; updateElement('updateLater').hidden = true; updateElement('updateStatus').textContent = 'You can return here to update when ready.'; });
if (nativeSecurity) window.chrome.webview.addEventListener('message', event => {
  if (event.data?.kind === 'updates-state') renderUpdateStatus(event.data.status);
  if (event.data?.kind === 'updates-error') {
    if (lastUpdateStatus) renderUpdateStatus(lastUpdateStatus);
    updateElement('updateStatus').textContent = event.data.message;
  }
});
window.showAppPage = showAppPage;
document.getElementById('nativeBackButton')?.addEventListener('click', () => {
  if (appPageHistoryIndex === 0) return;
  showAppPage(appPageHistory[--appPageHistoryIndex], false);
  window.scrollTo(0, 0);
});
document.getElementById('nativeForwardButton')?.addEventListener('click', () => {
  if (appPageHistoryIndex >= appPageHistory.length - 1) return;
  showAppPage(appPageHistory[++appPageHistoryIndex], false);
  window.scrollTo(0, 0);
});
document.getElementById('nativeSettingsButton')?.addEventListener('click', () => {
  showAppPage('diagnosticsPage');
  if (matchMedia('(max-width: 699px)').matches) setSidebarOpen(false);
  requestAnimationFrame(() => {
    document.querySelector('.temperature-settings')?.scrollIntoView({ block: 'start' });
    document.getElementById('monitorSettings')?.focus({ preventScroll: true });
  });
});

async function releaseMonitoringLease() {
  stopLeaseHeartbeat();
  closeDashboardConnections();
  const leaseId = monitoringLeaseId;
  monitoringLeaseId = null;
  desiredMonitoringProfile = 'dashboard';
  appliedMonitoringProfile = null;
  profileRequestPending = false;
  if (!leaseId || window.pcMonitorUninstalling) return;
  const body = JSON.stringify({ action: 'release', leaseId });
  try {
    if (navigator.sendBeacon) {
      const queued = navigator.sendBeacon('/api/monitoring/lease', new Blob([body], { type: 'text/plain;charset=UTF-8' }));
      if (queued) return;
    }
    await fetch('/api/monitoring/lease', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body
    });
  } catch (_) {
    // Lease timeout is the fallback when unload/background delivery fails.
  }
}

async function startDashboardSession() {
  if (window.pcMonitorUninstalling) return;
  if (dashboardSessionStarting || !dashboardClientVisible()) return;
  dashboardSessionStarting = true;
  try {
    const acquired = await acquireMonitoringLease();
    if (!acquired) return;
    if (!dashboardClientVisible()) {
      await releaseMonitoringLease();
      return;
    }
    await fetchInitialMetrics();
    connectStream();
    startLeaseHeartbeat();
    maybeShowMobileOnboarding();
    if (desiredMonitoringProfile !== appliedMonitoringProfile) {
      const profileApplied = await setMonitoringProfile(desiredMonitoringProfile);
      if (cpuDetailActive) {
        cpuDetailProfileReady = profileApplied;
        updateCpuDetailSampleState();
      }
    }
  } finally {
    dashboardSessionStarting = false;
  }
}

async function fetchInitialMetrics() {
  try {
    const headers = monitoringLeaseId ? { 'X-Monitor-Lease': monitoringLeaseId } : {};
    const res = await fetch('/api/metrics', { headers, credentials: 'same-origin' });
    if (res.status === 401) {
      redirectToLogin();
      return;
    }
    if (res.status === 410 && monitoringLeaseId) {
      monitoringLeaseId = null;
      return;
    }
    const data = await res.json();
    if (data.history && data.history.cpuUsage) {
      chartData.cpu = data.history.cpuUsage.slice(-MAX_POINTS);
      chartData.gpu = data.history.gpuUsage.slice(-MAX_POINTS);
      chartData.gpuTemp = data.history.gpuTemp.slice(-MAX_POINTS);
      chartData.ram = data.history.ramUsagePercent.slice(-MAX_POINTS);
      chartData.netDown = data.history.networkDownKB.slice(-MAX_POINTS);
      chartData.netUp = data.history.networkUpKB.slice(-MAX_POINTS);
    }
    if (data.metrics) {
      updateUI(data.metrics);
    }
  } catch (err) {
    console.warn('Initial fetch error:', err);
  }
}

function startPolling() {
  if (window.pcMonitorUninstalling) return;
  if (pollInterval || !dashboardClientVisible() || eventSource) return;
  pollInterval = setInterval(async () => {
    if (pollController) return;
    const controller = new AbortController();
    pollController = controller;
    try {
      const headers = monitoringLeaseId ? { 'X-Monitor-Lease': monitoringLeaseId } : {};
      const res = await fetch('/api/metrics', { headers, credentials: 'same-origin', signal: controller.signal });
      if (res.status === 401) { redirectToLogin(); return; }
      if (res.ok) {
        reconnectBanner.style.display = 'none';
        const data = await res.json();
        if (data.metrics) updateUI(data.metrics);
      } else if (res.status === 410 && monitoringLeaseId) {
        monitoringLeaseId = null;
        await startDashboardSession();
      }
    } catch (e) {
      if (e.name !== 'AbortError') reconnectBanner.style.display = 'block';
    } finally {
      if (pollController === controller) pollController = null;
    }
  }, 4000);
}

// Window resize handler for canvas charts
window.addEventListener('resize', () => {
  if (chartData.cpu.length > 0) {
    drawSparkline('cpu', [{ data: chartData.cpu, name: 'CPU load', format: 'percent', color: '#66c7ff', fillColor: 'rgba(102, 199, 255, 0.14)' }], { max: 100, fixedMax: true });
    drawSparkline('gpu', [
      { data: chartData.gpu, name: 'GPU load', format: 'percent', color: '#8b92ee', fillColor: 'rgba(139, 146, 238, 0.12)' },
      ...(latestDashboardMetrics?.gpu?.available && latestDashboardMetrics.gpu.temperatureC !== null ? [{ data: chartData.gpuTemp, name: 'GPU temp', format: 'temperature', color: '#e8be70' }] : [])
    ], { max: 100, fixedMax: true });
    drawSparkline('ram', [{ data: chartData.ram, name: 'RAM use', format: 'percent', color: '#60d6ab', fillColor: 'rgba(96, 214, 171, 0.12)' }], { max: 100, fixedMax: true });
    drawSparkline('net', [
      { data: chartData.netDown, name: 'Download', format: 'speed', color: '#60d6ab', fillColor: 'rgba(96, 214, 171, 0.1)' },
      { data: chartData.netUp, name: 'Upload', format: 'speed', color: '#66c7ff' }
    ], { fixedMax: false });
  }
});

// Initialize on page load
setupInteractiveCharts();
document.getElementById('logoutButton')?.addEventListener('click', async () => {
  if (nativeSecurity) { window.chrome.webview.postMessage('security-lock'); return; }
  try {
    const response = await fetch('/api/logout', { method: 'POST', credentials: 'same-origin' });
    if (!response.ok) { alert('Rovarin could not lock. Please try again.'); return; }
    window.location.replace('/');
  } catch (_) { alert('Rovarin could not lock. Please try again.'); }
});
window.addEventListener('DOMContentLoaded', async () => {
  await startDashboardSession();
});

function handleDashboardVisibility() {
  if (!dashboardClientVisible()) {
    if (cpuDetailDialog?.open) {
      cpuDetailActive = false;
      cpuDetailProfileReady = false;
      cpuDetailDialog.close();
    }
    releaseMonitoringLease();
  }
  else { checkDashboardUpdate(); startDashboardSession(); }
}
document.addEventListener('visibilitychange', handleDashboardVisibility);
// Native host visibility is an additional client condition, never authorization.
// Browsers/iPhones keep the normal document visibility behavior unchanged.
window.addEventListener('pc-monitor-desktop-visibility', event => {
  if (typeof event.detail?.visible !== 'boolean') return;
  desktopClientVisible = event.detail.visible;
  handleDashboardVisibility();
});
window.addEventListener('pagehide', () => {
  if (cpuDetailDialog?.open) {
    suppressCpuProfileRestore = true;
    cpuDetailActive = false;
    cpuDetailProfileReady = false;
    cpuDetailDialog.close();
  }
  releaseMonitoringLease();
});
window.addEventListener('pageshow', () => {
  suppressCpuProfileRestore = false;
  if (dashboardClientVisible()) { checkDashboardUpdate(); startDashboardSession(); }
});
window.addEventListener('pc-monitor-uninstalling', () => {
  authRedirecting = true;
  stopLeaseHeartbeat(); closeDashboardConnections();
  monitoringLeaseId = null; window.monitoringLeaseId = null;
  reconnectBanner.style.display = 'none';
  document.querySelectorAll('.page-nav-button').forEach(button => { button.disabled = true; });
});
