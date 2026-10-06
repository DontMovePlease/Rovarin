'use strict';

function parseCpuSeconds(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function isSameProcessInstance(current, previous) {
  return Boolean(current && previous
    && current.pid === previous.pid
    && current.name === previous.name
    && typeof current.startedAt === 'string'
    && current.startedAt.length > 0
    && current.startedAt === previous.startedAt);
}

function normalizeProcessRecords(records, previousCpuTimes, sampledAt, logicalProcessors) {
  const nextCpuTimes = new Map();
  const processes = [];
  if (!Array.isArray(records)) return { processes, nextCpuTimes };

  for (const record of records) {
    if (!record || (typeof record.Id !== 'number' && typeof record.Id !== 'string')) continue;
    const pid = Number(record.Id);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const name = String(record.ProcessName || 'Unknown').slice(0, 128);
    const cpuSeconds = parseCpuSeconds(record.CPU);
    const ramRaw = record.WorkingSet64;
    const ramBytes = typeof ramRaw === 'number' || (typeof ramRaw === 'string' && ramRaw.trim() !== '') ? Number(ramRaw) : NaN;
    if (!Number.isFinite(ramBytes) || ramBytes < 0) continue;
    const startedAt = typeof record.StartedAt === 'string' && record.StartedAt ? record.StartedAt : null;
    const currentIdentity = { pid, name, startedAt };
    const previous = previousCpuTimes.get(pid);
    const sameProcess = cpuSeconds !== null && startedAt && isSameProcessInstance(currentIdentity, previous) && cpuSeconds >= previous.cpuSeconds;
    const cpuPercent = cpuSeconds === null || !startedAt ? null : sameProcess
      ? calculateCpuPercent(cpuSeconds, previous.cpuSeconds, sampledAt - previous.sampledAt, logicalProcessors)
      : 0;
    if (cpuSeconds !== null && startedAt) nextCpuTimes.set(pid, { ...currentIdentity, cpuSeconds, sampledAt });
    processes.push({ name, pid, cpuPercent, ramMB: Math.round((ramBytes / (1024 ** 2)) * 10) / 10, startedAt });
  }

  processes.sort((a, b) => ((b.cpuPercent ?? -1) - (a.cpuPercent ?? -1)) || (b.ramMB - a.ramMB));
  return { processes, nextCpuTimes };
}

function isProcessSnapshotStale(sampledAt, now, staleAfterMs) {
  return !Number.isFinite(sampledAt) || sampledAt <= 0
    || !Number.isFinite(now) || !Number.isFinite(staleAfterMs) || staleAfterMs < 0
    || now - sampledAt > staleAfterMs;
}

function calculateCpuPercent(cpuSeconds, previousCpuSeconds, elapsedMs, logicalProcessors) {
  if (!Number.isFinite(cpuSeconds) || cpuSeconds < 0 || !Number.isFinite(previousCpuSeconds) || previousCpuSeconds < 0) return 0;
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0 || cpuSeconds < previousCpuSeconds) return 0;
  const cores = Number.isInteger(logicalProcessors) && logicalProcessors > 0 ? logicalProcessors : 1;
  const elapsedSeconds = elapsedMs / 1000;
  return Math.round(Math.max(0, Math.min(100, ((cpuSeconds - previousCpuSeconds) / elapsedSeconds) * (100 / cores))) * 10) / 10;
}

// Bounded exit verification. Never signals a still-present PID again: it may
// already identify a different process. No telemetry loop is created.
async function verifyProcessExit(pid, { probe = target => process.kill(target, 0), timeoutMs = 2000, pause = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  const checks = Math.max(1, Math.ceil(timeoutMs / 100));
  for (let index = 0; index <= checks; index++) {
    try { probe(pid); }
    catch (error) { return error.code === 'ESRCH' ? 'exited' : 'unconfirmed'; }
    if (index < checks) await pause(100);
  }
  return 'still-running';
}

module.exports = { calculateCpuPercent, parseCpuSeconds, isSameProcessInstance, normalizeProcessRecords, isProcessSnapshotStale, verifyProcessExit };

// Display metadata is never a process identity or a termination input.
function friendlyProcessName(metadata, fallback) {
  const clean=value=>typeof value==='string'?value.trim().replace(/[\x00-\x1f\x7f]/g,'').slice(0,180):'';
  const product=clean(metadata?.productName);
  const pkg=clean(metadata?.packageName).replace(/\s+version\s+[\d.]+.*$/i,'');
  return pkg || (/^(Microsoft.*Windows.*Operating System|Microsoft.*Windows.*Betriebssystem)$/i.test(product)?'':product) || clean(metadata?.fileDescription) || clean(metadata?.serviceName) || fallback;
}
class ProcessDisplayCache {
  constructor({resolve,stat=require('fs').statSync,now=Date.now}={}){this.entries=new Map();this.resolve=resolve||resolveProcessDisplay;this.stat=stat;this.now=now;this.busy=false;this.groupSecret=require('crypto').randomBytes(32);}
  cached(records){const output=new Map();output.metadataAvailable=new Set();output.groupKeys=new Map();for(const row of records){const identity=row.Id+'|'+row.ProcessName+'|'+row.StartedAt;const key=row.ExecutablePath?row.ExecutablePath.toLowerCase():identity;const metadata=this.entries.get(key)?.metadata;output.set(identity,friendlyProcessName(metadata,row.ProcessName));if(friendlyProcessName(metadata,'')){output.metadataAvailable.add(identity);if(row.ExecutablePath&&!/^(node|python.*|powershell|pwsh|cmd|svchost|rundll32|dllhost|msedgewebview2|cefsharp.*)$/i.test(row.ProcessName)){const source=metadata?.groupSource||key;output.groupKeys.set(identity,require('crypto').createHmac('sha256',this.groupSecret).update(source).digest('hex'));}}}return output;}
  async enrich(records){
    const output=new Map(),misses=[],now=this.now();output.metadataAvailable=new Set();
    for(const row of records){if(!row.StartedAt)continue;const identity=row.Id+'|'+row.ProcessName+'|'+row.StartedAt;
      const file=typeof row.ExecutablePath==='string'?row.ExecutablePath:'';const key=file?file.toLowerCase():identity;
      let entry=this.entries.get(key);
      if(!entry||now-entry.checkedAt>=60000){let stamp='unavailable';if(file){try{const info=this.stat(file);stamp=info.size+'|'+info.mtimeMs}catch{}}
        if(!entry||entry.stamp!==stamp||now-entry.resolvedAt>=600000){entry={stamp,checkedAt:now,resolvedAt:0,metadata:null};this.entries.set(key,entry);}else entry.checkedAt=now;
      }
      if(entry.metadata===null&&misses.length<50)misses.push({key,path:file,pid:Number(row.Id),name:row.ProcessName,startedAt:row.StartedAt});
      output.set(identity,friendlyProcessName(entry.metadata,row.ProcessName));if(friendlyProcessName(entry.metadata,''))output.metadataAvailable.add(identity);
    }
    if(!this.busy&&misses.length){this.busy=true;try{const distinct=[...new Map(misses.map(x=>[x.key,x])).values()];const answers=await this.resolve(distinct);
      for(const request of distinct){const entry=this.entries.get(request.key);if(!entry)continue;entry.metadata=answers.find(x=>x.key===request.key)||{};entry.resolvedAt=this.now();}
      for(const row of records){const identity=row.Id+'|'+row.ProcessName+'|'+row.StartedAt;const key=row.ExecutablePath?row.ExecutablePath.toLowerCase():identity;output.set(identity,friendlyProcessName(this.entries.get(key)?.metadata,row.ProcessName));if(friendlyProcessName(this.entries.get(key)?.metadata,''))output.metadataAvailable.add(identity);}
    }catch{}finally{this.busy=false;}}
    while(this.entries.size>1024)this.entries.delete(this.entries.keys().next().value);return this.cached(records);
  }
}
function resolveProcessDisplay(requests){return new Promise(resolve=>{try{const child=require('child_process').execFile(require('path').join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',require('path').join(__dirname,'scripts/process-display.ps1')],{windowsHide:true,timeout:5000,maxBuffer:128*1024},(error,stdout)=>{try{const data=JSON.parse(stdout);resolve(!error&&Array.isArray(data)?data:[])}catch{resolve([])}});child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify(requests));}catch{resolve([])}});}
module.exports.friendlyProcessName=friendlyProcessName;
module.exports.ProcessDisplayCache=ProcessDisplayCache;
