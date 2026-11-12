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
    unsupported: false,
    platform: 'windows',
    isLocal: (!window.location.hostname || ['localhost', '127.0.0.1', '::1'].includes(window.location.hostname)),
    serviceEnabled: false,
    serviceState: 'disabled',
    lastLogCount: 0,
    pollTimer: null,
    runningActionId: null,
    pendingToastActionId: null,
    toastTimer: null,
    boostHudTimer: null,
    boostAnimFrame: null,
    boostBadgeTimer: null,
    resetNetworkOfflineCount: 0
  };

  // ── Action Definitions (mirrors server ACTIONS) ───────────────────────────

  const ACTIONS = [
    {
      id:'boost', emoji:'✦', title:'Boost', category:'Quick actions', requiresAdmin:false,
      confirm:false,
      desc:'Free background RAM and clean temporary files.'
    },
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
      platform: 'windows',
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
      platform: 'windows',
      confirm: false
    },
    {
      id: 'dism_check',
      emoji: '💿',
      title: 'Check Windows Component Store',
      desc: 'Diagnostic scan of the Windows Component Store (DISM CheckHealth + ScanHealth). Does not modify any files.',
      category: 'Windows Repair',
      requiresAdmin: true,
      platform: 'windows',
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
      platform: 'windows',
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
      platform: 'windows',
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
      platform: 'windows',
      confirm: false
    },
    // Linux-specific actions
    {
      id: 'systemd_journal_vacuum',
      emoji: '📜',
      title: 'Vacuum User Journal',
      desc: 'Reduces user systemd journal disk consumption to 50 MB.',
      category: 'Cleanup',
      requiresAdmin: false,
      platform: 'linux',
      confirm: true,
      confirmTitle: 'Vacuum User Journal?',
      confirmBody: 'This will vacuum the user systemd journal to reduce disk space to 50 MB.',
      confirmBtnLabel: 'Vacuum Journal',
      confirmDanger: false
    },
    {
      id: 'package_cache_clean',
      emoji: '📦',
      title: 'Package Cache Analysis',
      desc: 'Analyzes safe package cache cleanup in dry-run mode.',
      category: 'Cleanup',
      requiresAdmin: false,
      platform: 'linux',
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

      <!-- PC Manager-style Boost HUD Card -->
      <div id="boostHudCard" class="boost-hud-card" role="status" aria-live="polite" aria-atomic="true" hidden>
        <div class="boost-hud-glow" aria-hidden="true"></div>
        <div class="boost-hud-top">
          <div class="boost-hud-gauge-wrap" aria-hidden="true">
            <svg class="boost-hud-gauge" viewBox="0 0 64 64">
              <circle class="boost-hud-track" cx="32" cy="32" r="26"/>
              <circle id="boostHudArc" class="boost-hud-arc" cx="32" cy="32" r="26" stroke-dasharray="163.36" stroke-dashoffset="163.36"/>
            </svg>
            <div id="boostHudCoreIcon" class="boost-hud-core-icon">⚡</div>
          </div>
          <div class="boost-hud-heading">
            <div id="boostHudTitle" class="boost-hud-title">Boosting PC…</div>
            <div id="boostHudStep" class="boost-hud-step">Reclaiming background memory &amp; temp files</div>
          </div>
          <button id="boostHudClose" class="boost-hud-close" type="button" aria-label="Dismiss Boost summary">×</button>
        </div>
        <div id="boostHudMetrics" class="boost-hud-metrics">
          <div class="boost-hud-metric">
            <span id="boostHudRamLabel" class="boost-hud-metric-label">Working Set</span>
            <strong id="boostHudRamVal" class="boost-hud-metric-val">Scanning…</strong>
            <small id="boostHudRamSub" class="boost-hud-metric-sub">Working set memory</small>
          </div>
          <div class="boost-hud-metric">
            <span class="boost-hud-metric-label">Temp Cleaned</span>
            <strong id="boostHudTempVal" class="boost-hud-metric-val">Scanning…</strong>
            <small id="boostHudTempSub" class="boost-hud-metric-sub">Temporary cache files</small>
          </div>
        </div>
      </div>

      <!-- Confirmation Modal (outside maint-section so it overlays correctly) -->
      <div id="maintModal" class="maint-modal-overlay" style="display:none">
        <div class="maint-modal" role="dialog" aria-modal="true" aria-labelledby="maintModalTitle" aria-describedby="maintModalBody maintModalWarn">
          <div id="maintModalIcon" class="maint-modal-icon"></div>
          <div id="maintModalTitle" class="maint-modal-title"></div>
          <div id="maintModalBody" class="maint-modal-body"></div>
          <div id="maintModalWarn" class="maint-modal-warn" style="display:none"></div>
          <div id="maintModalPinSection" style="display:none;margin-top:0.75rem;text-align:left;">
            <label for="maintModalPin" style="font-size:0.9rem;opacity:0.9;display:block;margin-bottom:0.25rem;">Enter your Rovarin PIN to authorize:</label>
            <input id="maintModalPin" type="password" inputmode="numeric" pattern="[0-9]{6}|[0-9]{8}|[0-9]{12}" maxlength="12" autocomplete="off" placeholder="PIN" style="width:100%;box-sizing:border-box;padding:0.6rem;font-size:1.1rem;letter-spacing:0.15em;text-align:center;border-radius:6px;border:1px solid rgba(255,255,255,0.25);background:rgba(0,0,0,0.3);color:#fff;">
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

  function updateActionCardsForPlatform() {
    const isLinux = state.platform === 'linux';
    ACTIONS.forEach(a => {
      const btn = qs(`#maint-btn-${a.id}`);
      if (!btn) return;
      let visible = true;
      if (isLinux) {
        if (a.platform === 'windows') visible = false;
      } else {
        if (a.platform === 'linux') visible = false;
      }
      if (btn.style) btn.style.display = visible ? '' : 'none';

      if (isLinux) {
        const desc = typeof btn.querySelector === 'function' ? btn.querySelector('.maint-card-desc') : qs(`#maint-btn-${a.id} .maint-card-desc`);
        if (desc) {
          if (a.id === 'clean_temp') desc.textContent = 'Safely analyzes and removes user thumbnail caches and owned temporary files.';
          else if (a.id === 'empty_recycle_bin') desc.textContent = 'Permanently deletes files from user XDG Trash.';
          else if (a.id === 'clear_dns') desc.textContent = 'Flushes the systemd-resolved DNS cache if available.';
        }
        if (a.id === 'clear_dns') {
          const req = typeof btn.querySelector === 'function' ? btn.querySelector('.maint-requires-admin') : qs('#maint-btn-clear_dns .maint-requires-admin');
          if (req && req.style) req.style.display = 'none';
        }
      } else {
        if (a.id === 'clear_dns') {
          const req = typeof btn.querySelector === 'function' ? btn.querySelector('.maint-requires-admin') : qs('#maint-btn-clear_dns .maint-requires-admin');
          if (req && req.style) req.style.display = '';
        }
      }
    });

    if (typeof document.querySelectorAll === 'function') {
      const groups = document.querySelectorAll('.maint-group');
      if (Array.isArray(groups) || (groups && typeof groups.forEach === 'function')) {
        groups.forEach(group => {
          if (group && typeof group.querySelectorAll === 'function') {
            const cards = group.querySelectorAll('.maint-action-card');
            const hasVisible = Array.from(cards).some(c => c.style && c.style.display !== 'none');
            if (group.style) group.style.display = hasVisible ? '' : 'none';
          }
        });
      }
    }
  }

  // ── Render & Mount ─────────────────────────────────────────────────────────

  function mount() {
    const mountDiv = qs('#maintenanceMount');
    if (!mountDiv || mountDiv.dataset.initialized === 'true') return;
    mountDiv.innerHTML = buildMaintenanceHTML();
    mountDiv.dataset.initialized = 'true';
    updateActionCardsForPlatform();

    // Results remain visible after navigating away from Maintenance. Global
    // overlays also avoid being clipped by the page's glass styling.
    document.body.append(qs('#maintToast'), qs('#boostHudCard'), qs('#maintModal'));

    // Wire button clicks
    ACTIONS.forEach(a => {
      const btn = qs(`#maint-btn-${a.id}`);
      if (btn) btn.addEventListener('click', () => onActionClick(a));
    });

    // Wire modal buttons
    qs('#maintModalCancel').addEventListener('click', closeModal);
    qs('#liquidOverviewSettings')?.addEventListener('click', () => onActionClick(ACTIONS.find(a => a.id === 'boost')));
    qs('#maintToastClose').addEventListener('click', dismissMaintenanceToast);
    qs('#boostHudClose')?.addEventListener('click', dismissBoostHud);
    window.addEventListener('resize', positionBoostHud, { passive: true });
    qs('#maintModalConfirm').addEventListener('click', () => {
      const modal = qs('#maintModal');
      const actionId = modal.dataset.pendingAction;
      if (!actionId) { closeModal(); return; }
      const action = ACTIONS.find(a => a.id === actionId);
      let pin = undefined;
      if ((action && action.requiresAdmin && !state.isLocal) || state.platform === 'linux') {
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

  // ── Boost HUD & Animation ──────────────────────────────────────────────────

  function formatBoostBytesUI(bytes) {
    const n = Number(bytes) || 0;
    if (n <= 0) return '0 MB';
    const gb = n / (1024 * 1024 * 1024);
    if (gb >= 1) return `${gb.toFixed(gb >= 10 ? 1 : 2)} GB`;
    const mb = n / (1024 * 1024);
    if (mb >= 1) return `${mb >= 10 ? Math.round(mb) : mb.toFixed(1)} MB`;
    const kb = Math.max(1, Math.round(n / 1024));
    return `${kb} KB`;
  }

  function parseBoostFallbackBytes(summary) {
    let ramBytes = 0;
    let tempBytes = 0;
    if (typeof summary === 'string') {
      const ramMatch = summary.match(/([\d.]+)\s*(GB|MB|KB)\s*(?:of\s+)?(?:RAM|resident-memory|working[\s-]set)/i);
      if (ramMatch) {
        const val = parseFloat(ramMatch[1]);
        const unit = ramMatch[2].toUpperCase();
        ramBytes = Math.round(val * (unit === 'GB' ? 1073741824 : unit === 'MB' ? 1048576 : 1024));
      }
      let tempMatch = summary.match(/([\d.]+)\s*(GB|MB|KB)\s*(?:of\s+)?(?:old\s+)?temp/i);
      if (!tempMatch) {
        tempMatch = summary.match(/(?:temporary files(?: removed)?:\s*)([\d.]+)\s*(GB|MB|KB)/i);
      }
      if (tempMatch) {
        const val = parseFloat(tempMatch[1]);
        const unit = tempMatch[2].toUpperCase();
        tempBytes = Math.round(val * (unit === 'GB' ? 1073741824 : unit === 'MB' ? 1048576 : 1024));
      }
    }
    return { ramBytes, tempBytes };
  }

  function positionBoostHud() {
    const hud = qs('#boostHudCard');
    const btn = qs('#liquidOverviewSettings');
    if (!hud || hud.hidden || !btn) return;
    const rect = btn.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return;
    const vw = window.innerWidth;
    if (vw <= 699) {
      hud.style.top = Math.max(64, Math.round(rect.bottom + 10)) + 'px';
      hud.style.right = '12px';
      hud.style.left = '12px';
    } else {
      hud.style.top = Math.max(14, Math.round(rect.bottom + 10)) + 'px';
      hud.style.right = Math.max(16, Math.round(vw - rect.right)) + 'px';
      hud.style.left = 'auto';
    }
  }

  function startBoostVisuals() {
    clearTimeout(state.boostHudTimer);
    clearTimeout(state.boostBadgeTimer);
    if (state.boostAnimFrame) cancelAnimationFrame(state.boostAnimFrame);

    const btn = qs('#liquidOverviewSettings');
    const label = qs('#boostBtnLabel');
    const sub = qs('#boostBtnSub');
    if (btn) {
      btn.classList.remove('is-boost-complete');
      btn.classList.add('is-boosting');
    }
    if (label) label.textContent = 'Boosting…';
    if (sub) { sub.hidden = true; sub.textContent = ''; }

    const ramCard = qs('.overview-ram-card');
    if (ramCard) ramCard.classList.add('is-boosting-ram');

    const hud = qs('#boostHudCard');
    if (!hud) return;
    hud.hidden = false;
    hud.classList.remove('is-complete', 'is-failed');
    hud.classList.add('is-running', 'is-visible');
    qs('#boostHudTitle').textContent = 'Boosting PC…';
    qs('#boostHudStep').textContent = 'Trimming background memory & sweeping temp cache…';
    qs('#boostHudCoreIcon').textContent = '⚡';
    qs('#boostHudRamVal').textContent = 'Scanning…';
    qs('#boostHudRamSub').textContent = 'Working set memory';
    qs('#boostHudTempVal').textContent = 'Scanning…';
    qs('#boostHudTempSub').textContent = 'Temporary cache';
    const arc = qs('#boostHudArc');
    if (arc) arc.style.strokeDashoffset = '48';
    positionBoostHud();
  }

  function updateBoostVisualsProgress(task) {
    if (!task || task.id !== 'boost') return;
    const stepEl = qs('#boostHudStep');
    if (stepEl && task.stepTitle) stepEl.textContent = task.stepTitle;
    const arc = qs('#boostHudArc');
    if (arc && task.totalSteps > 0) {
      const pct = Math.min(0.92, Math.max(0.25, task.currentStep / task.totalSteps));
      arc.style.strokeDashoffset = String(Math.round(163.36 * (1 - pct)));
    }
  }

  function completeBoostVisuals(result, title) {
    const btn = qs('#liquidOverviewSettings');
    const label = qs('#boostBtnLabel');
    const sub = qs('#boostBtnSub');
    const ramCard = qs('.overview-ram-card');
    if (ramCard) ramCard.classList.remove('is-boosting-ram');

    const success = Boolean(result && result.success !== false);
    const details = (result && result.detailedResult) || {};
    const fallback = parseBoostFallbackBytes(result?.summary || '');
    const wsTrimmedBytes = Number.isFinite(details.workingSetTrimmedBytes)
      ? details.workingSetTrimmedBytes
      : (Number.isFinite(details.workingSetReductionBytes)
          ? details.workingSetReductionBytes
          : (Number.isFinite(details.workingSetReducedBytes)
              ? details.workingSetReducedBytes
              : (Number.isFinite(details.ramFreedBytes) ? details.ramFreedBytes : fallback.ramBytes)));
    const availableChange=Number.isFinite(details.availableChangeBytes)?details.availableChangeBytes:null;
    const observedMemory=availableChange===null?'Unavailable':`${availableChange<0?'-':'+'}${formatBoostBytesUI(Math.abs(availableChange))} observed (not attributable)`;
    const tempFreedBytes = Number.isFinite(details.tempFreedBytes)
      ? details.tempFreedBytes
      : (Number.isFinite(details.bytesFreed)
          ? details.bytesFreed
          : (Number.isFinite(details.reclaimedBytes)
              ? details.reclaimedBytes
              : (Number.isFinite(details.tempDeletedBytes)
                  ? details.tempDeletedBytes
                  : (Number.isFinite(result?.summary?.reclaimedBytes) ? result.summary.reclaimedBytes : fallback.tempBytes))));
    const trimmedProcesses = Number.isFinite(details.trimmedProcesses) ? details.trimmedProcesses : 0;
    const isNoOp = success && (details.code === 'no-eligible-items' || details.code === 'already-optimized' || (wsTrimmedBytes === 0 && tempFreedBytes === 0 && trimmedProcesses === 0));
    const scannedItems = Number.isFinite(details.scannedCount) ? details.scannedCount : 0;
    const deletedItems = Number.isFinite(details.deletedCount) ? details.deletedCount : 0;
    const summaryText = result?.summary || (
      isNoOp
        ? `No optimization needed: background apps within optimal bounds and ${scannedItems ? `${scannedItems} inspected temporary files` : 'temporary files'} within retention limits.`
        : `Boost complete: ${formatBoostBytesUI(wsTrimmedBytes)} trimmed · ${formatBoostBytesUI(tempFreedBytes)} temp cleaned (${deletedItems} items).`
    );

    // Populate #maintToastMessage silently for test/accessibility compatibility
    const toastTitle = qs('#maintToastTitle');
    const toastMsg = qs('#maintToastMessage');
    if (toastTitle) toastTitle.textContent = isNoOp ? 'PC Boost Checked' : `${title || 'Boost'} ${success ? 'succeeded' : 'failed'}`;
    if (toastMsg) toastMsg.textContent = summaryText;

    if (btn) {
      btn.classList.remove('is-boosting');
      if (success) btn.classList.add('is-boost-complete');
    }
    if (label) label.textContent = success ? (isNoOp ? 'Checked' : 'Boosted') : 'Boost';
    if (sub && success) {
      sub.textContent = isNoOp ? 'No cleanup needed' : `${formatBoostBytesUI(wsTrimmedBytes)} trimmed · ${formatBoostBytesUI(tempFreedBytes)} temp`;
      sub.hidden = false;
    }

    const hud = qs('#boostHudCard');
    if (!hud) return;
    hud.hidden = false;
    hud.classList.remove('is-running', 'is-complete', 'is-failed');
    hud.classList.add(success ? 'is-complete' : 'is-failed', 'is-visible');
    positionBoostHud();

    const arc = qs('#boostHudArc');
    if (arc) arc.style.strokeDashoffset = '0';
    qs('#boostHudCoreIcon').textContent = success ? '✓' : '!';
    qs('#boostHudTitle').textContent = success ? (isNoOp ? 'No Cleanup Needed' : 'PC Boost Complete') : 'Boost Failed';
    qs('#boostHudStep').textContent = success
      ? (isNoOp
          ? (scannedItems > 0
              ? `Inspected ${scannedItems} items in temp & cache; evaluated background apps`
              : 'Evaluated background apps; temporary files within retention limits')
          : (trimmedProcesses > 0 && deletedItems > 0
              ? `Optimized ${trimmedProcesses} background app${trimmedProcesses === 1 ? '' : 's'} (${formatBoostBytesUI(wsTrimmedBytes)}) · Removed ${deletedItems} temp items (${formatBoostBytesUI(tempFreedBytes)})`
              : (trimmedProcesses > 0
                  ? `Optimized ${trimmedProcesses} background app${trimmedProcesses === 1 ? '' : 's'} (${formatBoostBytesUI(wsTrimmedBytes)} trimmed)`
                  : `Removed ${deletedItems} temporary items (${formatBoostBytesUI(tempFreedBytes)})`)))
      : summaryText;

    const ramLabel = qs('#boostHudRamLabel');
    if (ramLabel) ramLabel.textContent = 'Working Set';

    const ramEl = qs('#boostHudRamVal');
    const ramSub = qs('#boostHudRamSub');
    const tempEl = qs('#boostHudTempVal');
    const tempSub = qs('#boostHudTempSub');

    if (ramSub) {
      ramSub.textContent = isNoOp
        ? 'No apps eligible to trim'
        : (trimmedProcesses > 0
            ? `${trimmedProcesses} background app${trimmedProcesses === 1 ? '' : 's'} (${observedMemory})`
            : 'No memory trimming performed');
    }
    if (tempSub) {
      tempSub.textContent = isNoOp
        ? (scannedItems > 0 ? `Inspected ${scannedItems} items in temp & cache` : 'Temporary files within retention limits')
        : (deletedItems > 0 ? `${deletedItems} temporary item${deletedItems === 1 ? '' : 's'} removed` : 'Temporary cache cleared');
    }

    const prefersReducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (prefersReducedMotion || !success || isNoOp) {
      if (ramEl) ramEl.textContent = formatBoostBytesUI(wsTrimmedBytes);
      if (tempEl) tempEl.textContent = formatBoostBytesUI(tempFreedBytes);
    } else {
      const start = performance.now();
      const duration = 680;
      const tick = (now) => {
        const t = Math.min(1, (now - start) / duration);
        const ease = 1 - Math.pow(1 - t, 3);
        if (ramEl) ramEl.textContent = formatBoostBytesUI(Math.round(wsTrimmedBytes * ease));
        if (tempEl) tempEl.textContent = formatBoostBytesUI(Math.round(tempFreedBytes * ease));
        if (t < 1) {
          state.boostAnimFrame = requestAnimationFrame(tick);
        } else {
          if (ramEl) ramEl.textContent = formatBoostBytesUI(wsTrimmedBytes);
          if (tempEl) tempEl.textContent = formatBoostBytesUI(tempFreedBytes);
        }
      };
      state.boostAnimFrame = requestAnimationFrame(tick);
    }

    clearTimeout(state.boostHudTimer);
    state.boostHudTimer = setTimeout(dismissBoostHud, 2800);
    clearTimeout(state.boostBadgeTimer);
    state.boostBadgeTimer = setTimeout(() => {
      if (btn) btn.classList.remove('is-boost-complete');
      if (label) label.textContent = 'Boost';
      if (sub) sub.hidden = true;
    }, 3600);
  }

  function dismissBoostHud() {
    clearTimeout(state.boostHudTimer);
    state.boostHudTimer = null;
    const hud = qs('#boostHudCard');
    if (hud) {
      hud.classList.remove('is-visible', 'is-running', 'is-complete', 'is-failed');
      hud.hidden = true;
    }
  }

  // ── Action Click Handler ──────────────────────────────────────────────────

  function onActionClick(action) {
    if (!action || state.isRunning || state.unsupported) return;

    if (action.confirm || action.requiresAdmin || state.platform === 'linux') {
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
    if (action.requiresAdmin && !state.isLocal && !state.serviceEnabled && state.platform !== 'linux') {
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

    if (state.platform === 'linux') {
      if (action.id === 'empty_recycle_bin') {
        qs('#maintModalTitle').textContent = 'Empty Trash?';
        confirmBtn.textContent = 'Empty Trash';
      } else {
        qs('#maintModalTitle').textContent = action.confirmTitle || `Run: ${action.title}?`;
        confirmBtn.textContent = action.confirmBtnLabel || 'Confirm';
      }
    } else {
      qs('#maintModalTitle').textContent = action.confirmTitle || `Run: ${action.title}?`;
      confirmBtn.textContent = action.confirmBtnLabel || 'Confirm';
    }

    let bodyText = action.confirmBody || action.desc;
    if (state.platform === 'linux') {
      if (action.id === 'clean_temp') {
        bodyText = 'Safely analyzes and removes user thumbnail caches and owned temporary files.';
      } else if (action.id === 'empty_recycle_bin') {
        bodyText = 'Permanently deletes files from user XDG Trash. They cannot be recovered afterward.';
      } else if (action.id === 'clear_dns') {
        bodyText = 'Flushes the systemd-resolved DNS cache if available.';
      } else if (action.id === 'boost') {
        bodyText = 'Frees temporary user cache files and reclaims disposable memory.';
      }
      bodyText += ' Enter your Rovarin PIN to authorize execution.';
    } else if (action.requiresAdmin) {
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

    const needsPin = (action.requiresAdmin && !state.isLocal) || state.platform === 'linux';
    if (needsPin) {
      if (pinSection) pinSection.style.display = 'block';
      setTimeout(() => { if (pinInput) pinInput.focus(); }, 50);
    } else {
      if (pinSection) pinSection.style.display = 'none';
    }

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

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      const hud = qs('#boostHudCard');
      if (hud && !hud.hidden && !state.isRunning) {
        dismissBoostHud();
      }
    }
  });

  // Click outside modal to dismiss
  document.addEventListener('click', (e) => {
    const modal = qs('#maintModal');
    if (modal && modal.style.display !== 'none' && e.target === modal) closeModal();
  });

  // ── Execute Action ─────────────────────────────────────────────────────────

  async function executeAction(actionId, pin) {
    if (state.isRunning || state.unsupported) return;

    // Show progress panel immediately
    state.isRunning = true;
    showProgressPanel(actionId);
    setAllButtonsDisabled(true, actionId);
    if (actionId === 'boost') {
      startBoostVisuals();
    }

    const action = ACTIONS.find(a => a.id === actionId);
    const payload = (action && (action.confirm || action.requiresAdmin || actionId === 'boost'))
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
        if (actionId === 'boost') {
          completeBoostVisuals({ success: false, summary: data.error || 'Failed to start Boost.' }, 'Boost');
        } else {
          showMaintenanceToast(false, data.error || 'Failed to start operation.', actionTitle(actionId));
        }
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
      if (actionId === 'boost') {
        completeBoostVisuals({ success: false, summary: 'Could not contact the maintenance service.' }, 'Boost');
      } else {
        showMaintenanceToast(false, 'Could not contact the maintenance service.', actionTitle(actionId));
      }
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

    if (task.id === 'boost' && task.status === 'running') {
      updateBoostVisualsProgress(task);
    }

    qs('#maintProgressTitle').textContent = task.title || 'Running…';
    qs('#maintProgressStep').textContent = task.stepTitle || '';

    const pill = qs('#maintStatusPill');
    pill.textContent = task.status === 'running' ? 'Running' : task.status === 'completed' ? 'Done' : task.status === 'partially-completed' ? 'Partial' : task.status === 'unverified' ? 'Unverified' : task.status === 'cancelled' ? 'Cancelled' : 'Failed';
    pill.className = 'maint-status-pill ' + (task.status === 'running' ? 'running' : task.status === 'completed' ? 'completed' : task.status === 'partially-completed' ? 'partially-completed' : task.status === 'unverified' ? 'unverified' : task.status === 'cancelled' ? 'cancelled' : 'failed');

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
      banner.className = 'maint-result-banner ' + (task.status === 'cancelled' ? 'cancelled' : task.status === 'partially-completed' ? 'partially-completed' : task.status === 'unverified' ? 'unverified' : task.result.success ? 'success' : 'failed');
    }
  }

  // ── Status Polling ─────────────────────────────────────────────────────────

  function schedulePoll() {
    clearTimeout(state.pollTimer);
    if (window.pcMonitorUninstalling || state.unsupported) return;
    if (typeof window.dashboardClientVisible === 'function' && !window.dashboardClientVisible()) return;
    state.pollTimer = setTimeout(fetchStatus, state.isRunning ? 450 : 4000);
  }

  function startFastPoll() {
    clearTimeout(state.pollTimer);
    if (state.unsupported) return;
    state.pollTimer = setTimeout(fetchStatus, 320);
  }

  function markMaintenanceUnsupported() {
    state.unsupported = true;
    clearTimeout(state.pollTimer);
    state.pollTimer = null;
    state.isRunning = false;
    state.runningActionId = null;
    state.pendingToastActionId = null;
    closeModal();
    dismissBoostHud();
    const panel = qs('#maintProgressPanel');
    if (panel) panel.classList.add('active');
    const pill = qs('#maintStatusPill');
    if (pill) { pill.textContent = 'Unavailable on Linux'; pill.className = 'maint-status-pill failed'; }
    const title = qs('#maintProgressTitle');
    if (title) title.textContent = 'Maintenance unavailable';
    const step = qs('#maintProgressStep');
    if (step) step.textContent = 'Maintenance actions are Windows-only and are not available on Linux.';
    const badge = qs('#maintAdminBadge');
    if (badge) { badge.textContent = 'Not available on Linux'; badge.className = 'maint-admin-badge not-admin'; }
    setAllButtonsDisabled(true);
  }

  async function fetchStatus() {
    if (window.pcMonitorUninstalling || state.unsupported) return;
    if (typeof window.dashboardClientVisible === 'function' && !window.dashboardClientVisible()) return;
    try {
      const res = await fetch('/api/maintenance/status', { credentials: 'same-origin' });
      // Only the Linux backend's explicit capability error is terminal.
      // Generic 501s and transient Windows failures retain normal retries.
      if (res.status === 501) {
        const error = await res.json();
        if (error?.error === 'unsupported_on_linux') { markMaintenanceUnsupported(); return; }
      }
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
    state.boostAdviceAvailable=Boolean(data.boostAdvice&&typeof data.boostAdvice.suggested==='boolean');
    const boostButton=qs('#liquidOverviewSettings');
    const suggested=data.boostAdvice?.suggested===true&&!data.isRunning;
    if(boostButton){boostButton.classList.toggle('is-boost-suggested',suggested);boostButton.setAttribute('aria-label',suggested?'PC Boost: sustained memory pressure; eligible minimized apps available':'PC Boost');}

    if (state.unsupported) return;
    if (data.platform) {
      state.platform = data.platform;
    }
    updateActionCardsForPlatform();
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
      if (data.platform === 'linux') {
        badge.textContent = 'Standard User';
        badge.className = 'maint-admin-badge not-admin';
        badge.title = 'Linux user-level maintenance actions. Actions run safely within user permissions.';
      } else if (state.serviceEnabled) {
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

    const activeTask = data.currentTask || data.currentJob;

    if (activeTask) {
      updateProgressPanel(activeTask);

      if (activeTask.status !== 'running') {
        const taskId = activeTask.id || activeTask.action;
        if (state.pendingToastActionId && (taskId === state.pendingToastActionId)) {
          const result = activeTask.result || {};
          if (taskId === 'boost') {
            completeBoostVisuals(result, activeTask.title || 'Boost');
          } else {
            const isCancelled = result.detailedResult?.code === 'uac-cancelled' || activeTask.status === 'cancelled';
            const isPartial = activeTask.status === 'partially-completed' || result.detailedResult?.code === 'partially-completed' || result.detailedResult?.code === 'locked-files-only';
            const isUnverified = activeTask.status === 'unverified' || result.detailedResult?.code === 'verification-unavailable';
            const isAlreadyClean = result.detailedResult?.code === 'already-empty' || result.detailedResult?.code === 'already-clean';
            showMaintenanceToast(result.success, result.summary || (result.success ? 'Operation completed.' : 'Operation failed.'), activeTask.title || actionTitle(state.pendingToastActionId), isCancelled, isPartial, isUnverified, isAlreadyClean);
          }
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
        const lastId = last ? (last.id || last.action) : null;
        if (last && lastId === state.runningActionId) {
          const pill = qs('#maintStatusPill');
          if (pill) {
            pill.textContent = last.status === 'completed' ? 'Done' : last.status === 'partially-completed' ? 'Partial' : last.status === 'unverified' ? 'Unverified' : last.status === 'cancelled' ? 'Cancelled' : 'Failed';
            pill.className = 'maint-status-pill ' + (last.status === 'completed' ? 'completed' : last.status === 'partially-completed' ? 'partially-completed' : last.status === 'unverified' ? 'unverified' : last.status === 'cancelled' ? 'cancelled' : 'failed');
          }
          const stepFill = qs('#maintStepFill');
          if (stepFill) stepFill.style.width = '100%';
          const banner = qs('#maintResultBanner');
          if (banner) {
            banner.textContent = last.summary;
            banner.className = 'maint-result-banner ' + (last.status === 'cancelled' ? 'cancelled' : last.status === 'partially-completed' ? 'partially-completed' : last.status === 'unverified' ? 'unverified' : last.success ? 'success' : 'failed');
          }
          if (state.pendingToastActionId && lastId === state.pendingToastActionId) {
            if (lastId === 'boost') {
              completeBoostVisuals({ success: last.success, summary: last.summary, detailedResult: last.detailedResult }, last.title || 'Boost');
            } else {
              const isCancelled = last.status === 'cancelled';
              const isPartial = last.status === 'partially-completed';
              const isUnverified = last.status === 'unverified';
              showMaintenanceToast(last.success, last.summary, last.title || actionTitle(lastId), isCancelled, isPartial, isUnverified);
            }
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

  function showMaintenanceToast(success, message, title, cancelled = false, isPartial = false, isUnverified = false, isAlreadyClean = false) {
    const toast = qs('#maintToast');
    if (!toast) return;
    clearTimeout(state.toastTimer);
    qs('#maintToastIcon').textContent = isUnverified ? 'ℹ' : isPartial ? '!' : success ? '✓' : '×';
    const outcomeText = cancelled ? 'cancelled' : isUnverified ? 'completed (unverified)' : isPartial ? 'partially completed' : isAlreadyClean ? 'already clean' : success ? 'succeeded' : 'failed';
    qs('#maintToastTitle').textContent = `${title} ${outcomeText}`;
    qs('#maintToastMessage').textContent = message;
    toast.classList.remove('success', 'failed', 'cancelled', 'partial', 'unverified');
    toast.classList.add(cancelled ? 'cancelled' : isUnverified ? 'unverified' : isPartial ? 'partial' : success ? 'success' : 'failed', 'is-visible');
    state.toastTimer = setTimeout(dismissMaintenanceToast, 6500);
  }

  function dismissMaintenanceToast() {
    clearTimeout(state.toastTimer);
    state.toastTimer = null;
    const toast = qs('#maintToast');
    if (toast) toast.classList.remove('is-visible');
  }

  function setAllButtonsDisabled(disabled, activeId) {
    disabled = disabled || state.unsupported;
    const boost = qs('#liquidOverviewSettings');
    if (boost) {
      boost.disabled = disabled || state.boostAdviceAvailable!==true;
      boost.title = state.unsupported ? 'PC Boost is Windows-only' : disabled ? 'PC Boost running' : 'PC Boost';
      boost.setAttribute('aria-busy', String(disabled && activeId === 'boost'));
      if (!disabled) {
        boost.classList.remove('is-boosting');
      }
    }
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

    list.innerHTML = historyItems.slice(0, 10).map(item => {
      const title = item.title || actionTitle(item.id || item.action);
      const date = item.date || (item.completedAt ? new Date(item.completedAt).toLocaleDateString('en-US') : '');
      const time = item.timestamp || (item.completedAt ? new Date(item.completedAt).toLocaleTimeString('en-US', { hour12: false }) : '');
      const duration = item.duration || (item.durationMs !== undefined ? `${Math.round(item.durationMs / 1000)}s` : '0s');
      return `
      <div class="maint-history-item">
        <div class="maint-history-dot ${item.status === 'unverified' ? 'unverified' : item.status === 'partially-completed' ? 'partial' : item.success ? 'success' : 'failed'}"></div>
        <div class="maint-history-body">
          <div class="maint-history-name">${escHtml(title)}</div>
          <div class="maint-history-meta">${escHtml(date)} ${escHtml(time)} · ${escHtml(duration)} · ${item.status === 'cancelled' ? 'Cancelled' : item.status === 'partially-completed' ? 'Partial (Restart Required)' : item.status === 'unverified' ? 'Unverified' : item.success ? 'Succeeded' : 'Failed'}</div>
        </div>
      </div>
    `;
    }).join('');
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
