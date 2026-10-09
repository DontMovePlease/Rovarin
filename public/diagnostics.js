'use strict';

(() => {
  const clientVisible = () => typeof window.dashboardClientVisible === 'function' ? window.dashboardClientVisible() : document.visibilityState === 'visible';
  const page = document.getElementById('diagnosticsPage');
  const refreshButton = document.getElementById('refreshDiagnostics');
  const copyButton = document.getElementById('copyDiagnostics');
  const feedback = document.getElementById('diagnosticsFeedback');
  const reportField = document.getElementById('diagnosticsReport');
  let busy = false;
  let savingMode = false;
  const modeSelector = document.getElementById('cpuTemperatureMode');
  const saveMode = document.getElementById('saveTemperatureMode');

  function reportText(data) {
    return ['Rovarin compatibility report', `Checked: ${data.generatedAt}`, data.overall.title,
      ...data.checks.map(check => `${check.label}: ${check.status}${check.value !== undefined && typeof check.value !== 'object' ? ` · ${check.value}` : ''}\n  ${check.summary}`)
    ].join('\n');
  }

  function render(data) {
    if (modeSelector && data.temperatureSettings) modeSelector.value = data.temperatureSettings.mode;
    const experimental = document.getElementById('experimentalTemperatureOption');
    const allowExperimental = document.getElementById('enableExperimentalTemperature');
    if (experimental && allowExperimental && modeSelector.value === 'thermal-zone') {
      allowExperimental.checked = true; experimental.hidden = false; experimental.disabled = false;
      document.getElementById('temperatureAdvanced').open = true;
    }
    document.getElementById('diagnosticsSummaryTitle').textContent = data.overall.title;
    document.getElementById('diagnosticsSummaryText').textContent = `${data.overall.summary} ${data.overall.supported} supported · ${data.overall.unavailable} unavailable · ${data.overall.failed} failed.`;
    document.getElementById('diagnosticsUpdated').textContent = `Checked ${new Date(data.generatedAt).toLocaleString()}`;
    const list = document.getElementById('diagnosticsChecks');
    list.replaceChildren();
    for (const check of data.checks) {
      const card = document.createElement('article');
      card.className = 'diagnostics-check';
      const heading = document.createElement('h3'); heading.textContent = check.label;
      const badge = document.createElement('span');
      badge.className = `diagnostics-status ${check.status}`;
      badge.textContent = check.status[0].toUpperCase() + check.status.slice(1);
      const summary = document.createElement('p'); summary.textContent = check.summary;
      card.append(heading, badge, summary);
      if (check.value !== undefined && typeof check.value !== 'object') {
        const value = document.createElement('p'); value.className = 'diagnostics-value'; value.textContent = String(check.value); card.append(value);
      }
      if (check.id === 'cpu-temperature') {
        const actions = document.createElement('div'); actions.className = 'diagnostics-actions';
        actions.dataset.enhancedActions = ''; card.append(actions);
      }
      if (window.chrome?.webview && check.id === 'tailscale' && check.status === 'unavailable') {
        const actions = document.createElement('div'); actions.className = 'diagnostics-actions';
        const download = document.createElement('a'); download.textContent = 'Download Tailscale';
        download.href = 'https://tailscale.com/download/windows'; download.target = '_blank'; download.rel = 'noopener noreferrer';
        const note = document.createElement('p'); note.textContent = 'Optional for local use; needed for remote access. Opens the official download page.';
        actions.append(download, note); card.append(actions);
      }
      if (window.chrome?.webview && check.id === 'tailscale-status' && check.status !== 'supported') {
        const actions = document.createElement('div'); actions.className = 'diagnostics-actions';
        const recheck = document.createElement('button'); recheck.type = 'button'; recheck.textContent = 'Re-check';
        recheck.addEventListener('click', () => refresh(true));
        const note = document.createElement('p'); note.textContent = 'If installed, open Tailscale and connect, then re-check. Away from home, your phone needs Tailscale Connected too. Rovarin does not change your network settings.';
        actions.append(recheck, note); card.append(actions);
      }
      list.append(card);
    }
    reportField.value = reportText(data);
    document.getElementById('diagnosticsReportDetails').hidden = false;
    copyButton.disabled = false;
    window.dispatchEvent(new CustomEvent('rovarin-diagnostics-rendered'));
  }

  async function refresh(force = false) {
    if (busy || savingMode || page.hidden || !clientVisible()) return;
    busy = true; refreshButton.disabled = true;
    if (modeSelector) modeSelector.disabled = true;
    if (saveMode) saveMode.disabled = true;
    feedback.textContent = 'Checking compatibility…';
    try {
      const response = await fetch(force ? '/api/diagnostics?refresh=1' : '/api/diagnostics', { credentials: 'same-origin', cache: 'no-store' });
      if (response.status === 401) { (window.redirectToLogin || (() => window.location.replace('/')))('diagnostics-refresh-401'); return; }
      if (!response.ok) throw new Error('request-failed');
      render(await response.json());
      feedback.textContent = 'Checks complete. Optional capabilities are listed separately.';
    } catch (_) {
      feedback.textContent = 'Could not refresh diagnostics. Any displayed report is the last successful check. Try again.';
    } finally {
      busy = false; refreshButton.disabled = false;
      if (modeSelector) modeSelector.disabled = false;
      if (saveMode) saveMode.disabled = false;
    }
  }

  copyButton.addEventListener('click', async () => {
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(reportField.value);
      else {
        document.getElementById('diagnosticsReportDetails').open = true;
        reportField.focus(); reportField.select(); reportField.setSelectionRange(0, reportField.value.length);
        if (!document.execCommand('copy')) throw new Error('copy-blocked');
      }
      feedback.textContent = 'Compatibility report copied.';
    } catch (_) {
      document.getElementById('diagnosticsReportDetails').open = true;
      reportField.focus(); reportField.select();
      feedback.textContent = 'Select and copy the text report below.';
    }
  });
  refreshButton.addEventListener('click', () => refresh(true));
  const allowExperimental = document.getElementById('enableExperimentalTemperature');
  if (allowExperimental) allowExperimental.addEventListener('change', () => {
    const option = document.getElementById('experimentalTemperatureOption');
    option.hidden = !allowExperimental.checked; option.disabled = !allowExperimental.checked;
    if (!allowExperimental.checked && modeSelector.value === 'thermal-zone') modeSelector.value = 'enhanced';
  });
  if (saveMode) saveMode.addEventListener('click', async () => {
    if (busy || savingMode) return;
    const selectedMode = modeSelector.value;
    savingMode = true;
    saveMode.disabled = true;
    modeSelector.disabled = true;
    refreshButton.disabled = true;
    const status = document.getElementById('temperatureModeFeedback');
    try {
      const response = await fetch('/api/temperature/settings', { method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: selectedMode }) });
      if (response.status === 401) { (window.redirectToLogin || (() => window.location.replace('/')))('diagnostics-settings-401'); return; }
      const result = await response.json();
      if (!response.ok || !result.success) throw new Error('save-failed');
      modeSelector.value = result.settings.mode;
      savingMode = false;
      status.textContent = 'Source saved. Sensor status updates on the next lease-driven sample. No driver is installed by this setting.';
      await refresh();
    } catch (_) { status.textContent = 'Could not save the temperature source. Try again.'; }
    finally { savingMode = false; saveMode.disabled = false; modeSelector.disabled = false; refreshButton.disabled = false; }
  });
  window.addEventListener('pc-monitor-pagechange', event => { if (event.detail.page === 'diagnosticsPage') refresh(); });
  document.addEventListener('visibilitychange', () => { if (clientVisible()) refresh(); });
  window.addEventListener('pc-monitor-desktop-visibility', () => { if (clientVisible()) refresh(); });
})();
