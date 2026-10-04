const pinInput = document.getElementById('pinInput');
const unlockBtn = document.getElementById('unlockBtn');
const errMsg = document.getElementById('errMsg');
try { localStorage.removeItem('auth_pin'); } catch (_) {}
let loginPending = false;
let autoSubmittedPin = null;
// Length mode only, rendered by the server; absent/unknown metadata fails to manual entry.
const sixDigitPinMode = document.querySelector?.('meta[name="rovarin-pin-mode"]')?.content === '6';

async function attemptLogin() {
  const pin = pinInput.value.trim();
  if (!pin || loginPending) return;
  loginPending = true;
  errMsg.textContent = '';
  unlockBtn.disabled = true;
  unlockBtn.textContent = 'Verifying...';

  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ pin })
    });
    const data = await response.json();
    if (response.ok && data.success) {
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
    if (root.classList.contains('native-shell') || window.innerWidth > 699) {
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
})();
