'use strict';
(() => {
  const section = document.getElementById('uninstallControls');
  const form = document.getElementById('uninstallForm');
  const pin = document.getElementById('uninstallPin');
  const removeData = document.getElementById('uninstallRemoveData');
  const button = document.getElementById('uninstallSubmit');
  const feedback = document.getElementById('uninstallFeedback');
  let busy = false, accepted = false;
  async function refresh() {
    if (busy || accepted) return;
    try {
      const response = await fetch('/api/system/uninstall', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return;
      const data = await response.json();
      section.hidden = !data.available;
      button.disabled = data.uninstalling;
    } catch (_) { /* No retries: this is an on-demand installed-only control. */ }
  }
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || accepted || !/^(?:\d{6}|\d{8}|\d{12})$/.test(pin.value)) return;
    const policy = removeData.checked ? 'Your PIN and Rovarin settings will be erased.' : 'Your PIN and settings will be preserved for reinstall.';
    if (!window.confirm(`Uninstall Rovarin from this PC? Remote access will stop. ${policy} PawnIO and Tailscale remain installed.`)) return;
    busy = true; button.disabled = true;
    feedback.textContent = 'Validating the fixed Windows uninstall handoff…';
    try {
      const body = JSON.stringify({ pin: pin.value, confirmation: 'uninstall-pc-monitor', removeData: removeData.checked });
      pin.value = '';
      const response = await fetch('/api/system/uninstall', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body });
      const result = await response.json();
      if (response.status === 202 && result.code === 'uninstall-accepted') {
        accepted = true; removeData.disabled = true; pin.disabled = true;
        feedback.textContent = 'Uninstall accepted. Rovarin is shutting down and this dashboard will become unreachable. If removal does not finish, check Windows Settings → Apps on the PC. No automatic retry will be made.';
        window.pcMonitorUninstalling = true;
        window.dispatchEvent(new CustomEvent('pc-monitor-uninstalling'));
      } else feedback.textContent = result.error || 'Uninstall was not accepted. Rovarin remains running.';
    } catch (_) {
      // A lost response might already have committed the handoff. Never retry it.
      feedback.textContent = 'The result could not be confirmed. Check Windows Apps on the PC before trying again.';
      accepted = true;
      window.pcMonitorUninstalling = true;
      window.dispatchEvent(new CustomEvent('pc-monitor-uninstalling'));
    } finally { pin.value = ''; busy = false; button.disabled = accepted; }
  });
  window.addEventListener('pc-monitor-pagechange', event => { if (event.detail.page === 'diagnosticsPage') refresh(); });
  document.getElementById('refreshDiagnostics').addEventListener('click', refresh);
})();
