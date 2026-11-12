'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {LeftoverManager}=require('./leftover-manager');
const INVENTORY_CACHE_TTL_MS = 300000;
const STARTUP_CACHE_TTL_MS = 300000;
const CODES = new Set(['settings-opened','user-mismatch','inspected','removal-unconfirmed','removal-denied','package-in-use','package-removal-failed','completed','reboot-required','not-installed','inventory-changed','unsupported','cancelled','access-denied','uninstall-failed','still-running','operation-failed','launched','launch-failed','limit-reached','already-pinned','pinned','unpinned','not-found','elevation-required','startup-changed','unavailable']);
function elevatedStartupOperation(request,authorize){
  const permitted=()=>{try{return Boolean(authorize());}catch(_){return false;}};
  return new Promise(resolve=>{
    let directory,child,finished=false,result=null,buffer='',bytes=0,approved=false,timer;
    const finish=value=>{if(finished)return;finished=true;clearTimeout(timer);if(directory){for(const name of ['startup.cs','RovarinStartup.exe']){try{fs.unlinkSync(path.join(directory,name));}catch(_){}}try{fs.rmdirSync(directory);}catch(_){}}resolve(value);};
    try{
      if(!permitted())return finish({success:false,code:'authentication-required'});
      directory=fs.mkdtempSync(path.join(require('os').tmpdir(),'rovarin-startup-'));
      const source=path.join(__dirname,'scripts/startup-elevated.cs');if(!fs.lstatSync(source).isFile()||fs.lstatSync(source).isSymbolicLink())throw Error();
      fs.writeFileSync(path.join(directory,'startup.cs'),fs.readFileSync(source),{flag:'wx'});
      const exe=path.join(directory,'RovarinStartup.exe');
      execFile(path.join(process.env.SystemRoot||'C:\\Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:exe','/platform:x64','/optimize+','/r:System.Web.Extensions.dll','/r:System.Management.dll','/r:System.Xml.dll','/r:Microsoft.CSharp.dll','/out:'+exe,path.join(directory,'startup.cs')],{windowsHide:true,timeout:30000,maxBuffer:8192},error=>{
        if(error)return finish({success:false,code:'operation-failed'});
        if(!permitted())return finish({success:false,code:'authentication-required'});
        try{
          child=require('child_process').spawn(exe,[String(process.pid)],{windowsHide:true,stdio:['pipe','pipe','pipe']});
          timer=setTimeout(()=>{child.kill();},140000);
          child.stdin.on('error',()=>{});child.stderr.resume();
          child.stdout.on('data',chunk=>{
            bytes+=chunk.length;if(bytes>16384){child.kill();return;}buffer+=chunk.toString('utf8');let end;
            while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line);
              if(value.type==='approval-ready'){
                if(approved){child.kill();return;}approved=true;
                // UAC can take time. A revoked session/PIN never receives GO.
                if(!permitted()){result={success:false,code:'authentication-required'};child.stdin.end('NO\n');}
                else child.stdin.end('GO\n');
              }else if(typeof value.success==='boolean'&&CODES.has(value.code)){result=value;}
              else child.kill();
            }catch(_){child.kill();}}
          });
          child.on('error',()=>finish({success:false,code:'operation-failed'}));
          child.on('close',code=>finish(code===0&&result?result:result?.code==='authentication-required'?result:{success:false,code:'operation-failed'}));
          child.stdin.write(JSON.stringify({source:request.locator.source,key:request.locator.key,fingerprint:request.fingerprint,enabled:request.enabled})+'\n');
        }catch(_){finish({success:false,code:'operation-failed'});}
      });
    }catch(_){finish({success:false,code:'operation-failed'});}
  });
}
function windowsOperation(request, execute = execFile, authorize = ()=>true) {
  if(process.platform==='win32'&&request.action==='startup-toggle'&&request.localApproval===true)return elevatedStartupOperation(request,authorize);
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ success:false, code:'windows-only' });
    try {
      const timeout = request.action === 'inventory' ? 45000 : ['startup-inventory', 'launch'].includes(request.action) ? 15000 : request.action === 'startup-toggle' ? 10000 : request.action==='verify-uninstall'?15000:request.action==='uninstall'&&request.locator?.scope==='appx'?300000:110000;
      const child=execute(path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'scripts/app-manager.ps1')],
        {windowsHide:true,timeout,maxBuffer:8*1024*1024},(error,stdout)=>{
          try {
            const result=JSON.parse(String(stdout).trim());
            if (error) throw Error();
            if (request.action === 'inventory' && (result.success !== true || !Array.isArray(result.apps) || result.apps.length > 2048)) throw Error();
            if (request.action === 'startup-inventory' && (result.success !== true || !Array.isArray(result.items))) throw Error();
            if (!['inventory', 'startup-inventory'].includes(request.action) && !CODES.has(result.code)) throw Error();
            if(request.action==='uninstall')result.helperExited=true;
            resolve(result);
          }
          catch(_){resolve({success:false,code:error?.killed?'timed-out':'operation-failed',helperExited:Boolean(error?.killed)});}
        });child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
    }catch(_){resolve({success:false,code:'operation-failed'});}
  });
}
function validRow(row) {
  return row && ['user','machine64','machine32','appx'].includes(row.locator?.scope) && typeof row.locator.key==='string' && row.locator.key.length>0 && row.locator.key.length<=300 && !/[\\/\r\n]/.test(row.locator.key)
    && /^[a-f0-9]{64}$/.test(row.fingerprint) && typeof row.name==='string' && row.name.length>0 && ['msi','exe','appx','manual'].includes(row.type);
}
function isOpaqueIdentifier(name) {
  if (typeof name !== 'string') return true;
  const t = name.trim();
  if (!t) return true;
  if (/^\{?[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}\}?$/.test(t)) return true;
  if (/^(?:ms-resource:|@\{)/i.test(t)) return true;
  if (/^\d{5,}$/.test(t)) return true;
  if (/^[0-9a-fA-F_\-]{12,}$/.test(t) && (t.match(/\d/g) || []).length >= 4) return true;
  return false;
}
function cleanPublisher(raw) {
  if (!raw || typeof raw !== 'string') return '';
  const s = raw.trim();
  if (!s || s.startsWith('ms-resource:')) return '';
  if (/^CN\s*=/i.test(s) || /,\s*(?:O|OU|L|S|C)\s*=/i.test(s)) {
    const parts = {};
    const matches = s.match(/(?:^|,\s*)([A-Za-z]+)\s*=\s*([^,]+)/g);
    if (matches) {
      for (const m of matches) {
        const eq = m.indexOf('=');
        if (eq !== -1) {
          const k = m.slice(0, eq).replace(/^,\s*/, '').trim().toUpperCase();
          const v = m.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1');
          if (!parts[k]) parts[k] = v;
        }
      }
    }
    if (parts.CN && !/^[0-9a-fA-F-]{16,}$/.test(parts.CN) && !/^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}/.test(parts.CN)) {
      return parts.CN;
    }
    if (parts.O && !/^[0-9a-fA-F-]{16,}$/.test(parts.O)) {
      return parts.O;
    }
    if (parts.OU && !/^[0-9a-fA-F-]{16,}$/.test(parts.OU)) {
      return parts.OU;
    }
    if (parts.CN) return parts.CN;
    return '';
  }
  return s;
}
function publicApp(row,id) {
  const text=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240):'';
  const description=text(row.description);
  const safeDescription=/[A-Za-z]:[\\/]|\\\\|(?:powershell|cmd\.exe|msiexec)\s/i.test(description)?'':description;
  const category=row.systemComponent===true?'system':row.locator?.scope==='appx'?'store':['user','machine64','machine32'].includes(row.locator?.scope)?'desktop':'other';
  const available=row.type!=='manual' && row.protected!==true && row.systemComponent!==true;
  const rawName=text(row.name);
  let displayName = rawName;
  let identifier = null;
  const cleanedPub = cleanPublisher(text(row.publisher));
  if (isOpaqueIdentifier(rawName)) {
    identifier = rawName;
    if (category === 'store' || row.locator?.scope === 'appx') {
      displayName = 'Unknown Microsoft Store app';
    } else if (cleanedPub && !isOpaqueIdentifier(cleanedPub)) {
      displayName = `Unknown application by ${cleanedPub}`;
    } else {
      displayName = 'Unknown application';
    }
  }
  let unsupportedReason = null;
  if (!available) {
    if (row.systemComponent === true) unsupportedReason = 'system-component';
    else if (row.protected === true) unsupportedReason = 'protected-application';
    else if (row.manualReason) unsupportedReason = row.manualReason;
    else unsupportedReason = 'manual-only';
  }
  const app = {
    id,
    name: displayName,
    version: text(row.version),
    publisher: cleanedPub,
    description: safeDescription,
    category,
    sizeKB: Number.isFinite(row.sizeKB) && row.sizeKB >= 0 ? row.sizeKB : null,
    sizeEstimated: row.sizeEstimated === true,
    hasIcon: Boolean(row.icon || row.hasIcon),
    installDate: text(row.installDate),
    type: row.type,
    uninstallCapable: available,
    batchCapable: available && row.batchCapable === true,
    elevationLikely: row.elevationLikely === true,
    status: available ? 'available' : 'manual-only',
    unsupportedReason,
    launchCapable: row.launchCapable === true
  };
  if (identifier) app.identifier = identifier;
  return app;
}
class AppManager {
  constructor({operation=windowsOperation,onChange=()=>{},stateDirectory=null,leftovers}={}) {
    this.operation=operation;
    this.onChange=onChange;
    this.statusEpoch=crypto.randomBytes(16).toString("hex");this.revision=0;
    this.leftovers=leftovers||new LeftoverManager({onChange:()=>this.publish(),protectedRoots:[__dirname,...(stateDirectory?[stateDirectory]:[])]});
    this.stateDirectory=stateDirectory||null;
    this.quickLaunchFile=this.stateDirectory?path.join(this.stateDirectory,'quick-launch.json'):null;
    this.journalFile=this.stateDirectory?path.join(this.stateDirectory,'uninstall-operation.json'):null;
    this.key=crypto.randomBytes(32);
    this.rows=new Map();
    this.rawRowsByLocator=new Map();
    this.iconCache=new Map();
    this.sizeCache=new Map();
    this.cache=null;
    this.loading=null;
    this.busy=false;
    this.blocked=false;
    this.job=null;
    this.history=[];
    this.quickLaunch=this.loadQuickLaunch();
    this.startupRows=new Map();
    this.startupIconCache=new Map();
    this.startupCache=null;
    this.startupLoading=null;
    this.loadJournal();
  }
  loadJournal(){
    if(!this.journalFile)return;
    try {
      if(fs.existsSync(this.journalFile)){
        const raw=fs.readFileSync(this.journalFile,'utf8');
        const data=JSON.parse(raw);
        if(data&&typeof data.jobId==='string'&&Array.isArray(data.items)&&data.items.length>0&&Array.isArray(data.targets)){
          const isFinished=!['running','preparing','removing','waiting-windows','verifying','unconfirmed'].includes(data.state)&&data.items.every(it=>['completed','reboot-required','failed','cancelled','skipped'].includes(it.state));
          if(!isFinished){
            this.blocked=true;
            this.job={
              id:data.jobId,
              batch:Boolean(data.batch),
              state:'unconfirmed',
              stage:'unconfirmed',
              items:data.items.map(it=>['running','queued','uninstalling','verifying','unconfirmed'].includes(it.state)?{...it,state:'unconfirmed',code:it.code||'operation-unconfirmed'}:it)
            };
            this.uninstallTargets=data.targets.map(t=>({
              id:t.id,
              row:{locator:t.locator,fingerprint:t.fingerprint,ownerSid:t.ownerSid,cleanupPackageFamily:t.cleanupPackageFamily,type:t.type,name:t.name},
              outcome:t.outcome||{success:false,code:'interrupted-restart',helperExited:true},
              cleanup:t.cleanup
            }));
            this.audit('uninstall-recovered-uncertain',{jobId:data.jobId});
          }
        }
      }
    }catch(_){}
  }
  saveJournal(){
    if(!this.journalFile)return;
    if(!this.job){this.clearJournal();return;}
    try {
      const data={
        jobId:this.job.id,
        batch:this.job.batch,
        state:this.job.state,
        stage:this.job.stage,
        items:this.job.items,
        targets:(this.uninstallTargets||[]).map(t=>({
          id:t.id,
          name:t.row?.name||t.name,
          locator:t.row?.locator,
          fingerprint:t.row?.fingerprint,
          ownerSid:t.row?.ownerSid,
          cleanupPackageFamily:t.row?.cleanupPackageFamily,
          type:t.row?.type,
          outcome:t.outcome,
          cleanup:t.cleanup
        }))
      };
      const tmp=`${this.journalFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp,JSON.stringify(data,null,2),'utf8');
      fs.renameSync(tmp,this.journalFile);
    }catch(_){}
  }
  clearJournal(){
    if(!this.journalFile)return;
    try{if(fs.existsSync(this.journalFile))fs.unlinkSync(this.journalFile);}catch(_){}
  }
  loadQuickLaunch(){
    if(!this.quickLaunchFile)return {pins:[]};
    try {
      if(fs.existsSync(this.quickLaunchFile)){
        const data=JSON.parse(fs.readFileSync(this.quickLaunchFile,'utf8'));
        if(Array.isArray(data.pins)){
          const valid=data.pins.filter(p=>p&&p.locator&&typeof p.locator.scope==='string'&&typeof p.locator.key==='string'&&typeof p.name==='string');
          return {pins:valid.slice(0,12)};
        }
      }
    }catch(_){}
    return {pins:[]};
  }
  saveQuickLaunch(){
    if(!this.quickLaunchFile)return;
    try {
      const payload=JSON.stringify(this.quickLaunch,null,2);
      const tmp=`${this.quickLaunchFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp,payload,'utf8');
      fs.renameSync(tmp,this.quickLaunchFile);
    }catch(_){}
  }
  getQuickLaunch(){
    const pins=[];
    let migrated=false;
    for(const pin of this.quickLaunch.pins){
      // A Store update changes PackageFullName, but not its registered family.
      // Match only a unique current package in that family, never a display name.
      if(pin.locator.scope==='appx' && ![...this.rows.values()].some(row=>row.locator?.scope==='appx'&&row.locator.key===pin.locator.key)){
        const parts=pin.locator.key.match(/^([A-Za-z0-9.-]+)_\d+\.\d+\.\d+\.\d+_(?:x64|x86|arm64|arm|neutral)_([A-Za-z0-9.-]*)_([A-Za-z0-9]+)$/);
        const family=parts?parts[1]+'_'+parts[3]:null;
        const matches=family?[...this.rows.values()].filter(row=>row.locator?.scope==='appx'&&row.cleanupPackageFamily===family&&row.launchCapable===true):[];
        if(matches.length===1){pin.locator={scope:'appx',key:matches[0].locator.key};migrated=true;}
      }
      let matchedId=null,matchedRow=null;
      for(const [id,row] of this.rows.entries()){
        if(row.locator?.scope===pin.locator.scope&&row.locator?.key===pin.locator.key){matchedId=id;matchedRow=row;break;}
      }
      if(matchedRow){
        pins.push({id:matchedId,name:matchedRow.name,locator:pin.locator,launchCapable:matchedRow.launchCapable===true,hasIcon:Boolean(this.iconCache.get(matchedId)),available:true});
      }else{
        pins.push({id:null,name:pin.name,locator:pin.locator,launchCapable:false,hasIcon:false,available:false});
      }
    }
    if(migrated)this.saveQuickLaunch();
    return {pins,maxPins:12};
  }
  pinApp(id){
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('invalid-request');
    const row=this.rows.get(id);
    if(!row)throw Error('not-found');
    if(!row.launchCapable)throw Error('unsupported');
    if(this.quickLaunch.pins.length>=12)throw Error('limit-reached');
    const already=this.quickLaunch.pins.some(p=>p.locator.scope===row.locator.scope&&p.locator.key===row.locator.key);
    if(already)throw Error('already-pinned');
    this.quickLaunch.pins.push({locator:{scope:row.locator.scope,key:row.locator.key},name:row.name,addedAt:Date.now()});
    this.saveQuickLaunch();
    this.audit('app-pinned',{name:row.name});
    return {success:true,code:'pinned'};
  }
  unpinApp({id,locator}={}){
    let index=-1;
    if(id&&typeof id==='string'){
      const row=this.rows.get(id);
      if(row)index=this.quickLaunch.pins.findIndex(p=>p.locator.scope===row.locator.scope&&p.locator.key===row.locator.key);
    }
    if(index===-1&&locator&&typeof locator.scope==='string'&&typeof locator.key==='string'){
      index=this.quickLaunch.pins.findIndex(p=>p.locator.scope===locator.scope&&p.locator.key===locator.key);
    }
    if(index===-1)throw Error('not-found');
    const removed=this.quickLaunch.pins.splice(index,1)[0];
    this.saveQuickLaunch();
    this.audit('app-unpinned',{name:removed.name});
    return {success:true,code:'unpinned'};
  }
  async launch(id){
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('invalid-request');
    const row=this.rows.get(id);
    if(!row)throw Error('not-found');
    if(!row.launchCapable)throw Error('unsupported');
    const result=await this.operation({action:'launch',locator:row.locator,fingerprint:row.fingerprint});
    if(!result.success){
      this.audit('launch-failed',{name:row.name,code:result.code});
      const err=new Error(result.error||result.code);err.code=result.code;throw err;
    }
    this.audit('app-launched',{name:row.name});
    return {success:true,code:'launched'};
  }
  async startupInventory(force=false){
    if(!force&&this.startupCache&&Date.now()-this.startupCache.sampledAt<STARTUP_CACHE_TTL_MS)return this.startupCache;
    if(this.startupLoading)return this.startupLoading;
    this.startupLoading=(async()=>{
      const result=await this.operation({action:'startup-inventory',...(this.cache?.packagesAvailable && Date.now()-this.cache.sampledAt<INVENTORY_CACHE_TTL_MS && Array.isArray(this.packageStartup)?{packageStartup:this.packageStartup}:{}),...(this.cache?{appLocations:[...this.rows.values()].filter(r=>typeof r.installLocation==='string'&&r.installLocation).map(r=>({name:r.name,location:r.installLocation})).slice(0,2048)}:{})});
      if(!result.success)throw Error(result.code);
      const nextRows=new Map(),nextIcons=new Map(),items=[];
      for(const item of result.items){
        if(!item||!item.locator||typeof item.locator.source!=='string'||typeof item.locator.key!=='string')continue;
        if (!['registry-user','registry-user32','registry-machine','registry-machine32','folder-user','folder-machine','scheduled-task','packaged-startup','app-service'].includes(item.locator.source) || item.locator.key.length>1024 || !/^[a-f0-9]{64}$/.test(item.fingerprint||'')) continue;
        const id=crypto.createHmac('sha256',this.key).update(item.locator.source+'|'+item.locator.key+'|'+item.fingerprint).digest('hex');
        if(nextRows.has(id))continue;
        let iconBuf=null;
        if(typeof item.icon==='string'&&item.icon.length>0&&item.icon.length<131072){
          try{iconBuf=Buffer.from(item.icon,'base64');}catch(_){}
        }
        const readOnly=item.readOnly===true || (item.locator.source==='scheduled-task' && item.taskManageable!==true) || !['registry-user','registry-user32','folder-user','scheduled-task','registry-machine','registry-machine32','folder-machine'].includes(item.locator.source) || (['registry-machine','registry-machine32','folder-machine'].includes(item.locator.source)&&item.requiresElevation!==true) || typeof item.enabled!=='boolean';
        const controlMode=!readOnly?(item.requiresElevation===true?'local-approval':'direct'):item.locator.source==='packaged-startup'&&item.policyControlled!==true?'windows-settings':'unsupported';
        const storedItem={...item,readOnly,controlMode,hasIcon:Boolean(iconBuf||item.hasIcon)};
        delete storedItem.icon;
        nextRows.set(id,storedItem);
        if(iconBuf)nextIcons.set(id,iconBuf);
        items.push({
          id,
          name:typeof item.name==='string'?item.name.slice(0,120):'',
          displayName:typeof item.displayName==='string'?item.displayName.slice(0,120):item.name,
          publisher:typeof item.publisher==='string'?item.publisher.slice(0,120):'',
          source:item.source,
          scope:item.scope,
          serviceState:['Running','Stopped','StartPending','StopPending','Paused','Unknown'].includes(item.serviceState)?item.serviceState:'Unknown',
          startupMode:['Automatic','Manual','Disabled'].includes(item.startupMode)?item.startupMode:'Unknown',
          method:typeof item.method==='string'?item.method.slice(0,100):'',
          executable:typeof item.executable==='string'?path.win32.basename(item.executable).replace(/[\x00-\x1f]/g,'').slice(0,120):'',
          enabled:typeof item.enabled==='boolean'?item.enabled:null,
          readOnly,controlMode,
          requiresElevation:item.requiresElevation===true,
          canRestore:item.locator.source==='scheduled-task' && item.canRestore===true,
          blockedReason:item.locator.source==='packaged-startup'?(item.policyControlled===true?'This startup entry is controlled by Windows policy.':'Change this entry in Windows Startup settings on the PC, then verify its state here.'):typeof item.blockedReason==='string'?item.blockedReason.slice(0,160):'',
          hasIcon:Boolean(iconBuf||item.hasIcon)
        });
      }
      this.startupRows=nextRows;
      this.startupIconCache=nextIcons;
      this.startupCache={items,sampledAt:Date.now(),warnings:Array.isArray(result.warnings)?result.warnings.filter(x=>['scheduled-tasks-incomplete','scheduled-tasks-unavailable','packaged-startup-incomplete','packaged-startup-unavailable','user-run32-unavailable','app-services-incomplete','app-services-unavailable'].includes(x)):[]};
      return this.startupCache;
    })();
    try{return await this.startupLoading;}finally{this.startupLoading=null;}
  }
  getStartupIcon(id){if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))return null;return this.startupIconCache.get(id)||null;}
  async toggleStartup(id,enabled,options={}){
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('invalid-request');
    if(typeof enabled!=='boolean'&&enabled!=='restore')throw Error('invalid-request');
    const item=this.startupRows.get(id);
    if(!item)throw Error('not-found');
      if(item.readOnly||(item.locator.source==='scheduled-task'&&item.taskManageable!==true)||!['registry-user','registry-user32','folder-user','scheduled-task','registry-machine','registry-machine32','folder-machine'].includes(item.locator.source))throw Error('elevation-required');
      if(item.requiresElevation===true&&options.localApproval!==true)throw Error('local-approval-required');
    if(enabled==='restore' && (item.locator.source!=='scheduled-task'||!item.canRestore))throw Error('unsupported');
    if(this.startupChanging)throw Error('operation-running');
    this.startupChanging=true;
    try {
      const authorize=typeof options.authorize==='function'?options.authorize:()=>true;
      if(!authorize())throw Error('authentication-required');
      const result=await this.operation({action:'startup-toggle',locator:item.locator,fingerprint:item.fingerprint,enabled:enabled==='restore'?false:enabled,restore:enabled==='restore',...(item.requiresElevation===true?{localApproval:true}:{})},undefined,authorize);
      if(!result.success){this.startupCache=null;const messages={'startup-changed':'Windows startup state changed or could not be verified. Refresh and review the entry before trying again.','operation-failed':'Windows did not confirm the startup change. Refresh its state before retrying.',cancelled:'Administrator approval was cancelled; no startup change was authorized.','access-denied':'Windows denied the startup change.','unsupported':'This startup entry could not be safely changed. Refresh its details.'};const err=new Error(result.error||messages[result.code]||result.code);err.code=result.code;throw err;}
      if(typeof result.enabled!=='boolean'||(enabled!=='restore'&&result.enabled!==enabled)){this.startupCache=null;throw Error('startup-state-unconfirmed');}
      item.enabled=result.enabled;
    if(this.startupCache&&Array.isArray(this.startupCache.items)){
      const cached=this.startupCache.items.find(x=>x.id===id);
      if(cached)cached.enabled=item.enabled;
    }
    this.audit('startup-toggled',{name:item.name,enabled});
    if(item.locator.source==='scheduled-task')this.startupCache=null;
    return {success:true,code:'startup-changed',enabled:item.enabled};
    }finally{this.startupChanging=false;}
  }
  async openStartupSettings(id,authorize=()=>true){
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('invalid-request');
    const item=this.startupRows.get(id);
    if(!item)throw Error('not-found');
    if(item.controlMode!=='windows-settings'||item.locator.source!=='packaged-startup')throw Error('unsupported');
    if(!authorize())throw Error('authentication-required');
    const result=await this.operation({action:'startup-settings',locator:item.locator,fingerprint:item.fingerprint});
    if(!result.success)throw Error(result.code||'operation-failed');
    if(result.code!=='settings-opened'||result.changed!==false)throw Error('operation-failed');
    return {success:true,code:'settings-opened',changed:false};
  }
  async openInstalledAppsSettings(id,authorize=()=>true){
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('invalid-request');
    const row=this.rows.get(id);
    if(!row)throw Error('not-found');
    if(!authorize())throw Error('authentication-required');
    const result=await this.operation({action:'installed-apps-settings',locator:row.locator,fingerprint:row.fingerprint});
    if(!result.success)throw Error(result.code||'operation-failed');
    if(result.code!=='settings-opened'||result.changed!==false)throw Error('operation-failed');
    return {success:true,code:'settings-opened',changed:false};
  }
  clearUnconfirmed(authorize=()=>true){
    if(this.busy||this.leftovers.busy)throw Error('operation-running');
    if(!this.blocked||!this.job)return this.status();
    if(!authorize())throw Error('authentication-required');
    for(const item of this.job.items){
      if(item.state==='unconfirmed'){
        item.state='failed';
        item.code='still-installed';
      }
    }
    this.blocked=false;
    this.job.state='failed';
    this.job.stage='failed';
    this.clearJournal();
    this.publish();
    this.audit('uninstall-unconfirmed-cleared');
    return this.status();
  }
  status(){return {epoch:this.statusEpoch,revision:this.revision,busy:this.busy||this.leftovers.busy,blocked:this.blocked,job:this.job,leftovers:this.leftovers.status(),history:this.history.slice(-20)};}
  publish(){this.revision++;this.onChange(this.status());}
  audit(event,details={}){this.history.push({at:Date.now(),event,...details});if(this.history.length>64)this.history.shift();}
  getIcon(id){if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))return null;return this.iconCache.get(id)||null;}
  async inventory(force=false){
    if(!force&&this.cache&&Date.now()-this.cache.sampledAt<INVENTORY_CACHE_TTL_MS)return this.cache;
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      const cachedFingerprints={};
      if(!force){
        for(const [locKey,rawRow] of this.rawRowsByLocator.entries()){
          if(rawRow&&typeof rawRow.fingerprint==='string')cachedFingerprints[locKey]=rawRow.fingerprint;
        }
      }
      const request={action:'inventory',cachedSizes:Object.fromEntries(this.sizeCache),...(Object.keys(cachedFingerprints).length?{cachedFingerprints}:{})};
      const result=await this.operation(request);
      if(!result.success)throw Error(result.code);
      if(!result.packageStartupReused){
        // A mixed incremental result contains startup metadata only for changed
        // packages. It cannot replace a complete snapshot; let the on-demand
        // startup helper independently enumerate all packages instead.
        const partialPackages=result.apps.some(row=>row?.unchanged===true&&row.locator?.scope==='appx');
        this.packageStartup=!partialPackages&&Array.isArray(result.packageStartup)?result.packageStartup:null;
      }
      this.startupCache=null;
      if(result.calculatedSizes&&typeof result.calculatedSizes==='object'){
        for(const [k,v] of Object.entries(result.calculatedSizes)){
          if(v&&Number.isFinite(v.sizeKB)&&Number.isFinite(v.mtime))this.sizeCache.set(k,{sizeKB:v.sizeKB,mtime:v.mtime});
        }
        while(this.sizeCache.size>2048)this.sizeCache.delete(this.sizeCache.keys().next().value);
      }
      const next=new Map(),nextRawByLoc=new Map(),apps=[],dedupe=new Map(),nextIcons=new Map();
      for(const rawItem of result.apps){
        let row=rawItem;
        if(rawItem&&rawItem.unchanged===true&&rawItem.locator&&typeof rawItem.locator.scope==='string'&&typeof rawItem.locator.key==='string'){
          const prev=this.rawRowsByLocator.get(rawItem.locator.scope+'|'+rawItem.locator.key);
          if(prev&&prev.fingerprint===rawItem.fingerprint)row=prev;
        }
        if(!validRow(row))continue;
        const locKey=row.locator.scope+'|'+row.locator.key;
        const id=crypto.createHmac('sha256',this.key).update(locKey+'|'+row.fingerprint).digest('hex');
        let iconBuf=this.iconCache.get(id)||null;
        if(typeof row.icon==='string'&&row.icon.length>0&&row.icon.length<131072){
          try{iconBuf=Buffer.from(row.icon,'base64');}catch(_){}
        }
        if(row.icon!==undefined){
          row={...row,hasIcon:Boolean(iconBuf||row.hasIcon)};
          delete row.icon;
        }
        nextRawByLoc.set(locKey,row);
        // Dedupe only proven same registration/product identity, never unrelated
        // applications that happen to have the same display name.
        const duplicate=row.product?String(row.product).toLowerCase():locKey.toLowerCase();if(dedupe.has(duplicate))continue;dedupe.set(duplicate,id);next.set(id,row);
        if(iconBuf)nextIcons.set(id,iconBuf);
        apps.push(publicApp(row,id));
      }
      this.rows=next;this.rawRowsByLocator=nextRawByLoc;this.iconCache=nextIcons;this.cache={apps,sampledAt:Date.now(),packagesAvailable:result.packagesAvailable===true};return this.cache;
    })();try{return await this.loading;}finally{this.loading=null;}
  }
  async start(ids,batch,authorize=()=>true){
    if(this.busy||this.blocked||this.leftovers.busy)throw Error(this.blocked?'operation-unconfirmed':'operation-running');
    if(!Array.isArray(ids)||!ids.length||ids.length>20||new Set(ids).size!==ids.length||ids.some(id=>typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))||(!batch&&ids.length!==1))throw Error('invalid-request');
    this.busy=true;
    try{
      // Freeze the reviewed identity, then independently inventory before execution.
      const selected=ids.map(id=>({id,row:this.rows.get(id)}));if(selected.some(x=>!x.row))throw Error('inventory-changed');
      await this.inventory(true);
      if(!authorize())throw Error('authentication-required');
      if(selected.some(x=>this.rows.get(x.id)?.fingerprint!==x.row.fingerprint))throw Error('inventory-changed');
      if(selected.some(x=>!publicApp(x.row,x.id).uninstallCapable||(batch&&!x.row.batchCapable)))throw Error('unsupported');
      this.audit(batch?'batch-started':'uninstall-requested',{count:selected.length});
      this.job={id:crypto.randomBytes(16).toString('hex'),batch,state:'running',stage:'preparing',items:selected.map(x=>({id:x.id,name:x.row.name,state:'queued'}))};
      this.uninstallTargets=selected;
      this.saveJournal();
      this.publish();
      const jobId=this.job.id;this.running=this.run(selected,batch,authorize);return {success:true,code:'accepted',jobId};
    }catch(error){this.busy=false;throw error;}
  }
  async reconcile(authorize=()=>true){
    if(this.busy||this.leftovers.busy||!this.job||!this.blocked)return this.status();
    if(this.reconciling)return this.reconciling;
    this.reconciling=(async()=>{
      for(let index=0;index<this.job.items.length;index++){
        const item=this.job.items[index],target=this.uninstallTargets?.[index];
        if(item.state!=='unconfirmed'||!target)continue;
        if(!authorize())throw Error('authentication-required');
        // Reconcile when the helper has exited (no active helper wait) by re-checking live registration.
        if(target.outcome?.helperExited!==true)continue;
        const verified=await this.operation({action:'verify-uninstall',locator:target.row.locator,ownerSid:target.row.ownerSid,packageFamily:target.row.cleanupPackageFamily});
        if(!authorize())throw Error('authentication-required');
        if(!verified.success||verified.code!=='inspected'||typeof verified.installed!=='boolean')continue;
        const previousCode=item.code;
        if(!verified.installed){
          item.state='completed';item.code='removal-verified';
          if(target.cleanup)item.leftoverReceiptId=this.leftovers.confirmed(target.cleanup);
        }else if(target.row?.type==='appx'){
          item.state='failed';item.code='still-installed';
        }else{
          item.state='unconfirmed';item.code='still-installed';
        }
        this.audit('uninstall-reconciled',{appId:target.id,previousCode,code:item.code});
      }
      this.blocked=this.job.items.some(item=>item.state==='unconfirmed');
      this.job.state=this.blocked?'unconfirmed':this.job.items.every(item=>['completed','reboot-required'].includes(item.state))?'completed':this.job.items.some(item=>['completed','reboot-required'].includes(item.state))?'partial':'failed';
      this.job.stage=this.job.state;
      if(!this.blocked)this.clearJournal();else this.saveJournal();
      this.cache=null;this.publish();
      try{await this.inventory(true);}catch(_){this.audit('inventory-refresh-failed',{code:'inventory-unavailable'});}
      return this.status();
    })();try{return await this.reconciling;}finally{this.reconciling=null;}
  }
  async run(selected,batch,authorize){
    try{for(let index=0;index<selected.length;index++){
      const target=selected[index],item=this.job.items[index];
      if(this.blocked||!authorize()){item.state='skipped';item.code=this.blocked?'operation-unconfirmed':'authentication-required';this.saveJournal();this.publish();continue;}
      try{target.cleanup=await this.leftovers.prepare(target.row,[...this.rows.values()]);}catch(_){target.cleanup=null;}
      if(!authorize()){item.state='skipped';item.code='authentication-required';this.saveJournal();this.publish();continue;}
      item.state='uninstalling';this.job.stage=target.row.type==='exe'&&!target.row.batchCapable?'waiting-windows':'removing';this.audit('application-started',{appId:target.id});this.saveJournal();this.publish();let outcome;
      try{outcome=await this.operation({action:'uninstall',locator:target.row.locator,fingerprint:target.row.fingerprint,ownerSid:target.row.ownerSid,batch});}catch(_){outcome={success:false,code:'operation-failed'};}
      target.outcome=outcome;item.hresult=/^0x[0-9a-f]{8}$/i.test(outcome.hresult||'')?outcome.hresult:undefined;
      if(['timed-out','still-running'].includes(outcome.code)){this.blocked=true;item.state='unconfirmed';item.code='operation-unconfirmed';}
      else {
        try {this.job.stage='verifying';this.saveJournal();this.publish();await this.inventory(true);if(target.row.type==='appx'&&!this.cache.packagesAvailable)throw Error('package-inventory-unavailable');const remains=[...this.rows.values()].some(row=>row.locator.scope===target.row.locator.scope&&row.locator.key===target.row.locator.key);
          item.state=outcome.code==='reboot-required'?'reboot-required':!remains&&['completed','not-installed'].includes(outcome.code)?'completed':'failed';
          item.code=remains&&outcome.code==='completed'?'removal-unconfirmed':outcome.code;
          if(item.code==='removal-unconfirmed'){this.blocked=true;item.state='unconfirmed';}
          if(item.state==='completed'&&target.cleanup)item.leftoverReceiptId=this.leftovers.confirmed(target.cleanup);
        }catch(_){if(['user-mismatch','access-denied','removal-denied','package-in-use','package-removal-failed','cancelled','uninstall-failed'].includes(outcome.code)){item.state='failed';item.code=outcome.code;}else{item.state='unconfirmed';item.code='verification-unavailable';this.blocked=true;}}
      }
      this.saveJournal();
      // Bounded secret-free audit; no PIN, raw registration command or paths.
      this.audit(item.state==='reboot-required'?'reboot-required':'application-finished',{appId:target.id,code:item.code,helperCode:outcome.code,hresult:item.hresult});this.publish();
    }}finally{this.busy=false;this.job.state=this.job.items.some(x=>x.state==='unconfirmed')?'unconfirmed':this.job.items.every(x=>['completed','reboot-required'].includes(x.state))?'completed':this.job.items.every(x=>['failed','skipped'].includes(x.state))?'failed':'partial';this.job.stage=this.job.state;if(!this.blocked&&['completed','failed','partial'].includes(this.job.state))this.clearJournal();else this.saveJournal();this.publish();}
  }
}
module.exports={AppManager,windowsOperation,validRow,publicApp,isOpaqueIdentifier,cleanPublisher};
