const pinInput = document.getElementById('pinInput');
const unlockBtn = document.getElementById('unlockBtn');
const errMsg = document.getElementById('errMsg');
try { localStorage.removeItem('auth_pin'); } catch (_) {}
try { sessionStorage.removeItem('rovarin.cachedApps.v1'); } catch (_) {}
let loginPending = false;
let autoSubmittedPin = null;
// Length mode only, rendered by the server; absent/unknown metadata fails to manual entry.
const sixDigitPinMode = document.querySelector?.('meta[name="rovarin-pin-mode"]')?.content === '6';

function reportClientLog(event, detail = {}) {
  try {
    if (typeof window === 'undefined' || !window.location || !window.location.origin) return;
    const payload = JSON.stringify({
      event,
      url: window.location.href,
      visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
      detail
    });
    console.log('[Rovarin Login Log]', event, detail);
    fetch('/api/debug/client-log', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      keepalive: true,
      body: payload
    }).catch(() => {
      if (typeof navigator !== 'undefined' && navigator.sendBeacon) {
        navigator.sendBeacon('/api/debug/client-log', new Blob([payload], { type: 'application/json' }));
      }
    });
  } catch (_) {}
}
reportClientLog('LOGIN_PAGE_MOUNT', {
  hasSessionCookie: String(document.cookie || '').includes('pc_monitor_session'),
  hasAuthPinCookie: String(document.cookie || '').includes('auth_pin')
});

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function' && typeof window !== 'undefined' && window.location && window.location.origin) {
  document.addEventListener('visibilitychange', () => {
    reportClientLog('LOGIN_VISIBILITY_CHANGE', { state: document.visibilityState });
  });
}
if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && window.location && window.location.origin) {
  window.addEventListener('pageshow', (e) => {
    reportClientLog('LOGIN_PAGE_SHOW', { persisted: e.persisted });
  });
}

async function attemptLogin() {
  const pin = pinInput.value.trim();
  if (!pin || loginPending) return;
  loginPending = true;
  errMsg.textContent = '';
  unlockBtn.disabled = true;
  unlockBtn.textContent = 'Verifying...';
  reportClientLog('LOGIN_SUBMIT_START', { pinLength: pin.length });

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pin })
    });
    const data = await response.json();
    reportClientLog('LOGIN_SUBMIT_RESPONSE', {
      status: response.status,
      ok: response.ok,
      success: data && data.success,
      code: data && data.code,
      error: data && data.error
    });
    if (response.ok && data.success) {
      unlockBtn.textContent = 'Unlocked!';
      try { pinInput.blur(); } catch (_) {}
      if (typeof window.cleanupLoginViewport === 'function') {
        try { window.cleanupLoginViewport(); } catch (_) {}
      }
      try {
        const root = document.documentElement;
        root.style.removeProperty('--login-viewport-height');
        root.style.removeProperty('--login-viewport-top');
        root.classList.remove('login-keyboard', 'login-page');
        document.body?.classList?.remove('login-keyboard', 'login-page');
        window.scrollTo(0, 0);
      } catch (_) {}
      reportClientLog('LOGIN_NAVIGATING_TO_ROOT');
      window.location.replace('/');
      return;
    }
    errMsg.textContent = response.status === 429
      ? `Too many attempts. Try again in ${Number(response.headers.get('Retry-After')) || 60} seconds.`
      : 'Incorrect PIN. Please try again.';
    if (pinInput.value.trim() === pin) pinInput.value = '';
    pinInput.focus();
  } catch (_) {
    errMsg.textContent = 'Connection error. Check Tailscale.';
  } finally {
    loginPending = false;
    unlockBtn.disabled = false;
    unlockBtn.textContent = 'Unlock Dashboard';
  }
}

unlockBtn.addEventListener('click', attemptLogin);
pinInput.addEventListener('keydown', event => {
  if (event.key === 'Enter') attemptLogin();
});
// Only current six-digit mode auto-submits. Legacy/unknown mode never guesses
// at digit six; Enter/button still use the one shared attemptLogin routine.
pinInput.addEventListener('input', () => {
  const pin = pinInput.value.trim();
  if (!sixDigitPinMode || !/^\d{6}$/.test(pin) || loginPending || pin === autoSubmittedPin) return;
  autoSubmittedPin = pin;
  attemptLogin();
});

// Follow the keyboard's usable viewport without introducing a scrolling pane.
(() => {
  const viewport = window.visualViewport;
  if (!viewport) return;
  const root = document.documentElement;
  const updateViewport = () => {
    if (root.classList.contains('native-shell') || (window.innerWidth > 699 && !window.matchMedia?.('(pointer: coarse)').matches)) {
      root.style.removeProperty('--login-viewport-height');
      root.style.removeProperty('--login-viewport-top');
      root.classList.remove('login-keyboard');
      return;
    }
    root.style.setProperty('--login-viewport-height', viewport.height + 'px');
    root.style.setProperty('--login-viewport-top', viewport.offsetTop + 'px');
    root.classList.toggle('login-keyboard', viewport.height < window.innerHeight * .8);
  };
  const detach = () => {
    viewport.removeEventListener('resize', updateViewport);
    viewport.removeEventListener('scroll', updateViewport);
    window.removeEventListener('resize', updateViewport);
  };
  // Reattach after a bfcache restore; pagehide prevents stale listeners.
  const attach = () => {
    detach();
    viewport.addEventListener('resize', updateViewport);
    viewport.addEventListener('scroll', updateViewport);
    window.addEventListener('resize', updateViewport);
    updateViewport();
  };
  window.addEventListener('pagehide', detach);
  window.addEventListener('pageshow', attach);
  attach();
  window.cleanupLoginViewport = () => {
    detach();
    root.style.removeProperty('--login-viewport-height');
    root.style.removeProperty('--login-viewport-top');
    root.classList.remove('login-keyboard');
    try { document.body?.classList?.remove('login-keyboard'); } catch (_) {}
  };
})();
