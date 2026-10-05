'use strict';
const assert=require('assert'),{spawn,execFile}=require('child_process'),path=require('path');
const {processTree}=require('../process-termination');
const children=[];
const fs=require('fs'),os=require('os');
async function policyFixtures(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-tree-policy-'));
 try{let code=fs.readFileSync(path.join(__dirname,'process-tree.cs'),'utf8').replace(/^    \[DllImport[^\n]+\n/gm,'');
 code=code.replace(/    static List<Entry> Snapshot\(\) \{[\s\S]*?    static Node Open/,`    public static int Mode=0;public static HashSet<int> killed=new HashSet<int>();
    static List<Entry> Snapshot(){return new List<Entry>{new Entry{pid=100,parent=0,exe="node.exe"},new Entry{pid=200,parent=100,exe="node.exe"},new Entry{pid=300,parent=200,exe="node.exe"},new Entry{pid=400,parent=0,exe="unrelated.exe"}};}
    static IntPtr OpenProcess(uint a,bool i,int p){return new IntPtr(p);}
    static bool GetProcessTimes(IntPtr h,out long c,out long e,out long k,out long u){int p=h.ToInt32();c=(Mode==2&&p==300)?50:p;e=killed.Contains(p)?c+1000:0;k=u=0;return true;}
    static bool QueryFullProcessImageName(IntPtr h,uint f,StringBuilder n,ref uint s){n.Append("node.exe");return true;}
    static bool IsProcessCritical(IntPtr h,out bool critical){critical=Mode==3&&h.ToInt32()==300;return true;}
    static bool TerminateProcess(IntPtr h,uint c){int p=h.ToInt32();if(Mode==1&&p==200)return false;killed.Add(p);return true;}
    static uint WaitForSingleObject(IntPtr h,uint ms){return killed.Contains(h.ToInt32())?0u:258u;}
    static bool CloseHandle(IntPtr h){return true;}
    static Node Open`);
 if(code.includes('DllImport'))throw Error('Native mock boundary incomplete');
 const file=path.join(directory,'fixture.ps1');fs.writeFileSync(file,"Add-Type -TypeDefinition @'\n"+code+"\n'@\n"+`
[RovarinProcessTree]::Mode=1
$r=[RovarinProcessTree]::Run(100,'node',100,@(),$true)
if($r.code -ne 'tree-partial' -or $r.verified -or $r.remaining -notcontains 200 -or -not [RovarinProcessTree]::killed.Contains(100) -or [RovarinProcessTree]::killed.Contains(400)){throw 'Partial/access denied result failed'}
[RovarinProcessTree]::killed.Clear();[RovarinProcessTree]::Mode=2
$r=[RovarinProcessTree]::Run(100,'node',100,@(),$true)
if(-not $r.verified -or [RovarinProcessTree]::killed.Contains(300) -or [RovarinProcessTree]::killed.Contains(400)){throw 'Reused parent lifetime protection failed'}
[RovarinProcessTree]::killed.Clear();[RovarinProcessTree]::Mode=3
$r=[RovarinProcessTree]::Run(100,'node',100,@(),$true)
if($r.code -ne 'protected-process' -or [RovarinProcessTree]::killed.Count -ne 0){throw 'Critical descendant not fail closed'}
'PASS production tree logic with controlled native boundary: partial access denial, parent-PID reuse lifetime and critical descendant protection'
`);
 const output=await new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',file],{windowsHide:true,timeout:15000},(e,s)=>e?reject(Error('Tree native-boundary fixture failed: '+String(s).slice(0,1000))):resolve(s)));console.log(output.trim());
 }finally{fs.rmSync(directory,{recursive:true,force:true});}
}

function disposable(code){const child=spawn(process.execPath,['-e',code],{windowsHide:true,stdio:['ignore','pipe','pipe']});children.push(child);return child;}
function ready(child){return new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Disposable tree did not start')),10000);child.stdout.once('data',data=>{clearTimeout(timer);resolve(JSON.parse(data.toString()));});child.once('error',reject);});}
function identity(pid){return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-Command',`$p=Get-Process -Id ${pid}; @{pid=$p.Id;name=$p.ProcessName;startedAt=$p.StartTime.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress`],{windowsHide:true,timeout:10000},(e,s)=>e?reject(e):resolve(JSON.parse(s))));}
function alive(pid){try{process.kill(pid,0);return true;}catch(e){return e.code!=='ESRCH';}}
(async()=>{
 await policyFixtures();
 const unrelated=disposable('setInterval(()=>{},1000)');
 const descendantCode=`const {spawn}=require('child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});console.log(JSON.stringify({child:process.pid,grandchild:c.pid}));setInterval(()=>{},1000);`;
 const root=disposable(`const {spawn}=require('child_process');const c=spawn(process.execPath,['-e',${JSON.stringify(descendantCode)}],{windowsHide:true,stdio:['ignore','pipe','ignore']});c.stdout.once('data',data=>console.log(data.toString().trim()));setInterval(()=>{},1000);`);
 const ids=await ready(root),target=await identity(root.pid);try{
   let result=await processTree({...target,startedAt:'2001-01-01T00:00:00.0000000Z'},'terminate',[]);assert.equal(result.code,'stale-process');assert(alive(root.pid)&&alive(ids.child)&&alive(unrelated.pid));
   result=await processTree(target,'preview',[]);assert.equal(result.code,'tree-preview');assert(result.descendantCount>=2,'both known descendants are discovered, including Windows-owned console hosts where present');assert(alive(root.pid)&&alive(ids.child));
   result=await processTree(target,'terminate',[ids.grandchild]);assert.equal(result.code,'protected-process');assert(alive(root.pid)&&alive(ids.child)&&alive(ids.grandchild),'protected descendant rejects tree before any signal');
   result=await processTree(target,'terminate',[]);assert.equal(result.code,'tree-terminated',JSON.stringify(result));assert(result.verified);assert.equal(result.remaining.length,0);assert(result.results.some(x=>x.pid===ids.grandchild&&['terminated','already-exited'].includes(x.code)));assert.equal(result.results.at(-1).pid,root.pid,'deepest first, root last');assert(!alive(root.pid)&&!alive(ids.child)&&!alive(ids.grandchild));assert(alive(unrelated.pid),'unrelated process survives');
   result=await processTree(target,'terminate',[]);assert.equal(result.code,'already-exited');
   let input;result=await processTree(target,'terminate',[],(exe,args,options,cb)=>{assert(!options.shell&&options.timeout<=20000);setImmediate(()=>cb(null,'not-json'));return {stdin:{on(){},end(value){input=JSON.parse(value);}}};});assert.equal(result.code,'tree-unavailable');assert.deepEqual(input.identity,target);assert.equal(input.mode,'terminate');
   console.log('PASS real Windows root/child/grandchild preview, deepest-first termination, unrelated survivor, stale identity, protected descendant fail-closed, already-exited and malformed helper output.');
 }finally{for(const pid of [ids.child,ids.grandchild])if(alive(pid))process.kill(pid);}
})().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(async()=>{for(const child of children){if(child.exitCode===null&&child.signalCode===null){const exit=new Promise(r=>child.once('exit',r));child.kill();await exit;}}});
