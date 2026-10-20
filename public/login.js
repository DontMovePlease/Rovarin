// Main application styles enhance the lock screen without blocking PIN setup.
const loginBaseStyles=document.getElementById('loginBaseStyles');
if(loginBaseStyles){const enable=()=>{loginBaseStyles.media='all';};loginBaseStyles.addEventListener('load',enable,{once:true});if(loginBaseStyles.sheet)enable();}
const pinInput = document.getElementById('pinInput');
const unlockBtn = document.getElementById('unlockBtn');
const errMsg = document.getElementById('errMsg');
try { localStorage.removeItem('auth_pin'); } catch (_) {}
try { sessionStorage.removeItem('rovarin.cachedApps.v1'); } catch (_) {}
let loginPending = false;
let loginSucceeded = false;
let autoSubmittedPin = null;
let loginController = null;
// Length mode only, rendered by the server; absent/unknown metadata fails to manual entry.
let sixDigitPinMode = document.querySelector?.('meta[name="rovarin-pin-mode"]')?.content === '6';

async function attemptLogin() {
  const pin = pinInput.value.trim();
  if (!pin || loginPending || loginSucceeded) return;
  loginPending = true;
  errMsg.textContent = '';
  unlockBtn.disabled = true;
  unlockBtn.textContent = 'Verifying...';


  const controller = new AbortController();
  loginController = controller;
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      signal: controller.signal,
      body: JSON.stringify({ pin })
    });
    const data = await response.json();
    if (controller.signal.aborted) return;
    if (response.ok && data.success) {
      loginSucceeded = true;
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

      window.location.replace('/');
      return;
    }
    if(response.status===401&&data.code==='pin-mode-changed'&&['6','12'].includes(data.pinMode)){
      sixDigitPinMode=data.pinMode==='6';
      errMsg.textContent='Your PIN uses '+data.pinMode+' digits. Enter the full PIN, then tap Unlock.';
      pinInput.focus();return;
    }
    if (response.status === 429) {
      errMsg.textContent = `Too many attempts. Try again in ${Number(response.headers.get('Retry-After')) || 60} seconds.`;
    } else if (response.status === 401) {
      errMsg.textContent = 'Incorrect PIN. Please try again.';
    } else if(data.code==='credential-unavailable'){
      errMsg.textContent='Rovarin cannot read its saved sign-in settings on this PC. Your PIN was not changed. Try again once Rovarin is ready.';
    } else {
      autoSubmittedPin = null;
      errMsg.textContent = 'Rovarin is temporarily unavailable. Check that it is running on your PC, then try again.';
    }
    if ([401,429].includes(response.status) && pinInput.value.trim() === pin) pinInput.value = '';
    pinInput.focus();
  } catch (_) {
    autoSubmittedPin = null;
    errMsg.textContent = controller.signal.aborted
      ? 'Rovarin did not respond. Check that your PC is online and Tailscale is connected, then try again.'
      : 'Could not reach Rovarin. Check your PC and Tailscale connection, then try again.';
  } finally {
    clearTimeout(timeout);
    if (loginController === controller) loginController = null;
    loginPending = false;
    autoSubmittedPin = null;
    unlockBtn.disabled = loginSucceeded;
    if(!loginSucceeded)unlockBtn.textContent = 'Unlock Dashboard';
  }
}

window.addEventListener('pagehide', () => loginController?.abort());
document.documentElement.dataset.loginReady = 'true';
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
    // WebKit can report a zero viewport while opening/resuming. Never collapse
    // the only visible login surface; keep the last usable size/CSS fallback.
    const height = Number(viewport.height);
    if (document.hidden || !Number.isFinite(height) || height <= 0) return;
    const top = Math.max(0, Math.min(Number(viewport.offsetTop) || 0, Math.max(0, window.innerHeight - height)));
    root.style.setProperty('--login-viewport-height', height + 'px');
    root.style.setProperty('--login-viewport-top', top + 'px');
    root.classList.toggle('login-keyboard', height < window.innerHeight * .8);
  };
  let viewportFrame = null;
  const detach = () => {
    if (viewportFrame !== null) { window.cancelAnimationFrame(viewportFrame); viewportFrame = null; }
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
    if (typeof window.requestAnimationFrame === 'function') viewportFrame = window.requestAnimationFrame(() => { viewportFrame = null; updateViewport(); });
  };
  document.addEventListener?.('visibilitychange', () => { if (document.hidden) detach(); else attach(); });
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
