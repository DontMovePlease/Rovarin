'use strict';
(() => {
  const get=id=>document.getElementById(id),list=get('appsList'),status=get('appsStatus'),dialog=get('appsConfirmDialog'),form=get('appsConfirmForm'),pin=get('appsConfirmPin');
  let apps=[],loading=false,operationBusy=false,sortDirection=1,review=null,selectionMode=false,appsLoadError=false;
  const selected=new Set();
  const APPS_SESSION_CACHE_KEY='rovarin.cachedApps.v1';
  let appsFetchSeq=0;
  if(!document.documentElement?.classList?.contains('login-page')&&!document.body?.classList?.contains('login-page')){
    try{
      const raw=sessionStorage.getItem(APPS_SESSION_CACHE_KEY);
      if(raw){
        const parsed=JSON.parse(raw);
        if(Array.isArray(parsed.apps)&&parsed.apps.length>0){apps=parsed.apps;}
      }
    }catch(_){}
  }

  // Quick Launch state
  let quickLaunchData={pins:[],maxPins:12},qlStatusTimer=null;
  const qlRail=get('quickLaunchRail'),qlCount=get('quickLaunchCount'),qlStatus=get('quickLaunchStatus');
  const qlDialog=get('quickLaunchPickerDialog'),qlSearch=get('qlPickerSearch'),qlPickerList=get('qlPickerList'),qlPickerCount=get('qlPickerCount');

  // Startup Apps state
  let startupApps=[],startupLoading=false,startupTarget=null,activeTab='installed',startupLoadError=false;
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
    if(tab==='startup'&&(!lastStartupLoadedAt||Date.now()-lastStartupLoadedAt>APPS_STALE_MS))refreshStartup();
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
  let lastQlLoadedAt = 0;
  async function refreshQuickLaunch(){
    try {
      const r=await fetch('/api/apps/quick-launch',{credentials:'same-origin',cache:'no-store'});
      if(r.ok){
        quickLaunchData=await r.json();
        lastQlLoadedAt = Date.now();
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
  let qlEditMode=false;
  function setQlEditMode(enabled){
    qlEditMode=Boolean(enabled&&quickLaunchData.pins.length>0);
    qlRail.classList.toggle('is-editing',qlEditMode);
    for(const tile of qlRail.querySelectorAll('.quick-launch-tile')){
      tile.classList.toggle('is-wiggling',qlEditMode);
    }
  }
  document.addEventListener('pointerdown',e=>{
    if(qlEditMode&&!e.target.closest('#quickLaunchRail')){
      setQlEditMode(false);
    }
  });
  window.addEventListener('keydown',e=>{
    if(e.key==='Escape'&&qlEditMode){
      setQlEditMode(false);
    }
  });
  window.addEventListener('scroll',()=>{
    if(qlEditMode)setQlEditMode(false);
  },{passive:true});

  function renderQuickLaunch(){
    qlCount.textContent=`${quickLaunchData.pins.length} / ${quickLaunchData.maxPins||12} pinned`;
    qlRail.replaceChildren();
    if(!quickLaunchData.pins.length){
      setQlEditMode(false);
      const emptyCard=node('div',undefined,'quick-launch-empty-card');
      emptyCard.append(node('p','No apps pinned yet. Tap “+ Add apps” to pin applications for fast remote launching.','quick-launch-empty-text'));
      const addBtn=node('button','+ Add apps','quick-launch-add-btn');
      addBtn.type='button';
      addBtn.addEventListener('click',openQuickLaunchPicker);
      emptyCard.append(addBtn);
      qlRail.append(emptyCard);
      return;
    }
    qlRail.classList.toggle('is-editing',qlEditMode);
    for(const pin of quickLaunchData.pins){
      const tile=node('div',undefined,'quick-launch-tile'+(pin.available?'':' is-missing')+(qlEditMode?' is-wiggling':''));
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
      unpinBtn.addEventListener('click',e=>{
        e.stopPropagation();
        e.preventDefault();
        unpinApp({id:pin.id,locator:pin.locator});
      });
      tile.append(unpinBtn);

      let longPressTimer=null;
      let longPressTriggered=false;
      let touchStartX=0;
      let touchStartY=0;

      const cancelLongPress=()=>{
        if(longPressTimer){
          clearTimeout(longPressTimer);
          longPressTimer=null;
        }
      };

      tile.addEventListener('pointerdown',e=>{
        if(e.pointerType==='mouse'&&e.button!==0)return;
        if(qlEditMode)return;
        longPressTriggered=false;
        touchStartX=e.clientX;
        touchStartY=e.clientY;
        cancelLongPress();
        longPressTimer=setTimeout(()=>{
          longPressTriggered=true;
          setQlEditMode(true);
          if(navigator.vibrate){
            try{navigator.vibrate(40);}catch(_){}
          }
        },450);
      });

      tile.addEventListener('pointermove',e=>{
        if(!longPressTimer)return;
        const dx=e.clientX-touchStartX;
        const dy=e.clientY-touchStartY;
        if(Math.hypot(dx,dy)>8){
          cancelLongPress();
        }
      });

      tile.addEventListener('pointerup',cancelLongPress);
      tile.addEventListener('pointercancel',cancelLongPress);

      tile.addEventListener('click',e=>{
        if(longPressTriggered){
          longPressTriggered=false;
          e.preventDefault();
          e.stopPropagation();
          return;
        }
        if(qlEditMode){
          e.preventDefault();
          e.stopPropagation();
          setQlEditMode(false);
          return;
        }
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
  const appRowCache=new Map();
  function createAppRow(app){
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
      const detailsBtn=node('button',app.category==='system'?'System info':'Removal options','apps-row-action apps-details-btn');
      detailsBtn.type='button';
      detailsBtn.disabled=operationBusy;
      detailsBtn.title='Why '+app.name+' cannot be removed here and how to manage it in Windows';
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
    return row;
  }
  function getAppRow(app){
    let row=appRowCache.get(app.id);
    if(!row){
      row=createAppRow(app);
      appRowCache.set(app.id,row);
    }else{
      const isSel=selected.has(app.id);
      if(row.classList.contains('is-selected')!==isSel)row.classList.toggle('is-selected',isSel);
      const check=row.querySelector('input[type="checkbox"]');
      if(check){
        if(check.checked!==isSel)check.checked=isSel;
        check.disabled=operationBusy;
      }
    }
    return row;
  }
  function setSelectionMode(enabled){
    selectionMode=Boolean(enabled);
    if(!selectionMode)selected.clear();
    setTrayExpanded(false);
    for(const r of appRowCache.values()){
      const isSel=selected.has(r.dataset.appId);
      r.classList.toggle('is-selected',isSel);
      const c=r.querySelector('input[type="checkbox"]');
      if(c)c.checked=isSel;
    }
    selection();
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
    const scroll=list.scrollTop;
    if(!shown.length){
      list.replaceChildren();
      const query=get('appsSearch').value.trim();
      list.append(node('p',loading?'Loading applications…':appsLoadError?'Application inventory unavailable. Try Refresh.':apps.length?query?'No apps match “'+query+'”.':'No apps match this category.':'No applications found.','apps-empty'));
      list.scrollTop=scroll;
      selection();
      return;
    }
    const fragment=document.createDocumentFragment();
    const initialBatch=shown.slice(0,40);
    for(const app of initialBatch)fragment.append(getAppRow(app));
    list.replaceChildren(fragment);
    if(shown.length>40){
      const remaining=shown.slice(40);
      requestAnimationFrame(()=>{
        if(!list)return;
        const remainingFrag=document.createDocumentFragment();
        for(const app of remaining)remainingFrag.append(getAppRow(app));
        list.append(remainingFrag);
      });
    }
    list.scrollTop=scroll;
    selection();
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
  let progressPollTimer=null, progressTracking=false;
  let progressEpoch=null, progressRevision=-1, currentProgressJob=null, dismissedProgressJob=null;
  const terminalProgressJobs=new Set();
  function startProgressTracking(){
    progressTracking=true;
    // Bounded request rate and only while a known job is active. Never overlap requests.
    if(!progressPollTimer)progressPollTimer=setTimeout(async()=>{
      progressPollTimer=null;await readStatus();
      if(progressTracking)startProgressTracking();
    },2500);
  }
  function stopProgressTracking(){
    progressTracking=false;
    if(progressPollTimer){clearTimeout(progressPollTimer);progressPollTimer=null;}
  }
  let progressRequestPending=false;

  async function readStatus(check=false){
    if(progressRequestPending)return;progressRequestPending=true;
    try{
      const r=await fetch('/api/apps/status'+(check===true?'?check=1':''),{credentials:'same-origin',cache:'no-store'});
      if(r.status===401){(window.redirectToLogin||(()=>window.location.replace('/')))('apps-read-status-401');return;}
      if(!r.ok)throw Error('Progress unavailable');showProgress(await r.json());
    }catch(_){get('appsProgressSubtext').textContent='Progress unavailable. Check the PC or refresh progress.';}
    finally{progressRequestPending=false;}
  }
  let lastAppsLoadedAt = 0;
  const APPS_STALE_MS = 300000;
  async function refresh(force=false, silent=false){
    if(loading)return;loading=true;
    const fetchSeq = ++appsFetchSeq;
    selection();list.setAttribute('aria-busy','true');
    if(!silent){status.textContent=apps.length?'Refreshing installed applications…':'Reading installed applications…';if(!apps.length)render();}
    try{
      const r=await fetch('/api/apps'+(force?'?refresh=1':''),{credentials:'same-origin',cache:'no-store'});
      if(r.status===401){(window.redirectToLogin||(()=>window.location.replace('/')))('apps-refresh-401');return;}
      const data=await r.json();if(!r.ok)throw Error(data.error||'Inventory unavailable.');
      if(fetchSeq!==appsFetchSeq)return;
      lastAppsLoadedAt = Number.isFinite(data.sampledAt)?data.sampledAt:Date.now();
      appsLoadError=false;
      apps=data.apps;
      try{sessionStorage.setItem(APPS_SESSION_CACHE_KEY,JSON.stringify({apps,sampledAt:data.sampledAt}));}catch(_){}
      for(const cachedRow of appRowCache.values())for(const image of cachedRow.querySelectorAll('img'))iconObserver?.unobserve(image);
      appRowCache.clear();
      const validIds = new Set(apps.map(a => a.id));
      for (const id of appRowCache.keys()) {
        if (!validIds.has(id)) appRowCache.delete(id);
      }
      for(const id of selected)if(!apps.some(app=>app.id===id))selected.delete(id);
      status.textContent=`${apps.length} applications · loaded ${new Date(data.sampledAt).toLocaleTimeString()}${data.packagesAvailable?'':' · Store inventory unavailable'}`;
    }catch(e){
      if(fetchSeq!==appsFetchSeq)return;
      appsLoadError=true;
      status.textContent=(apps.length?'Refresh failed; showing the previous inventory. ':'')+e.message;
    }
    finally{
      if(fetchSeq===appsFetchSeq){
        loading=false;list.setAttribute('aria-busy','false');filters();render();if(review)renderReview();
      }
    }
  }
  function reviewRecords(){return review?review.ids.map(id=>apps.find(app=>app.id===id)).filter(Boolean):[];}
  function canRemove(){const records=reviewRecords();return !!review&&records.length===review.ids.length&&records.length>0&&records.length<=20&&records.every(app=>app.uninstallCapable&&(!review.batch||app.batchCapable));}
  function renderReview(){
    if(!review)return;const records=reviewRecords(),changed=records.length!==review.ids.length;
    get('appsConfirmList').replaceChildren();
    for(const app of records){
      const li=node('li'),info=node('div');
      const isSilent=Boolean(app.batchCapable);
      const isInteractive=Boolean(!app.batchCapable&&app.type==='exe');
      const needsUac=Boolean(app.elevationLikely);

      info.append(
        node('strong',app.name),
        node('small',[cleanPublisher(app.publisher)||'Publisher unavailable',app.version,categories[category(app)],sizeLabel(app.sizeKB,app.sizeEstimated)].filter(Boolean).join(' · ')),
        node('small',removal(app)+(app.elevationLikely?' · UAC may be required':''),'apps-removal-support')
      );

      if(!app.uninstallCapable){
        info.append(node('div','ℹ️ Cannot be removed automatically. If supported, remove this component through Windows Settings → Apps on your PC.','apps-removal-notice apps-notice-manual'));
      }else if(isInteractive){
        info.append(node('div','🖥️ Action required on PC: This uninstaller has an interactive setup window that will open on your PC screen. Please complete it on the computer.','apps-removal-notice apps-notice-interactive'));
      }else if(isSilent){
        info.append(node('div','⚡ Silent background removal: This application will uninstall automatically without opening setup windows.','apps-removal-notice apps-notice-silent'));
      }
      if(needsUac&&app.uninstallCapable){
        info.append(node('div','🛡️ Administrator approval: Windows will display a permission prompt (UAC) on your PC screen.','apps-removal-notice apps-notice-uac'));
      }

      li.append(appIcon(app),info);
      const advanced=node('details');
      advanced.append(node('summary','Advanced details'),node('small','Installer technology: '+({msi:'Windows Installer (MSI) — Silent unattended removal',appx:'Microsoft Store package — Clean user removal',exe:isSilent?'Desktop program uninstaller — Quiet mode supported':'Desktop program uninstaller — Interactive wizard',manual:'Unsupported / manual removal'})[app.type]));
      if(app.identifier)advanced.append(node('small','Identifier: '+app.identifier));
      info.append(advanced);

      if(review.batch&&!app.batchCapable&&app.uninstallCapable){
        const individual=node('button','Review individually','processes-freeze');
        individual.type='button';
        individual.addEventListener('click',()=>{review={ids:[app.id],batch:false};pin.value='';renderReview();});
        info.append(individual);
      }
      if(review.batch){
        const remove=node('button','Exclude','apps-review-remove');
        remove.type='button';
        remove.setAttribute('aria-label','Remove '+app.name+' from review');
        remove.addEventListener('click',()=>{selected.delete(app.id);review.ids=review.ids.filter(id=>id!==app.id);pin.value='';render();renderReview();});
        li.append(remove);
      }
      get('appsConfirmList').append(li);
    }
    get('appsConfirmTitle').textContent=review.batch?'Remove '+records.length+' application'+(records.length===1?'?':'s?'):records.length?'Review '+records[0].name:'Nothing selected';
    const limited=records.filter(app=>!app.uninstallCapable||!app.batchCapable);
    const hasInteractive=records.some(app=>!app.batchCapable&&app.type==='exe');
    const hasElevation=records.some(app=>app.elevationLikely);

    get('appsReviewLimitations').textContent=changed?'The reviewed inventory changed. Cancel and review your current selection again; nothing will be removed.':records.length>20?'Review up to 20 applications at a time.':review.batch&&limited.length?limited.length+' need individual or manual removal. Remove them from this batch or review an eligible app individually; nothing will be silently skipped.':!records.length?'Select an application before removing.':!canRemove()?'Rovarin cannot safely remove this entry. On the PC, open Windows Settings → Apps → Installed apps and search for its name. Windows system components may not support removal.':(window.RovarinRemovalSecurity.requirePin?'Your PIN confirms this complete selection. ':'Confirm this complete selection. ')+'Windows may request UAC approval on the PC.'+(hasInteractive?' An uninstaller window will open on your PC desktop.':'');
    get('appsConfirmSubmit').disabled=!canRemove()||operationBusy;
    pin.disabled=!canRemove()||!window.RovarinRemovalSecurity.requirePin;
    get('appsConfirmSubmit').textContent=review.batch?'Confirm removal':'Confirm uninstall';
  }
  async function openReview(ids,batch){if(operationBusy)return;try{await window.RovarinRemovalSecurity.refresh();}catch(_){status.textContent="Removal security unavailable. Try again.";return;}if(ids.some(id=>!apps.some(app=>app.id===id)))return;review={ids:[...ids],batch};pin.value='';get('appsConfirmError').textContent='';renderReview();if(!dialog.open)dialog.showModal();if(canRemove())(window.RovarinRemovalSecurity.requirePin?pin:get('appsConfirmSubmit')).focus();}
  function showProgress(data){
    if(!data||typeof data!=='object')return;
    if(data.epoch&&progressEpoch!==data.epoch){progressEpoch=data.epoch;progressRevision=-1;terminalProgressJobs.clear();dismissedProgressJob=null;}
    if(Number.isFinite(data.revision)){if(data.revision<progressRevision)return;progressRevision=data.revision;}
    const active=Boolean(data.job?.state==='running');
    if(active&&terminalProgressJobs.has(data.job.id))return;
    const newlyFinished=Boolean(data.job&&!active&&!terminalProgressJobs.has(data.job.id));
    if(newlyFinished){terminalProgressJobs.add(data.job.id);if(terminalProgressJobs.size>64)terminalProgressJobs.delete(terminalProgressJobs.values().next().value);}
    currentProgressJob=data.job?.id||null;
    const wasBusy=operationBusy;
    operationBusy=Boolean(data.busy||data.blocked);
    window.RovarinLeftovers?.update(data.leftovers,operationBusy);
    if(data.leftovers?.busy){startProgressTracking();selection();render();return;}
    const progressEl=get('appsProgress');
    const dismissBtn=get('appsProgressDismiss');
    const subtextEl=get('appsProgressSubtext');
    const titleEl=get('appsProgressTitle');
    const rowsEl=get('appsProgressRows');

    if(!data.job){
      if(progressEl)progressEl.hidden=true;
      stopProgressTracking();
    }else{
      if(progressEl)progressEl.hidden=dismissedProgressJob===data.job.id;
      if(active){
        startProgressTracking();
      }else{
        stopProgressTracking();
      }
      if(titleEl){
        if(active){
          titleEl.textContent=data.job.batch?`Uninstalling ${data.job.items.length} applications…`:`Uninstalling ${data.job.items[0]?.name||'application'}…`;
        }else{
          titleEl.textContent=data.job.state==='unconfirmed'?'Uninstall outcome unconfirmed':data.job.state==='completed'?'Uninstall complete':data.job.state==='failed'?'Uninstall failed':'Uninstall finished with issues';
        }
      }
      if(dismissBtn)dismissBtn.hidden=active;
      get('appsProgressRefresh').textContent=active?'Refresh progress':'Check again';
      const bar=get('appsProgressBar');
      const stage={preparing:'Preparing uninstall',removing:'Removing application','waiting-windows':'Waiting for Windows',verifying:'Verifying removal',completed:'Completed',failed:'Failed',partial:'Finished with issues',unconfirmed:'Outcome unconfirmed'}[data.job.stage||data.job.state]||'Removing application';
      get('appsProgressStage').textContent=stage;
      bar.dataset.state=active?'active':data.job.state;
      bar.setAttribute('aria-valuetext',stage);
      // Current Windows handlers supply stages, not trustworthy numeric progress.
      bar.removeAttribute('aria-valuenow');
      if(subtextEl){
        if(active){
          const activeItem=data.job.items.find(x=>x.state==='uninstalling')||data.job.items[0];
          const activeApp=apps.find(a=>a.id===activeItem?.id);
          if(data.job.stage==='verifying'){
            subtextEl.textContent='Checking Windows installed-app records before reporting the result.';
          }else if(data.job.stage==='preparing'){
            subtextEl.textContent='Preparing the reviewed application for removal.';
          }else if(data.job.stage==='waiting-windows'||(activeApp&&!activeApp.batchCapable&&activeApp.type==='exe')){
            subtextEl.textContent='🖥️ Interactive uninstaller active: Please complete the setup window on your PC screen.';
          }else if(activeApp&&activeApp.elevationLikely){
            subtextEl.textContent='🛡️ Administrator permission: Check your PC screen for a Windows UAC approval prompt.';
          }else{
            subtextEl.textContent='Removing in the background. Windows may require a moment to finish cleanup.';
          }
        }else{
          if(data.job.state==='completed'){
            const hasReboot=data.job.items.some(x=>x.state==='reboot-required');
            subtextEl.textContent=hasReboot?'Windows reported removal complete; restart the PC to finish pending changes.':'Selected applications removed successfully.';
          }else if(data.blocked){
            subtextEl.textContent='Windows did not confirm removal. Check the PC for an open uninstaller, then use Check again to refresh installed apps. Check again will verify the registration and release the block when safe.';
          }else{
            subtextEl.textContent='One or more applications could not be removed. Review details below.';
          }
        }
      }
      if(rowsEl){
        rowsEl.replaceChildren();
        for(const item of data.job.items){
          const li=node('li');
          const badge=node('span',undefined,'apps-prog-badge');
          let label=item.state.replaceAll('-',' ');
          if(item.state==='completed'){
            badge.className='apps-prog-badge apps-prog-completed';
            badge.textContent='✓ Done';
            label='completed';
          }else if(item.state==='reboot-required'){
            badge.className='apps-prog-badge apps-prog-reboot';
            badge.textContent='⚠️ Reboot needed';
            label='completed · restart required';
          }else if(item.state==='uninstalling'){
            badge.className='apps-prog-badge apps-prog-running';
            badge.textContent='⏳ Working';
            label='uninstalling';
          }else if(item.state==='unconfirmed'){
            badge.className='apps-prog-badge apps-prog-reboot';badge.textContent='? Unconfirmed';label='removal could not be verified';
          }else if(item.state==='failed'){
            badge.className='apps-prog-badge apps-prog-failed';
            badge.textContent='✕ Failed';
            if(item.code==='cancelled')label='failed · cancelled on PC';
            else if(item.code==='still-running')label='failed · still running on PC';
            else if(item.code==='timed-out')label='outcome unconfirmed · Windows did not finish within the observation limit';
            else if(item.code==='removal-unconfirmed')label='failed · removal unconfirmed';
            else label='failed'+(item.code?' · '+({'user-mismatch':'Package belongs to a different Windows user','access-denied':'Windows denied access','removal-denied':'Windows refused package removal','package-in-use':'Close the application on the PC and retry','package-removal-failed':'Windows package removal failed','still-installed':'Still installed; no uninstall is running'}[item.code]||item.code.replaceAll('-',' ')):'')+(item.hresult?' ('+item.hresult+')':'');
          }else if(item.state==='queued'){
            badge.className='apps-prog-badge apps-prog-queued';
            badge.textContent='⋯ Queued';
            label='queued';
          }else if(item.state==='skipped'){
            badge.className='apps-prog-badge apps-prog-skipped';
            badge.textContent='— Skipped';
            label='skipped';
          }
          li.append(badge,node('strong',item.name),node('span',` · ${label}`));
          rowsEl.append(li);
        }
      }
      if(!data.busy){
        if(data.blocked){
          status.textContent='Uninstall outcome unconfirmed. Review the result below.';
        }else if(data.job.state==='completed'){
          const hasReboot=data.job.items.some(x=>x.state==='reboot-required');
          status.textContent=(data.job.items.length===1?`Successfully uninstalled ${data.job.items[0].name}.`:'Uninstall queue completed.')+(hasReboot?' Reboot may be required.':'');
        }else{
          status.textContent='Uninstall queue finished with failures or skipped apps. Review the results.';
        }
      }
    }
    selection();render();
    if(newlyFinished||(wasBusy&&!operationBusy)){
      try{sessionStorage.removeItem(APPS_SESSION_CACHE_KEY);}catch(_){}
      refresh(true);
    }
  }
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(!canRemove()||operationBusy||(window.RovarinRemovalSecurity.requirePin&&!/^(?:\d{6}|\d{12})$/.test(pin.value)))return;
    get('appsConfirmSubmit').disabled=true;get('appsConfirmError').textContent='Checking the reviewed selection…';
    const body=JSON.stringify({...review,...(window.RovarinRemovalSecurity.requirePin?{pin:pin.value}:{}),confirmation:'uninstall-apps'});pin.value='';
    try{
      const r=await fetch('/api/apps/uninstall',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body});
      const data=await r.json();if(r.status!==202){if(data.code==='pin-required'){await window.RovarinRemovalSecurity.refresh();renderReview();pin.focus();}throw Error(data.error||'Uninstall not accepted.');}
      operationBusy=true;dialog.close();status.textContent='Uninstall started. See progress below.';
      render();startProgressTracking();await readStatus();
    }catch(e){stopProgressTracking();get('appsConfirmError').textContent=e.message;}
    finally{get('appsConfirmSubmit').disabled=!canRemove()||operationBusy;pin.value='';}
  });
  dialog.addEventListener('close',()=>{pin.value='';review=null;});get('appsConfirmCancel').addEventListener('click',()=>dialog.close());get('appsRefresh').addEventListener('click',()=>{refresh(true);refreshQuickLaunch();});get('appsProgressRefresh').addEventListener('click',()=>{readStatus(true);refresh(true);});get('appsProgressDismiss')?.addEventListener('click',()=>{const p=get('appsProgress');if(p)p.hidden=true;dismissedProgressJob=currentProgressJob;stopProgressTracking();});get('appsBatchUninstall').addEventListener('click',()=>{setTrayExpanded(false);openReview([...selected],true);});get('appsClearSelection').addEventListener('click',()=>{selected.clear();setTrayExpanded(false);render();});get('appsSearch').addEventListener('input',render);get('appsType').addEventListener('change',render);get('appsSort').addEventListener('change',()=>{sortDirection=get('appsSort').value==='size'?-1:1;get('appsSortDirection').textContent=sortDirection===1?'↑':'↓';render();});get('appsSortDirection').addEventListener('click',()=>{sortDirection*=-1;get('appsSortDirection').textContent=sortDirection===1?'↑':'↓';render();});get('appsShowSystem')?.addEventListener('change',()=>{filters();render();});
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
      if(statusVal==='enabled'&&item.enabled!==true)return false;
      if(statusVal==='disabled'&&item.enabled!==false)return false;
      if(search&&![item.name,item.displayName,item.publisher,item.method,item.executable].filter(Boolean).join(' ').toLocaleLowerCase().includes(search))return false;
      return true;
    });
  }
  const startupSources={'registry-user':'Sign-in registry','registry-user32':'32-bit sign-in registry','registry-machine':'Sign-in registry','registry-machine32':'32-bit sign-in registry','folder-user':'Startup folder','folder-machine':'Startup folder','scheduled-task':'Scheduled task','packaged-startup':'Packaged app','app-service':'App background service'};
  function renderStartup(){
    const shown=visibleStartupApps();
    shown.sort((a,b)=>compareAppNames(a.displayName||a.name,b.displayName||b.name));
    startupList.replaceChildren();
    if(!shown.length){
      const query=get('startupSearch').value.trim();
      startupList.append(node('p',startupLoading?'Loading startup applications…':startupLoadError?'Startup inventory unavailable. Try Refresh.':startupApps.length?query?'No startup apps match “'+query+'”.':'No apps match this filter.':'No startup applications found.','apps-empty'));
      return;
    }
    const services=node('details',undefined,'startup-associated-services');
    const serviceCount=shown.filter(item=>item.source==='app-service').length;
    services.append(node('summary',`App background services (${serviceCount}) — read-only`));
    for(const item of shown){
      const row=node('article',undefined,'startup-row');
      const icon=startupIcon(item);
      const info=node('div',undefined,'startup-info');
      info.append(node('h2',item.displayName||item.name));
      const sub=[item.publisher||'',item.method||startupSources[item.source]||'Windows startup registration'].filter(Boolean).join(' · ');
      if(sub)info.append(node('p',sub));
      const details=node('details',undefined,'startup-entry-details');
      details.append(node('summary','Startup information'),node('p','Source: '+(startupSources[item.source]||'Windows registration')),node('p','Entry: '+item.name));
      if(item.executable)details.append(node('p','Executable: '+item.executable));
      if(item.source==='app-service')details.append(node('p','Now: '+(item.serviceState||'Unknown')),node('p','Next boot: '+(item.startupMode||'Unknown')));
      if(item.readOnly)info.append(node('p',item.blockedReason||(item.source==='scheduled-task'?'Cannot safely manage this task':item.source==='packaged-startup'?'Packaged startup state cannot safely be changed here.':item.source==='app-service'?'Service controls are not supported.':item.scope==='machine'?'All-users startup changes require administrator support.':item.enabled===null?'Windows startup state is unavailable.':'This startup file type is not supported.'),'startup-control-reason'));
      if(item.source==='packaged-startup')details.append(node('p','Manage this entry in Windows Settings → Apps → Startup.'));
      info.append(details);
      const badges=node('div',undefined,'startup-badges');
      badges.append(
        node('span',item.scope==='user'?'Current User':'All Users (System)','startup-scope-badge startup-scope-'+item.scope),
        node('span',item.source==='app-service'?(item.serviceState||'Unknown')+' · '+(item.startupMode||'Unknown'):item.enabled===null?'State unavailable':item.enabled?'Enabled':'Disabled','startup-status-badge startup-status-'+(item.enabled===null?'unknown':item.enabled?'enabled':'disabled'))
      );
      const toggle=node('button',item.readOnly?'View information':item.enabled?'Disable':'Enable','startup-toggle-btn');
      toggle.type='button';
      toggle.disabled=operationBusy;
      toggle.title=item.readOnly?'View startup source and Windows management guidance':(item.enabled?'Disable ':'Enable ')+(item.displayName||item.name);
      toggle.setAttribute('aria-label',(item.readOnly?'View startup information for ':(item.enabled?'Disable ':'Enable '))+(item.displayName||item.name));
      toggle.addEventListener('click',()=>{if(item.readOnly){details.open=!details.open;}else openStartupConfirm(item);});
      const actions=node('div',undefined,'startup-actions');actions.append(toggle);
      if(item.canRestore&&!item.readOnly){const restore=node('button','Restore original','startup-toggle-btn');restore.type='button';restore.disabled=operationBusy;restore.addEventListener('click',()=>openStartupConfirm(item,true));actions.append(restore);}
      row.append(icon,info,badges,actions);
      if(item.source==='app-service')services.append(row);else startupList.append(row);
    }
    if(serviceCount)startupList.append(services);
  }
  let lastStartupLoadedAt = 0;
  async function refreshStartup(force=false){
    if(startupLoading)return;
    startupLoading=true;
    startupStatus.textContent=startupApps.length?'Refreshing startup entries…':'Reading startup applications…';
    startupList.setAttribute('aria-busy','true');
    get('startupRefresh').disabled=true;
    if(!startupApps.length)renderStartup();
    try {
      const r=await fetch('/api/apps/startup'+(force?'?refresh=1':''),{credentials:'same-origin',cache:'no-store'});
      if(r.status===401){(window.redirectToLogin||(()=>window.location.replace('/')))('apps-startup-401');return;}
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'Startup inventory unavailable.');
      lastStartupLoadedAt = Number.isFinite(data.sampledAt)?data.sampledAt:Date.now();
      startupLoadError=false;
      startupApps=data.items;
      startupStatus.textContent=`${startupApps.length} startup entries · loaded ${new Date(data.sampledAt).toLocaleTimeString()}${data.warnings?.length?' · Some startup sources could not be fully read':''}`;
    }catch(e){startupLoadError=true;startupStatus.textContent=(startupApps.length?'Refresh failed; showing the previous inventory. ':'')+e.message;}
    finally{startupLoading=false;startupList.setAttribute('aria-busy','false');get('startupRefresh').disabled=false;renderStartup();}
  }
  function openStartupConfirm(item,restore=false){
    if(item.readOnly||operationBusy)return;
    startupTarget={...item,restore};
    get('startupConfirmPin').value='';
    get('startupConfirmTitle').textContent=(restore?'Restore original state for ':item.enabled?'Disable ':'Enable ')+(item.displayName||item.name);
    get('startupConfirmDetails').replaceChildren(
      node('p',`Application: ${item.displayName||item.name}`),
      node('p',`Scope: ${item.scope==='user'?'Current User':'All Users'}`),
      node('p',`Action: ${restore?'Restore the enabled/disabled state saved before Rovarin changed this task':item.enabled?'Prevent starting at the next sign-in; this does not stop a running app':'Allow starting at the next sign-in'}`)
    );
    get('startupConfirmError').textContent='';
    if(!startupDialog.open)startupDialog.showModal();
    get('startupConfirmPin').focus();
  }
  startupForm.addEventListener('submit',async e=>{
    e.preventDefault();
    if(!startupTarget||operationBusy)return;
    const target=startupTarget;
    const nextEnabled=target.restore?'restore':!target.enabled;
    const currentPin=get('startupConfirmPin').value;
    if(!/^(?:\d{6}|\d{12})$/.test(currentPin))return;
    get('startupConfirmPin').value='';
    get('startupConfirmSubmit').disabled=true;
    get('startupConfirmError').textContent='Applying changes…';
    try {
      const r=await fetch('/api/apps/startup/toggle',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:target.id,enabled:nextEnabled,pin:currentPin,confirmation:'change-startup'})});
      const data=await r.json();
      if(!r.ok)throw Error(data.error||'Failed to update startup configuration.');
      startupDialog.close();
      await refreshStartup(true);
    }catch(err){get('startupConfirmError').textContent=err.message;}
    finally{get('startupConfirmSubmit').disabled=false;}
  });
  get('startupConfirmCancel').addEventListener('click',()=>startupDialog.close());
  startupDialog.addEventListener('close',()=>{startupTarget=null;get('startupConfirmPin').value='';});
  get('startupRefresh').addEventListener('click',()=>refreshStartup(true));
  get('startupSearch').addEventListener('input',renderStartup);
  get('startupScope').addEventListener('change',renderStartup);
  get('startupStatusFilter').addEventListener('change',renderStartup);

  window.addEventListener('pc-monitor-pagechange',event=>{
    selection();
    if(event.detail.page==='appsPage'){
      if(apps.length > 0){
        if(Date.now() - lastAppsLoadedAt > APPS_STALE_MS){
          refresh(false, true);
        }
      } else {
        refresh();
      }
      readStatus();
      if(!quickLaunchData || !Array.isArray(quickLaunchData.pins) || !quickLaunchData.pins.length || Date.now() - lastQlLoadedAt > APPS_STALE_MS){
        refreshQuickLaunch();
      }
      if(activeTab==='startup'&&(!startupApps.length || Date.now() - lastStartupLoadedAt > APPS_STALE_MS))refreshStartup();
    }
  });
  window.addEventListener('rovarin-apps-refresh-status',readStatus);
  window.addEventListener('rovarin-apps-operation',event=>showProgress(event.detail));
  window.addEventListener('pc-monitor-stream-state',event=>{
    if(event.detail.connected&&!get('appsPage').hidden){
      if(apps.length > 0){
        if(Date.now() - lastAppsLoadedAt > APPS_STALE_MS) refresh(false, true);
      } else {
        refresh();
      }
      readStatus();
      if(!quickLaunchData || !Array.isArray(quickLaunchData.pins) || !quickLaunchData.pins.length || Date.now() - lastQlLoadedAt > APPS_STALE_MS){
        refreshQuickLaunch();
      }
      if(activeTab==='startup'&&(!startupApps.length || Date.now() - lastStartupLoadedAt > APPS_STALE_MS))refreshStartup();
    }
  });
})();
