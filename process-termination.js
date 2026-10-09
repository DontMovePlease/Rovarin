'use strict';
const { execFile } = require('child_process');
const path = require('path');

function terminateProcess(identity, execute = execFile, protectedPids = []) {
  return new Promise(resolve => {
    if (process.platform !== 'win32') return resolve({ success: false, code: 'unavailable' });
    try {
      const child = execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'),
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scripts', 'terminate-process.ps1')],
        { windowsHide: true, timeout: 15000, maxBuffer: 16384 }, (error, stdout) => {
          try {
            const result = JSON.parse(String(stdout).trim());
            const codes = ['terminated', 'already-exited', 'stale-process', 'access-denied', 'termination-unconfirmed', 'server-error'];
            if (error || !codes.includes(result.code) || result.success !== (result.code === 'terminated') || (result.success && result.verified !== true)) throw new Error();
            resolve({ success: result.success, code: result.code, verified: result.verified === true });
          } catch (_) { resolve({ success: false, code: 'termination-unconfirmed' }); }
        });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify({ ...identity, protectedPids }));
    } catch (_) { resolve({ success: false, code: 'server-error' }); }
  });
}
function processTree(identity,mode,protectedPids,execute=execFile) {
  return new Promise(resolve=>{
    if(process.platform!=='win32')return resolve({success:false,code:'unavailable',results:[],remaining:[]});
    try {
      const child=execute(path.join(process.env.SystemRoot||'C:\\Windows','System32/WindowsPowerShell/v1.0/powershell.exe'),['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'scripts/process-tree.ps1')],{windowsHide:true,timeout:20000,maxBuffer:131072},(error,stdout)=>{
        try{const result=JSON.parse(String(stdout).trim());if(error||!['tree-preview','tree-terminated','tree-partial','tree-unavailable','protected-process','stale-process','access-denied','already-exited'].includes(result.code)||!Array.isArray(result.results)||result.results.length>2048||!Array.isArray(result.remaining)||result.remaining.length>2048|| (result.code==='tree-terminated'&&(!result.success||!result.verified||result.remaining.length)))throw Error();if(result.code==='tree-preview'&&(!Array.isArray(result.members)||result.members.length<1||result.members.length>512||result.members.some(item=>!Number.isSafeInteger(item.pid)||typeof item.name!=='string'||typeof item.startedAt!=='string'||item.code!=='verified')))throw Error();resolve(result);}catch(_){resolve({success:false,code:'tree-unavailable',results:[],remaining:[],error:'The process tree could not be verified.'});}
      });child.stdin.on('error',()=>{});child.stdin.end(JSON.stringify({identity,mode,protectedPids}));
    }catch(_){resolve({success:false,code:'tree-unavailable',results:[],remaining:[]});}
  });
}
module.exports = { terminateProcess, processTree };
