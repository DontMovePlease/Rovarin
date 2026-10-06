'use strict';
(() => {
  const get=id=>document.getElementById(id),list=get('appsList'),status=get('appsStatus'),dialog=get('appsConfirmDialog'),form=get('appsConfirmForm'),pin=get('appsConfirmPin');
  let apps=[],loading=false,operationBusy=false,sortDirection=1,review=null,selectionMode=false;
  const selected=new Set();

  // Quick Launch state
  let quickLaunchData={pins:[],maxPins:12},qlStatusTimer=null;
  const qlRail=get('quickLaunchRail'),qlCount=get('quickLaunchCount'),qlStatus=get('quickLaunchStatus');
  const qlDialog=get('quickLaunchPickerDialog'),qlSearch=get('qlPickerSearch'),qlPickerList=get('qlPickerList'),qlPickerCount=get('qlPickerCount');

  // Startup Apps state
  let startupApps=[],startupLoading=false,startupTarget=null,activeTab='installed';
  const startupList=get('startupList'),startupStatus=get('startupStatus'),startupDialog=get('startupConfirmDialog'),startupForm=get('startupConfirmForm');

  function setView(mode){const grid=mode==='grid';list.classList.toggle('is-grid',grid);get('appsViewList').setAttribute('aria-pressed',String(!grid));get('appsViewGrid').setAttribute('aria-pressed',String(grid));try{localStorage.setItem('rovarin.appsView',grid?'grid':'list');}catch{}}
  let initialView='list';try{initialView=localStorage.getItem('rovarin.appsView')==='grid'?'grid':'list';}catch{}setView(initialView);
  get('appsViewList').addEventListener('click',()=>setView('list'));get('appsViewGrid').addEventListener('click',()=>setView('grid'));
  const nameCollator=new Intl.Collator(undefined,{sensitivity:'base',numeric:true});
  function nameSortGroup(str){const t=String(str||'').trim();if(/^\p{L}/u.test(t))return 1;if(/^\p{N}/u.test(t))return 2;return 3;}
  function compareAppNames(aName,bName){const aStr=String(aName||'').trim(),bStr=String(bName||'').trim();const aG=nameSortGroup(aStr),bG=nameSortGroup(bStr);if(aG!==bG)return aG-bG;return nameCollator.compare(aStr,bStr);}
  function cleanPublisher(raw){
    if(!raw||typeof raw!=='string')return '';
    const s=raw.trim();
    if(!s||s.startsWith('ms-resource:'))return '';
    if(/^CN\s*=/i.test(s)||/,\s*(?:O|OU|L|S|C)\s*=/i.test(s)){
      const parts={};
      const matches=s.match(/(?:^|,\s*)([A-Za-z]+)\s*=\s*([^,]+)/g);
      if(matches){
        for(const m of matches){
          const eq=m.indexOf('=');
          if(eq!==-1){
            const k=m.slice(0,eq).replace(/^,\s*/,'').trim().toUpperCase();
            const v=m.slice(eq+1).trim().replace(/^"(.*)"$/,'$1');
            if(!parts[k])parts[k]=v;
          }
        }
      }
      if(parts.CN&&!/^[0-9a-fA-F-]{16,}$/.test(parts.CN)&&!/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(parts.CN))return parts.CN;
      if(parts.O&&!/^[0-9a-fA-F-]{16,}$/.test(parts.O))return parts.O;
      if(parts.OU&&!/^[0-9a-fA-F-]{16,}$/.test(parts.OU))return parts.OU;
      if(parts.CN)return parts.CN;
      return '';
    }
    return s;
  }
  const categories={desktop:'Desktop app',store:'Microsoft Store app',system:'System component',other:'Other'};
  const category=app=>categories[app.category]?app.category:'other';
  const removal=app=>!app.uninstallCapable?'Manual removal required':app.batchCapable?'Ready for batch removal':'Needs individual removal';
  function sizeLabel(kb,isEstimated){if(!Number.isFinite(kb)||kb<0)return '—';const p=isEstimated?'~':'';if(kb===0)return p+'0 KB';if(kb>=1024*1024)return p+(kb/(1024*1024)).toFixed(1).replace(/\.0$/,'')+' GB';if(kb>=1024)return p+(kb/1024).toFixed(kb<10240?1:0).replace(/\.0$/,'')+' MB';return p+Math.round(kb)+' KB';}
  function node(tag,text,cls){const el=document.createElement(tag);if(text!==undefined)el.textContent=text;if(cls)el.className=cls;return el;}
  let iconObserver=null;
  function getIconObserver(){
    if(!iconObserver&&typeof IntersectionObserver==='function'){
      iconObserver=new IntersectionObserver((entries,obs)=>{
        for(const entry of entries){
          if(entry.isIntersecting){
            const img=entry.target;
            obs.unobserve(img);
            if(img.dataset.src){
              img.src=img.dataset.src;
              delete img.dataset.src;
            }
          }
        }
      },{rootMargin:'250px 0px'});
    }
    return iconObserver;
  }
  function observeOrSetSrc(img,url){
    const obs=getIconObserver();
    if(obs){
      img.dataset.src=url;
      obs.observe(img);
    }else{
      img.loading='lazy';
      img.src=url;
    }
  }
  function appFallbackIcon(app){const initial=(app.name||'?').trim().charAt(0).toUpperCase();const glyph=node('div',initial,'apps-icon-fallback');glyph.setAttribute('aria-hidden','true');return glyph;}
  function appIcon(app){const wrap=node('div',undefined,'apps-icon-wrap');if(app.hasIcon){const img=document.createElement('img');img.className='apps-icon-img';img.alt='';img.onerror=()=>{wrap.replaceChildren(appFallbackIcon(app));};observeOrSetSrc(img,'/api/apps/icon?id='+encodeURIComponent(app.id));wrap.append(img);}else{wrap.append(appFallbackIcon(app));}return wrap;}
  function startupIcon(item){const wrap=node('div',undefined,'apps-icon-wrap');if(item.hasIcon){const img=document.createElement('img');img.className='apps-icon-img';img.alt='';img.onerror=()=>{wrap.replaceChildren(appFallbackIcon(item));};observeOrSetSrc(img,'/api/apps/startup/icon?id='+encodeURIComponent(item.id));wrap.append(img);}else{wrap.append(appFallbackIcon(item));}return wrap;}

  function visibleApps(){
    const search=get('appsSearch').value.trim().toLocaleLowerCase(),type=get('appsType').value;
    const showSystem=Boolean(get('appsShowSystem')?.checked||type==='system');
    return apps.filter(app=>{
      const cat=category(app);
      if(!showSystem&&cat==='system')return false;
      if(type&&cat!==type)return false;
      if(search&&![app.name,app.publisher,app.description].filter(Boolean).join(' ').toLocaleLowerCase().includes(search))return false;
      return true;
    });
  }
  function filters(){
    const control=get('appsType'),value=control.value;
    const showSystem=Boolean(get('appsShowSystem')?.checked);
    control.replaceChildren(node('option','All apps'));
    control.firstChild.value='';
    for(const [key,label] of Object.entries(categories)){
      if(key==='system'&&!showSystem)continue;
      if(apps.some(app=>category(app)===key)){
        const option=node('option',label);
        option.value=key;
        control.append(option);
      }
    }
    control.value=[...control.options].some(x=>x.value===value)?value:'';
  }

  /* Subnav tabs */
  function setTab(tab){
    activeTab=tab;
    get('appsTabInstalled').classList.toggle('is-active',tab==='installed');
    get('appsTabInstalled').setAttribute('aria-selected',String(tab==='installed'));
    get('appsTabStartup').classList.toggle('is-active',tab==='startup');
    get('appsTabStartup').setAttribute('aria-selected',String(tab==='startup'));
    get('appsInstalledPanel').hidden=tab!=='installed';
    get('appsStartupPanel').hidden=tab!=='startup';
    if(tab==='startup'&&!startupApps.length)refreshStartup();
    selection();
  }
  get('appsTabInstalled').addEventListener('click',()=>setTab('installed'));
  get('appsTabStartup').addEventListener('click',()=>setTab('startup'));

  /* Quick Launch */
  function setQlStatus(text,isError=false){
    if(qlStatusTimer)clearTimeout(qlStatusTimer);
    qlStatus.className='quick-launch-status'+(isError?' is-error':'');
    qlStatus.textContent=text;
    if(text)qlStatusTimer=setTimeout(()=>{qlStatus.textContent='';},5000);
  }
  async function refreshQuickLaunch(){
    try {
      const r=await fetch('/api/apps/quick-launch',{credentials:'same-origin',cache:'no-store'});
      if(r.ok){
        quickLaunchData=await r.json();
        renderQuickLaunch();
      }
    }catch(_){}
  }
  function isPinned(app){
    if(!app||!Array.isArray(quickLaunchData.pins))return false;
    return quickLaunchData.pins.some(p=>(app.id&&p.id===app.id)||(p.locator&&app.locator&&p.locator.scope===app.locator.scope&&p.locator.key===app.locator.key));
  }
  async function pinApp(id){
    if(operationBusy)return;
    try {
      const r=await fetch('/api/apps/quick-launch',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'pin',id})});
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'Could not pin app');
      setQlStatus('Pinned to Quick Launch');
      await refreshQuickLaunch();
    }catch(e){setQlStatus(e.message,true);}
  }
  async function unpinApp({id,locator}){
    if(operationBusy)return;
    try {
      const r=await fetch('/api/apps/quick-launch',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'unpin',id,locator})});
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'Could not unpin app');
      setQlStatus('Unpinned from Quick Launch');
      await refreshQuickLaunch();
    }catch(e){setQlStatus(e.message,true);}
  }
  async function launchApp(id,name,tile){
    if(operationBusy||tile.classList.contains('is-launching'))return;
    tile.classList.add('is-launching');
    setQlStatus('Launching '+name+'…');
    try {
      const r=await fetch('/api/apps/launch',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({id})});
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'Launch failed');
      setQlStatus('Launched '+name+' on PC');
    }catch(e){
      setQlStatus('Launch failed: '+e.message,true);
    }finally{
      tile.classList.remove('is-launching');
    }
  }
  function renderQuickLaunchPicker(){
    const search=(qlSearch.value||'').trim().toLocaleLowerCase();
    const launchable=apps.filter(a=>a.launchCapable);
    launchable.sort((a,b)=>nameCollator.compare(a.name,b.name));
    const filtered=search?launchable.filter(a=>[a.name,a.publisher,a.description].filter(Boolean).join(' ').toLocaleLowerCase().includes(search)):launchable;
    qlPickerList.replaceChildren();
    qlPickerCount.textContent=`${quickLaunchData.pins.length} / ${quickLaunchData.maxPins||12} pinned`;
    if(!filtered.length){
      qlPickerList.append(node('p',launchable.length?'No launchable apps match “'+search+'”.':'No launch-capable applications found.','apps-empty'));
      return;
    }
    for(const app of filtered){
      const item=node('div',undefined,'ql-picker-item');
      const icon=appIcon(app);
      const info=node('div',undefined,'ql-picker-item-info');
      info.append(node('strong',app.name),node('small',cleanPublisher(app.publisher)||'Publisher unavailable'));
      const pinned=isPinned(app);
      const toggleBtn=node('button',pinned?'Pinned':'+ Add','ql-picker-toggle-btn'+(pinned?' is-pinned':''));
      toggleBtn.type='button';
      toggleBtn.disabled=operationBusy||(!pinned&&quickLaunchData.pins.length>=(quickLaunchData.maxPins||12));
      toggleBtn.title=pinned?'Unpin from Quick Launch':quickLaunchData.pins.length>=12?'Quick Launch full (max 12)':'Pin to Quick Launch';
      toggleBtn.addEventListener('click',async()=>{
        if(pinned)await unpinApp({id:app.id,locator:app.locator});
        else await pinApp(app.id);
        renderQuickLaunchPicker();
      });
      item.append(icon,info,toggleBtn);
      qlPickerList.append(item);
    }
  }
  function openQuickLaunchPicker(){
    qlSearch.value='';
    renderQuickLaunchPicker();
    if(!qlDialog.open)qlDialog.showModal();
  }
  function renderQuickLaunch(){
    qlCount.textContent=`${quickLaunchData.pins.length} / ${quickLaunchData.maxPins||12} pinned`;
    qlRail.replaceChildren();
    if(!quickLaunchData.pins.length){
      const emptyCard=node('div',undefined,'quick-launch-empty-card');
      emptyCard.append(node('p','No apps pinned yet. Tap “+ Add apps” to pin applications for fast remote launching.','quick-launch-empty-text'));
      const addBtn=node('button','+ Add apps','quick-launch-add-btn');
      addBtn.type='button';
      addBtn.addEventListener('click',openQuickLaunchPicker);
      emptyCard.append(addBtn);
      qlRail.append(emptyCard);
      return;
    }
    for(const pin of quickLaunchData.pins){
      const tile=node('div',undefined,'quick-launch-tile'+(pin.available?'':' is-missing'));
      tile.tabIndex=0;
      tile.setAttribute('role','button');
      tile.setAttribute('aria-label',pin.available?'Launch '+pin.name:'Missing application '+pin.name);
      const iconWrap=node('div',undefined,'quick-launch-tile-icon-wrap');
      if(pin.hasIcon&&pin.id){
        const img=document.createElement('img');
        img.className='quick-launch-tile-icon';
        img.alt='';
        img.loading='lazy';
        img.src='/api/apps/icon?id='+encodeURIComponent(pin.id);
        img.onerror=()=>{iconWrap.replaceChildren(appFallbackIcon(pin));};
        iconWrap.append(img);
      }else{
        iconWrap.append(appFallbackIcon(pin));
      }
      const nameEl=node('span',pin.name,'quick-launch-tile-name');
      nameEl.title=pin.name;
      tile.append(iconWrap,nameEl);
      if(!pin.available)tile.append(node('span','(Not found)','quick-launch-missing-label'));
      const unpinBtn=node('button','✕','quick-launch-unpin-btn');
      unpinBtn.type='button';
      unpinBtn.title='Unpin from Quick Launch';
      unpinBtn.setAttribute('aria-label','Unpin '+pin.name);
      unpinBtn.addEventListener('click',e=>{e.stopPropagation();unpinApp({id:pin.id,locator:pin.locator});});
      tile.append(unpinBtn);
      tile.addEventListener('click',()=>{
        if(!pin.available){setQlStatus('App not found on PC. You can unpin it.',true);return;}
        if(!pin.launchCapable){setQlStatus('App cannot be launched directly.',true);return;}
        launchApp(pin.id,pin.name,tile);
      });
      tile.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();tile.click();}});
      qlRail.append(tile);
    }
  }

  /* Installed Apps */
  let trayExpanded=false;
  function setTrayExpanded(expanded){
    trayExpanded=Boolean(expanded);
    const tray=get('appsSelectionBar');
    const expEl=get('appsTrayExpanded');
    const summaryBtn=get('appsTraySummaryBtn');
    if(tray)tray.classList.toggle('is-expanded',trayExpanded);
    if(expEl)expEl.hidden=!trayExpanded;
    if(summaryBtn)summaryBtn.setAttribute('aria-expanded',String(trayExpanded));
    if(trayExpanded)renderExpandedTrayList();
  }
  function formatSelectedPreview(selectedApps){
    if(!selectedApps.length)return '';
    const names=selectedApps.map(a=>a.name);
    if(names.length<=2)return names.join(' · ');
    const shown=names.slice(0,2);
    const remaining=names.length-2;
    return `${shown.join(' · ')} · +${remaining}`;
  }
  function renderExpandedTrayList(){
    const listEl=get('appsTraySelectedList');
    if(!listEl)return;
    const selectedApps=[...selected].map(id=>apps.find(a=>a.id===id)).filter(Boolean);
    listEl.replaceChildren();
    if(!selectedApps.length){
      setTrayExpanded(false);
      return;
    }
    for(const app of selectedApps){
      const item=node('div',undefined,'apps-tray-item');
      item.setAttribute('role','listitem');
      const icon=appIcon(app);
      const info=node('div',undefined,'apps-tray-item-info');
      const title=node('strong',app.name);
      title.title=app.name;
      info.append(title);
      const size=node('span',sizeLabel(app.sizeKB,app.sizeEstimated),'apps-tray-item-size');
      const removeBtn=node('button','×','apps-tray-item-remove');
      removeBtn.type='button';
      removeBtn.setAttribute('aria-label','Remove '+app.name+' from selection');
      removeBtn.title='Remove '+app.name+' from selection';
      removeBtn.addEventListener('click',e=>{
        e.stopPropagation();
        selected.delete(app.id);
        const row=list.querySelector(`.apps-row[data-app-id="${app.id}"]`);
        if(row){
          row.classList.remove('is-selected');
          const check=row.querySelector('input[type="checkbox"]');
          if(check)check.checked=false;
        }
        selection();
        if(!selected.size){
          setTrayExpanded(false);
        }else{
          renderExpandedTrayList();
        }
      });
      item.append(icon,info,size,removeBtn);
      listEl.append(item);
    }
  }
  function setSelectionMode(enabled){
    selectionMode=Boolean(enabled);
    if(!selectionMode)selected.clear();
    setTrayExpanded(false);
    render();
  }
  function render(){
    const sort=get('appsSort').value,shown=visibleApps();
    shown.sort((a,b)=>{
      let value;
      if(sort==='size'){
        if(a.sizeKB==null||b.sizeKB==null)return a.sizeKB==null&&b.sizeKB==null?compareAppNames(a.name,b.name):a.sizeKB==null?1:-1;
        value=a.sizeKB-b.sizeKB;
      }else if(sort==='publisher'){
        value=compareAppNames(a.publisher,b.publisher)||compareAppNames(a.name,b.name);
      }else{
        value=compareAppNames(a.name,b.name);
      }
      return (value*sortDirection)||compareAppNames(a.name,b.name)||a.id.localeCompare(b.id);
    });
    const scroll=list.scrollTop;list.replaceChildren();for(const app of shown){
      const row=node('article',undefined,'apps-row'+(selected.has(app.id)?' is-selected':'')),check=node('input');row.dataset.appId=app.id;check.type='checkbox';check.checked=selected.has(app.id);check.disabled=operationBusy;check.setAttribute('aria-label','Select '+app.name+' for review');check.addEventListener('change',()=>{check.checked?selected.add(app.id):selected.delete(app.id);row.classList.toggle('is-selected',check.checked);selection();});
      const selectArea=node('label',undefined,'apps-select');selectArea.append(check);

      const cardHeader=node('div',undefined,'apps-card-header');
      const icon=appIcon(app);
      const info=node('div',undefined,'apps-info');
      const title=node('h2',app.name);title.title=app.name;info.append(title);
      if(app.description&&app.description!==app.name)info.append(node('p',app.description,'apps-description'));
      const pubText=[cleanPublisher(app.publisher)||'Publisher unavailable',app.version].filter(Boolean).join(' · ');
      const pubEl=node('p',pubText,'apps-publisher');pubEl.title=pubText;info.append(pubEl);
      cardHeader.append(icon,info);

      const cardMeta=node('div',undefined,'apps-card-meta');
      const cat=node('span',categories[category(app)],'apps-category');
      const size=node('strong',sizeLabel(app.sizeKB,app.sizeEstimated),'apps-size');
      size.title=app.sizeKB==null?'Windows does not report an installed size':app.sizeEstimated?'Estimated size calculated from application files':'Installed size reported by Windows';
      cardMeta.append(cat,size);

      const actionsWrap=node('div',undefined,'apps-row-actions');
      if(app.uninstallCapable){
        const uninstallBtn=node('button','Uninstall','apps-row-action apps-uninstall-btn');
        uninstallBtn.type='button';
        uninstallBtn.disabled=operationBusy;
        uninstallBtn.title='Uninstall '+app.name;
        uninstallBtn.addEventListener('click',e=>{e.stopPropagation();openReview([app.id],false);});
        actionsWrap.append(uninstallBtn);
      }else{
        const detailsBtn=node('button','Details','apps-row-action apps-details-btn');
        detailsBtn.type='button';
        detailsBtn.disabled=operationBusy;
        detailsBtn.title='Manual removal required in Windows · View details';
        detailsBtn.addEventListener('click',e=>{e.stopPropagation();openReview([app.id],false);});
        actionsWrap.append(detailsBtn);
      }
      row.append(selectArea,cardHeader,cardMeta,actionsWrap);

      row.addEventListener('click',e=>{
        if((selectionMode||selected.size>0)&&!e.target.closest('button, a, input, select')){
          check.checked=!check.checked;
          check.checked?selected.add(app.id):selected.delete(app.id);
          row.classList.toggle('is-selected',check.checked);
          selection();
        }
      });
      list.append(row);
    }
    if(!shown.length){const query=get('appsSearch').value.trim();list.append(node('p',loading?'Loading applications…':apps.length?query?'No apps match “'+query+'”.':'No apps match this category.':'No applications found.','apps-empty'));}list.scrollTop=scroll;selection();
  }
  function selection(){
    const selectedApps=[...selected].map(id=>apps.find(app=>app.id===id)).filter(Boolean);
    const visibleIds=new Set(visibleApps().map(app=>app.id));
    const hidden=[...selected].filter(id=>!visibleIds.has(id)).length;
    const tray=get('appsSelectionBar');
    const page=get('appsPage');
    const hasSelection=selected.size>0;
    const isInstalledActive=Boolean(page && !page.hidden && activeTab==='installed');
    const showTray=Boolean(isInstalledActive && hasSelection);

    if(tray)tray.hidden=!showTray;
    if(page){
      page.classList.toggle('has-selection-tray',showTray);
      page.classList.toggle('is-selecting',selectionMode||hasSelection);
    }
    const modeBtn=get('appsSelectModeBtn');
    if(modeBtn)modeBtn.textContent=(selectionMode||hasSelection)?'Cancel':'Select apps';

    if(!showTray&&trayExpanded){
      setTrayExpanded(false);
    }

    let totalKB=0,unknownCount=0,hasEstimated=false,knownCount=0;
    for(const a of selectedApps){
      if(Number.isFinite(a.sizeKB)&&a.sizeKB>=0){
        totalKB+=a.sizeKB;
        knownCount++;
        if(a.sizeEstimated)hasEstimated=true;
      }else unknownCount++;
    }

    const countEl=get('appsSelectedCount');
    if(countEl)countEl.textContent=selected.size+' selected';

    const sizeEl=get('appsSelectedSize');
    if(sizeEl){
      if(selected.size>0){
        if(knownCount>0){
          const formatted=sizeLabel(totalKB,hasEstimated||unknownCount>0);
          sizeEl.textContent=` · ${formatted}${unknownCount>0?' known':''}`;
        }else{
          sizeEl.textContent=' · size unknown';
        }
      }else{
        sizeEl.textContent='';
      }
    }

    const previewEl=get('appsSelectedPreview');
    if(previewEl){
      previewEl.textContent=formatSelectedPreview(selectedApps);
    }

    const hiddenEl=get('appsHiddenSelection');
    if(hiddenEl){
      hiddenEl.textContent=hidden?`${hidden} hidden by your search or filter`:'';
    }

    const badgeEl=get('appsTrayExpandedBadge');
    if(badgeEl)badgeEl.textContent=String(selected.size);

    const knownSizeEl=get('appsTrayKnownSize');
    if(knownSizeEl){
      if(knownCount>0){
        knownSizeEl.textContent=`Known size: ${sizeLabel(totalKB,hasEstimated||unknownCount>0)}`;
      }else if(selected.size>0){
        knownSizeEl.textContent='Known size: unknown';
      }else{
        knownSizeEl.textContent='';
      }
    }

    const unknownSizeEl=get('appsTrayUnknownSize');
    if(unknownSizeEl){
      unknownSizeEl.textContent=unknownCount>0?`${unknownCount} size${unknownCount===1?'':'s'} unknown`:'';
    }

    const batchBtn=get('appsBatchUninstall');
    if(batchBtn)batchBtn.disabled=!selected.size||operationBusy;
    const clearBtn=get('appsClearSelection');
    if(clearBtn)clearBtn.disabled=operationBusy;
    const expClearBtn=get('appsTrayExpandedClear');
    if(expClearBtn)expClearBtn.disabled=operationBusy;
    const expReviewBtn=get('appsTrayExpandedReview');
    if(expReviewBtn)expReviewBtn.disabled=!selected.size||operationBusy;
    const refreshBtn=get('appsRefresh');
    if(refreshBtn)refreshBtn.disabled=loading||operationBusy;

    if(trayExpanded)renderExpandedTrayList();
  }
  async function readStatus(){try{const r=await fetch('/api/apps/status',{credentials:'same-origin',cache:'no-store'});if(r.status===401){(window.redirectToLogin||(()=>window.location.replace('/')))('apps-read-status-401');return;}if(r.ok)showProgress(await r.json());}catch(_){status.textContent='Progress unavailable. Check the PC before retrying.';}}
  async function refresh(force=false){
    if(loading)return;loading=true;selection();status.textContent='Reading installed applications…';
    try{
      const r=await fetch('/api/apps'+(force?'?refresh=1':''),{credentials:'same-origin',cache:'no-store'});
      if(r.status===401){(window.redirectToLogin||(()=>window.location.replace('/')))('apps-refresh-401');return;}
      const data=await r.json();if(!r.ok)throw Error(data.error||'Inventory unavailable.');
      apps=data.apps;
      for(const id of selected)if(!apps.some(app=>app.id===id))selected.delete(id);
      status.textContent=`${apps.length} applications · loaded ${new Date(data.sampledAt).toLocaleTimeString()}${data.packagesAvailable?'':' · Store inventory unavailable'}`;
    }catch(e){status.textContent=e.message;}
    finally{loading=false;filters();render();if(review)renderReview();refreshQuickLaunch();}
  }
  function reviewRecords(){return review?review.ids.map(id=>apps.find(app=>app.id===id)).filter(Boolean):[];}
  function canRemove(){const records=reviewRecords();return !!review&&records.length===review.ids.length&&records.length>0&&records.length<=20&&records.every(app=>app.uninstallCapable&&(!review.batch||app.batchCapable));}
  function renderReview(){if(!review)return;const records=reviewRecords(),changed=records.length!==review.ids.length;get('appsConfirmList').replaceChildren();for(const app of records){const li=node('li'),info=node('div');info.append(node('strong',app.name),node('small',[cleanPublisher(app.publisher)||'Publisher unavailable',app.version,categories[category(app)],sizeLabel(app.sizeKB,app.sizeEstimated)].filter(Boolean).join(' · ')),node('small',removal(app)+(app.elevationLikely?' · UAC may be required':''),'apps-removal-support'));li.append(appIcon(app),info);
      const advanced=node('details');advanced.append(node('summary','Advanced details'),node('small','Installer technology: '+({msi:'MSI',appx:'Store package',exe:'Registered uninstaller',manual:'Unsupported / manual'})[app.type]));if(app.identifier)advanced.append(node('small','Identifier: '+app.identifier));info.append(advanced);
      if(review.batch&&!app.batchCapable&&app.uninstallCapable){const individual=node('button','Review individually','processes-freeze');individual.type='button';individual.addEventListener('click',()=>{review={ids:[app.id],batch:false};pin.value='';renderReview();});info.append(individual);}
      if(review.batch){const remove=node('button','Exclude','apps-review-remove');remove.type='button';remove.setAttribute('aria-label','Remove '+app.name+' from review');remove.addEventListener('click',()=>{selected.delete(app.id);review.ids=review.ids.filter(id=>id!==app.id);pin.value='';render();renderReview();});li.append(remove);}get('appsConfirmList').append(li);
    }
    get('appsConfirmTitle').textContent=review.batch?'Remove '+records.length+' application'+(records.length===1?'?':'s?'):records.length?'Review '+records[0].name:'Nothing selected';const limited=records.filter(app=>!app.uninstallCapable||!app.batchCapable);get('appsReviewLimitations').textContent=changed?'The reviewed inventory changed. Cancel and review your current selection again; nothing will be removed.':records.length>20?'Review up to 20 applications at a time.':review.batch&&limited.length?limited.length+' need individual or manual removal. Remove them from this batch or review an eligible app individually; nothing will be silently skipped.':!records.length?'Select an application before removing.':!canRemove()?'This application requires manual removal in Windows.':'Your PIN confirms this complete selection. Windows may request UAC approval on the PC.';get('appsConfirmSubmit').disabled=!canRemove()||operationBusy;pin.disabled=!canRemove();get('appsConfirmSubmit').textContent=review.batch?'Confirm removal':'Confirm uninstall';
  }
  function openReview(ids,batch){if(operationBusy)return;if(ids.some(id=>!apps.some(app=>app.id===id)))return;review={ids:[...ids],batch};pin.value='';get('appsConfirmError').textContent='';renderReview();if(!dialog.open)dialog.showModal();if(canRemove())pin.focus();}
  function showProgress(data){const wasBusy=operationBusy;operationBusy=data.busy||data.blocked;get('appsProgress').hidden=!data.job;if(data.job){get('appsProgressRows').replaceChildren();for(const item of data.job.items)get('appsProgressRows').append(node('li',`${item.name}: ${item.state.replaceAll('-',' ')}${item.code?' · '+item.code.replaceAll('-',' '):''}`));if(!data.busy)status.textContent=data.blocked?'An uninstaller may still be running. Complete it on the PC before restarting Rovarin.':data.job.state==='completed'?'Uninstall queue completed. Reboot may be required.':'Uninstall queue finished with failures or skipped apps. Review the results.';}
    selection();render();if(wasBusy&&!operationBusy){refresh(true);}}
  form.addEventListener('submit',async event=>{event.preventDefault();if(!canRemove()||operationBusy||!/^(?:\d{6}|\d{12})$/.test(pin.value))return;get('appsConfirmSubmit').disabled=true;get('appsConfirmError').textContent='Checking the reviewed selection…';const body=JSON.stringify({...review,pin:pin.value,confirmation:'uninstall-apps'});pin.value='';try{const r=await fetch('/api/apps/uninstall',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body});const data=await r.json();if(r.status!==202)throw Error(data.error||'Uninstall not accepted.');operationBusy=true;dialog.close();status.textContent='Uninstall started. Windows may need attention on the PC.';render();await readStatus();}catch(e){get('appsConfirmError').textContent=e.message;}finally{get('appsConfirmSubmit').disabled=!canRemove()||operationBusy;pin.value='';}});
  dialog.addEventListener('close',()=>{pin.value='';review=null;});get('appsConfirmCancel').addEventListener('click',()=>dialog.close());get('appsRefresh').addEventListener('click',()=>refresh(true));get('appsProgressRefresh').addEventListener('click',readStatus);get('appsBatchUninstall').addEventListener('click',()=>{setTrayExpanded(false);openReview([...selected],true);});get('appsClearSelection').addEventListener('click',()=>{selected.clear();setTrayExpanded(false);render();});get('appsSearch').addEventListener('input',render);get('appsType').addEventListener('change',render);get('appsSort').addEventListener('change',()=>{sortDirection=get('appsSort').value==='size'?-1:1;get('appsSortDirection').textContent=sortDirection===1?'↑':'↓';render();});get('appsSortDirection').addEventListener('click',()=>{sortDirection*=-1;get('appsSortDirection').textContent=sortDirection===1?'↑':'↓';render();});get('appsShowSystem')?.addEventListener('change',()=>{filters();render();});
  get('appsTraySummaryBtn')?.addEventListener('click',()=>setTrayExpanded(!trayExpanded));
  get('appsTrayCollapseBtn')?.addEventListener('click',()=>setTrayExpanded(false));
  get('appsTrayExpandedClear')?.addEventListener('click',()=>{selected.clear();setTrayExpanded(false);render();});
  get('appsTrayExpandedReview')?.addEventListener('click',()=>{setTrayExpanded(false);openReview([...selected],true);});
  window.addEventListener('keydown',e=>{if(e.key==='Escape'&&trayExpanded){setTrayExpanded(false);}});
  document.addEventListener('click',e=>{if(trayExpanded&&!e.target.closest('#appsSelectionBar')){setTrayExpanded(false);}});
  get('quickLaunchAddBtn').addEventListener('click',openQuickLaunchPicker);
  get('qlPickerClose').addEventListener('click',()=>qlDialog.close());
  get('qlPickerDone').addEventListener('click',()=>qlDialog.close());
  get('qlPickerSearch').addEventListener('input',renderQuickLaunchPicker);
  get('appsSelectModeBtn').addEventListener('click',()=>setSelectionMode(!selectionMode));
  get('appsDoneSelection').addEventListener('click',()=>setSelectionMode(false));

  /* Startup Apps Implementation */
  function visibleStartupApps(){
    const search=get('startupSearch').value.trim().toLocaleLowerCase();
    const scope=get('startupScope').value;
    const statusVal=get('startupStatusFilter').value;
    return startupApps.filter(item=>{
      if(scope&&item.scope!==scope)return false;
      if(statusVal==='enabled'&&!item.enabled)return false;
      if(statusVal==='disabled'&&item.enabled)return false;
      if(search&&![item.name,item.displayName,item.publisher].join(' ').toLocaleLowerCase().includes(search))return false;
      return true;
    });
  }
  function renderStartup(){
    const shown=visibleStartupApps();
    shown.sort((a,b)=>compareAppNames(a.displayName||a.name,b.displayName||b.name));
    startupList.replaceChildren();
    if(!shown.length){
      const query=get('startupSearch').value.trim();
      startupList.append(node('p',startupLoading?'Loading startup applications…':startupApps.length?query?'No startup apps match “'+query+'”.':'No apps match this filter.':'No startup applications found.','apps-empty'));
      return;
    }
    for(const item of shown){
      const row=node('article',undefined,'startup-row');
      const icon=startupIcon(item);
      const info=node('div',undefined,'startup-info');
      info.append(node('h2',item.displayName||item.name));
      const sub=[item.publisher||'',item.name!==item.displayName?item.name:''].filter(Boolean).join(' · ');
      if(sub)info.append(node('p',sub));
      const badges=node('div',undefined,'startup-badges');
      badges.append(
        node('span',item.scope==='user'?'Current User':'All Users (System)','startup-scope-badge startup-scope-'+item.scope),
        node('span',item.enabled?'Enabled':'Disabled','startup-status-badge startup-status-'+(item.enabled?'enabled':'disabled'))
      );
      const toggle=node('button',item.readOnly?'Admin required':item.enabled?'Disable':'Enable','startup-toggle-btn');
      toggle.type='button';
      toggle.disabled=operationBusy||item.readOnly;
      toggle.title=item.readOnly?'All Users startup entries require administrator permissions to change':(item.enabled?'Disable ':'Enable ')+(item.displayName||item.name);
      toggle.addEventListener('click',()=>openStartupConfirm(item));
      row.append(icon,info,badges,toggle);
      startupList.append(row);
    }
  }
  async function refreshStartup(force=false){
    if(startupLoading)return;
    startupLoading=true;
    startupStatus.textContent='Reading startup applications…';
    try {
      const r=await fetch('/api/apps/startup'+(force?'?refresh=1':''),{credentials:'same-origin',cache:'no-store'});
      if(r.status===401){(window.redirectToLogin||(()=>window.location.replace('/')))('apps-startup-401');return;}
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'Startup inventory unavailable.');
      startupApps=data.items;
      startupStatus.textContent=`${startupApps.length} startup applications · loaded ${new Date(data.sampledAt).toLocaleTimeString()}`;
    }catch(e){startupStatus.textContent=e.message;}
    finally{startupLoading=false;renderStartup();}
  }
  function openStartupConfirm(item){
    if(item.readOnly||operationBusy)return;
    startupTarget=item;
    get('startupConfirmTitle').textContent=(item.enabled?'Disable ':'Enable ')+(item.displayName||item.name);
    get('startupConfirmDetails').replaceChildren(
      node('p',`Application: ${item.displayName||item.name}`),
      node('p',`Scope: ${item.scope==='user'?'Current User':'All Users'}`),
      node('p',`Action: ${item.enabled?'Disable from starting with Windows':'Enable to start with Windows'}`)
    );
    get('startupConfirmError').textContent='';
    if(!startupDialog.open)startupDialog.showModal();
  }
  startupForm.addEventListener('submit',async e=>{
    e.preventDefault();
    if(!startupTarget||operationBusy)return;
    const target=startupTarget;
    const nextEnabled=!target.enabled;
    get('startupConfirmSubmit').disabled=true;
    get('startupConfirmError').textContent='Applying changes…';
    try {
      const r=await fetch('/api/apps/startup/toggle',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:target.id,enabled:nextEnabled})});
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'Failed to update startup configuration.');
      startupDialog.close();
      target.enabled=nextEnabled;
      renderStartup();
    }catch(err){get('startupConfirmError').textContent=err.message;}
    finally{get('startupConfirmSubmit').disabled=false;}
  });
  get('startupConfirmCancel').addEventListener('click',()=>startupDialog.close());
  startupDialog.addEventListener('close',()=>{startupTarget=null;});
  get('startupRefresh').addEventListener('click',()=>refreshStartup(true));
  get('startupSearch').addEventListener('input',renderStartup);
  get('startupScope').addEventListener('change',renderStartup);
  get('startupStatusFilter').addEventListener('change',renderStartup);

  window.addEventListener('pc-monitor-pagechange',event=>{
    selection();
    if(event.detail.page==='appsPage'){
      refresh();
      readStatus();
      refreshQuickLaunch();
      if(activeTab==='startup')refreshStartup();
    }
  });
  window.addEventListener('rovarin-apps-operation',event=>showProgress(event.detail));
  window.addEventListener('pc-monitor-stream-state',event=>{if(event.detail.connected&&!get('appsPage').hidden){readStatus();refreshQuickLaunch();if(activeTab==='startup')refreshStartup();}});
})();
