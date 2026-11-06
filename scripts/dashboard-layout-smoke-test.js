'use strict';
// Presentation-only fixtures; never performs real system/application actions.
const assert=require('assert'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto');
const {spawn}=require('child_process');
const {chromium,webkit}=require(process.env.ROVARIN_PLAYWRIGHT_PATH||'playwright');
const root=path.resolve(__dirname,'..'),engine=process.env.ROVARIN_TEST_WEBKIT==='1'?'webkit':'chromium';
const out=path.join(root,'packaging/cache/mobile-polish-20261022',engine),state=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-system-ui-state-dashboard-'));
fs.mkdirSync(out,{recursive:true});
const pin=String(crypto.randomInt(100000,1000000)),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
let server,browser,base,output='';const results=[],errors=[];
// Exercise the real assessment without starting collectors or changing thresholds.
const source=fs.readFileSync(path.join(root,'server.js'),'utf8');
const assess=require('vm').runInNewContext('('+source.slice(source.indexOf('function assessHealth('),source.indexOf('// Uptime formatter')).trim()+')');
for(const [cpu,expected,color,count] of [[10,'Healthy','emerald',0],[80,'1 Advisory','amber',1],[95,'Attention Needed','rose',1]]){
 const result=assess({overall:cpu},{usedPercent:20},{available:false},[],null);
 assert.equal(result.rating,expected);assert.equal(result.badgeColor,color);assert.equal(result.advisoriesCount,count);
}
// Storage scope is deliberately C:-only, not one grouped warning for all disks.
for(const [cPercent,gPercent,count,level] of [[50,96,0,'optimal'],[90,96,1,'warning'],[94,96,1,'critical'],[85,96,0,'optimal'],[92,96,1,'warning'],[50,20,0,'optimal']]){
 const result=assess({overall:10},{usedPercent:20},{available:false},[{mount:'C:',usedPercent:cPercent,freeGB:12},{mount:'G:',usedPercent:gPercent,freeGB:8}],null);
 assert.equal(result.advisoriesCount,count);assert.equal(result.issues[0].level,level);
 if(count){assert(result.issues[0].text.includes('C:'));assert(!result.issues[0].text.includes('G:'));}
}
async function start(){server=spawn(process.execPath,['-r',path.join(__dirname,'power-test-tools.js'),'server.js'],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'0',PC_MONITOR_PIN:pin,ROVARIN_REMOVAL_POLICY_TEST_DIRECTORY:state}});server.stdout.on('data',x=>output+=x);server.stderr.on('data',x=>output+=x);for(let i=0;i<200;i++){const match=output.match(/Localhost access: http:\/\/127\.0\.0\.1:(\d+)/);if(match){base='http://127.0.0.1:'+match[1];return;}if(server.exitCode!==null)break;await pause(100);}throw Error('Dashboard fixture backend unavailable: '+output.replaceAll(pin,'[redacted]').slice(-1800));}
async function scene(name,width,height,native,scale=1,desktopBrowser=false){
 const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:scale,isMobile:!native&&!desktopBrowser,hasTouch:!native&&!desktopBrowser});
 try{
  await context.addInitScript(({native})=>{localStorage.setItem('rovarin.graphicsQuality','minimal');localStorage.setItem('rovarin.healthCardCollapsed','false');localStorage.setItem('rovarin.mobileOnboardingSeen','true');localStorage.setItem('pc-monitor-sidebar-expanded','false');if(native)document.addEventListener('DOMContentLoaded',()=>document.documentElement.classList.add('native-shell'),{once:true});},{native});
  const login=await context.request.post(base+'/api/login',{headers:{Origin:base},data:{pin}});assert.equal(login.status(),200);
  const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));await page.goto(base+'/',{waitUntil:'networkidle'});
  await page.waitForFunction(()=>!!latestDashboardMetrics?.ram);
  await page.evaluate(()=>{
   eventSource?.close();
   const data=structuredClone(latestDashboardMetrics);
   data.ram={...data.ram,totalGB:16,usedGB:6,freeGB:10,usedPercent:37.5};
   data.cpu={...data.cpu,model:'Fixture processor with 12 logical cores'};
   data.gpu={...data.gpu,name:'Fixture graphics adapter',available:true,temperatureC:91,temperatureAvailable:true,temperatureStale:false};
   data.health={...data.health,advisoriesCount:2,issues:[{level:'critical',text:'Fixture storage warning'},{level:'warning',text:'Fixture temperature advisory'}]};
   window.dashboardLayoutFixture=data;updateUI(data);
  });
  await page.locator('#healthToggle').click();assert.equal(await page.locator('#healthToggle').getAttribute('aria-expanded'),'false');
  assert(!(await page.locator('#healthChecklist').isVisible()),'collapsed health really hides assessment');
  assert((await page.locator('#healthSubText').innerText()).includes('2 active advisories'),'collapsed advisory count retained');
  const summary=await page.locator('#healthCard').boundingBox();assert(summary.height<100,'health summary stays compact: '+name+' '+summary.height);
  const collapsed=await page.locator('.dashboard-container').boundingBox();
  if(native){await page.locator('#sidebarToggle').click();await pause(400);const open=await page.locator('.dashboard-container').boundingBox();assert.equal(open.x,collapsed.x,'overlay does not shift page');assert.equal(open.width,collapsed.width,'overlay does not resize page');await page.locator('#sidebarToggle').click();}
  assert.equal(await page.locator('.memory-statistics').getAttribute('open'),null);
  await page.locator('.memory-statistics summary').click();assert(await page.locator('#ramAvailGB').isVisible(),'full memory statistics accessible');assert.equal(await page.locator('#ramAvailGB').innerText(),'10 GB');
  await page.locator('.memory-statistics summary').press('Enter');assert(!(await page.locator('#ramAvailGB').isVisible()),'keyboard closes memory disclosure');
  assert((await page.locator('#gpuTempBadge').innerText()).includes('Very high'),'temperature warning remains visible');assert(await page.locator('#gpuTempBadge').isVisible());
  if(!native&&!desktopBrowser){assert(!(await page.locator('#ramFreeBadge').isVisible()));assert(!(await page.locator('#latencyBadge').isVisible()));assert(await page.locator('#netLatencyText').isVisible());assert(!(await page.locator('.overview-core-loads').isVisible()));assert(await page.locator('#openCpuDetailButton').isVisible());}
  const measured=await page.evaluate(()=>{const grid=document.querySelector('.metrics-grid'),card=key=>{const r=document.querySelector('.overview-'+key+'-card').getBoundingClientRect();return{x:r.x,y:r.y,width:r.width,height:r.height}};return{width:innerWidth,height:innerHeight,overflow:document.documentElement.scrollWidth>innerWidth,contentWidth:grid.clientWidth,gridColumns:getComputedStyle(grid).gridTemplateColumns.split(' ').length,cpu:card('cpu'),gpu:card('gpu'),ram:card('ram'),storage:card('storage'),network:card('network'),pageHeight:document.getElementById('dashboardPage').getBoundingClientRect().height,healthHeight:document.getElementById('healthCard').getBoundingClientRect().height};});
  assert(!measured.overflow,'no horizontal overflow: '+name);
  if(native&&name==='default'){assert.equal(measured.gridColumns,2);assert(measured.cpu.height<300&&measured.gpu.height<300);assert(measured.ram.height<240);}
  if(desktopBrowser&&width===1440)assert.equal(measured.gridColumns,3);
  if(native&&name==='large')assert.equal(measured.gridColumns,3);
  if(native&&name==='maximized')assert.equal(measured.gridColumns,4);
  if(!native&&!desktopBrowser&&width===320)assert.equal(measured.gridColumns,1);
  if(!native&&!desktopBrowser){
   assert((await page.locator('#openCpuDetailButton').boundingBox()).height>=44,'CPU detail touch target retained');
   assert((await page.locator('.memory-statistics summary').boundingBox()).height>=44,'RAM disclosure touch target retained');
   assert(Math.abs(measured.ram.width-measured.contentWidth)<2,'RAM uses full width');
   assert(Math.abs(measured.storage.width-measured.contentWidth)<2,'Storage uses full width');
   assert(Math.abs(measured.network.width-measured.contentWidth)<2,'Network uses full width');
   assert(measured.storage.y>=measured.ram.y+measured.ram.height,'storage follows RAM');
   assert(measured.storage.y-measured.ram.y-measured.ram.height<20,'no unused row beneath RAM');
   assert(measured.network.y-measured.storage.y-measured.storage.height<20,'no unused row beneath Storage');
   assert(measured.ram.height<240,'compact RAM');
   if(width>=375){assert.equal(measured.cpu.y,measured.gpu.y);assert(measured.gpu.height<310,'GPU readable compact summary');}
   const vram=await page.locator('#gpuVramTotal').boundingBox();assert(vram.width>0,'VRAM details retained');
  }
  const charts=await page.locator('#dashboardPage .chart-container').evaluateAll(nodes=>nodes.map(el=>({w:el.clientWidth,h:el.clientHeight})));assert(charts.every(r=>r.w>0&&r.h>=36),'history charts stay useful');
  // Contradictory/legacy and partial snapshots must not leave a stale green badge.
  for(const [health,badge,count] of [
   [{rating:'Optimal',badgeColor:'emerald',advisoriesCount:0,issues:[{level:'warning',text:'Fixture warning'}]},'Advisory','1 active advisory'],
   [{rating:'Optimal',badgeColor:'emerald',advisoriesCount:1,issues:[{level:'critical',text:'Fixture critical'},{level:'warning',text:'Fixture warning'}]},'Attention Needed','2 active advisories'],
   [{rating:'Attention Needed',badgeColor:'rose',advisoriesCount:7,issues:[{level:'optimal',text:'All hardware systems running smoothly'}]},'Healthy','All hardware systems'],
   [{advisoriesCount:1},'Advisory','1 active advisory'],
   [undefined,'Unavailable','Assessment unavailable']
  ]){
   await page.evaluate(health=>{setHealthCollapsed(true);updateUI({...dashboardLayoutFixture,health});},health);
   assert.equal(await page.locator('#healthBadge').textContent(),badge);
   assert((await page.locator('#healthSubText').innerText()).includes(count));
   await page.locator('#healthToggle').click();assert.equal(await page.locator('#healthBadge').textContent(),badge);
   assert.equal(await page.locator('#healthChecklist').evaluate(el=>el.hidden),false);
   await page.locator('#healthToggle').click();assert((await page.locator('#healthSubText').innerText()).includes(count));
  }
  await page.evaluate(()=>updateUI(dashboardLayoutFixture));
  await page.screenshot({path:path.join(out,name+'.png'),fullPage:!native});
  await page.locator('#healthToggle').click();assert(await page.locator('#healthChecklist').isVisible(),'health expands');
  assert((await page.locator('#healthChecklist').innerText()).includes('Storage health checks cover C:'),'expanded assessment explains existing storage scope');
  if((native&&name==='default')||name==='mobile375'){
   await page.evaluate(()=>{document.getElementById('cpuModelText').textContent='Long processor model name with extra platform information and no truncated measurements';document.getElementById('gpuNameText').textContent='Long graphics adapter model name with dedicated video memory information';const list=document.getElementById('drivesList'),original=list.firstElementChild;if(original)for(let i=0;i<6;i++){const row=original.cloneNode(true);row.querySelector('.drive-top').firstElementChild.textContent='Long app-owned fixture volume label '+i+' (96.4%)';list.append(row);}});
   assert(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),'long names and many drives do not overflow');
   const storage=await page.locator('.overview-storage-card').boundingBox();assert(storage.height>300,'many drives grow naturally');
   await page.locator('#openCpuDetailButton').click();await page.waitForFunction(()=>document.getElementById('cpuDetailDialog').open);assert(await page.locator('#cpuDetailDialog').isVisible(),'detailed CPU statistics remain accessible');await page.locator('#closeCpuDetailButton').click();
  }
  results.push({name,scale,...measured});
  await context.request.post(base+'/api/logout');
 }finally{await context.close();}
}
(async()=>{await start();browser=engine==='webkit'?await webkit.launch({headless:true}):await chromium.launch({headless:true,executablePath:'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'});
 for(const args of [['default',888,668,true],['minimum',748,548,true],['narrow',808,608,true],['medium',1088,788,true],['large',1428,888,true],['maximized',1908,1068,true],['dpi125',710,534,true,1.25],['dpi150',592,445,true,1.5],['mobile320',320,568,false],['mobile375',375,812,false],['mobile390',390,844,false],['mobile430',430,932,false],['mobile600',600,900,false],['tablet768',768,1024,false],['browser1000',1000,800,false,1,true],['browser1440',1440,900,false,1,true],['landscape',844,390,false]])await scene(...args);
 assert.deepEqual(errors,[],'no frontend exceptions');fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({engine,results,errors},null,2));console.log('PASS '+engine+': 17 content-width/DPI scenarios, mixed-width mobile ordering and no empty rows, real backend health severity/partial snapshot consistency, stationary overlay, health collapse, memory disclosure/keyboard, warnings, long names/many drives, CPU detail access and no overflow.');
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{if(browser)await browser.close();if(server&&server.exitCode===null){const done=new Promise(resolve=>server.once('exit',resolve));server.kill();await done;}fs.rmSync(state,{recursive:true,force:true});});
