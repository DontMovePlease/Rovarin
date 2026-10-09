/* ──────────────────────────────────────────────────────────────────────────
   PC Maintenance & Repair — Frontend Controller
   Polling-based: no extra SSE connection, keeps idle CPU near zero.
   ────────────────────────────────────────────────────────────────────────── */

(function () {
  'use strict';

  // ── State ────────────────────────────────────────────────────────────────

  const state = {
    isAdmin: false,
    isRunning: false,
    isLocal: (!window.location.hostname || ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)),
    serviceEnabled: false,
    serviceState: 'disabled',
    lastLogCount: 0,
    pollTimer: null,
    runningActionId: null,
    pendingToastActionId: null,
    toastTimer: null,
    resetNetworkOfflineCount: 0
  };

  // ── Action Definitions (mirrors server ACTIONS) ───────────────────────────

  const ACTIONS = [
    // Cleanup
    {
      id: 'clean_temp',
      emoji: '🧹',
      title: 'Clean Temporary Files',
      desc: 'Safely removes files from the Windows temp folder and your user temp directory. Files locked by running programs are skipped.',
      category: 'Cleanup',
      requiresAdmin: false,
      confirm: false
    },
    {
      id: 'empty_recycle_bin',
      emoji: '🗑️',
      title: 'Empty Recycle Bin',
      desc: 'Permanently deletes all files currently sitting in the Windows Recycle Bin.',
      category: 'Cleanup',
      requiresAdmin: false,
      confirm: true,
      confirmTitle: 'Empty Recycle Bin?',
      confirmBody: 'This will permanently delete all files in the Recycle Bin. They cannot be recovered afterward.',
      confirmBtnLabel: 'Empty Now',
      confirmDanger: true
    },
    {
      id: 'clear_dns',
      emoji: '🌐',
      title: 'Clear DNS Cache',
      desc: 'Flushes the Windows DNS resolver cache. Useful when websites fail to load due to stale or incorrect DNS entries.',
      category: 'Cleanup',
      requiresAdmin: true,
      confirm: false
    },
    // Windows Repair
    {
      id: 'windows_repair',
      emoji: '🛠️',
      title: 'Windows System Repair',
      desc: 'Runs a full repair sequence: DISM CheckHealth → ScanHealth → RestoreHealth, then SFC system file check. Can take 5–20 minutes.',
      category: 'Windows Repair',
      requiresAdmin: true,
      confirm: true,
      confirmTitle: 'Start Windows System Repair?',
      confirmBody: 'This will run DISM and SFC to check and repair Windows system components. Your PC will stay on — no restart will happen automatically. This process can take 5–20 minutes.',
      confirmBtnLabel: 'Start Repair',
      confirmDanger: false
    },
    {
      id: 'sfc_scan',
      emoji: '🔍',
      title: 'Scan Windows System Files',
      desc: 'Runs SFC /scannow to verify and restore protected Windows system files. Requires Administrator.',
      category: 'Windows Repair',
      requiresAdmin: true,
      confirm: false
    },
    {
      id: 'dism_check',
      emoji: '💿',
      title: 'Check Windows Component Store',
      desc: 'Diagnostic scan of the Windows Component Store (DISM CheckHealth + ScanHealth). Does not modify any files.',
      category: 'Windows Repair',
      requiresAdmin: true,
      confirm: false
    },
    // Network
    {
      id: 'reset_network',
      emoji: '📡',
      title: 'Reset Network Settings',
      desc: 'Resets the Winsock catalog and TCP/IP stack to factory defaults. Useful for resolving persistent network errors.',
      category: 'Network',
      requiresAdmin: true,
      confirm: true,
      confirmTitle: 'Reset Network Settings?',
      confirmBody: 'This resets Winsock and TCP/IP. Your current network connections will be interrupted. A restart is recommended after the reset to fully apply changes.',
      confirmWarn: 'Your network (including Tailscale) will disconnect briefly.',
      confirmBtnLabel: 'Reset Network',
      confirmDanger: true
    },
    {
      id: 'renew_network',
      emoji: '🔄',
      title: 'Renew Network Connection',
      desc: 'Refreshes your DHCP IP address lease without touching Tailscale or other virtual adapters.',
      category: 'Network',
      requiresAdmin: false,
      confirm: false
    },
    // Explorer
    {
      id: 'restart_explorer',
      emoji: '🪟',
      title: 'Restart Windows Explorer',
      desc: 'Restarts explorer.exe. Your taskbar and desktop will briefly disappear and come back. Useful for fixing a frozen shell.',
      category: 'Explorer',
      requiresAdmin: false,
      confirm: false
    }
  ];

  const CATEGORY_ORDER = ['Cleanup', 'Windows Repair', 'Network', 'Explorer'];

  // ── DOM Helpers ───────────────────────────────────────────────────────────

  function qs(sel, root) { return (root || document).querySelector(sel); }

  function buildMaintenanceHTML() {
    const grouped = {};
    CATEGORY_ORDER.forEach(cat => grouped[cat] = []);
    ACTIONS.forEach(a => { if (grouped[a.category]) grouped[a.category].push(a); });

    let html = `
      <div class="maint-section">
        <div class="maint-section-title">
          <svg viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M11.42 15.17L17.25 21A2.652 2.652 0 0021 17.25l-5.877-5.877M11.42 15.17l2.496-3.03c.317-.384.74-.626 1.208-.766M11.42 15.17l-4.655 5.653a2.548 2.548 0 11-3.586-3.586l6.837-5.63m5.108-.233c.55-.164 1.163-.188 1.743-.14a4.5 4.5 0 004.486-6.336l-3.276 3.277a3.004 3.004 0 01-2.25-2.25l3.276-3.276a4.5 4.5 0 00-6.336 4.486c.091 1.076-.071 2.264-.904 2.95l-.102.085m-1.745 1.437L5.909 7.5H4.5L2.25 3.75l1.5-1.5L7.5 4.5v1.409l4.26 4.26m-1.745 1.437l1.745-1.437m6.615 8.206L15.75 15.75M4.867 19.125h.008v.008h-.008v-.008z"/></svg>
          <span class="maint-heading-text">PC Maintenance &amp; Repair</span>
          <span id="maintAdminBadge" class="maint-admin-badge not-admin">Checking…</span>
        </div>
    `;

    CATEGORY_ORDER.forEach(cat => {
      const items = grouped[cat];
      if (!items.length) return;
      html += `<div class="maint-group"><div class="maint-group-label">${cat}</div><div class="maint-grid">`;
      items.forEach(a => {
        html += `
          <button class="maint-action-card" id="maint-btn-${a.id}" data-action="${a.id}"
                  title="${a.title}">
            <div class="maint-card-header">
              <span class="maint-card-emoji">${a.emoji}</span>
              <span class="maint-card-title">${a.title}</span>
            </div>
            <div class="maint-card-desc">${a.desc}</div>
            ${a.requiresAdmin ? '<span class="maint-requires-admin">⚠ Administrator approval required</span>' : ''}
            <div class="maint-card-running-bar"></div>
          </button>`;
      });
      html += `</div></div>`;
    });

    html += `
        <!-- Active Task Progress Panel -->
        <div id="maintProgressPanel" class="maint-progress-panel">
          <div class="maint-progress-header">
            <div>
              <div id="maintProgressTitle" class="maint-progress-title">Running…</div>
              <div id="maintProgressStep" class="maint-progress-step"></div>
            </div>
            <span id="maintStatusPill" class="maint-status-pill running">Running</span>
          </div>
          <div class="maint-step-track">
            <div id="maintStepFill" class="maint-step-fill" style="width:0%"></div>
          </div>
          <div id="maintLogConsole" class="maint-log-console"></div>
          <div id="maintResultBanner" class="maint-result-banner"></div>
        </div>

        <!-- Maintenance History -->
        <div class="maint-history-section">
          <div class="maint-history-title">Operation History</div>
          <div id="maintHistoryList" class="maint-history-list">
            <div class="maint-history-empty">No operations run yet.</div>
          </div>
        </div>
      </div>

      <div id="maintToast" class="maint-toast" role="status" aria-live="polite" aria-atomic="true">
        <span id="maintToastIcon" class="maint-toast-icon" aria-hidden="true"></span>
        <span class="maint-toast-copy">
          <strong id="maintToastTitle"></strong>
          <span id="maintToastMessage"></span>
        </span>
        <button id="maintToastClose" class="maint-toast-close" type="button" aria-label="Dismiss result">×</button>
      </div>

      <!-- Confirmation Modal (outside maint-section so it overlays correctly) -->
      <div id="maintModal" class="maint-modal-overlay" style="display:none">
        <div class="maint-modal">
          <div id="maintModalIcon" class="maint-modal-icon"></div>
          <div id="maintModalTitle" class="maint-modal-title"></div>
          <div id="maintModalBody" class="maint-modal-body"></div>
          <div id="maintModalWarn" class="maint-modal-warn" style="display:none"></div>
          <div id="maintModalPinSection" style="display:none;margin-top:0.75rem;text-align:left;">
            <label for="maintModalPin" style="font-size:0.9rem;opacity:0.9;display:block;margin-bottom:0.25rem;">Enter your Rovarin PIN to authorize:</label>
            <input id="maintModalPin" type="password" inputmode="numeric" pattern="[0-9]{6}|[0-9]{12}" maxlength="12" autocomplete="off" placeholder="PIN" style="width:100%;box-sizing:border-box;padding:0.6rem;font-size:1.1rem;letter-spacing:0.15em;text-align:center;border-radius:6px;border:1px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.3);color:#fff;">
            <p id="maintModalPinError" style="display:none;color:#ff6b6b;font-size:0.85rem;margin-top:0.35rem;"></p>
          </div>
          <div class="maint-modal-buttons">
            <button id="maintModalCancel" class="maint-btn maint-btn-cancel">Cancel</button>
            <button id="maintModalConfirm" class="maint-btn maint-btn-confirm">Confirm</button>
          </div>
        </div>
      </div>
    `;

    return html;
  }

  // ── Render & Mount ─────────────────────────────────────────────────────────

  function mount() {
    const mountDiv = qs('#maintenanceMount');
    if (!mountDiv || mountDiv.dataset.initialized === 'true') return;
    mountDiv.innerHTML = buildMaintenanceHTML();
    mountDiv.dataset.initialized = 'true';

    // Results remain visible after navigating away from Maintenance. Global
    // overlays also avoid being clipped by the page's glass styling.
    document.body.append(qs('#maintToast'), qs('#maintModal'));

    // Wire button clicks
    ACTIONS.forEach(a => {
      const btn = qs(`#maint-btn-${a.id}`);
      if (btn) btn.addEventListener('click', () => onActionClick(a));
    });

    // Wire modal buttons
    qs('#maintModalCancel').addEventListener('click', closeModal);
    qs('#maintToastClose').addEventListener('click', dismissMaintenanceToast);
    qs('#maintModalConfirm').addEventListener('click', () => {
      const modal = qs('#maintModal');
      const actionId = modal.dataset.pendingAction;
      if (!actionId) { closeModal(); return; }
      const action = ACTIONS.find(a => a.id === actionId);
      let pin = undefined;
      if (action && action.requiresAdmin && !state.isLocal) {
        const pinInput = qs('#maintModalPin');
        const pinError = qs('#maintModalPinError');
        const val = pinInput ? pinInput.value.trim() : '';
        if (!val || val.length < 6) {
          if (pinError) {
            pinError.textContent = 'Please enter your 6-digit PIN.';
            pinError.style.display = 'block';
          }
          if (pinInput) pinInput.focus();
          return;
        }
        pin = val;
      }
      closeModal();
      executeAction(actionId, pin);
    });

    const pinInput = qs('#maintModalPin');
    if (pinInput) {
      pinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          qs('#maintModalConfirm').click();
        }
      });
      pinInput.addEventListener('input', () => {
        const pinError = qs('#maintModalPinError');
        if (pinError) pinError.style.display = 'none';
      });
    }

    // Start status polling (4 s idle, 1 s when running)
    schedulePoll();
    if (typeof window.currentAppPage !== 'undefined' && window.currentAppPage === 'maintenancePage') {
      fetchStatus();
    } else {
      setTimeout(fetchStatus, 1500);
    }
  }

  // ── Action Click Handler ──────────────────────────────────────────────────

  function onActionClick(action) {
    if (state.isRunning) return;

    if (action.confirm || action.requiresAdmin) {
      showConfirmModal(action);
    } else {
      executeAction(action.id);
    }
  }

  // ── Confirmation Modal ────────────────────────────────────────────────────

  function showConfirmModal(action) {
    const modal = qs('#maintModal');
    qs('#maintModalIcon').textContent = action.emoji;
    const confirmBtn = qs('#maintModalConfirm');
    const cancelBtn = qs('#maintModalCancel');
    const warnEl = qs('#maintModalWarn');
    const pinSection = qs('#maintModalPinSection');
    const pinInput = qs('#maintModalPin');
    const pinError = qs('#maintModalPinError');

    if (pinError) { pinError.textContent = ''; pinError.style.display = 'none'; }
    if (pinInput) { pinInput.value = ''; }

    // If remote caller and action requires admin but service is disabled
    if (action.requiresAdmin && !state.isLocal && !state.serviceEnabled) {
      qs('#maintModalTitle').textContent = 'Administrator Maintenance Disabled';
      qs('#maintModalBody').textContent = 'Administrator maintenance is disabled on this PC. Turn on "Enable administrator maintenance" in Settings from the Rovarin desktop app before running privileged actions from your phone.';
      warnEl.style.display = 'none';
      if (pinSection) pinSection.style.display = 'none';
      confirmBtn.style.display = 'none';
      cancelBtn.textContent = 'Close';
      modal.dataset.pendingAction = '';
      modal.style.display = 'flex';
      return;
    }

    confirmBtn.style.display = '';
    cancelBtn.textContent = 'Cancel';
    qs('#maintModalTitle').textContent = action.confirmTitle || `Run: ${action.title}?`;

    let bodyText = action.confirmBody || action.desc;
    if (action.requiresAdmin) {
      if (!state.isLocal) {
        bodyText += ' Enter your Rovarin PIN to authorize execution on this PC.';
      } else if (!state.serviceEnabled) {
        bodyText += ' Windows will ask for administrator approval on this PC for this action only.';
      }
    }
    qs('#maintModalBody').textContent = bodyText;

    if (action.confirmWarn) {
      warnEl.textContent = '⚠ ' + action.confirmWarn;
      warnEl.style.display = 'block';
    } else {
      warnEl.style.display = 'none';
    }

    if (action.requiresAdmin && !state.isLocal) {
      if (pinSection) pinSection.style.display = 'block';
      setTimeout(() => { if (pinInput) pinInput.focus(); }, 50);
    } else {
      if (pinSection) pinSection.style.display = 'none';
    }

    confirmBtn.textContent = action.confirmBtnLabel || 'Confirm';
    confirmBtn.className = 'maint-btn maint-btn-confirm' + (action.confirmDanger ? ' danger' : '');

    modal.dataset.pendingAction = action.id;
    modal.style.display = 'flex';
  }

  function closeModal() {
    qs('#maintModal').style.display = 'none';
    qs('#maintModal').dataset.pendingAction = '';
    const pinError = qs('#maintModalPinError');
    if (pinError) pinError.style.display = 'none';
    const pinInput = qs('#maintModalPin');
    if (pinInput) pinInput.value = '';
  }

  // Click outside modal to dismiss
  document.addEventListener('click', (e) => {
    const modal = qs('#maintModal');
    if (modal && modal.style.display !== 'none' && e.target === modal) closeModal();
  });

  // ── Execute Action ─────────────────────────────────────────────────────────

  async function executeAction(actionId, pin) {
    if (state.isRunning) return;

    // Show progress panel immediately
    state.isRunning = true;
    showProgressPanel(actionId);
    setAllButtonsDisabled(true, actionId);

    const action = ACTIONS.find(a => a.id === actionId);
    const payload = (action && (action.confirm || action.requiresAdmin))
      ? { action: actionId, confirmed: true }
      : { action: actionId };
    if (pin) {
      payload.pin = pin;
    }

    try {
      const res = await fetch('/api/maintenance/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        appendLocalLog('error', data.error || 'Failed to start operation.');
        state.isRunning = false;
        state.runningActionId = null;
        const pill = qs('#maintStatusPill');
        if (pill) { pill.textContent = 'Failed'; pill.className = 'maint-status-pill failed'; }
        const banner = qs('#maintResultBanner');
        if (banner) { banner.textContent = data.error || 'Failed to start operation.'; banner.className = 'maint-result-banner failed'; }
        showMaintenanceToast(false, data.error || 'Failed to start operation.', actionTitle(actionId));
        state.pendingToastActionId = null;
        setAllButtonsDisabled(false);
        document.querySelectorAll('.maint-action-card.running').forEach(b => b.classList.remove('running'));
        return;
      }
    } catch (err) {
      if (actionId === 'reset_network') {
        appendLocalLog('info', 'Network resetting; reconnecting to PC…');
        qs('#maintProgressStep').textContent = 'Reconnecting to PC after network reset…';
        startFastPoll();
        return;
      }
      appendLocalLog('error', 'Network error: ' + err.message);
      state.isRunning = false;
      state.runningActionId = null;
      const pill = qs('#maintStatusPill');
      if (pill) { pill.textContent = 'Failed'; pill.className = 'maint-status-pill failed'; }
      const banner = qs('#maintResultBanner');
      if (banner) { banner.textContent = 'Could not contact the maintenance service.'; banner.className = 'maint-result-banner failed'; }
      showMaintenanceToast(false, 'Could not contact the maintenance service.', actionTitle(actionId));
      state.pendingToastActionId = null;
      setAllButtonsDisabled(false);
      document.querySelectorAll('.maint-action-card.running').forEach(b => b.classList.remove('running'));
      return;
    }

    // Switch to fast polling
    startFastPoll();
  }

  // ── Progress Panel ─────────────────────────────────────────────────────────

  function showProgressPanel(actionId) {
    dismissMaintenanceToast();
    state.pendingToastActionId = actionId;
    const panel = qs('#maintProgressPanel');
    const action = ACTIONS.find(a => a.id === actionId);
    qs('#maintProgressTitle').textContent = action ? `${action.emoji} ${action.title}` : 'Running…';
    qs('#maintProgressStep').textContent = 'Starting…';
    qs('#maintStatusPill').textContent = 'Running';
    qs('#maintStatusPill').className = 'maint-status-pill running';
    qs('#maintStepFill').style.width = '0%';
    qs('#maintLogConsole').innerHTML = '';
    qs('#maintResultBanner').className = 'maint-result-banner';
    qs('#maintResultBanner').textContent = '';
    panel.classList.add('active');
    state.lastLogCount = 0;
    state.runningActionId = actionId;

    // Mark the active button
    const btn = qs(`#maint-btn-${actionId}`);
    if (btn) btn.classList.add('running');
  }

  function appendLocalLog(level, message) {
    const console = qs('#maintLogConsole');
    if (!console) return;
    const time = new Date().toLocaleTimeString('en-US', { hour12: false });
    const line = document.createElement('div');
    line.className = `maint-log-line ${level}`;
    line.innerHTML = `<span class="maint-log-time">${time}</span><span class="maint-log-msg">${escHtml(message)}</span>`;
    console.appendChild(line);
    console.scrollTop = console.scrollHeight;
  }

  function updateProgressPanel(task) {
    if (!task) return;

    qs('#maintProgressTitle').textContent = task.title || 'Running…';
    qs('#maintProgressStep').textContent = task.stepTitle || '';

    const pill = qs('#maintStatusPill');
    pill.textContent = task.status === 'running' ? 'Running' : task.status === 'completed' ? 'Done' : task.status === 'partially-completed' ? 'Partial' : task.status === 'cancelled' ? 'Cancelled' : 'Failed';
    pill.className = 'maint-status-pill ' + (task.status === 'running' ? 'running' : task.status === 'completed' ? 'completed' : task.status === 'partially-completed' ? 'partially-completed' : task.status === 'cancelled' ? 'cancelled' : 'failed');

    // Step progress bar
    const pct = task.totalSteps > 0 ? Math.round((task.currentStep / task.totalSteps) * 100) : (task.status !== 'running' ? 100 : 20);
    qs('#maintStepFill').style.width = pct + '%';

    // Append only new log lines (delta)
    const logConsole = qs('#maintLogConsole');
    if (task.logs && task.logs.length > state.lastLogCount) {
      const newEntries = task.logs.slice(state.lastLogCount);
      newEntries.forEach(entry => {
        const line = document.createElement('div');
        line.className = `maint-log-line ${entry.level || 'info'}`;
        line.innerHTML = `<span class="maint-log-time">${entry.time}</span><span class="maint-log-msg">${escHtml(entry.message)}</span>`;
        logConsole.appendChild(line);
      });
      logConsole.scrollTop = logConsole.scrollHeight;
      state.lastLogCount = task.logs.length;
    }

    // Show result when done
    if (task.status !== 'running' && task.result) {
      const banner = qs('#maintResultBanner');
      banner.textContent = task.result.summary;
      banner.className = 'maint-result-banner ' + (task.status === 'cancelled' ? 'cancelled' : task.status === 'partially-completed' ? 'partially-completed' : task.result.success ? 'success' : 'failed');
    }
  }

  // ── Status Polling ─────────────────────────────────────────────────────────

  function schedulePoll() {
    if (window.pcMonitorUninstalling) return;
    clearTimeout(state.pollTimer);
    if (typeof window.dashboardClientVisible === 'function' && !window.dashboardClientVisible()) return;
    state.pollTimer = setTimeout(fetchStatus, state.isRunning ? 1000 : 4000);
  }

  function startFastPoll() {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(fetchStatus, 800);
  }

  async function fetchStatus() {
    if (window.pcMonitorUninstalling) return;
    if (typeof window.dashboardClientVisible === 'function' && !window.dashboardClientVisible()) return;
    try {
      const res = await fetch('/api/maintenance/status', { credentials: 'same-origin' });
      if (!res.ok) { schedulePoll(); return; }
      const data = await res.json();
      state.resetNetworkOfflineCount = 0;
      applyStatus(data);
    } catch (_) {
      if (state.runningActionId === 'reset_network') {
        state.resetNetworkOfflineCount = (state.resetNetworkOfflineCount || 0) + 1;
        const step = qs('#maintProgressStep');
        if (step) step.textContent = 'Reconnecting to PC after network reset…';
        const pill = qs('#maintStatusPill');
        if (pill) { pill.textContent = 'Reconnecting'; pill.className = 'maint-status-pill running'; }
      }
    }
    schedulePoll();
  }

  function applyStatus(data) {
    if (typeof data.isLocal === 'boolean') {
      state.isLocal = data.isLocal;
    }
    if (data.service) {
      state.serviceEnabled = !!data.service.enabled;
      state.serviceState = data.service.state || (data.service.enabled ? 'enabled' : 'disabled');
    }
    state.isAdmin = data.isAdmin;

    // Admin badge
    const badge = qs('#maintAdminBadge');
    if (badge) {
      if (state.serviceEnabled) {
        badge.textContent = '🛡 Administrator Maintenance Enabled';
        badge.className = 'maint-admin-badge is-admin';
        badge.title = 'Authorized maintenance actions can run from your phone without repeated Windows administrator prompts.';
      } else if (data.isAdmin) {
        badge.textContent = '⚙ Administrator';
        badge.className = 'maint-admin-badge is-admin';
        badge.title = 'Rovarin is currently elevated.';
      } else {
        badge.textContent = '⚠ Standard User';
        badge.className = 'maint-admin-badge not-admin';
        badge.title = 'Rovarin runs with standard user rights. Actions requiring administrator approval can be enabled in desktop Settings.';
      }
    }

    state.isRunning = data.isRunning;

    if (data.currentTask) {
      updateProgressPanel(data.currentTask);

      if (data.currentTask.status !== 'running') {
        if (state.pendingToastActionId && data.currentTask.id === state.pendingToastActionId) {
          const result = data.currentTask.result || {};
          showMaintenanceToast(result.success, result.summary || (result.success ? 'Operation completed.' : 'Operation failed.'), data.currentTask.title || actionTitle(state.pendingToastActionId), result.detailedResult?.code === 'uac-cancelled', data.currentTask.status === 'partially-completed');
          state.pendingToastActionId = null;
        }
        // Task finished
        state.runningActionId = null;
        setAllButtonsDisabled(false);
        // Remove running shimmer from all cards
        document.querySelectorAll('.maint-action-card.running').forEach(b => b.classList.remove('running'));
      }
    } else if (!data.isRunning) {
      if (state.runningActionId && data.history && data.history.length > 0) {
        const last = data.history[0];
        if (last && last.id === state.runningActionId) {
          const pill = qs('#maintStatusPill');
          if (pill) {
            pill.textContent = last.status === 'completed' ? 'Done' : last.status === 'partially-completed' ? 'Partial' : last.status === 'cancelled' ? 'Cancelled' : 'Failed';
            pill.className = 'maint-status-pill ' + (last.status === 'completed' ? 'completed' : last.status === 'partially-completed' ? 'partially-completed' : last.status === 'cancelled' ? 'cancelled' : 'failed');
          }
          const stepFill = qs('#maintStepFill');
          if (stepFill) stepFill.style.width = '100%';
          const banner = qs('#maintResultBanner');
          if (banner) {
            banner.textContent = last.summary;
            banner.className = 'maint-result-banner ' + (last.status === 'cancelled' ? 'cancelled' : last.status === 'partially-completed' ? 'partially-completed' : last.success ? 'success' : 'failed');
          }
          if (state.pendingToastActionId && last.id === state.pendingToastActionId) {
            showMaintenanceToast(last.success, last.summary, last.title || actionTitle(last.id), last.status === 'cancelled', last.status === 'partially-completed');
            state.pendingToastActionId = null;
          }
          state.runningActionId = null;
        }
      }
      setAllButtonsDisabled(false);
      document.querySelectorAll('.maint-action-card.running').forEach(b => b.classList.remove('running'));
    }

    // Render history
    renderHistory(data.history || []);
  }

  function actionTitle(actionId) {
    const action = ACTIONS.find(item => item.id === actionId);
    return action ? action.title : 'Maintenance operation';
  }

  function showMaintenanceToast(success, message, title, cancelled = false, isPartial = false) {
    const toast = qs('#maintToast');
    if (!toast) return;
    clearTimeout(state.toastTimer);
    qs('#maintToastIcon').textContent = isPartial ? '!' : success ? '✓' : '×';
    qs('#maintToastTitle').textContent = `${title} ${cancelled ? 'cancelled' : isPartial ? 'partially completed' : success ? 'succeeded' : 'failed'}`;
    qs('#maintToastMessage').textContent = message;
    toast.classList.remove('success', 'failed', 'cancelled', 'partial');
    toast.classList.add(cancelled ? 'cancelled' : isPartial ? 'partial' : success ? 'success' : 'failed', 'is-visible');
    state.toastTimer = setTimeout(dismissMaintenanceToast, 6500);
  }

  function dismissMaintenanceToast() {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
    const toast = qs('#maintToast');
    if (toast) toast.classList.remove('is-visible');
  }

  function setAllButtonsDisabled(disabled, activeId) {
    ACTIONS.forEach(a => {
      const btn = qs(`#maint-btn-${a.id}`);
      if (!btn) return;
      btn.disabled = disabled;
      btn.title = a.requiresAdmin
        ? `${a.title} — Windows administrator approval required for this action.`
        : a.title;
      if (disabled && a.id === activeId) btn.classList.add('running');
      else btn.classList.remove('running');
    });
  }

  // ── History ────────────────────────────────────────────────────────────────

  function renderHistory(historyItems) {
    const list = qs('#maintHistoryList');
    if (!list) return;

    if (!historyItems || historyItems.length === 0) {
      list.innerHTML = '<div class="maint-history-empty">No operations run yet.</div>';
      return;
    }

    list.innerHTML = historyItems.slice(0, 10).map(item => `
      <div class="maint-history-item">
        <div class="maint-history-dot ${item.status === 'partially-completed' ? 'partial' : item.success ? 'success' : 'failed'}"></div>
        <div class="maint-history-body">
          <div class="maint-history-name">${escHtml(item.title)}</div>
          <div class="maint-history-meta">${escHtml(item.date)} ${escHtml(item.timestamp)} · ${escHtml(item.duration)} · ${item.status === 'cancelled' ? 'Cancelled' : item.status === 'partially-completed' ? 'Partial (Restart Required)' : item.success ? 'Succeeded' : 'Failed'}</div>
        </div>
      </div>
    `).join('');
  }

  // ── Utilities ──────────────────────────────────────────────────────────────

  function escHtml(str) {
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // ── Boot ───────────────────────────────────────────────────────────────────

  window.addEventListener('pc-monitor-desktop-visibility', event => {
    clearTimeout(state.pollTimer);
    if (event.detail?.visible) fetchStatus();
  });

  window.addEventListener('pc-monitor-pagechange', event => {
    if (event.detail?.page === 'maintenancePage') {
      fetchStatus();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }

})();
