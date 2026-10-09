 'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),{execFile}=require('child_process');
const TTL=24*60*60*1000,SCAN_TTL=15*60*1000;
const token=()=>crypto.randomBytes(16).toString('hex');
const inside=(p,r)=>p.toLowerCase()===r.toLowerCase()||p.toLowerCase().startsWith(r.toLowerCase()+path.sep);
const norm=s=>String(s||'').normalize('NFKC').toLowerCase().replace(/[\s._()-]/g,'');
function goodName(s){return typeof s==='string'&&s.length>=4&&s.length<120&&!/[\\/:*?"<>|\x00-\x1f]/.test(s)&&!new Set(['cache','data','temp','logs','shared','common','microsoft','windows','programs','applications','apps','users','system','packages','rovarin','pcmonitor','setup','uninstall','uninstaller','updater','update','launcher','installer','helper','service','settings','config','bin','backup','downloads','documents','desktop','pictures','videos','music','public','default','programdata','programfiles','local','roaming','localcache']).has(norm(s))&&/\p{L}/u.test(s);}
function nativeOperation(request){return new Promise(resolve=>{
 if(process.platform!=='win32')return resolve({success:false,code:'windows-only'});
 try{const child=execFile(path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'scripts/app-leftovers.ps1')],{windowsHide:true,timeout:45000,maxBuffer:8*1024*1024},(err,out)=>{try{if(err)throw err;const data=JSON.parse(String(out).trim());resolve(data);}catch(_){resolve({success:false,code:err?.killed?'timed-out':'operation-failed',unconfirmed:true});}});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(request));}catch(_){resolve({success:false,code:'operation-failed'});}
});}
class LeftoverManager {
 constructor({operation=nativeOperation,onChange=()=>{},roots={local:process.env.LOCALAPPDATA,roaming:process.env.APPDATA,programData:process.env.ProgramData},protectedRoots=[__dirname]}={}){this.operation=operation;this.onChange=onChange;this.roots=roots;this.protectedRoots=protectedRoots.filter(Boolean).map(p=>path.resolve(p));this.receipts=new Map();this.scans=new Map();this.busy=false;this.job=null;}
 prune(){const now=Date.now();for(const [id,r]of this.receipts)if(now-r.at>TTL)this.receipts.delete(id);for(const [id,s]of this.scans)if(now-s.at>SCAN_TTL)this.scans.delete(id);}
 status(){this.prune();return {busy:this.busy,job:this.job,offers:[...this.receipts].map(([id,r])=>({id,name:r.name,at:r.at}))};}
 async prepare(row,others){
  // Capture directory identity only, never enumerate contents or scan before the user asks.
  const paths=[],excluded=[];const add=(raw,source)=>{
   if(typeof raw!=='string'||!path.isAbsolute(raw))return;const p=path.resolve(raw);
   if(this.protectedRoots.some(r=>inside(p,r)||inside(r,p)))return;
   if(others.some(x=>x.locator.scope!==row.locator.scope||x.locator.key!==row.locator.key?x.installLocation&&path.isAbsolute(x.installLocation)&&(inside(p,path.resolve(x.installLocation))||inside(path.resolve(x.installLocation),p)):false)){excluded.push({location:this.location(p),reason:'Shared with another installed application'});return;}
   if(!paths.some(x=>inside(p,x.path))) {for(let i=paths.length-1;i>=0;i--)if(inside(paths[i].path,p))paths.splice(i,1);paths.push({path:p,source});}
  };
  const names=[row.name,...(Array.isArray(row.cleanupAliases)?row.cleanupAliases:[])].filter(goodName);
  if(row.installLocation&&goodName(path.basename(row.installLocation))&&names.some(n=>norm(n)===norm(path.basename(row.installLocation))))add(row.installLocation,'Installation folder');
  if(row.cleanupVerified===true){
   for(const root of Object.values(this.roots).filter(Boolean))for(const name of names){add(path.join(root,name),'Application data');if(goodName(row.publisher))add(path.join(root,row.publisher,name),'Application data');}
  }
  if(row.locator.scope==='appx'&&/^[a-zA-Z0-9._-]{4,180}$/.test(row.cleanupPackageFamily||'')&&this.roots.local)add(path.join(this.roots.local,'Packages',row.cleanupPackageFamily),'Packaged application data');
  if(paths.length>24)paths.length=24;
  let result={success:true,candidates:[],excluded:[]};if(paths.length)try{result=await this.operation({action:'capture',paths});}catch(_){result={success:false};}
  if(!result.success)excluded.push({location:'Application folders',reason:'Folder identity could not be captured safely'});
  return {name:row.name,locator:{...row.locator},packageFamily:row.cleanupPackageFamily||'',at:Date.now(),candidates:result.success&&Array.isArray(result.candidates)?result.candidates:[],excluded:[...excluded,...(result.excluded||[]).map(x=>({location:this.location(x.location),reason:'Missing, protected, redirected or inaccessible folder'}))]};
 }
 location(p){for(const [key,r]of Object.entries(this.roots))if(r&&inside(p,path.resolve(r)))return {local:'%LOCALAPPDATA%',roaming:'%APPDATA%',programData:'%PROGRAMDATA%'}[key]+p.slice(path.resolve(r).length);return p;}
 confirmed(prepared){this.prune();while(this.receipts.size>=20)this.receipts.delete(this.receipts.keys().next().value);const id=token();this.receipts.set(id,prepared);this.onChange();return id;}
 getReceipt(id){this.prune();if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id)||!this.receipts.has(id))throw Error('not-found');return this.receipts.get(id);}
 assertRemoved(receipt,rows){if(rows.some(x=>(x.locator.scope===receipt.locator.scope&&x.locator.key===receipt.locator.key)||(receipt.packageFamily&&x.cleanupPackageFamily===receipt.packageFamily)))throw Error('application-present');}
 eligible(receipt,rows,candidates){this.assertRemoved(receipt,rows);return candidates.filter(c=>!rows.some(x=>x.installLocation&&path.isAbsolute(x.installLocation)&&(inside(c.Path,path.resolve(x.installLocation))||inside(path.resolve(x.installLocation),c.Path))));}
 async scan(id,rows,authorize=()=>true){
  if(this.busy)throw Error('operation-running');const receipt=this.getReceipt(id);this.assertRemoved(receipt,rows);this.busy=true;this.onChange();
  try {const candidates=this.eligible(receipt,rows,receipt.candidates);const result=await this.operation({action:'scan',candidates});if(!authorize())throw Error('authentication-required');if(!result.success||!Array.isArray(result.manifests))throw Error(result.code||'scan-failed');
   const scanId=token();const manifests=result.manifests.filter(m=>candidates.some(c=>c.Path===m.Candidate?.Path&&c.Identity===m.Candidate.Identity));const preview={id:scanId,name:receipt.name,permanent:true,bytes:manifests.reduce((n,m)=>n+m.Bytes,0),fileCount:manifests.reduce((n,m)=>n+m.Files,0),candidates:manifests.map(m=>({id:token(),location:this.location(m.Candidate.Path),source:m.Candidate.Source,fileCount:m.Files,bytes:m.Bytes})),excluded:[...receipt.excluded,...(candidates.length<receipt.candidates.length?[{location:'Shared application folder',reason:'Now used by another installed application'}]:[]),...(result.excluded||[]).map(x=>({location:this.location(x.location),reason:x.reason==='scan-limit'?'Too large or deep to verify within the scan limit':'Cannot verify this entire folder safely'}))]};
   this.scans.set(scanId,{at:Date.now(),receiptId:id,manifests,preview});while(this.scans.size>20)this.scans.delete(this.scans.keys().next().value);return preview;
  }finally{this.busy=false;this.onChange();}
 }
 cancel(id){if(this.busy)throw Error('operation-running');if(!this.scans.delete(id))throw Error('not-found');return {success:true,code:'cancelled'};}
 startDelete(id,rows,authorize=()=>true){this.prune();if(this.busy)throw Error('operation-running');const scan=this.scans.get(id);if(!scan)throw Error('not-found');const receipt=this.getReceipt(scan.receiptId);this.assertRemoved(receipt,rows);if(!authorize())throw Error('authentication-required');this.scans.delete(id);this.busy=true;
  this.job={id:token(),state:'deleting',name:receipt.name,filesRemoved:0,filesSkipped:0,filesFailed:0,bytesRemoved:0,items:scan.manifests.map((m,i)=>({location:scan.preview.candidates[i].location,state:'queued',fileCount:m.Files}))};this.onChange();
  this.running=this.remove(scan,receipt,rows,authorize);return {success:true,code:'accepted',jobId:this.job.id};
 }
 async remove(scan,receipt,rows,authorize){
  try{for(let i=0;i<scan.manifests.length;i++){const m=scan.manifests[i],item=this.job.items[i];if(!authorize()||rows.some(x=>x.locator.scope===receipt.locator.scope&&x.locator.key===receipt.locator.key)||!this.eligible(receipt,rows,[m.Candidate]).length){item.state='skipped';item.reason='Session expired or application ownership changed';this.job.filesSkipped+=m.Files;this.onChange();continue;}
   item.state='deleting';this.onChange();let result;try{result=await this.operation({action:'delete',manifest:m,guard:{scope:receipt.locator.scope,key:receipt.locator.key,packageFamily:receipt.packageFamily}});}catch(_){result={success:false,code:'operation-failed',unconfirmed:true};}
   item.state=result.success===true&&result.folderRemoved===true?'completed':result.code==='skipped'?'skipped':'partial';item.details=(result.details||[]).map(x=>({location:x.location,reason:x.reason}));if(result.unconfirmed)item.reason='Cleanup result could not be fully verified. Scan again before retrying.';
   for(const field of ['filesRemoved','filesSkipped','filesFailed','bytesRemoved']){const value=result[field];if(Number.isSafeInteger(value)&&value>=0)this.job[field]+=value;}
   if(result.unconfirmed){this.job.unconfirmed=true;this.job.filesFailed+=m.Files;}
   this.onChange();
  }}catch(_){this.job.unconfirmed=true;for(const item of this.job.items)if(['queued','deleting'].includes(item.state)){item.state='skipped';item.reason='Cleanup stopped; scan again before retrying.';this.job.filesSkipped+=item.fileCount;}}finally{this.busy=false;this.job.state=this.job.items.every(x=>x.state==='completed')?'completed':'partial';if(this.job.state==='completed')this.receipts.delete(scan.receiptId);this.onChange();}
 }
}
module.exports={LeftoverManager,nativeOperation,goodName};
