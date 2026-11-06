"use strict";
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{spawn}=require('child_process');
const {chromium,webkit}=require(process.env.ROVARIN_PLAYWRIGHT_PATH||'playwright');
const root=path.resolve(__dirname,'..'),engine=process.env.ROVARIN_TEST_WEBKIT?'webkit':'chromium';
const state=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-system-ui-state-filters-')),pin=String(crypto.randomInt(100000,1000000));
const out=path.join(root,'packaging/cache/filter-polish-20261022',engine);fs.mkdirSync(out,{recursive:true});
let server,browser,output='',base;const errors=[];
(async()=>{
 server=spawn(process.execPath,['-r',path.join(__dirname,'system-management-test-tools.js'),'server.js'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'0',PC_MONITOR_PIN:pin,ROVARIN_REMOVAL_POLICY_TEST_DIRECTORY:state}});
 server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);
 for(let i=0;i<180;i++){const m=output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);if(m){base='http://127.0.0.1:'+m[1];break;}if(server.exitCode!==null)break;await new Promise(r=>setTimeout(r,100));}assert(base,'Fixture backend available');
 browser=engine==='webkit'?await webkit.launch({headless:true}):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 for(const width of [320,375,390,430,900]){
  const context=await browser.newContext({viewport:{width,height:844},isMobile:width<700,hasTouch:width<700});
  await context.addInitScript(()=>{localStorage.setItem('rovarin.graphicsQuality',innerWidth===390?'balanced':'minimal');localStorage.setItem('rovarin.mobileOnboardingSeen','true');});
  assert.equal((await context.request.post(base+'/api/login',{headers:{Origin:base},data:{pin}})).status(),200);
  const page=await context.newPage();page.on('pageerror',e=>errors.push(e.message));await page.goto(base);await page.waitForFunction(()=>typeof showAppPage==='function');
  assert.deepEqual(await page.locator('.memory-statistics .chip-title').allTextContents(),['In Use','Total','Available']);
  await page.evaluate(()=>showAppPage('appsPage'));await page.locator('#appsTypeTrigger').waitFor();await page.waitForFunction(()=>document.querySelector('#appsType').options.length>1);
  async function menu(id){
   const button=page.locator('#'+id+'Trigger');await button.scrollIntoViewIfNeeded();await button.click();
   const box=await page.locator('#appsFilterMenu').boundingBox(),trigger=await button.boundingBox();assert(box&&box.y>=trigger.y+trigger.height+4,'menu below '+id+' at '+width);assert(box.x>=0&&box.x+box.width<=width+1,'menu inside viewport');assert.equal(await button.getAttribute('aria-expanded'),'true');
  }
  await menu('appsType');await page.getByRole('option',{name:'Desktop app',exact:true}).click();assert.equal(await page.locator('#appsType').inputValue(),'desktop');
  await menu('appsSort');await page.keyboard.press('End');await page.keyboard.press('Enter');assert.equal(await page.locator('#appsSort').inputValue(),'publisher');
  if(width===390){await menu('appsType');await page.screenshot({path:path.join(out,'installed-menu.png')});await page.keyboard.press('Escape');}
  await page.locator('#appsTabStartup').click();await page.waitForFunction(()=>document.querySelectorAll('.startup-row').length===3);
  await page.locator('#startupControlFilter').check();assert.equal(await page.locator('.startup-row').count(),1);assert((await page.locator('#startupStatus').innerText()).includes('Showing 1 of 3'));assert((await page.locator('#startupList').innerText()).includes('Fixture Startup'));assert(!await page.locator('.startup-associated-services').isVisible());
  assert(await page.locator('.startup-row').getByRole('button',{name:/Enable|Disable/}).isVisible());
  if(width===390)await page.screenshot({path:path.join(out,'supported-startup.png'),fullPage:true});
  await menu('startupScope');await page.keyboard.press('Escape');assert.equal(await page.locator('#startupScopeTrigger').getAttribute('aria-expanded'),'false');
  await menu('startupStatusFilter');await page.keyboard.press('Escape');
  await page.locator('#startupControlFilter').uncheck();assert.equal(await page.locator('.startup-row').count(),3);
  assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'no horizontal overflow');
  if(width<700){await page.evaluate(()=>document.documentElement.dataset.graphicsQuality='balanced');const blur=await page.locator('.phone-header .native-app-bar').evaluate(el=>getComputedStyle(el).backdropFilter||getComputedStyle(el).webkitBackdropFilter);assert(blur.includes('28px'),'mobile header blur retained');}
  await context.request.post(base+'/api/logout');await context.close();
 }
 assert.deepEqual(errors,[]);console.log('PASS '+engine+': five widths, RAM order, below-trigger menus, keyboard/escape, safe-startup checkbox and restoration, protected entries, header blur, no overflow/errors');
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server&&server.exitCode===null){const done=new Promise(r=>server.once('exit',r));server.kill();await done;}fs.rmSync(state,{recursive:true,force:true});});
