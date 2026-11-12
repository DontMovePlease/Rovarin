(() => {
  'use strict';
  const page = document.getElementById('powerPage'), dialog = document.getElementById('powerConfirm');
  if (!page || !dialog) return;
  const status = document.getElementById('powerStatus'), pin = document.getElementById('powerPin'), error = document.getElementById('powerConfirmError');
  const actions = { sleep: ['Sleep', 'Remote access will disconnect until this PC wakes. Sleep availability depends on Windows and your hardware.'], restart: ['Restart', 'Save your work first. Remote access will disconnect while Windows restarts. Unsaved work may require attention on the PC.'], shutdown: ['Shut Down', 'Save your work first. Remote access will disconnect. Someone must turn this PC on before you can reconnect.'] };
  let selected = null, submitting = false, opening = false, requirePin = true, timer = null, generation = 0, currentPlatform = 'windows';
  function disable(value) { page.querySelectorAll('[data-power-action]').forEach(button => { button.disabled = value; }); }
  function stopChecking() { generation++; clearTimeout(timer); timer = null; }
  async function check(generationAtStart = generation, remaining = 0) {
    try {
      const response = await fetch('/api/power/status', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) {
        if (response.status === 501) {
          const body = await response.json().catch(() => ({}));
          if (generationAtStart === generation) {
            status.textContent = body?.message || 'Power controls are not supported on this platform.';
            disable(true);
          }
          return;
        }
        throw Error(response.status === 401 ? 'Your session expired. Sign in again.' : 'Power status is unavailable.');
      }
      const data = await response.json();
      if (generationAtStart !== generation) return;
      currentPlatform = data.platform || 'windows';
      requirePin = data.requirePin !== false;
      const isLinux = currentPlatform === 'linux';
      const restartCopy = page.querySelector('[data-power-action="restart"] .power-action-copy span');
      if (restartCopy) restartCopy.textContent = isLinux ? 'Restart this PC. Remote access disconnects temporarily.' : 'Restart Windows. Remote access disconnects temporarily.';
      status.textContent = data.operation?.message || (data.available ? (isLinux ? 'Choose an action. System permissions still apply.' : 'Choose an action. Windows permissions still apply.') : (isLinux ? 'Power controls require systemd or logind.' : 'Power controls require Windows.'));
      disable(submitting || data.busy || !data.available);
      if (remaining > 0 && !page.hidden && ['preparing','awaiting-ack','accepted','pending'].includes(data.operation?.state)) timer = setTimeout(() => check(generationAtStart, remaining - 1), 800);
      return data;
    } catch (failure) {
      if (generationAtStart === generation) status.textContent = failure.message === 'Your session expired. Sign in again.' ? failure.message : 'Connection unavailable. The power request may have started; completion is not verified. Check the PC before retrying.';
    }
  }
  page.querySelectorAll('[data-power-action]').forEach(button => button.addEventListener('click', async () => {
    if (submitting || opening) return;
    opening = true;
    const ticket = generation;
    let policy; try { policy = await check(ticket); } finally { opening = false; }
    if (!policy || policy.busy || !policy.available || page.hidden || ticket !== generation) return;
    selected = button.dataset.powerAction;
    const isLinux = currentPlatform === 'linux';
    const actionDesc = (isLinux && selected === 'sleep')
      ? 'Remote access will disconnect until this PC wakes. Sleep availability depends on your system and hardware.'
      : (isLinux && selected === 'restart')
        ? 'Save your work first. Remote access will disconnect while the system restarts. Unsaved work may require attention on the PC.'
        : actions[selected][1];
    document.getElementById('powerConfirmTitle').textContent = actions[selected][0] + ' this PC?';
    document.getElementById('powerConfirmDescription').textContent = actionDesc;
    document.getElementById('powerConfirmSubmit').textContent = actions[selected][0];
    pin.hidden = !requirePin; pin.required = requirePin;
    dialog.querySelector('label[for=powerPin]').hidden = !requirePin;
    pin.value = ''; error.textContent = ''; dialog.showModal();
    (requirePin ? pin : document.getElementById('powerCancel')).focus();
  }));
  document.getElementById('powerCancel').addEventListener('click', () => { if (!submitting) { dialog.close(); pin.value = ''; selected = null; } });
  dialog.addEventListener('cancel', event => { if (submitting) event.preventDefault(); else { pin.value = ''; selected = null; } });
  document.getElementById('powerConfirmForm').addEventListener('submit', async event => {
    event.preventDefault(); if (submitting || !selected) return;
    if (requirePin && !/^(?:\d{6}|\d{8}|\d{12})$/.test(pin.value)) { error.textContent = 'Enter your current Rovarin PIN.'; return; }
    submitting = true; disable(true); stopChecking();
    const submit = document.getElementById('powerConfirmSubmit'), cancel = document.getElementById('powerCancel'); submit.disabled = true; cancel.disabled = true;
    const body = { action: selected, confirmed: true, requestId: crypto.randomUUID() };
    if (requirePin) body.pin = pin.value;
    pin.value = '';
    error.textContent = ''; status.textContent = currentPlatform === 'linux' ? 'Preparing power request…' : 'Preparing Windows power request…';
    try {
      const response = await fetch('/api/power/run', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) { error.textContent = result.error || (currentPlatform === 'linux' ? 'System refused this request.' : 'Windows refused this request.'); status.textContent = error.textContent; disable(false); return; }
      dialog.close(); status.textContent = currentPlatform === 'linux' ? 'Request acknowledged. Waiting for system; completion is not verified.' : 'Request acknowledged. Waiting for Windows; completion is not verified.';
      check(generation, 20);
    } catch { dialog.close(); status.textContent = 'Connection lost. The request may have started; completion is not verified. Check the PC before retrying.'; }
    finally { body.pin = ''; submitting = false; submit.disabled = false; cancel.disabled = false; }
  });
  document.getElementById('powerRefresh').addEventListener('click', () => { stopChecking(); check(); });
  window.addEventListener('pc-monitor-pagechange', event => { stopChecking(); if (event.detail.page === 'powerPage') check(); else if (dialog.open && !submitting) { dialog.close(); pin.value = ''; selected = null; } });
  window.addEventListener('pagehide', stopChecking);
})();
