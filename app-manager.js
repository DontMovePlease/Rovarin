'use strict';
const { execFile } = require('child_process');
const crypto = require('crypto');
const path = require('path');
const CODES = new Set(['completed','reboot-required','not-installed','inventory-changed','unsupported','cancelled','access-denied','uninstall-failed','still-running','operation-failed']);
function windowsOperation(request, execute = execFile) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ success:false, code:'windows-only' });
    try {
      const child=execute(path.join(process.env.SystemRoot || 'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'scripts/app-manager.ps1')],
        {windowsHide:true,timeout:request.action==='inventory'?30000:110000,maxBuffer:4*1024*1024},(error,stdout)=>{
          try { const result=JSON.parse(String(stdout).trim()); if(error || (request.action==='inventory' ? result.success!==true||!Array.isArray(result.apps)||result.apps.length>2048 : !CODES.has(result.code)))throw Error();resolve(result); }
          catch(_){resolve({success:false,code:error?.killed?'timed-out':'operation-failed'});}
        });child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));
    }catch(_){resolve({success:false,code:'operation-failed'});}
  });
}
function validRow(row) {
  return row && ['user','machine64','machine32','appx'].includes(row.locator?.scope) && typeof row.locator.key==='string' && row.locator.key.length>0 && row.locator.key.length<=300 && !/[\\/\r\n]/.test(row.locator.key)
    && /^[a-f0-9]{64}$/.test(row.fingerprint) && typeof row.name==='string' && row.name.length>0 && ['msi','exe','appx','manual'].includes(row.type);
}
function publicApp(row,id) {
  const text=value=>typeof value==='string'?value.replace(/[\x00-\x1f\x7f]/g,' ').trim().slice(0,240):'';
  const description=text(row.description);
  const safeDescription=/[A-Za-z]:[\\/]|\\\\|(?:powershell|cmd\.exe|msiexec)\s/i.test(description)?'':description;
  const category=row.systemComponent===true?'system':row.locator?.scope==='appx'?'store':['user','machine64','machine32'].includes(row.locator?.scope)?'desktop':'other';
  const available=row.type!=='manual' && row.protected!==true;
  return {id,name:text(row.name),version:text(row.version),publisher:text(row.publisher),description:safeDescription,category,sizeKB:Number.isFinite(row.sizeKB)&&row.sizeKB>=0?row.sizeKB:null,installDate:text(row.installDate),type:row.type,uninstallCapable:available,batchCapable:available&&row.batchCapable===true,elevationLikely:row.elevationLikely===true,status:available?'available':'manual-only'};
}
class AppManager {
  constructor({operation=windowsOperation,onChange=()=>{}}={}) {this.operation=operation;this.onChange=onChange;this.key=crypto.randomBytes(32);this.rows=new Map();this.cache=null;this.loading=null;this.busy=false;this.blocked=false;this.job=null;this.history=[];}
  status(){return {busy:this.busy,blocked:this.blocked,job:this.job,history:this.history.slice(-20)};}
  publish(){this.onChange(this.status());}
  audit(event,details={}){this.history.push({at:Date.now(),event,...details});if(this.history.length>64)this.history.shift();}
  async inventory(force=false){
    if(!force&&this.cache&&Date.now()-this.cache.sampledAt<60000)return this.cache;
    if(this.loading)return this.loading;
    this.loading=(async()=>{const result=await this.operation({action:'inventory'});if(!result.success)throw Error(result.code);const next=new Map(),apps=[],dedupe=new Map();
      for(const row of result.apps){if(!validRow(row))continue;const id=crypto.createHmac('sha256',this.key).update(row.locator.scope+'|'+row.locator.key+'|'+row.fingerprint).digest('hex');
        // Dedupe only proven same registration/product identity, never unrelated
        // applications that happen to have the same display name.
        const duplicate=row.product?String(row.product).toLowerCase():row.locator.scope+'|'+row.locator.key.toLowerCase();if(dedupe.has(duplicate))continue;dedupe.set(duplicate,id);next.set(id,row);apps.push(publicApp(row,id));}
      this.rows=next;this.cache={apps,sampledAt:Date.now(),packagesAvailable:result.packagesAvailable===true};return this.cache;
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
module.exports={AppManager,windowsOperation,validRow,publicApp};
