(() => {
  'use strict';
  // Decorative resources must never gate PIN handlers, first paint or app bootstrap.
  const root = document.documentElement;
  const THEME_KEY='rovarin.desktopTheme';
  let theme='simplified';
  try { const saved=localStorage.getItem(THEME_KEY); if(['simplified','liquid'].includes(saved))theme=saved; } catch {}
  root.dataset.desktopTheme=theme;
  function chooseTheme(value){
    if(!['simplified','liquid'].includes(value))return;
    root.dataset.desktopTheme=value;
    try{localStorage.setItem(THEME_KEY,value);}catch{}
    window.dispatchEvent(new Event('rovarin-theme-change'));
  }
  document.addEventListener('DOMContentLoaded',()=>{
    const select=document.getElementById('desktopTheme');
    if(select){select.value=theme;select.addEventListener('change',e=>chooseTheme(e.target.value));}
  },{once:true});
  const stylesheet = document.getElementById('liquidStyles');
  const enableStyles = () => { if (stylesheet) stylesheet.media = 'all'; };
  if (stylesheet) {
    stylesheet.addEventListener('load', enableStyles, { once: true });
    if (performance.getEntriesByName(stylesheet.href).some(entry => entry.responseEnd > 0)) enableStyles();
  }
  if (root.classList.contains('login-page')) {
    // The locked page keeps the glass CSS, with no renderer/compile on the PIN path.
    root.dataset.graphicsQuality = 'minimal';
    window.RovarinGlass = Object.freeze({ diagnostics: () => ({ quality: 'minimal', frames: 0, idle: true, contexts: 0 }) });
    return;
  }
  const start = () => requestAnimationFrame(() => requestAnimationFrame(() => {
    if (document.hidden) return;
    import('./liquid-glass.js').catch(() => { root.dataset.graphicsQuality = 'minimal'; });
  }));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
  // If initially opened in a background tab, start once it becomes visible.
  document.addEventListener('visibilitychange', function resume() {
    if (!document.hidden) { document.removeEventListener('visibilitychange', resume); if (!window.RovarinGlass) start(); }
  });
})();
