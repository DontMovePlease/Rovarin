'use strict';
(() => {
  const page=document.getElementById('processesPage'),rows=document.getElementById('processesRows'),liveText=document.getElementById('processesLiveText'),liveDot=document.getElementById('processesLiveDot'),updated=document.getElementById('processesUpdated'),pauseButton=document.getElementById('processesFreezeButton'),search=document.getElementById('processesSearch'),killButton=document.getElementById('processesKillButton'),treeButton=document.getElementById('processesTreeButton'),selectionText=document.getElementById('processesSelection'),killStatus=document.getElementById('processesKillStatus'),actionBar=document.getElementById('processesActions');
  const buttons=Array.from(document.querySelectorAll('#processesPage [data-sort]')),collator=new Intl.Collator(undefined,{sensitivity:'base',numeric:true}),expanded=new Set(),rowNodes=new Map(),endedIdentities=new Map();
  let sortBy='cpu',sortDirection=-1,snapshot=null,newestSnapshot=null,paused=false,selected=null,killBusy=false,inFlight=false,streamConnected=false,refreshTimer=null;
  const identity=item=>item.pid+'|'+item.name+'|'+(item.startedAt||''),displayName=item=>item.displayName||item.name;
  const clientVisible=()=>typeof window.dashboardClientVisible==='function'?window.dashboardClientVisible():document.visibilityState==='visible';
  const processLeaseHeader=()=>window.monitoringLeaseId?{'X-Monitor-Lease':window.monitoringLeaseId}:{};
  function setKillStatus(text,kind){killStatus.textContent=text||'';killStatus.className='processes-kill-status'+(kind?' '+kind:'');}
  function syncSelection(){
    const present=selected&&newestSnapshot?.processes?.find(item=>identity(item)===identity(selected));
    if(selected&&!present&&newestSnapshot&&!newestSnapshot.error){selected=null;setKillStatus('Process ended or left the current list.','');}
    selectionText.textContent=selected?displayName(present||selected)+' · PID '+selected.pid:'';
    killButton.disabled=treeButton.disabled=!selected||!present||killBusy||paused||newestSnapshot?.stale||!!newestSnapshot?.error||!newestSnapshot?.sampledAt||Date.now()-newestSnapshot.sampledAt>15000;
    actionBar.hidden=!selected;
  }
  function acceptSnapshot(data){for(const [key,at] of endedIdentities)if(Date.now()-at>60000)endedIdentities.delete(key);if(newestSnapshot?.sampledAt&&data.sampledAt&&data.sampledAt<newestSnapshot.sampledAt)return;newestSnapshot=data;syncSelection();if(!paused){snapshot=data;render();}else updateStatus();}
  function updateStatus(){const stale=!snapshot||snapshot.stale||!snapshot.sampledAt||Date.now()-snapshot.sampledAt>15000;liveDot.classList.toggle('is-stale',paused||stale||!!newestSnapshot?.error);liveText.textContent=paused?'Paused':newestSnapshot?.error?'Unavailable':stale?'Waiting':'Live';updated.textContent=snapshot?.sampledAt?'Updated '+new Date(snapshot.sampledAt).toLocaleTimeString():'Updated —';}
  function compare(a,b){let value;if(sortBy==='name')value=collator.compare(a.label||displayName(a),b.label||displayName(b));else {const field=sortBy==='cpu'?'cpuPercent':sortBy==='pid'?'pid':'ramMB';if((a[field]==null)!==(b[field]==null))return a[field]==null?1:-1;value=a[field]==null?0:a[field]-b[field];}return value*sortDirection||collator.compare(a.name||a.label,b.name||b.label)||(a.pid||0)-(b.pid||0);}
  function groups(){const all=new Map();for(const item of snapshot?.processes||[]){if(endedIdentities.has(identity(item)))continue;const key=item.displayGroup||identity(item);let group=all.get(key);if(!group){group={key,label:displayName(item),members:[],cpuPercent:null,ramMB:0,pid:item.pid,name:item.name};all.set(key,group);}group.members.push(item);group.pid=Math.min(group.pid,item.pid);if(collator.compare(item.name,group.name)<0)group.name=item.name;if(Number.isFinite(item.cpuPercent))group.cpuPercent=(group.cpuPercent||0)+item.cpuPercent;group.ramMB+=Number(item.ramMB)||0;}
    for(const key of expanded)if(!all.has(key))expanded.delete(key);
    const query=search.value.trim().toLocaleLowerCase();return [...all.values()].map(group=>{group.members.sort(compare);group.matches=group.members.filter(item=>!query||(displayName(item)+' '+item.name+' '+item.pid).toLocaleLowerCase().includes(query));group.searchExpanded=!!query&&group.matches.length>0;return group;}).filter(group=>group.matches.length).sort(compare);
  }
  function row(key){let element=rowNodes.get(key);if(!element){element=rows.insertRow();for(let i=0;i<4;i++)element.insertCell();element.addEventListener('pointerdown',()=>{element.__pressed=element.__process?{pid:element.__process.pid,name:element.__process.name,startedAt:element.__process.startedAt}:null;});element.addEventListener('click',()=>activate(element));element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate(element);}});rowNodes.set(key,element);}return element;}
  function activate(element){if(killBusy)return;if(element.__group){expanded.has(element.__group)?expanded.delete(element.__group):expanded.add(element.__group);render();return;}const target=element.__pressed||element.__process;element.__pressed=null;if(!target?.startedAt)return;const current=newestSnapshot?.processes?.find(item=>identity(item)===identity(target));if(!current){setKillStatus('Process ended.','');return;}selected=selected&&identity(selected)===identity(current)?null:{pid:current.pid,name:current.name,startedAt:current.startedAt};setKillStatus('','');render();}
  function paint(element,item,group,child){element.__group=group?.members.length>1?group.key:null;element.__process=element.__group?null:item;element.className=element.__group?'process-group':'is-selectable'+(child?' process-child':'');element.tabIndex=0;element.setAttribute('aria-selected',String(!!selected&&!element.__group&&identity(selected)===identity(item)));element.classList.toggle('is-selected',!!selected&&!element.__group&&identity(selected)===identity(item));const cell=element.cells[0];cell.className='process-name';cell.setAttribute('data-display-name',element.__group?group.label:displayName(item));cell.replaceChildren();const label=document.createElement('span');label.className='process-label';label.textContent=element.__group?(expanded.has(group.key)||group.searchExpanded?'▾ ':'▸ ')+group.label+' ('+group.members.length+')':displayName(item);cell.appendChild(label);
    const detail=document.createElement('small');detail.className='process-technical-name';if(element.__group){element.setAttribute('aria-expanded',String(expanded.has(group.key)||group.searchExpanded));detail.textContent=group.members.length+' processes';}else {element.removeAttribute('aria-expanded');detail.textContent=[item.hasFriendlyName?item.name.replace(/\.exe$/i,'')+'.exe':'',child?'PID '+item.pid:''].filter(Boolean).join(' · ');}if(detail.textContent)cell.appendChild(detail);
    element.cells[1].className='process-pid';element.cells[1].textContent=element.__group?'—':String(item.pid);element.cells[2].textContent=item.cpuPercent==null?'—':Number(item.cpuPercent).toFixed(1)+'%';element.cells[3].textContent=Math.round(item.ramMB||0)+' MB';
  }
  function render(){syncSelection();updateStatus();const list=groups(),desired=[];for(const group of list){const single=group.members.length===1,item=single?group.members[0]:group;const node=row(single?'p:'+identity(item):'g:'+group.key);paint(node,item,single?null:group,false);desired.push(node);if(!single&&(expanded.has(group.key)||group.searchExpanded))for(const child of group.matches){const node=row('p:'+identity(child));paint(node,child,null,true);desired.push(node);}}
    const active=new Set(desired);for(const [key,node] of rowNodes)if(!active.has(node)){node.remove();rowNodes.delete(key);}for(let i=0;i<desired.length;i++)if(rows.children[i]!==desired[i])rows.insertBefore(desired[i],rows.children[i]||null);
    if(!desired.length){rows.replaceChildren();const cell=rows.insertRow().insertCell();cell.colSpan=4;cell.className='processes-empty';cell.textContent=newestSnapshot?.error?'Process data unavailable.':snapshot?.sampledAt?'No processes match your search.':'Loading processes…';}else for(const node of [...rows.children])if(!active.has(node))node.remove();
  }
  pauseButton.addEventListener('click',()=>{paused=!paused;pauseButton.textContent=paused?'Resume':'Pause';pauseButton.setAttribute('aria-pressed',String(paused));if(!paused)snapshot=newestSnapshot;render();});search.addEventListener('input',render);
  function syncFallback(){clearInterval(refreshTimer);refreshTimer=null;if(!window.pcMonitorUninstalling&&!streamConnected&&clientVisible()&&!page.hidden)refreshTimer=setInterval(refresh,5000);}
  async function endSelected(tree = false) {
    if (!selected || killBusy) return;
    const target = selected;
    if (killButton.disabled) return;
    if (!tree && !window.confirm(`End ${target.name} (PID ${target.pid})? Only this process is targeted; child processes or a restarted app may remain.`)) return;
    killBusy = true;
    render();
    setKillStatus(`Ending ${target.name} (PID ${target.pid}) · verifying exit…`, '');
    try {
      if(tree){const preview=await fetch('/api/processes/tree',{method:'POST',headers:{'Content-Type':'application/json',...processLeaseHeader()},credentials:'same-origin',cache:'no-store',body:JSON.stringify(target)});const data=await preview.json();if(!preview.ok||!data.success){setKillStatus(data.error||'The tree could not be safely verified.','error');return;}if(!window.confirm('End '+target.name+' (PID '+target.pid+') and '+data.descendantCount+' verified descendant(s)'+(data.remaining?.length?' (additional inaccessible descendants may remain)':'')+'? Current descendants will be rechecked. Unsaved work may be lost.'))return;}
      const response = await fetch(tree ? '/api/processes/kill-tree' : '/api/processes/kill', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...processLeaseHeader() },
        credentials: 'same-origin',
        cache: 'no-store',
        body: JSON.stringify({ pid: target.pid, name: target.name, startedAt: target.startedAt, ...(tree ? {confirmed:true} : {}) })
      });
      if (response.status === 401) { window.location.replace('/'); return; }
      const data = await response.json().catch(() => ({}));
      if (response.ok && data.success) {
        endedIdentities.set(identity(target), Date.now());
        if (snapshot) snapshot = { ...snapshot, processes: snapshot.processes.filter(item => identity(item) !== identity(target)) };
        if (newestSnapshot) newestSnapshot = { ...newestSnapshot, processes: newestSnapshot.processes.filter(item => identity(item) !== identity(target)) };
        selected = null;
        setKillStatus(tree ? `Process tree ended · ${data.results.filter(item=>item.code==='terminated').length} terminated, exit verified.` : `Ended ${target.name} (PID ${target.pid}) · exit confirmed. Child processes or a new instance may remain.`, 'ok');
      } else {
        setKillStatus(tree && data.results?.length ? `Tree result: ${data.results.map(item=>`PID ${item.pid}: ${item.code}`).join('; ')}. Remaining: ${data.remaining?.length || 0}.` : data.error || 'End process failed; the process may still be running.', 'error');
      }
    } catch (_) {
      setKillStatus('Connection lost.', 'error');
    } finally {
      killBusy = false;
      if (!paused) snapshot = newestSnapshot;
      render();
      refresh();
    }
  }
  killButton.addEventListener('click',()=>endSelected(false));
  treeButton.addEventListener('click',()=>endSelected(true));

  async function refresh(){if(window.pcMonitorUninstalling||inFlight||!clientVisible()||page.hidden)return;inFlight=true;try{const response=await fetch('/api/processes',{headers:processLeaseHeader(),credentials:'same-origin',cache:'no-store'});if(response.status===401){window.location.replace('/');return;}if(response.ok)acceptSnapshot(await response.json());else acceptSnapshot({...newestSnapshot,stale:true,error:response.status===403?'profile-not-active':'server-error'});}catch{acceptSnapshot({...newestSnapshot,stale:true,error:'connection-lost'});}finally{inFlight=false;}}
  buttons.forEach(button=>button.addEventListener('click',()=>{const next=button.dataset.sort;sortDirection=next===sortBy?-sortDirection:['cpu','memory'].includes(next)?-1:1;sortBy=next;for(const item of buttons){const active=item.dataset.sort===sortBy;item.setAttribute('aria-pressed',String(active));item.parentElement.setAttribute('aria-sort',active?(sortDirection===1?'ascending':'descending'):'none');item.textContent=({name:'Name',cpu:'CPU',memory:'Memory',pid:'PID'})[item.dataset.sort]+(active?(sortDirection===1?' ↑':' ↓'):'');}render();}));
  window.addEventListener('pc-monitor-processes',event=>acceptSnapshot(event.detail));
  window.addEventListener('pc-monitor-pagechange',event=>{selected=null;paused=false;pauseButton.textContent='Pause';pauseButton.setAttribute('aria-pressed','false');snapshot=newestSnapshot=null;rowNodes.clear();rows.replaceChildren();expanded.clear();render();if(event.detail.page==='processesPage')refresh();syncFallback();});
  window.addEventListener('pc-monitor-stream-state',event=>{streamConnected=event.detail.connected===true;if(streamConnected&&!page.hidden)refresh();syncFallback();});
  const visibilityChanged=()=>{if(clientVisible()&&!page.hidden)refresh();syncFallback();};document.addEventListener('visibilitychange',visibilityChanged);window.addEventListener('pc-monitor-desktop-visibility',visibilityChanged);
})();
