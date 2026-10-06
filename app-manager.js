'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const CODES = new Set(['completed','reboot-required','not-installed','inventory-changed','unsupported','cancelled','access-denied','uninstall-failed','still-running','operation-failed','launched','launch-failed','limit-reached','already-pinned','pinned','unpinned','not-found','elevation-required','startup-changed','unavailable']);
function windowsOperation(request, execute = execFile) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ success:false, code:'windows-only' });
    try {
      const timeout = request.action === 'inventory' ? 30000 : ['startup-inventory', 'launch'].includes(request.action) ? 15000 : request.action === 'startup-toggle' ? 10000 : 110000;
      const child=execute(path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'scripts/app-manager.ps1')],
        {windowsHide:true,timeout,maxBuffer:8*1024*1024},(error,stdout)=>{
          try {
            const result=JSON.parse(String(stdout).trim());
            if (error) throw Error();
            if (request.action === 'inventory' && (result.success !== true || !Array.isArray(result.apps) || result.apps.length > 2048)) throw Error();
            if (request.action === 'startup-inventory' && (result.success !== true || !Array.isArray(result.items))) throw Error();
            if (!['inventory', 'startup-inventory'].includes(request.action) && !CODES.has(result.code)) throw Error();
            resolve(result);
          }
          catch(_){resolve({success:false,code:error?.killed?'timed-out':'operation-failed'});}
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
  const app = {
    id,
    name: displayName,
    version: text(row.version),
    publisher: cleanedPub,
    description: safeDescription,
    category,
    sizeKB: Number.isFinite(row.sizeKB) && row.sizeKB >= 0 ? row.sizeKB : null,
    sizeEstimated: row.sizeEstimated === true,
    hasIcon: Boolean(row.icon),
    installDate: text(row.installDate),
    type: row.type,
    uninstallCapable: available,
    batchCapable: available && row.batchCapable === true,
    elevationLikely: row.elevationLikely === true,
    status: available ? 'available' : 'manual-only',
    launchCapable: row.launchCapable === true
  };
  if (identifier) app.identifier = identifier;
  return app;
}
class AppManager {
  constructor({operation=windowsOperation,onChange=()=>{},stateDirectory=__dirname}={}) {
    this.operation=operation;
    this.onChange=onChange;
    this.stateDirectory=stateDirectory;
    this.quickLaunchFile=path.join(stateDirectory,'quick-launch.json');
    this.key=crypto.randomBytes(32);
    this.rows=new Map();
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
  }
  loadQuickLaunch(){
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
    try {
      const payload=JSON.stringify(this.quickLaunch,null,2);
      const tmp=`${this.quickLaunchFile}.${crypto.randomBytes(6).toString('hex')}.tmp`;
      fs.writeFileSync(tmp,payload,'utf8');
      fs.renameSync(tmp,this.quickLaunchFile);
    }catch(_){}
  }
  getQuickLaunch(){
    const pins=[];
    for(const pin of this.quickLaunch.pins){
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
    if(!force&&this.startupCache&&Date.now()-this.startupCache.sampledAt<30000)return this.startupCache;
    if(this.startupLoading)return this.startupLoading;
    this.startupLoading=(async()=>{
      const result=await this.operation({action:'startup-inventory'});
      if(!result.success)throw Error(result.code);
      const nextRows=new Map(),nextIcons=new Map(),items=[];
      for(const item of result.items){
        if(!item||!item.locator||typeof item.locator.source!=='string'||typeof item.locator.key!=='string')continue;
        const id=crypto.createHmac('sha256',this.key).update(item.locator.source+'|'+item.locator.key+'|'+(item.fingerprint||'')).digest('hex');
        nextRows.set(id,item);
        if(typeof item.icon==='string'&&item.icon.length>0&&item.icon.length<131072){
          try{nextIcons.set(id,Buffer.from(item.icon,'base64'));}catch(_){}
        }
        items.push({
          id,
          name:typeof item.name==='string'?item.name.slice(0,120):'',
          displayName:typeof item.displayName==='string'?item.displayName.slice(0,120):item.name,
          publisher:typeof item.publisher==='string'?item.publisher.slice(0,120):'',
          source:item.source,
          scope:item.scope,
          enabled:item.enabled===true,
          readOnly:item.readOnly===true,
          hasIcon:Boolean(item.icon)
        });
      }
      this.startupRows=nextRows;
      this.startupIconCache=nextIcons;
      this.startupCache={items,sampledAt:Date.now()};
      return this.startupCache;
    })();
    try{return await this.startupLoading;}finally{this.startupLoading=null;}
  }
  getStartupIcon(id){if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))return null;return this.startupIconCache.get(id)||null;}
  async toggleStartup(id,enabled){
    if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))throw Error('invalid-request');
    if(typeof enabled!=='boolean')throw Error('invalid-request');
    const item=this.startupRows.get(id);
    if(!item)throw Error('not-found');
    if(item.readOnly||!['registry-user','folder-user'].includes(item.locator.source))throw Error('elevation-required');
    const result=await this.operation({action:'startup-toggle',locator:item.locator,fingerprint:item.fingerprint,enabled});
    if(!result.success){const err=new Error(result.error||result.code);err.code=result.code;throw err;}
    item.enabled=enabled;
    if(this.startupCache&&Array.isArray(this.startupCache.items)){
      const cached=this.startupCache.items.find(x=>x.id===id);
      if(cached)cached.enabled=enabled;
    }
    this.audit('startup-toggled',{name:item.name,enabled});
    return {success:true,code:'startup-changed',enabled};
  }
  status(){return {busy:this.busy,blocked:this.blocked,job:this.job,history:this.history.slice(-20)};}
  publish(){this.onChange(this.status());}
  audit(event,details={}){this.history.push({at:Date.now(),event,...details});if(this.history.length>64)this.history.shift();}
  getIcon(id){if(typeof id!=='string'||!/^[a-f0-9]{64}$/.test(id))return null;return this.iconCache.get(id)||null;}
  async inventory(force=false){
    if(!force&&this.cache&&Date.now()-this.cache.sampledAt<60000)return this.cache;
    if(this.loading)return this.loading;
    this.loading=(async()=>{
      const request={action:'inventory',cachedSizes:Object.fromEntries(this.sizeCache)};
      const result=await this.operation(request);
      if(!result.success)throw Error(result.code);
      if(result.calculatedSizes&&typeof result.calculatedSizes==='object'){
        for(const [k,v] of Object.entries(result.calculatedSizes)){
          if(v&&Number.isFinite(v.sizeKB)&&Number.isFinite(v.mtime))this.sizeCache.set(k,{sizeKB:v.sizeKB,mtime:v.mtime});
        }
        while(this.sizeCache.size>2048)this.sizeCache.delete(this.sizeCache.keys().next().value);
      }
      const next=new Map(),apps=[],dedupe=new Map(),nextIcons=new Map();
      for(const row of result.apps){if(!validRow(row))continue;const id=crypto.createHmac('sha256',this.key).update(row.locator.scope+'|'+row.locator.key+'|'+row.fingerprint).digest('hex');
        // Dedupe only proven same registration/product identity, never unrelated
        // applications that happen to have the same display name.
        const duplicate=row.product?String(row.product).toLowerCase():row.locator.scope+'|'+row.locator.key.toLowerCase();if(dedupe.has(duplicate))continue;dedupe.set(duplicate,id);next.set(id,row);
        if(typeof row.icon==='string'&&row.icon.length>0&&row.icon.length<131072){try{nextIcons.set(id,Buffer.from(row.icon,'base64'));}catch(_){}}
        apps.push(publicApp(row,id));}
      this.rows=next;this.iconCache=nextIcons;this.cache={apps,sampledAt:Date.now(),packagesAvailable:result.packagesAvailable===true};return this.cache;
    })();try{return await this.loading;}finally{this.loading=null;}
  }
  async start(ids,batch,authorize=()=>true){
    if(this.busy||this.blocked)throw Error(this.blocked?'operation-unconfirmed':'operation-running');
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
      this.job={id:crypto.randomBytes(16).toString('hex'),batch,state:'running',items:selected.map(x=>({id:x.id,name:x.row.name,state:'queued'}))};this.publish();
      const jobId=this.job.id;this.running=this.run(selected,batch,authorize);return {success:true,code:'accepted',jobId};
    }catch(error){this.busy=false;throw error;}
  }
  async run(selected,batch,authorize){
    try{for(let index=0;index<selected.length;index++){
      const target=selected[index],item=this.job.items[index];
      if(this.blocked||!authorize()){item.state='skipped';item.code=this.blocked?'operation-unconfirmed':'authentication-required';this.publish();continue;}
      item.state='uninstalling';this.audit('application-started',{appId:target.id});this.publish();let outcome;
      try{outcome=await this.operation({action:'uninstall',locator:target.row.locator,fingerprint:target.row.fingerprint,batch});}catch(_){outcome={success:false,code:'operation-failed'};}
      if(['timed-out','still-running'].includes(outcome.code)){this.blocked=true;item.state='failed';item.code='operation-unconfirmed';}
      else {
        try {await this.inventory(true);const remains=[...this.rows.values()].some(row=>row.locator.scope===target.row.locator.scope&&row.locator.key===target.row.locator.key);
          item.state=outcome.code==='reboot-required'?'reboot-required':!remains&&['completed','not-installed'].includes(outcome.code)?'completed':'failed';
          item.code=remains&&outcome.code==='completed'?'removal-unconfirmed':outcome.code;
          if(item.code==='removal-unconfirmed')this.blocked=true;
        }catch(_){item.state='failed';item.code='verification-unavailable';this.blocked=true;}
      }
      // Bounded secret-free audit; no PIN, raw registration command or paths.
      this.audit(item.state==='reboot-required'?'reboot-required':'application-finished',{appId:target.id,code:item.code});this.publish();
    }}finally{this.busy=false;this.job.state=this.job.items.every(x=>['completed','reboot-required'].includes(x.state))?'completed':'partial';this.publish();}
  }
}
module.exports={AppManager,windowsOperation,validRow,publicApp,isOpaqueIdentifier,cleanPublisher};
