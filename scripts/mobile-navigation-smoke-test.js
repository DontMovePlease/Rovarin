'use strict';
const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const crypto = require('crypto');
const root = path.resolve(__dirname, '..');
const pin = String(crypto.randomInt(100000, 1000000));
const { chromium } = require(process.env.ROVARIN_PLAYWRIGHT_PATH || 'playwright');
let server, browser, output = '';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  server = spawn(process.execPath, ['-r', path.join(__dirname, 'system-management-test-tools.js'), 'server.js'], {
    cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PORT: '0', PC_MONITOR_PIN: pin }
  });
  server.stdout.on('data', x => output += x);
  server.stderr.on('data', x => output += x);
  let base;
  for (let i = 0; i < 150; i++) {
    const match = output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);
    if (match) { base = 'http://127.0.0.1:' + match[1]; break; }
    if (server.exitCode !== null) break;
    await delay(100);
  }
  assert(base, 'isolated frontend fixture starts');
  browser = await chromium.launch({ headless: true, executablePath: 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe' });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  assert.equal((await context.request.post(base + '/api/login', { headers: { Origin: base }, data: { pin } })).status(), 200);
  let maintenanceExecutionRequests = 0;
  // UI fixtures must never reach real host maintenance actions.
  await context.route('**/api/maintenance/**',async route=>{
    if(route.request().method()==='POST') {
      maintenanceExecutionRequests++;
      return route.fulfill({status:400,contentType:'application/json',body:JSON.stringify({error:'Maintenance execution disabled in UI fixture'})});
    }
    return route.continue();
  });
  await context.addInitScript(() => {
    const active = new Map();
    const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
    document.addEventListener = (type, fn, options) => {
      if (/^(handlePhoneDrawerTouch|preventPhoneBackgroundScroll)/.test(fn.name)) {
        if (!active.has(type)) active.set(type, new Set());
        active.get(type).add(fn);
      }
      return add(type, fn, options);
    };
    document.removeEventListener = (type, fn, options) => {
      active.get(type)?.delete(fn);
      return remove(type, fn, options);
    };
    window.navigationTouchListeners = () => [...active].filter(([type]) => type !== 'touchstart').reduce((n, [, listeners]) => n + listeners.size, 0);
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base);
  await page.waitForFunction(() => typeof setSidebarOpen === 'function');
  const geometry = () => page.evaluate(() => {
    const rect = selector => { const r = document.querySelector(selector).getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; };
    return { header: rect('.native-app-bar'), surface: rect('.phone-page-surface'), backdrop: rect('#sidebarBackdrop'), scroll: scrollY };
  });
  await page.evaluate(() => scrollTo(0, 400));
  await delay(100);
  const before = await geometry();
  await page.evaluate(() => setSidebarOpen(true));
  await delay(400);
  const open = await geometry();
  console.log('Scrolled drawer geometry:', JSON.stringify({ before, open }));
  if (process.argv.includes('--baseline')) return;
  assert(before.header.y >= 7 && before.header.y <= 9, 'header sticks after page scrolling');
  assert(open.header.y >= 7 && open.header.y <= 9, 'opening does not jump the header vertically');
  assert.equal(open.backdrop.y, 0, 'backdrop remains viewport-fixed');
  assert.equal(open.backdrop.height, 844, 'backdrop does not inherit full page height');
  const settle = async expected => {
    await page.waitForFunction(expected => {
      const expanded = document.body.classList.contains('sidebar-expanded');
      const offset = new DOMMatrixReadOnly(getComputedStyle(document.querySelector('.phone-page-surface')).transform).m41;
      const width = document.querySelector('#appSidebar').getBoundingClientRect().width;
      return expanded === expected && Math.abs(offset - (expected ? width : 0)) < 1;
    }, expected);
  };
  const touch = async (type, x, y = 200, selector = '.health-card') => page.evaluate(({type,x,y,selector}) => {
    const target = document.querySelector(selector);
    const point = new Touch({identifier: 7, target, clientX:x, clientY:y});
    target.dispatchEvent(new TouchEvent(type, {bubbles:true, cancelable:true,
      touches:type === 'touchend' || type === 'touchcancel' ? [] : [point], changedTouches:[point]}));
  }, {type,x,y,selector});
  const swipe = async (xs, selector = '.health-card') => {
    await touch('touchstart', xs[0], 200, selector);
    for (const x of xs.slice(1)) { await page.waitForTimeout(25); await touch('touchmove', x, 200, selector); }
    await touch('touchend', xs[xs.length-1], 200, selector);
  };
  await settle(true);
  await page.evaluate(() => setSidebarOpen(false)); await settle(false);
  const cdp = await context.newCDPSession(page);
  // Genuine browser touch input, rather than only dispatched DOM events.
  await page.evaluate(() => scrollTo(0,0));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:190,y:120}]});
  for (const x of [210,235,260,285,315]) {
    await page.waitForTimeout(25);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:120}]});
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await settle(true);
  await swipe([330,310,275,230,180], '#sidebarBackdrop'); await settle(false);
  await swipe([180,200,225]); await settle(true); // short decisive flick
  await swipe([330,310,280], '#sidebarBackdrop'); await settle(false);
  // Reversal of direction ends closed, not committed by total forward distance.
  await swipe([180,230,280,320,280,230,180]); await settle(false);
  await page.evaluate(()=>scrollTo(0,200));
  await touch('touchstart',180); await touch('touchmove',230); await page.waitForTimeout(50);
  const dragging = await geometry();
  assert(Math.abs(dragging.header.x-dragging.surface.x-12)<1,'header tracks finger with page');
  assert(Math.abs(dragging.backdrop.x-dragging.surface.x)<1,'backdrop tracks finger with page');
  assert.equal(dragging.header.y,8,'header stays at viewport top during drag');
  await touch('touchcancel',230); await settle(false);
  await page.evaluate(()=>setSidebarOpen(true));await page.waitForTimeout(100);
  await swipe([330,280,230],'#sidebarBackdrop');await settle(false);
  await touch('touchstart',180);await touch('touchmove',200);await page.waitForTimeout(150);await touch('touchend',200);await settle(false);
  assert.equal(await page.evaluate(()=>navigationTouchListeners()),0,'transient listeners removed after cancellation');
  assert(await page.evaluate(() => phoneDrawerSwipe === null && phoneDrawerFrame === null), 'cancel cleans active listeners/frame state');
  // Vertical native touch scrolling must remain available.
  await page.evaluate(() => scrollTo(0,0));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:190,y:250}]});
  for (const y of [225,190,155,110]) { await page.waitForTimeout(25); await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:190,y}]}); }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  await page.waitForTimeout(200);
  assert(await page.evaluate(() => scrollY > 50), 'native vertical touch scroll moves the page');
  assert(!await page.evaluate(() => document.body.classList.contains('sidebar-expanded')), 'vertical scroll never opens drawer');
  // A vertical beginning is not a permanent rejection of this touch.
  await touch('touchstart',180,200);
  await touch('touchmove',180,160);
  assert(await page.evaluate(()=>phoneDrawerSwipe && !phoneDrawerSwipe.horizontal),'vertical touch remains observable without claiming scroll');
  assert(!await page.evaluate(()=>document.documentElement.classList.contains('phone-navigation-locked')),'vertical intent leaves scroll unlocked');
  await touch('touchmove',215,160);
  assert(await page.evaluate(()=>phoneDrawerSwipe.horizontal && document.documentElement.classList.contains('phone-navigation-locked')),'horizontal turn claims drawer and temporary scroll lock');
  await touch('touchmove',250,190); // even subsequent diagonal travel stays drawer-owned
  assert(await page.evaluate(()=>phoneDrawerSwipe.horizontal),'horizontal ownership lasts until release');
  await touch('touchend',250,190);await settle(true);
  await swipe([330,280,230],'#sidebarBackdrop');await settle(false);
  // Actual browser scrolling followed by a horizontal turn in the same touch.
  await page.evaluate(()=>scrollTo(0,0));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:190,y:180}]});
  for(const y of [155,125,95]) {
    await page.waitForTimeout(20);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:190,y}]});
  }
  for(const x of [215,245,280,315]) {
    await page.waitForTimeout(20);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:95}]});
  }
  assert(await page.evaluate(()=>phoneDrawerSwipe?.horizontal),'real active-scroll horizontal turn recognized');
  const claimedScroll=await page.evaluate(()=>scrollY);
  await page.waitForTimeout(30);
  assert.equal(await page.evaluate(()=>scrollY),claimedScroll,'claimed horizontal swipe stops competing browser scroll');
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(true);
  await page.evaluate(()=>setSidebarOpen(false));await settle(false);
  // Start a new horizontal touch while an actual fling is still moving.
  await page.evaluate(()=>scrollTo(0,0));
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:190,y:280}]});
  for(const y of [250,215,170,120]) {
    await page.waitForTimeout(15);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:190,y}]});
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
  const flingStart=await page.evaluate(()=>scrollY);
  await page.waitForTimeout(20);
  const flingNext=await page.evaluate(()=>scrollY);
  console.log('Chromium scroll momentum observed:',flingNext>flingStart);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:190,y:85}]});
  for(const x of [215,250,290,320]) {
    await page.waitForTimeout(20);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x,y:85}]});
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await settle(true);
  await page.evaluate(()=>setSidebarOpen(false));await settle(false);
  // Maintenance uses the same listener. Never invoke an actual operation.
  // Keep injected presentation rows stable against normal background refresh.
  await page.route('**/api/maintenance/status',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
  await page.evaluate(()=>showAppPage('maintenancePage'));
  await page.waitForSelector('.maint-action-card:not(:disabled)');
  const card=page.locator('#maint-btn-empty_recycle_bin');
  const cardId=await card.getAttribute('id'),cardSelector='#'+cardId;
  await card.evaluate(node=>{
    window.maintenanceCardClickCount=0;
    node.addEventListener('click',()=>window.maintenanceCardClickCount++);
  });
  await swipe([180,215,255],cardSelector);await settle(true);
  await card.evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1})));
  assert.equal(await page.evaluate(()=>maintenanceCardClickCount),0,'swiped card never opens confirmation or executes action');
  await page.evaluate(()=>setSidebarOpen(false));await settle(false);
  await touch('touchstart',180,200,cardSelector);await touch('touchmove',280,200,cardSelector);
  await page.waitForTimeout(800);await touch('touchend',280,200,cardSelector);await settle(true);
  await card.evaluate(node=>node.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,detail:1})));
  assert.equal(await page.evaluate(()=>maintenanceCardClickCount),0,'long held swipe also suppresses compatibility click');
  await page.evaluate(()=>setSidebarOpen(false));await settle(false);
  await card.click();
  assert.equal(await page.evaluate(()=>maintenanceCardClickCount),1,'normal card tap still works');
  assert(await page.locator('#maintModal').isVisible(),'ordinary tap still opens existing confirmation');
  await swipe([180,230,280],'#maintModal');await settle(false);
  await page.locator('#maintModalCancel').click();
  await page.evaluate(()=>{
    document.querySelector('#maintProgressPanel').style.display='block';
    document.querySelector('#maintLogConsole').innerHTML=Array.from({length:70},(_,i)=>'<div class="maint-log-line"><span class="maint-log-msg">Safe fixture log line '+i+'</span></div>').join('');
    document.querySelector('#maintHistoryList').innerHTML='<div class="maint-history-item">Safe previous result</div>';
  });
  for(const selector of ['#maintenancePage','.maint-progress-title','.maint-log-msg','.maint-history-item']) {
    await swipe([180,215,255],selector);await settle(true);
    await swipe([330,280,230],'#sidebarBackdrop');await settle(false);
  }
  // Scrollable logs yield vertically, but can turn horizontally mid-touch.
  await touch('touchstart',180,200,'.maint-log-msg');await touch('touchmove',180,160,'.maint-log-msg');
  await touch('touchmove',220,160,'.maint-log-msg');await touch('touchmove',255,160,'.maint-log-msg');
  await touch('touchend',255,160,'.maint-log-msg');await settle(true);
  await page.evaluate(()=>setSidebarOpen(false));await settle(false);
  await page.evaluate(()=>{
    const log=document.querySelector('#maintLogConsole');log.style.overflowX='auto';
    log.innerHTML='<div class="maint-log-msg" style="width:1200px;white-space:nowrap">Wide copyable fixture log</div>';
  });
  await swipe([180,220,270],'.maint-log-msg');await settle(false);
  assert(await page.evaluate(()=>phoneDrawerSwipe===null),'wide horizontal log remains excluded');
  await page.evaluate(()=>{
    const text=document.querySelector('.maint-log-msg'),range=document.createRange();range.selectNodeContents(text);
    getSelection().removeAllRanges();getSelection().addRange(range);
  });
  await swipe([180,220,270],'#maintenancePage');await settle(false);
  await page.evaluate(()=>getSelection().removeAllRanges());
  await page.screenshot({path:path.join(root,'packaging/cache/mobile-maintenance-swipe.png')});
  await page.unroute('**/api/maintenance/status');
  await page.evaluate(()=>showAppPage('dashboardPage'));
  await page.evaluate(() => {
    const fixture=document.createElement('div');fixture.id='gestureFixtures';
    fixture.innerHTML='<button id="gestureButton">Button</button><input id="gestureInput"><input id="gestureSlider" type="range"><canvas id="gestureChart"></canvas><div id="gestureRail" style="width:80px;overflow-x:auto"><div id="gestureRailChild" style="width:300px">Carousel</div></div><div id="gestureDialog" role="dialog">Dialog</div>';
    document.querySelector('.dashboard-container').append(fixture);
  });
  for(const selector of ['#gestureButton','#gestureInput','#gestureSlider','#gestureChart','#gestureRailChild','#gestureDialog']) {
    await swipe([180,220,270],selector); await settle(false);
    assert(await page.evaluate(() => phoneDrawerSwipe === null), selector+' excluded from navigation gesture');
  }
  await swipe([2,80,160]); await settle(false); // system edge reserved
  for(const [width,height] of [[320,568],[375,812],[390,844],[430,932]]) {
    await page.setViewportSize({width,height}); await page.evaluate(() => {setSidebarOpen(false);scrollTo(0,200);});
    await settle(false);
    await swipe([width/2,width/2+25,width/2+65]); await settle(true);
    const dimensions=await geometry();
    assert(dimensions.header.y >= 7 && dimensions.header.y <= 9, 'sticky header '+width);
    assert.equal(dimensions.backdrop.height,height,'viewport backdrop '+width);
    assert(Math.abs(dimensions.header.x-dimensions.surface.x-12)<1,'header and content share translation '+width);
    assert(!await page.evaluate(() => document.documentElement.scrollWidth>innerWidth+1),'no horizontal overflow '+width);
    const scroll=await page.evaluate(()=>scrollY);
    await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:width-25,y:300}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:width-25,y:160}]});
    await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});
    assert.equal(await page.evaluate(()=>scrollY),scroll,'open drawer prevents background scroll '+width);
    await page.mouse.click(width-15,100);
    await settle(false);
    await page.evaluate(() => setSidebarOpen(true)); await settle(true);
    await page.locator('#appSidebar [data-page="appsPage"]').click();
    await settle(false);
    assert.equal(await page.locator('#appSectionTitle').innerText(),'Applications');
    assert.equal(await page.locator('#appSidebar [aria-current="page"]').getAttribute('data-page'),'appsPage');
    assert(!await page.evaluate(()=>document.documentElement.classList.contains('phone-navigation-locked')),'navigation releases scroll lock');
    await page.evaluate(()=>showAppPage('dashboardPage'));
  }
  await page.evaluate(()=>{setSidebarOpen(true);dispatchEvent(new Event('orientationchange'));});await settle(false);
  for(let i=0;i<5;i++) {
    await page.evaluate(()=>{dispatchEvent(new PageTransitionEvent('pagehide'));dispatchEvent(new PageTransitionEvent('pageshow'));});
    await swipe([180,210,245]);await settle(true);
    await swipe([330,290,245],'#sidebarBackdrop');await settle(false);
    assert(await page.evaluate(()=>phoneDrawerSwipe===null&&phoneDrawerFrame===null&&navigationTouchListeners()===0),'repeat gesture listener/frame cleanup');
  }
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.evaluate(()=>setSidebarOpen(true));await settle(true);
  assert.equal(await page.locator('.phone-page-surface').evaluate(x=>getComputedStyle(x).transitionDuration),'0s');
  await page.screenshot({path:path.join(root,'packaging/cache/mobile-navigation-open.png')});
  await page.evaluate(()=>setSidebarOpen(false));await settle(false);
  await page.screenshot({path:path.join(root,'packaging/cache/mobile-navigation-closed.png')});
  for(const id of ['dashboardPage','processesPage','appsPage','maintenancePage','diagnosticsPage']) {
    await page.evaluate(id=>showAppPage(id),id);
    await swipe([180,215,255],'#'+id);await settle(true);
    await swipe([330,280,230],'#sidebarBackdrop');await settle(false);
    assert.equal(await page.evaluate(()=>navigationTouchListeners()),0,'shared gesture cleanup in '+id);
  }
  await page.evaluate(()=>showAppPage('dashboardPage'));
  // Model a notched phone: the real sticky chrome must cover the safe area
  // at scroll depth, including partial drags. No synthetic overlay covers it.
  await page.evaluate(()=>{document.body.style.setProperty('--app-safe-top','44px');scrollTo(0,250);});
  const safeChrome = async () => {
    assert(await page.evaluate(()=>{
      const chrome=document.querySelector('.phone-header'),bar=document.querySelector('.native-app-bar');
      const c=chrome.getBoundingClientRect(),b=bar.getBoundingClientRect();
      const hit=document.elementFromPoint(c.x+35,20);
      return Math.abs(c.y)<1 && Math.abs(b.y-52)<1 && (chrome.contains(hit) || hit?.id === "sidebarBackdrop") &&
        getComputedStyle(chrome).backgroundColor !== "rgba(0, 0, 0, 0)" &&
        getComputedStyle(bar).backdropFilter==='none' && document.documentElement.scrollWidth<=innerWidth+1;
    }),'real header owns top safe-area background without blur/clipping');
  };
  await safeChrome();
  await page.screenshot({path:path.join(root,'packaging/cache/mobile-safe-header-closed.png')});
  await touch('touchstart',180);await touch('touchmove',245);await page.waitForTimeout(60);
  await safeChrome();
  await page.screenshot({path:path.join(root,'packaging/cache/mobile-safe-header-partial.png')});
  await touch('touchcancel',245);await settle(false);
  await page.evaluate(()=>setSidebarOpen(true));await settle(true);await safeChrome();
  await page.screenshot({path:path.join(root,'packaging/cache/mobile-safe-header-open.png')});
  await page.evaluate(()=>{setSidebarOpen(false);document.body.style.removeProperty('--app-safe-top');});await settle(false);
  // Login: real DOM geometry with explicit visual viewport/keyboard fixtures.
  const lockedContext = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  await lockedContext.addInitScript(()=>{
    const viewport=new EventTarget();
    Object.assign(viewport,{height:innerHeight,offsetTop:0});
    Object.defineProperty(window,'visualViewport',{value:viewport});
    window.setLoginTestViewport=(height,top)=>{
      viewport.height=height;viewport.offsetTop=top;
      viewport.dispatchEvent(new Event('resize'));
    };
  });
  const lockedPage=await lockedContext.newPage();
  // Simulate notch insets in the actual styles (desktop is checked separately).
  await lockedPage.route('**/login.html',async route=>{
    const response=await route.fetch();
    const html=(await response.text()).replaceAll('env(safe-area-inset-top)','44px').replaceAll('env(safe-area-inset-bottom)','34px');
    await route.fulfill({response,body:html});
  });
  await lockedPage.goto(base+'/login.html');
  await lockedPage.waitForFunction(()=>typeof cleanupLoginViewport==='function');
  async function checkLocked(width,height,usable=height,top=0) {
    await lockedPage.setViewportSize({width,height});
    await lockedPage.evaluate(({usable,top})=>setLoginTestViewport(usable,top),{usable,top});
    await lockedPage.waitForTimeout(30);
    const result=await lockedPage.evaluate(()=>{
      const rect=s=>{const r=document.querySelector(s).getBoundingClientRect();return {x:r.x,y:r.y,w:r.width,h:r.height,bottom:r.bottom};};
      const container=document.querySelector('.login-container'),style=getComputedStyle(container);
      return {card:rect('.login-card'),container:rect('.login-container'),pin:rect('#pinInput'),button:rect('#unlockBtn'),
        paddingTop:parseFloat(style.paddingTop),paddingBottom:parseFloat(style.paddingBottom),overflow:getComputedStyle(document.body).overflow,scroll:scrollY};
    });
    assert(Math.abs(result.card.x+result.card.w/2-width/2)<1,'horizontal login centering '+width);
    const center=top+(usable+result.paddingTop-result.paddingBottom)/2;
    assert(Math.abs(result.card.y+result.card.h/2-center)<1,'usable viewport login centering '+width+'x'+height+'/'+usable);
    assert(result.pin.y>=top && result.button.bottom<=top+usable,'PIN and Unlock visible '+width+'x'+height+'/'+usable);
    assert.equal(result.overflow,'hidden','locked body retains its own scroll lock');
    assert.equal(result.scroll,0,'locked page remains unscrolled');
    assert(await lockedPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),'login does not overflow horizontally');
  }
  for(const [width,height] of [[320,568],[375,812],[390,844],[430,932],[844,390]]) {
    await checkLocked(width,height);
    await checkLocked(width,height,Math.min(320,height-100),20);
    await checkLocked(width,height,height-70); // browser toolbar expanded
    await checkLocked(width,height); // keyboard/toolbars dismissed
  }
  await checkLocked(390,844);
  await lockedPage.screenshot({path:path.join(root,'packaging/cache/mobile-login-centered.png')});
  await lockedPage.locator('#pinInput').focus();
  await checkLocked(390,844,320,20);
  await lockedPage.screenshot({path:path.join(root,'packaging/cache/mobile-login-keyboard.png')});
  await lockedContext.close();
  // Native/desktop presentation remains display:contents around existing chrome.
  await page.setViewportSize({width:980,height:740});
  await page.evaluate(()=>document.documentElement.classList.add('native-shell'));
  assert.equal(await page.locator('.phone-header').evaluate(x=>getComputedStyle(x).display),'contents');
  const desktopLogin=await context.newPage();
  await desktopLogin.setViewportSize({width:360,height:430});
  await desktopLogin.goto(base+'/login.html');
  await desktopLogin.evaluate(()=>{document.documentElement.classList.add('native-shell');dispatchEvent(new Event('resize'));});
  assert.equal(await desktopLogin.locator('body').evaluate(x=>getComputedStyle(x).position),'fixed');
  assert.equal(await desktopLogin.locator('.login-container').evaluate(x=>getComputedStyle(x).padding),'0px');
  assert.equal(await desktopLogin.locator('html').evaluate(x=>x.style.getPropertyValue('--login-viewport-height')),'');
  await desktopLogin.close();
  console.log('PASS real active-scroll direction change, observed fling-to-swipe, Maintenance cards/taps/confirmation/log/history/selection/wide-log exclusions, shared navigation across all views; safe-area chrome closed/open/partial, portrait/landscape login centering, simulated keyboard/toolbars, no locked scrolling, and native desktop layout invariants.');
  assert.equal(maintenanceExecutionRequests,0,'no maintenance execution request leaves the UI fixture');
  assert.equal(errors.length,0,errors.join(';'));
  await context.close();
  console.log('PASS mobile center/flick/close/reversal/cancel gestures, native vertical scrolling, control/chart/carousel/dialog/system-edge exclusions, sticky header/viewport backdrop, background lock, navigation/rotation/cleanup and reduced motion at 320/375/390/430.');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server && server.exitCode === null) { const exited = new Promise(resolve => server.once('exit', resolve)); server.kill(); await exited; }
});
