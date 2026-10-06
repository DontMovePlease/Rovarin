'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path'),crypto=require('crypto'),{execFile}=require('child_process');
const {AppManager,windowsOperation,validRow,publicApp,cleanPublisher}=require('../app-manager');
const baseRow=(name='Fixture',scope='user',key='fixture')=>({name,version:'1.0',publisher:'Test',locator:{scope,key},fingerprint:'a'.repeat(64),type:'msi',product:'{AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA}',batchCapable:true,elevationLikely:false});
async function mocked(){
 const sizeFunction=require('vm').runInNewContext('('+fs.readFileSync(path.join(__dirname,'../public/apps.js'),'utf8').match(/  function sizeLabel[^\r\n]+/)[0].trim()+')');
 assert.equal(sizeFunction(500*1024),'500 MB');assert.equal(sizeFunction(1536*1024),'1.5 GB');assert.equal(sizeFunction(42),'42 KB');assert.equal(sizeFunction(0),'0 KB');assert.equal(sizeFunction(null),'—');
 assert.equal(sizeFunction(1024),'1 MB');assert.equal(sizeFunction(20480),'20 MB');assert.equal(sizeFunction(524288),'512 MB');assert.equal(sizeFunction(1048576),'1 GB');assert.equal(sizeFunction(1468006),'1.4 GB');assert.equal(sizeFunction(1024*1024*4),'4 GB');
 assert.equal(sizeFunction(500*1024,true),'~500 MB');assert.equal(sizeFunction(1536*1024,true),'~1.5 GB');assert.equal(sizeFunction(42,true),'~42 KB');assert.equal(sizeFunction(null,true),'—');

 let inventory=[baseRow('First'),{...baseRow('Duplicate','machine32','dup')}, {...baseRow('Other','user','other'),product:'{BBBBBBBB-BBBB-BBBB-BBBB-BBBBBBBBBBBB}',icon:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg==',sizeEstimated:true,sizeKB:612*1024}];let active=0,maxActive=0,calls=0;
 const operation=async request=>{if(request.action==='inventory')return {success:true,apps:inventory,packagesAvailable:true};active++;maxActive=Math.max(maxActive,active);calls++;await new Promise(r=>setTimeout(r,10));active--;if(request.locator.key==='fixture')return {success:false,code:'uninstall-failed'};inventory=inventory.filter(row=>row.locator.key!==request.locator.key);return {success:true,code:'completed'};};
 const manager=new AppManager({operation});const data=await manager.inventory();assert.equal(data.apps.length,2,'duplicate MSI registration deduped');assert(!JSON.stringify(data).includes('fingerprint'));assert(!JSON.stringify(data).includes('locator'));assert(data.apps.every(app=>/^[a-f0-9]{64}$/.test(app.id)));
 assert.equal(data.apps[1].hasIcon,true);assert.equal(data.apps[1].sizeEstimated,true);assert.equal(data.apps[1].sizeKB,612*1024);assert.equal(data.apps[0].hasIcon,false);assert.equal(data.apps[0].sizeEstimated,false);assert(!('icon' in data.apps[1]),'raw icon string must not be exposed in public app payload');
 const iconBuf=manager.getIcon(data.apps[1].id);assert(Buffer.isBuffer(iconBuf));assert.strictEqual(manager.getIcon(data.apps[0].id),null);assert.strictEqual(manager.getIcon('invalid-id'),null);
 await assert.rejects(manager.start(['C:\\evil.exe'],false),/invalid-request/);await assert.rejects(manager.start([data.apps[0].id],true,()=>false),/authentication-required/);assert.equal(calls,0);
 await manager.start(data.apps.map(x=>x.id),true);await assert.rejects(manager.start([data.apps[0].id],false),/operation-running/);await manager.running;assert.equal(maxActive,1,'queue is strictly sequential');assert.equal(calls,2,'one failure does not abort subsequent apps');assert.equal(manager.job.items[0].state,'failed');assert.equal(manager.job.items[1].state,'completed');assert.equal(manager.job.state,'partial');
 assert.equal(publicApp({...baseRow(),type:'appx',protected:true},'a').uninstallCapable,false);assert.equal(publicApp({...baseRow(),type:'manual',batchCapable:true},'a').batchCapable,false);assert(!validRow({...baseRow(),locator:{scope:'user',key:'../bad'}}));
 const display=publicApp({...baseRow(),description:'Locally registered description',installLocation:'C:\\private\\app',sizeKB:0},'a');assert.equal(display.category,'desktop');assert.equal(display.description,'Locally registered description');assert.equal(display.sizeKB,0);assert.equal(display.hasIcon,false);assert.equal(display.sizeEstimated,false);assert(!('installLocation' in display));assert(!('icon' in display));assert.equal(publicApp({...baseRow(),icon:'abc'},'a').hasIcon,true);assert.equal(publicApp({...baseRow(),sizeEstimated:true},'a').sizeEstimated,true);assert.equal(publicApp({...baseRow(),sizeKB:null},'a').sizeKB,null);assert.equal(publicApp({...baseRow(),sizeKB:-1},'a').sizeKB,null);assert.equal(publicApp({...baseRow(),description:'C:\\private\\app.exe'},'a').description,'');assert.equal(publicApp({...baseRow(),locator:{scope:'appx',key:'package'},type:'appx'},'a').category,'store');assert.equal(publicApp({...baseRow(),locator:{scope:'appx',key:'package'},systemComponent:true,type:'appx',protected:true},'a').category,'system');assert.equal(publicApp({...baseRow(),locator:{}},'a').category,'other');assert.equal(publicApp(baseRow(),'a').description,'','never fabricate missing descriptions');
 const still=new AppManager({operation:async r=>r.action==='inventory'?{success:true,apps:[baseRow()],packagesAvailable:false}:{success:true,code:'completed'}});const id=(await still.inventory()).apps[0].id;await still.start([id],false);await still.running;assert.equal(still.job.items[0].code,'removal-unconfirmed','launch/exit zero alone never claims removal');
 const reboot=new AppManager({operation:async r=>r.action==='inventory'?{success:true,apps:[baseRow()],packagesAvailable:false}:{success:true,code:'reboot-required'}});await reboot.start([(await reboot.inventory()).apps[0].id],false);await reboot.running;assert.equal(reboot.job.items[0].state,'reboot-required');
 const timeout=new AppManager({operation:async r=>r.action==='inventory'?{success:true,apps:[baseRow()],packagesAvailable:false}:{success:false,code:'still-running'}});await timeout.start([(await timeout.inventory()).apps[0].id],false);await timeout.running;assert(timeout.blocked);await assert.rejects(timeout.start([id],false),/operation-unconfirmed/);
 const changed=new AppManager({operation:async()=>({success:true,apps:[baseRow()],packagesAvailable:false})});const old=(await changed.inventory()).apps[0].id;changed.operation=async()=>({success:true,apps:[{...baseRow(),fingerprint:'b'.repeat(64)}],packagesAvailable:false});await assert.rejects(changed.start([old],false),/inventory-changed/);

  // Publisher cleaning unit tests
  assert.equal(cleanPublisher('CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'),'Microsoft Corporation');
  assert.equal(cleanPublisher('CN=Microsoft Windows, O=Microsoft Corporation, L=Redmond, S=Washington, C=US'),'Microsoft Windows');
  assert.equal(cleanPublisher('CN=725B3E69-B066-4190-84E3-8EE9A1556C4A, O=Spotify AB, L=Stockholm, C=SE'),'Spotify AB');
  assert.equal(cleanPublisher('Google LLC'),'Google LLC');
  assert.equal(cleanPublisher('Apple Inc.'),'Apple Inc.');
  assert.equal(cleanPublisher('ms-resource:Publisher'),'');
  assert.equal(cleanPublisher(''),'');

  // System component safety and publisher normalization in publicApp
  const sysApp=publicApp({...baseRow('AppResolverUX','appx','sys-pkg'),publisher:'CN=Microsoft Corporation, O=Microsoft Corporation, L=Redmond, S=Washington, C=US',systemComponent:true,type:'appx'},'test-sys');
  assert.equal(sysApp.name,'AppResolverUX');
  assert.equal(sysApp.category,'system');
  assert.equal(sysApp.uninstallCapable,false,'system components must never be uninstallCapable');
  assert.equal(sysApp.batchCapable,false);
  assert.equal(sysApp.status,'manual-only');
  assert.equal(sysApp.publisher,'Microsoft Corporation','raw DN publisher normalized in public app');

  // Opaque identifier resolution and fallback naming
  const guidApp=publicApp({...baseRow('{1527C705-839A-4832-9118-54D4BD6A0C89}','appx','pkg'),publisher:'Microsoft Corporation',type:'appx'},'test-guid');
  assert.equal(guidApp.name,'Unknown Microsoft Store app');
  assert.equal(guidApp.identifier,'{1527C705-839A-4832-9118-54D4BD6A0C89}');
  assert.equal(guidApp.id,'test-guid');
  assert.equal(guidApp.category,'store');

  const numApp=publicApp({...baseRow('123456789','user','num'),publisher:'Acme Corp'},'test-num');
  assert.equal(numApp.name,'Unknown application by Acme Corp');
  assert.equal(numApp.identifier,'123456789');

  const resApp=publicApp({...baseRow('ms-resource:AppxManifest_DisplayName','appx','res'),publisher:''},'test-res');
  assert.equal(resApp.name,'Unknown Microsoft Store app');
  assert.equal(resApp.identifier,'ms-resource:AppxManifest_DisplayName');

  const normApp=publicApp(baseRow('Spotify'),'test-norm');
  assert.equal(normApp.name,'Spotify');
  assert.strictEqual(normApp.identifier,undefined);

  // Frontend Installed actions separation and sorting checks
  const appsJsContent=fs.readFileSync(path.join(__dirname,'../public/apps.js'),'utf8');
  assert(!appsJsContent.includes("node('button','Launch','apps-launch-btn')"),'Installed rows must never render a Launch action');
  assert(appsJsContent.includes("node('button','Uninstall','apps-row-action apps-uninstall-btn')"),'Installed rows must render direct Uninstall button');
  assert(appsJsContent.includes("node('button','Details','apps-row-action apps-details-btn')"),'Installed rows must render Details button for manual entries');
  assert(appsJsContent.includes("node('div',undefined,'apps-card-header')"),'Installed rows structure card header');
  assert(appsJsContent.includes("node('div',undefined,'apps-card-meta')"),'Installed rows structure card meta');
  assert(appsJsContent.includes("get('appsShowSystem')?.addEventListener('change'"),'Show system components toggle wired');

  const htmlContent=fs.readFileSync(path.join(__dirname,'../public/index.html'),'utf8');
  assert(htmlContent.includes('id="appsShowSystem"'),'index.html contains appsShowSystem checkbox');
  assert(htmlContent.includes('Show system components'),'index.html contains Show system components label');

  const cssContent=fs.readFileSync(path.join(__dirname,'../public/apps.css'),'utf8');
  assert(cssContent.includes('.apps-system-toggle'),'apps.css styles apps-system-toggle');
  assert(cssContent.includes('.is-grid .apps-card-header'),'apps.css styles grid card header');
  assert(cssContent.includes('.is-grid .apps-card-meta'),'apps.css styles grid card meta');
  assert(cssContent.includes('max-width:379px') || cssContent.includes('max-width: 379px'),'apps.css includes responsive breakpoint for narrow phone grid');

  // Verify visibleApps filtering hides system apps by default
  const testFilterApps=[
    {id:'1',name:'Antigravity',category:'desktop',publisher:'Google',uninstallCapable:true},
    {id:'2',name:'ChatGPT',category:'store',publisher:'OpenAI',uninstallCapable:true},
    {id:'3',name:'AppResolverUX',category:'system',publisher:'Microsoft Corporation',uninstallCapable:false}
  ];
  const filterVm=require('vm').runInNewContext(
    '(function(apps){'+
    '  let showSystemVal=false, typeVal="", searchVal="";'+
    '  const categories={desktop:"Desktop app",store:"Microsoft Store app",system:"System component",other:"Other"};'+
    '  const category=app=>categories[app.category]?app.category:"other";'+
    '  function visibleApps(){'+
    '    const showSystem=Boolean(showSystemVal||typeVal==="system");'+
    '    return apps.filter(app=>{'+
    '      const cat=category(app);'+
    '      if(!showSystem&&cat==="system")return false;'+
    '      if(typeVal&&cat!==typeVal)return false;'+
    '      if(searchVal&&![app.name,app.publisher].filter(Boolean).join(" ").toLowerCase().includes(searchVal))return false;'+
    '      return true;'+
    '    });'+
    '  }'+
    '  return {visibleApps, setShowSystem: v => { showSystemVal=v; }, setType: t => { typeVal=t; }};'+
    '})'
  )(testFilterApps);
  assert.deepEqual(filterVm.visibleApps().map(a=>a.name),['Antigravity','ChatGPT'],'System components hidden by default');
  filterVm.setShowSystem(true);
  assert.deepEqual(filterVm.visibleApps().map(a=>a.name),['Antigravity','ChatGPT','AppResolverUX'],'Show system components reveals system apps');
  filterVm.setShowSystem(false);
  filterVm.setType('system');
  assert.deepEqual(filterVm.visibleApps().map(a=>a.name),['AppResolverUX'],'Type select system reveals system apps');

  const compareAppNames=require('vm').runInNewContext(
    '(function(){const nameCollator=new Intl.Collator(undefined,{sensitivity:"base",numeric:true});'+
    appsJsContent.match(/function nameSortGroup[^{]*\{[\s\S]*?return 3;\s*\}/)[0]+';'+
    appsJsContent.match(/function compareAppNames[^{]*\{[\s\S]*?return nameCollator\.compare\([^)]*\);\s*\}/)[0]+
    ';return compareAppNames;})()'
  );
  const unsortedApps=['123 Something','Spotify','7-Zip','{identifier-like entry}','adobe acrobat','ChatGPT','Discord','Google Chrome'];
  const sortedAsc=[...unsortedApps].sort((a,b)=>compareAppNames(a,b));
  assert.deepEqual(sortedAsc,['adobe acrobat','ChatGPT','Discord','Google Chrome','Spotify','7-Zip','123 Something','{identifier-like entry}'],'A-Z letter names sort first, then digits, then symbols');
  // Selection Tray HTML, CSS and logic tests
  assert(htmlContent.includes('id="appsSelectionBar"'),'index.html contains appsSelectionBar');
  assert(htmlContent.includes('apps-selection-tray'),'index.html contains apps-selection-tray class');
  // Verify appsSelectionBar is placed outside phone-page-surface so it is not trapped by CSS transforms
  const surfaceOpenIdx = htmlContent.indexOf('<div class="phone-page-surface">');
  const trayIdx = htmlContent.indexOf('id="appsSelectionBar"');
  const cpuDialogIdx = htmlContent.indexOf('id="cpuDetailDialog"');
  assert(trayIdx > surfaceOpenIdx && trayIdx < cpuDialogIdx, 'appsSelectionBar is placed outside phone-page-surface for true viewport anchoring');
  assert(!htmlContent.slice(surfaceOpenIdx, htmlContent.indexOf('</section>\n  </div>\n  <dialog id="appsConfirmDialog"')).includes('id="appsSelectionBar"'), 'appsSelectionBar is not trapped inside phone surface');
  assert(htmlContent.includes('id="appsTraySummaryBtn"'),'index.html contains appsTraySummaryBtn');
  assert(htmlContent.includes('id="appsSelectedCount"'),'index.html contains appsSelectedCount');
  assert(htmlContent.includes('id="appsSelectedSize"'),'index.html contains appsSelectedSize');
  assert(htmlContent.includes('id="appsSelectedPreview"'),'index.html contains appsSelectedPreview');
  assert(htmlContent.includes('id="appsHiddenSelection"'),'index.html contains appsHiddenSelection');
  assert(htmlContent.includes('id="appsTrayExpanded"'),'index.html contains appsTrayExpanded');
  assert(htmlContent.includes('id="appsTrayCollapseBtn"'),'index.html contains appsTrayCollapseBtn');
  assert(htmlContent.includes('id="appsTraySelectedList"'),'index.html contains appsTraySelectedList');
  assert(htmlContent.includes('id="appsClearSelection"'),'index.html contains appsClearSelection');
  assert(htmlContent.includes('id="appsBatchUninstall"'),'index.html contains appsBatchUninstall');

  assert(cssContent.includes('#appsPage .apps-selection-tray'),'apps.css styles apps-selection-tray');
  assert(cssContent.includes('position: fixed') || cssContent.includes('position:fixed'),'apps-selection-tray is fixed to viewport');
  assert(cssContent.includes('env(safe-area-inset-bottom'),'apps-selection-tray supports safe-area-inset-bottom');
  assert(cssContent.includes('.has-selection-tray'),'apps.css includes clearance class has-selection-tray');
  assert(cssContent.includes('.apps-tray-expanded'),'apps.css styles apps-tray-expanded');
  assert(cssContent.includes('.apps-tray-item-remove'),'apps.css styles apps-tray-item-remove');

  // VM tests for formatSelectedPreview
  const previewVm=require('vm').runInNewContext(
    '(function(){'+
    appsJsContent.match(/function formatSelectedPreview[^{]*\{[\s\S]*?return `\$\{shown\.join\(' · '\)\} · \+\$\{remaining\}`;?\s*\}/)[0]+
    ';return formatSelectedPreview;})()'
  );
  assert.equal(previewVm([]),'');
  assert.equal(previewVm([{name:'Antigravity'}]),'Antigravity');
  assert.equal(previewVm([{name:'Antigravity'},{name:'Discord'}]),'Antigravity · Discord');
  assert.equal(previewVm([{name:'Antigravity'},{name:'Discord'},{name:'Spotify'}]),'Antigravity · Discord · +1');
  assert.equal(previewVm([{name:'Antigravity'},{name:'Discord'},{name:'Spotify'},{name:'Chrome'}]),'Antigravity · Discord · +2');

  // Full selection tray VM simulation
  const trayVm=require('vm').runInNewContext(
    '(function(){'+
    '  const selected=new Set();'+
    '  let selectionMode=false, trayExpanded=false;'+
    '  let searchVal="", typeVal="", showSystemVal=false;'+
    '  const apps=['+
    '    {id:"app-1",name:"Apple Software Update",publisher:"Apple Inc.",sizeKB:500*1024,category:"desktop",uninstallCapable:true},'+
    '    {id:"app-2",name:"Antigravity",publisher:"Google LLC",sizeKB:1024*1024,category:"desktop",uninstallCapable:true},'+
    '    {id:"app-3",name:"Discord",publisher:"Discord Inc.",sizeKB:600*1024,category:"desktop",uninstallCapable:true},'+
    '    {id:"app-4",name:"Unknown Tool",publisher:"Acme",sizeKB:null,category:"other",uninstallCapable:false}'+
    '  ];'+
    '  const categories={desktop:"Desktop app",store:"Microsoft Store app",system:"System component",other:"Other"};'+
    '  const category=app=>categories[app.category]?app.category:"other";'+
    '  function visibleApps(){'+
    '    const showSystem=Boolean(showSystemVal||typeVal==="system");'+
    '    return apps.filter(app=>{'+
    '      const cat=category(app);'+
    '      if(!showSystem&&cat==="system")return false;'+
    '      if(typeVal&&cat!==typeVal)return false;'+
    '      if(searchVal&&![app.name,app.publisher].filter(Boolean).join(" ").toLowerCase().includes(searchVal.toLowerCase()))return false;'+
    '      return true;'+
    '    });'+
    '  }'+
    '  const makeClassList=()=>{const s=new Set();return{add:c=>s.add(c),remove:c=>s.delete(c),has:c=>s.has(c),contains:c=>s.has(c)};};'+
    '  const dom={'+
    '    appsSelectionBar:{hidden:true,classList:makeClassList()},'+
    '    appsPage:{hidden:false,classList:makeClassList()},'+
    '    appsSelectModeBtn:{textContent:"Select apps"},'+
    '    appsSelectedCount:{textContent:"0 selected"},'+
    '    appsSelectedSize:{textContent:""},'+
    '    appsSelectedPreview:{textContent:""},'+
    '    appsHiddenSelection:{textContent:""},'+
    '    appsTrayExpandedBadge:{textContent:"0"},'+
    '    appsTrayKnownSize:{textContent:""},'+
    '    appsTrayUnknownSize:{textContent:""},'+
    '    appsBatchUninstall:{disabled:true},'+
    '    appsClearSelection:{disabled:false},'+
    '    appsTrayExpandedClear:{disabled:false},'+
    '    appsTrayExpandedReview:{disabled:true},'+
    '    appsTrayExpanded:{hidden:true},'+
    '    appsTraySummaryBtn:{"aria-expanded":"false"},'+
    '    renderedList:[]'+
    '  };'+
    '  let activeTab="installed";'+
    '  function sizeLabel(kb,isEstimated){if(!Number.isFinite(kb)||kb<0)return "—";const p=isEstimated?"~":"";if(kb===0)return p+"0 KB";if(kb>=1024*1024)return p+(kb/(1024*1024)).toFixed(1).replace(/\\.0$/,"")+" GB";if(kb>=1024)return p+(kb/1024).toFixed(kb<10240?1:0).replace(/\\.0$/,"")+" MB";return p+Math.round(kb)+" KB";}'+
    '  function setTrayExpanded(expanded){'+
    '    trayExpanded=Boolean(expanded);'+
    '    if(trayExpanded)dom.appsSelectionBar.classList.add("is-expanded"); else dom.appsSelectionBar.classList.remove("is-expanded");'+
    '    dom.appsTrayExpanded.hidden=!trayExpanded;'+
    '    dom.appsTraySummaryBtn["aria-expanded"]=String(trayExpanded);'+
    '    if(trayExpanded)renderExpandedTrayList();'+
    '  };'+
    '  function renderExpandedTrayList(){'+
    '    const selectedApps=[...selected].map(id=>apps.find(a=>a.id===id)).filter(Boolean);'+
    '    dom.renderedList=selectedApps.map(a=>({id:a.id,name:a.name,size:sizeLabel(a.sizeKB,false)}));'+
    '  }'+
    appsJsContent.match(/function formatSelectedPreview[^{]*\{[\s\S]*?return `\$\{shown\.join\(' · '\)\} · \+\$\{remaining\}`;?\s*\}/)[0]+';'+
    '  function selection(){'+
    '    const selectedApps=[...selected].map(id=>apps.find(app=>app.id===id)).filter(Boolean);'+
    '    const visibleIds=new Set(visibleApps().map(app=>app.id));'+
    '    const hidden=[...selected].filter(id=>!visibleIds.has(id)).length;'+
    '    const hasSelection=selected.size>0;'+
    '    const isInstalledActive=Boolean(dom.appsPage && !dom.appsPage.hidden && activeTab==="installed");'+
    '    const showTray=Boolean(isInstalledActive && hasSelection);'+
    '    dom.appsSelectionBar.hidden=!showTray;'+
    '    if(showTray){dom.appsPage.classList.add("has-selection-tray");dom.appsPage.classList.add("is-selecting");}else{dom.appsPage.classList.remove("has-selection-tray");if(!selectionMode)dom.appsPage.classList.remove("is-selecting");}'+
    '    dom.appsSelectModeBtn.textContent=(selectionMode||hasSelection)?"Cancel":"Select apps";'+
    '    if(!showTray&&trayExpanded)setTrayExpanded(false);'+
    '    let totalKB=0,unknownCount=0,hasEstimated=false,knownCount=0;'+
    '    for(const a of selectedApps){if(Number.isFinite(a.sizeKB)&&a.sizeKB>=0){totalKB+=a.sizeKB;knownCount++;if(a.sizeEstimated)hasEstimated=true;}else unknownCount++;}'+
    '    dom.appsSelectedCount.textContent=selected.size+" selected";'+
    '    if(selected.size>0){'+
    '      if(knownCount>0){'+
    '        const formatted=sizeLabel(totalKB,hasEstimated||unknownCount>0);'+
    '        dom.appsSelectedSize.textContent=" · "+formatted+(unknownCount>0?" known":"");'+
    '      }else dom.appsSelectedSize.textContent=" · size unknown";'+
    '    }else dom.appsSelectedSize.textContent="";'+
    '    dom.appsSelectedPreview.textContent=formatSelectedPreview(selectedApps);'+
    '    dom.appsHiddenSelection.textContent=hidden?hidden+" hidden by your search or filter":"";'+
    '    dom.appsTrayExpandedBadge.textContent=String(selected.size);'+
    '    if(knownCount>0)dom.appsTrayKnownSize.textContent="Known size: "+sizeLabel(totalKB,hasEstimated||unknownCount>0);'+
    '    else if(selected.size>0)dom.appsTrayKnownSize.textContent="Known size: unknown";'+
    '    else dom.appsTrayKnownSize.textContent="";'+
    '    dom.appsTrayUnknownSize.textContent=unknownCount>0?unknownCount+" size"+(unknownCount===1?"":"s")+" unknown":"";'+
    '    dom.appsBatchUninstall.disabled=!selected.size;'+
    '    dom.appsTrayExpandedReview.disabled=!selected.size;'+
    '    if(trayExpanded)renderExpandedTrayList();'+
    '  }'+
    '  return {'+
    '    select: id => { selected.add(id); selection(); },'+
    '    unselect: id => { selected.delete(id); selection(); },'+
    '    clearAll: () => { selected.clear(); selection(); },'+
    '    setSearch: s => { searchVal=s; selection(); },'+
    '    setTab: t => { activeTab=t; selection(); },'+
    '    setPageHidden: h => { dom.appsPage.hidden=Boolean(h); selection(); },'+
    '    setTrayExpanded,'+
    '    getDom: () => dom,'+
    '    getSelected: () => [...selected],'+
    '    isExpanded: () => trayExpanded'+
    '  };'+
    '})()'
  );

  // 1. Initially hidden
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, true, 'Tray is initially hidden');
  assert(!trayVm.getDom().appsPage.classList.has('has-selection-tray'), 'No bottom clearance when empty');

  // 2. Select first app -> Tray appears immediately with count, size and preview
  trayVm.select('app-1');
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, false, 'Tray appears immediately on first selection');
  assert(trayVm.getDom().appsPage.classList.has('has-selection-tray'), 'Bottom clearance added');
  assert.equal(trayVm.getDom().appsSelectedCount.textContent, '1 selected');
  assert.equal(trayVm.getDom().appsSelectedSize.textContent, ' · 500 MB');
  assert.equal(trayVm.getDom().appsSelectedPreview.textContent, 'Apple Software Update');
  assert.equal(trayVm.getDom().appsHiddenSelection.textContent, '');

  // 3. Search change -> Selection survives, hidden count tracked
  trayVm.setSearch('Antigravity');
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, false, 'Tray remains visible during search');
  assert.equal(trayVm.getDom().appsSelectedCount.textContent, '1 selected');
  assert.equal(trayVm.getDom().appsHiddenSelection.textContent, '1 hidden by your search or filter');

  // 4. Select second app (Antigravity) -> Count, total size, preview update
  trayVm.select('app-2');
  assert.equal(trayVm.getDom().appsSelectedCount.textContent, '2 selected');
  assert.equal(trayVm.getDom().appsSelectedSize.textContent, ' · 1.5 GB');
  assert.equal(trayVm.getDom().appsSelectedPreview.textContent, 'Apple Software Update · Antigravity');

  // 5. Select third app (Discord) -> Count 3, preview shows +1
  trayVm.setSearch('');
  trayVm.select('app-3');
  assert.equal(trayVm.getDom().appsSelectedCount.textContent, '3 selected');
  assert.equal(trayVm.getDom().appsSelectedSize.textContent, ' · 2.1 GB');
  assert.equal(trayVm.getDom().appsSelectedPreview.textContent, 'Apple Software Update · Antigravity · +1');

  // 6. Expand tray -> Shows all selected apps in expanded list
  trayVm.setTrayExpanded(true);
  assert.equal(trayVm.isExpanded(), true);
  assert.equal(trayVm.getDom().appsTrayExpanded.hidden, false);
  assert.equal(trayVm.getDom().renderedList.length, 3);
  assert.deepEqual(trayVm.getDom().renderedList.map(x=>x.name), ['Apple Software Update','Antigravity','Discord']);
  assert.equal(trayVm.getDom().appsTrayKnownSize.textContent, 'Known size: 2.1 GB');

  // 7. Unknown size not counted as zero
  trayVm.select('app-4');
  assert.equal(trayVm.getDom().appsSelectedCount.textContent, '4 selected');
  assert.equal(trayVm.getDom().appsSelectedSize.textContent, ' · ~2.1 GB known');
  assert.equal(trayVm.getDom().appsTrayKnownSize.textContent, 'Known size: ~2.1 GB');
  assert.equal(trayVm.getDom().appsTrayUnknownSize.textContent, '1 size unknown');

  // 8. Remove one app from tray -> Immediately updates count, size, rendered items
  trayVm.unselect('app-1');
  assert.equal(trayVm.getDom().appsSelectedCount.textContent, '3 selected');
  assert.equal(trayVm.getDom().appsTrayKnownSize.textContent, 'Known size: ~1.6 GB');
  assert.equal(trayVm.getDom().appsTrayUnknownSize.textContent, '1 size unknown');
  assert.equal(trayVm.getDom().renderedList.length, 3);
  assert.deepEqual(trayVm.getDom().renderedList.map(x=>x.name), ['Antigravity','Discord','Unknown Tool']);

  // 9. Collapse tray -> Selection maintained
  trayVm.setTrayExpanded(false);
  assert.equal(trayVm.isExpanded(), false);
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, false);
  assert.equal(trayVm.getDom().appsSelectedCount.textContent, '3 selected');

  // 10. Clear all -> Clears every selection and hides tray
  trayVm.clearAll();
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, true, 'Tray disappears when selection cleared');
  assert(!trayVm.getDom().appsPage.classList.has('has-selection-tray'), 'Clearance removed on empty');
  assert.equal(trayVm.getDom().appsSelectedCount.textContent, '0 selected');
  assert.equal(trayVm.getSelected().length, 0);

  // 11. Tab scoping: switching away to Startup hides the tray; switching back restores it
  trayVm.select('app-1');
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, false, 'Tray visible on installed tab');
  trayVm.setTab('startup');
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, true, 'Tray hidden on startup tab');
  trayVm.setTab('installed');
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, false, 'Tray restored on installed tab');

  // 12. Page scoping: navigating to another page hides the tray; returning restores it
  trayVm.setPageHidden(true);
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, true, 'Tray hidden when page hidden');
  trayVm.setPageHidden(false);
  assert.equal(trayVm.getDom().appsSelectionBar.hidden, false, 'Tray restored when page visible');
  trayVm.clearAll();


  // Quick Launch unit tests
  const qlDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-ql-qa-'));
  try {
    const launchableRow = { ...baseRow('Launchable App', 'user', 'launch-app'), product: '{11111111-1111-1111-1111-111111111111}', launchCapable: true };
    const nonLaunchableRow = { ...baseRow('Unlaunchable App', 'user', 'no-launch-app'), product: '{22222222-2222-2222-2222-222222222222}', launchCapable: false };
    let launchedRequest = null;
    const qlOperation = async req => {
      if (req.action === 'inventory') return { success: true, apps: [launchableRow, nonLaunchableRow], packagesAvailable: false };
      if (req.action === 'launch') {
        launchedRequest = req;
        if (req.locator.key === 'launch-app') return { success: true, code: 'launched' };
        return { success: false, code: 'launch-failed', error: 'Could not launch' };
      }
      return { success: true, code: 'completed' };
    };
    const qlMgr = new AppManager({ operation: qlOperation, stateDirectory: qlDir });
    const qlInv = await qlMgr.inventory();
    const lId = qlInv.apps.find(a => a.name === 'Launchable App').id;
    const nlId = qlInv.apps.find(a => a.name === 'Unlaunchable App').id;

    assert.equal(qlMgr.getQuickLaunch().pins.length, 0);
    await assert.rejects(async () => qlMgr.pinApp('not-a-valid-id'), /invalid-request/);
    await assert.rejects(async () => qlMgr.pinApp('0'.repeat(64)), /not-found/);
    await assert.rejects(async () => qlMgr.pinApp(nlId), /unsupported/);

    const pinRes = qlMgr.pinApp(lId);
    assert.equal(pinRes.code, 'pinned');
    assert.equal(qlMgr.getQuickLaunch().pins.length, 1);
    assert.equal(qlMgr.getQuickLaunch().pins[0].name, 'Launchable App');
    assert.equal(qlMgr.getQuickLaunch().pins[0].available, true);
    assert.equal(qlMgr.getQuickLaunch().pins[0].launchCapable, true);

    // Duplicate pin rejected
    await assert.rejects(async () => qlMgr.pinApp(lId), /already-pinned/);

    // Launch validation
    await assert.rejects(async () => qlMgr.launch('not-a-valid-id'), /invalid-request/);
    await assert.rejects(async () => qlMgr.launch(nlId), /unsupported/);
    const launchRes = await qlMgr.launch(lId);
    assert.equal(launchRes.code, 'launched');
    assert.equal(launchedRequest.action, 'launch');
    assert.equal(launchedRequest.locator.key, 'launch-app');

    // Persistence across instances
    const qlMgr2 = new AppManager({ operation: qlOperation, stateDirectory: qlDir });
    await qlMgr2.inventory();
    assert.equal(qlMgr2.getQuickLaunch().pins.length, 1);
    assert.equal(qlMgr2.getQuickLaunch().pins[0].name, 'Launchable App');

    // Unpin validation
    await assert.rejects(async () => qlMgr2.unpinApp({ id: '0'.repeat(64) }), /not-found/);
    const unpinId = qlMgr2.getQuickLaunch().pins[0].id;
    const unpinRes = qlMgr2.unpinApp({ id: unpinId });
    assert.equal(unpinRes.code, 'unpinned');
    assert.equal(qlMgr2.getQuickLaunch().pins.length, 0);

    // Pin limit (12)
    for (let i = 0; i < 12; i++) {
      qlMgr2.quickLaunch.pins.push({ locator: { scope: 'user', key: `app-${i}` }, name: `App ${i}`, addedAt: Date.now() });
    }
    await assert.rejects(async () => qlMgr2.pinApp(unpinId), /limit-reached/);
  } finally {
    fs.rmSync(qlDir, { recursive: true, force: true });
  }

  // Startup management unit tests
  let startupItemsFixture = [
    {
      locator: { source: 'registry-user', key: 'UserApp' },
      fingerprint: '1'.repeat(64),
      name: 'UserApp',
      displayName: 'Friendly User App',
      publisher: 'Acme Corp',
      command: 'C:\\Users\\Public\\app.exe',
      source: 'registry-user',
      scope: 'user',
      enabled: true,
      readOnly: false,
      icon: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAAAAAA6fptVAAAACklEQVR4nGNiAAAABgADNjd8qAAAAABJRU5ErkJggg=='
    },
    {
      locator: { source: 'registry-machine', key: 'MachineApp' },
      fingerprint: '2'.repeat(64),
      name: 'MachineApp',
      displayName: 'System Driver Helper',
      publisher: 'Hardware Vendor',
      command: 'C:\\Program Files\\vendor\\helper.exe',
      source: 'registry-machine',
      scope: 'machine',
      enabled: true,
      readOnly: true,
      icon: null
    }
  ];
  let toggledReq = null;
  const startupOp = async req => {
    if (req.action === 'startup-inventory') return { success: true, code: 'startup-inventory', items: startupItemsFixture };
    if (req.action === 'startup-toggle') {
      toggledReq = req;
      return { success: true, code: 'completed', enabled: req.enabled };
    }
    return { success: false, code: 'unsupported' };
  };
  const startupMgr = new AppManager({ operation: startupOp });
  const stData = await startupMgr.startupInventory();
  assert.equal(stData.items.length, 2);
  assert.equal(stData.items[0].displayName, 'Friendly User App');
  assert.equal(stData.items[0].scope, 'user');
  assert.equal(stData.items[0].readOnly, false);
  assert.equal(stData.items[0].hasIcon, true);
  assert(!('command' in stData.items[0]), 'raw command path must not be exposed to frontend');
  assert(!('fingerprint' in stData.items[0]), 'raw fingerprint must not be exposed to frontend');
  assert.equal(stData.items[1].displayName, 'System Driver Helper');
  assert.equal(stData.items[1].scope, 'machine');
  assert.equal(stData.items[1].readOnly, true);
  assert.equal(stData.items[1].hasIcon, false);

  const stIcon = startupMgr.getStartupIcon(stData.items[0].id);
  assert(Buffer.isBuffer(stIcon));
  assert.strictEqual(startupMgr.getStartupIcon(stData.items[1].id), null);

  const toggleRes = await startupMgr.toggleStartup(stData.items[0].id, false);
  assert.equal(toggleRes.code, 'startup-changed');
  assert.equal(toggleRes.enabled, false);
  assert.equal(toggledReq.locator.key, 'UserApp');
  assert.equal(toggledReq.enabled, false);

  await assert.rejects(async () => startupMgr.toggleStartup(stData.items[1].id, false), /elevation-required/);
  await assert.rejects(async () => startupMgr.toggleStartup(stData.items[0].id, 'not-a-bool'), /invalid-request/);
  await assert.rejects(async () => startupMgr.toggleStartup('0'.repeat(64), false), /not-found/);

  console.log('PASS category/description privacy, truthful KB/MB/GB/unknown/zero sizes; opaque identity/review binding, MSI dedupe, supported/manual classification, sequential queue/partial failure, auth revocation, refresh verification, reboot, timeout fail-closed and malformed helper output; Quick Launch pins, limits, persistence, launch safety; Startup inventory, icons, reversible toggle, elevation protection.');
}
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-app-qa- ')),prefix='SystemManagementQA-'+crypto.randomBytes(12).toString('hex');
function fixture(cleanup=false){return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'app-manager-test-tools.ps1'),'-Directory',directory,'-Prefix',prefix,...(cleanup?['-Cleanup']:[])],{windowsHide:true,timeout:30000},(error)=>error?reject(Error('Owned app fixture setup/cleanup failed')):resolve()));}
async function packageMetadata(){const script=". '"+path.join(__dirname,'application-display.ps1').replace(/'/g,"''")+"';$p=[pscustomobject]@{Name='Technical.Package';PackageFullName='Technical_full'};$m=[xml]'<Package><Properties><DisplayName>Friendly Store app</DisplayName><Description>Local package description</Description></Properties></Package>';if((Get-RovarinPackageDisplayName $p $m) -cne 'Friendly Store app'){throw 'Package name lost'};if((Get-RovarinPackageDescription $p $m) -cne 'Local package description'){throw 'Package description lost'};$m.Package.Properties.Description='ms-resource:missing-description';if((Get-RovarinPackageDescription $p $m) -ne ''){throw 'Unresolved description invented'};";await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000},e=>e?reject(Error('Package presentation fixture failed')):resolve()));console.log('PASS trustworthy package name/description and unresolved-resource fallback');}
async function realWindows(){await fixture();const operation=windowsOperation;const manager=new AppManager({operation});let inventory=await manager.inventory();const find=name=>inventory.apps.find(a=>a.name==='Disposable App QA '+name);
 assert.equal(find('individual')?.description,'Local disposable fixture description');assert.equal(find('individual')?.category,'desktop');assert.equal(find('ambiguous')?.sizeKB,null,'absent EstimatedSize is unknown, not zero');assert(!JSON.stringify(inventory).includes('installLocation'));assert(inventory.apps.some(x=>x.category==='desktop'));if(inventory.packagesAvailable)assert(inventory.apps.some(x=>['store','system'].includes(x.category)));
 assert(find('individual')?.uninstallCapable&&find('individual').batchCapable,'quoted registered EXE and declared quiet command accepted');assert.equal(find('unsafe').uninstallCapable,false,'cmd registration is manual-only');assert.equal(find('ambiguous').uninstallCapable,false,'unquoted path with spaces is refused');
 const own=[...manager.rows.values()].filter(row=>row.locator.key.startsWith(prefix));assert.equal(own.length,6);assert(own.find(row=>row.locator.key.endsWith('protected')).protected);
 const untouched=inventory.apps.filter(a=>!a.name.startsWith('Disposable App QA ')&&a.name!=='Rovarin').map(a=>a.id);
 await manager.start([find('individual').id],false);await manager.running;assert.equal(manager.job.items[0].state,'completed');inventory=await manager.inventory();assert(!find('individual'),'actual registration removed and verified');
 await manager.start([find('batch-failure').id,find('batch-good').id],true);await manager.running;assert.equal(manager.job.items[0].state,'failed');assert.equal(manager.job.items[1].state,'completed');inventory=await manager.inventory();assert(!find('batch-good')&&find('batch-failure'));
 const stReal = await manager.startupInventory();
 assert(Array.isArray(stReal.items));
 const qlReal = manager.getQuickLaunch();
 assert(Array.isArray(qlReal.pins));
 assert(untouched.every(id=>inventory.apps.some(a=>a.id===id)),'all unrelated inventory identities remain');console.log('PASS actual HKCU disposable vendor EXE uninstall, metadata-declared quiet batch, partial failure continues, refresh verifies removal, unsafe/ambiguous/own-product refusal, unrelated apps unchanged.');}
(async()=>{await mocked();if(process.platform==='win32'){await packageMetadata();await realWindows();}})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{try{await fixture(true);fs.rmSync(directory,{recursive:true,force:true});console.log('PASS owned disposable registry/files cleaned.');}catch(_){console.error('Disposable cleanup failed; fixture retained.');process.exitCode=1;}});

