// Safe maintenance integration smoke test. All OS commands and temp-file access are mocked.
const assert = require('assert');
const EventEmitter = require('events');
const Module = require('module');
const realFs = require('fs');
const realOs = require('os');
const childProcess = require('child_process');

const mockState = { failDism: false, failRecycle: false, adminChecks: 0, spawnFailure: null, recycleResult:null, commandError:null, noTemp:false };
const mockedFs = Object.assign({}, realFs, {
  existsSync: () => false,
  readdirSync: () => [],
  statSync: () => ({ isFile: () => false, isDirectory: () => false, size: 0 }),
  unlinkSync: () => {},
  rmSync: () => {}
});
mockedFs.promises = { access: async directory => { if(mockState.noTemp || directory !== 'C:\\mock-temp') throw new Error('missing fixture'); }, readdir: async () => { if(mockState.noTemp)throw new Error('access denied');return Array.from({length:mockState.cleanupItems || 0}, (_,i)=>'fixture-'+i); }, lstat: async () => { await new Promise(resolve => setImmediate(resolve)); return { isSymbolicLink: () => false, isFile: () => true, isDirectory: () => false, size: 1 }; }, unlink: async () => {}, rm: async () => {} };
const mockedOs = Object.assign({}, realOs, { tmpdir: () => 'C:\\mock-temp' });

function getCallback(args) { return args.findLast(value => typeof value === 'function'); }
function mockedExecFile(command, ...args) {
  const callback = getCallback(args);
  if (!callback) throw new Error('Test mock expected an execFile callback');
  setImmediate(() => {
    if (command === 'net') { mockState.adminChecks++; return callback(null, 'admin'); }
    if (command === 'powershell.exe') {
      const joined = args.flat(Infinity).filter(value => typeof value === 'string').join(' ');
      if (joined.includes('empty-recycle-bin.ps1')) {
        const result = mockState.recycleResult || (mockState.failRecycle
          ? { success: false, code:'items-remain', before: 1, remaining: 1, verified:true }
          : { success: true, code:'emptied', before: 2, remaining: 0, verified:true });
        return callback(mockState.commandError, typeof result === 'string' ? result : JSON.stringify(result), '');
      }
      if (mockState.commandError) return callback(mockState.commandError,'','');
      if (joined.includes('EXPLORER_OK')) return callback(null, 'EXPLORER_OK', '');
      return callback(null, '', '');
    }
    return callback(mockState.commandError, 'mock command completed', '');
  });
}

function mockedSpawn(command, args) {
  if (mockState.spawnFailure === 'throws') throw Object.assign(new Error('test missing tool'), { code: 'ENOENT' });
  const proc = new EventEmitter();
  proc.kill = () => { proc.emit('close', -1); };
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  setImmediate(() => {
    if (mockState.spawnFailure === 'missing') { proc.emit('error', Object.assign(new Error('test missing tool'), { code: 'ENOENT' })); proc.emit('close', -1); return; }
    if (command === 'dism' && mockState.failDism && args.includes('/checkhealth')) {
      proc.stderr.emit('data', Buffer.from('Error 740: elevated permissions required'));
      proc.emit('close', 740);
      return;
    }
    const output = command === 'sfc'
      ? 'Windows Resource Protection did not find any integrity violations.\r'
      : 'No component store corruption detected.\r';
    proc.stdout.emit('data', Buffer.from(output));
    proc.emit('close', 0);
  });
  return proc;
}

const mockChildProcess = Object.assign({}, childProcess, { execFile: mockedExecFile, spawn: mockedSpawn });
const originalLoad = Module._load;
Module._load = function(request, parent, isMain) {
  if (request === 'fs') return mockedFs;
  if (request === 'os') return mockedOs;
  if (request === 'child_process') return mockChildProcess;
  return originalLoad.call(this, request, parent, isMain);
};

const { ACTIONS, runAction, getStatus } = require('../maintenance');
Module._load = originalLoad;

function run(actionId) {
  return new Promise((resolve, reject) => {
    const started = runAction(actionId, () => {}, resolve);
    if (!started.success) reject(new Error(`${actionId} refused to start: ${started.error}`));
  });
}

async function main() {
  const checksBefore = mockState.adminChecks;
  await Promise.all(Array.from({ length: 8 }, () => new Promise(resolve => getStatus(resolve))));
  assert.strictEqual(mockState.adminChecks - checksBefore, 1, 'concurrent status requests should share one admin check');
  console.log('PASS concurrent maintenance status requests share one admin check');

  for (const actionId of Object.keys(ACTIONS)) {
    mockState.failDism = false;
    mockState.failRecycle = false;
    const task = await run(actionId);
    assert.strictEqual(task.status, 'completed', `${actionId} should report success for successful mock commands: ${task.result?.summary || 'no result'}`);
    assert.strictEqual(task.result.success, true, `${actionId} result.success should be true`);
    console.log(`PASS ${actionId}`);
  }

  mockState.failRecycle = true;
  mockState.cleanupItems = 1000;
  let responsive = false;
  setImmediate(() => { responsive = true; });
  const cleanup = await run('clean_temp');
  assert(responsive, 'large cleanup must yield to request/event-loop work');
  assert.strictEqual(cleanup.result.detailedResult.deletedCount, 1000);
  mockState.cleanupItems = 0;
  console.log('PASS large mocked temporary cleanup yields and preserves deletion results');
  const recycleFailure = await run('empty_recycle_bin');
  assert.strictEqual(recycleFailure.status, 'failed', 'Recycle Bin must fail when items remain');
  assert.match(recycleFailure.result.summary, /not confirmed empty/i);
  console.log('PASS empty_recycle_bin rejects an unverifiable/partial clear');

  mockState.failDism = true;
  const dismFailure = await run('dism_check');
  assert.strictEqual(dismFailure.status, 'failed', 'DISM must fail when CheckHealth exits nonzero');
  assert.match(dismFailure.result.summary, /CheckHealth failed/);
  console.log('PASS dism_check reports the failing DISM stage and exit code');
  mockState.failDism = false;
  for (const failure of ['missing', 'throws']) {
    mockState.spawnFailure = failure;
    const task = await run('dism_check');
    assert.strictEqual(task.status, 'failed');
    assert.strictEqual(task.result.success, false);
    console.log('PASS maintenance tool ' + failure + ' degrades without an uncaught exception');
  }
  const vm = require('vm'), path = require('path');
  const isolated = { process, __dirname:path.resolve(__dirname,'..'), setTimeout, clearTimeout, module: { exports: {} }, require: name => name === 'child_process' ? { ...mockChildProcess, execFile() { throw Object.assign(new Error('test admin probe missing'), { code: 'ENOENT' }); } } : require(name.startsWith('.') ? path.resolve(__dirname, '..', name) : name) };
  vm.runInNewContext(realFs.readFileSync(require('path').join(__dirname, '..', 'maintenance.js'), 'utf8'), isolated);
  const denied = await new Promise(resolve => isolated.module.exports.getStatus(resolve));
  assert.strictEqual(denied.isAdmin, false);
  const retried = await new Promise(resolve => isolated.module.exports.getStatus(resolve));
  assert.strictEqual(retried.isAdmin, false, 'failed admin probe does not strand status callbacks');
  console.log('PASS synchronous administrator probe failure drains callbacks and fails closed');
  mockState.spawnFailure = null;
  mockState.failRecycle = false;
  for (const [code,success] of [['already-empty',true],['emptied',true],['verification-unavailable',true],['items-remain',false],['permission-denied',false],['tool-unavailable',false],['clear-failed',false]]) {
    mockState.recycleResult={code,success,verified:code !== 'verification-unavailable'};
    const task=await run('empty_recycle_bin');
    assert.strictEqual(task.result.success,success); assert.strictEqual(task.result.detailedResult.code,code);
  }
  for (const [output,error,code] of [['bad JSON',null,'invalid-output'],['{}',null,'invalid-output'],['{"success":true,"code":"items-remain"}',null,'invalid-output'],['',Object.assign(new Error('missing'),{code:'ENOENT'}),'tool-unavailable'],['',Object.assign(new Error('denied'),{code:'EACCES'}),'permission-denied'],['',Object.assign(new Error('denied'),{code:'EPERM'}),'permission-denied'],['',Object.assign(new Error('timeout'),{killed:true}),'timeout']]) {
    mockState.recycleResult=output || ' ';mockState.commandError=error;
    const task=await run('empty_recycle_bin');assert(!task.result.success);assert.strictEqual(task.result.detailedResult.code,code);
  }
  mockState.recycleResult={success:true,code:'emptied'}; mockState.commandError=new Error('confirmed failure');
  assert(!(await run('empty_recycle_bin')).result.success,'confirmed command failure cannot claim success');
  mockState.recycleResult=null;
  for(const action of ['clear_dns','reset_network','renew_network','restart_explorer']) {
    for(const code of ['ENOENT','EACCES','ETIMEDOUT']){
      mockState.commandError=Object.assign(new Error(code),{code});assert(!(await run(action)).result.success,action+' must reject '+code);
    }
  }
  mockState.commandError=null;mockState.noTemp=true;
  assert.strictEqual((await run('clean_temp')).result.detailedResult.code,'scan-unavailable');mockState.noTemp=false;
  for(const action of ['windows_repair','sfc_scan','dism_check']) {
    mockState.spawnFailure='missing';assert(!(await run(action)).result.success);
  }
  mockState.spawnFailure=null;
  assert.strictEqual((await run('clear_dns')).status,'completed','failure must not strand the operation gate');
  assert.strictEqual(denied.isAdmin,false);
  const deniedTask=await new Promise(resolve=>isolated.module.exports.runAction('reset_network',()=>{},resolve));
  assert(!deniedTask.result.success,'admin action must fail closed');
  let timedOutChildren=0;
  const timed={__dirname,process,console,module:{exports:{}},setTimeout:(fn,ms)=>setTimeout(fn,ms===30*60*1000?1:ms),clearTimeout,require:name=>name==='child_process'?{...mockChildProcess,spawn(){const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{timedOutChildren++;child.emit('close',-1);};return child;}}:require(name.startsWith('.') ? path.resolve(__dirname, '..', name) : name)};
  vm.runInNewContext(realFs.readFileSync(require('path').join(__dirname,'..','maintenance.js'),'utf8'),timed);
  for(const action of ['windows_repair','sfc_scan','dism_check']){const task=await new Promise(resolve=>timed.module.exports.runAction(action,()=>{},resolve));assert(!task.result.success);}
  assert.strictEqual(timedOutChildren,3,'each live command timeout stops its one owned child');
  console.log('PASS maintenance JSON/result mapping, missing/permission/timeout failures, temp scan failure, admin denial and recovery');
  await testElevation();
  await testNativeElevationBroker();
  testRecycleHelper();
  await testWatchdogOrdering();
  await testServiceIntegration();
}

async function testElevation() {
  const vm=require('vm'), path=require('path');
  const source=realFs.readFileSync(path.join(__dirname,'..','maintenance.js'),'utf8');
  async function scenario(mode) {
    let child, elevated=0, normal=0;
    const commands=[];
    const fakeFs={...mockedFs,mkdtempSync:()=>path.join(realOs.tmpdir(),'rovarin-maintenance-test-owned'),rmSync:()=>{}};
    const cp={...mockChildProcess,
      execFile(command,args,options,done) {
        if(command==='net')return setImmediate(()=>done(new Error('standard user')));
        if(command.endsWith('csc.exe'))return setImmediate(()=>done(mode==='compile-failed'?new Error('missing compiler'):null,''));
        normal++;setImmediate(()=>done(null,'command completed',''));
      },
      spawn(command,args,options) {
        elevated++;commands.push({command,args,options});
        child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>setImmediate(()=>child.emit('close',-1));
        setImmediate(()=>{
          if(mode==='hold'||mode==='timeout')return;
          if(mode==='error')return child.emit('error',new Error('spawn failed'));
          if(mode==='crash')return child.emit('close',1);
          if(mode==='malformed'){child.stdout.emit('data',Buffer.from('not JSON\n'));return;}
          const code=mode==='cancel'?'uac-cancelled':mode==='failed'?'operation-failed':mode==='partial'?'partially-completed':'completed';
          child.stdout.emit('data',Buffer.from(JSON.stringify({type:'progress',action:args[0],step:0,total:1,message:'Waiting for administrator approval'})+'\n'));
          child.stdout.emit('data',Buffer.from(JSON.stringify({type:'result',action:args[0],success:code==='completed'||code==='partially-completed',code,summary:code==='uac-cancelled'?'Administrator approval was cancelled.':'Test completion',exitCode:code==='completed'||code==='partially-completed'?0:null})+'\n'));
          child.emit('close',mode==='failed'?1:0);
        });return child;
      }
    };
    const context={process,__dirname:path.resolve(__dirname,'..'),console,setTimeout:mode==='timeout'?(fn,ms)=>setTimeout(fn,ms===32*60*1000?1:ms):setTimeout,clearTimeout,module:{exports:{}},require:name=>name==='fs'?fakeFs:name==='os'?mockedOs:name==='child_process'?cp:require(name.startsWith('.') ? path.resolve(__dirname, '..', name) : name)};
    vm.runInNewContext(source,context);
    const maintenance=context.module.exports;
    assert.strictEqual(maintenance.runAction('__proto__').success,false);
    assert.strictEqual(maintenance.ACTIONS.clear_dns.requiresAdmin,true,'Windows DNS cache flushing requires per-action administrator approval');
    const normalTask=await new Promise(resolve=>maintenance.runAction('renew_network',()=>{},resolve));
    assert(normalTask.result.success);assert.strictEqual(elevated,0);assert.strictEqual(normal,1);
    const pending=new Promise(resolve=>maintenance.runAction('dism_check',()=>{},resolve));
    assert.strictEqual(maintenance.runAction('sfc_scan').success,false,'duplicates are blocked during approval/preparation');
    if(mode==='hold'){await new Promise(resolve=>setImmediate(resolve));await new Promise(resolve=>setImmediate(resolve));child.kill();}
    const keepAlive=setInterval(()=>{},1000);
    let task;try {task=await pending;}finally {clearInterval(keepAlive);}
    assert.strictEqual(task.result.success,mode==='ok');
    if(mode==='cancel'){assert.strictEqual(task.status,'cancelled');assert.strictEqual(task.result.detailedResult.code,'uac-cancelled');}
    if(mode==='partial'){assert.strictEqual(task.status,'partially-completed');assert.strictEqual(task.result.detailedResult.code,'partially-completed');}
    if(mode==='timeout')assert.strictEqual(task.result.detailedResult.code,'timeout');
    if(mode==='malformed')assert.strictEqual(task.result.detailedResult.code,'invalid-output');
    if(mode!=='compile-failed'){
      assert.strictEqual(elevated,1);assert.deepStrictEqual(Array.from(commands[0].args),['dism_check',String(process.pid)]);
      assert.strictEqual(commands[0].options.windowsHide,true);
    }
    const status=await new Promise(resolve=>maintenance.getStatus(resolve));
    assert.strictEqual(status.isRunning,false);assert.strictEqual(status.history.length,2);assert.strictEqual(status.isAdmin,false);
  }
  for(const mode of ['ok','partial','cancel','failed','error','crash','malformed','compile-failed','hold','timeout'])await scenario(mode);
  const frontend=realFs.readFileSync(path.join(__dirname,'..','public','maintenance.js'),'utf8');
  assert(frontend.includes('btn.disabled = disabled;'));
  assert(!frontend.includes('disabled || needsAdmin'));
  assert(frontend.includes('action.confirm || action.requiresAdmin'));
  assert(frontend.includes('confirmed: true'));
  assert(!frontend.includes('Run as administrator'));
  console.log('PASS standard-user admin action availability, fixed helper arguments, normal unelevated actions, UAC cancellation, failures, malformed output, single-flight and history');
}

async function testNativeElevationBroker() {
  if(process.platform!=='win32')return;
  const path=require('path');
  const directory=realFs.mkdtempSync(path.join(realOs.tmpdir(),'rovarin-maintenance-native-'));
  const helperSource=realFs.readFileSync(path.join(__dirname,'maintenance-elevated.cs'),'utf8');
  const compiler=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
  try {
    const original=path.join(directory,'Original.exe');
    childProcess.execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/out:'+original,path.join(__dirname,'maintenance-elevated.cs')],{windowsHide:true,timeout:30000});
    for(const args of [['arbitrary_command'],['dism_check','1'],['--worker','dism_check','bad-pipe','1']]) {
      assert.throws(()=>childProcess.execFileSync(original,args,{windowsHide:true,timeout:5000}), 'invalid actions/parent/pipe never execute');
    }
    // ONLY this disposable test copy replaces UAC and diagnostic tools. The
    // production source has no test/environment/URL override for elevation.
    let fixture=helperSource.replace('UseShellExecute=true,Verb="runas"','UseShellExecute=false,Verb=""');
    fixture=fixture.replace('if(!new WindowsPrincipal(WindowsIdentity.GetCurrent()).IsInRole(WindowsBuiltInRole.Administrator)) return 2;','// Isolated non-admin job/pipe fixture only.');
    fixture=fixture.replace(/"dism.exe"/g,'"ping.exe"').replace(/\/online \/cleanup-image \/(?:checkhealth|scanhealth|restorehealth)/g,'127.0.0.1 -n 2');
    const file=path.join(directory,'Fixture.cs'),exe=path.join(directory,'Fixture.exe');
    realFs.writeFileSync(file,fixture);
    childProcess.execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/out:'+exe,file],{windowsHide:true,timeout:30000});
    const output=await new Promise((resolve,reject)=>childProcess.execFile(exe,['dism_check',String(process.pid)],{windowsHide:true,timeout:15000,maxBuffer:65536},(error,stdout)=>{if(error){error.stdout=stdout;reject(error);}else resolve(stdout);}));
    const messages=output.trim().split(/\r?\n/).map(line=>JSON.parse(line));
    assert(messages.some(value=>value.type==='progress'&&value.step===1));
    assert(messages.some(value=>value.type==='result'&&value.success===true&&value.code==='completed'));
    // The parent fixture owns all of these processes. Never signal user apps.
    const longSource=path.join(directory,'Lifetime.cs'),longExe=path.join(directory,'Lifetime.exe');
    const workerFile=path.join(directory,'worker.pid'),toolFile=path.join(directory,'tool.pid');
    let longFixture=fixture.replace(/127\.0\.0\.1 -n 2/g,'127.0.0.1 -n 60');
    longFixture=longFixture.replace('job=CreateJobObject(IntPtr.Zero,null);','File.WriteAllText('+JSON.stringify(workerFile)+',Process.GetCurrentProcess().Id.ToString());job=CreateJobObject(IntPtr.Zero,null);');
    longFixture=longFixture.replace('child.Start();','child.Start();File.WriteAllText('+JSON.stringify(toolFile)+',child.Id.ToString());');
    realFs.writeFileSync(longSource,longFixture);
    childProcess.execFileSync(compiler,['/nologo','/target:exe','/platform:x64','/r:System.Web.Extensions.dll','/out:'+longExe,longSource],{windowsHide:true,timeout:30000});
    const parent=childProcess.spawn(process.execPath,['-e','require("child_process").spawn('+JSON.stringify(longExe)+',["dism_check",String(process.pid)],{windowsHide:true,stdio:"ignore"});setInterval(()=>{},1000);'],{windowsHide:true,stdio:'ignore'});
    try {
      for(let i=0;i<100&&!realFs.existsSync(toolFile);i++)await new Promise(resolve=>setTimeout(resolve,100));
      assert(realFs.existsSync(toolFile),'owned tool must start before testing parent shutdown');
      const pids=[Number(realFs.readFileSync(workerFile)),Number(realFs.readFileSync(toolFile))];
      const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill();await exited;
      const alive=pid=>{try{process.kill(pid,0);return true;}catch(error){return error.code!=='ESRCH';}};
      for(let i=0;i<100&&pids.some(alive);i++)await new Promise(resolve=>setTimeout(resolve,100));
      assert(!pids.some(alive),'backend/parent exit must terminate the owned worker and tool via the protected pipe/job');
    } finally {if(parent.exitCode===null&&parent.signalCode===null){const exited=new Promise(resolve=>parent.once('exit',resolve));parent.kill();await exited;}}
    assert(helperSource.includes('GetNamedPipeClientProcessId')&&helperSource.includes('GetNamedPipeServerProcessId'));
    assert(helperSource.includes('limits.Basic.Flags=0x2000')&&helperSource.includes('AssignProcessToJobObject(job,Process.GetCurrentProcess().Handle)'));
    assert(helperSource.includes('TerminateJobObject(job,3)'));
    assert.doesNotMatch(helperSource,/cmd\.exe|-Command|ExecutionPolicy|TaskScheduler/);
    console.log('PASS real C# helper compilation, invalid input refusal, process-verified pipe handshake, fixed-tool progress/results and owned job shutdown (isolated non-UAC fixture)');
  } catch(error) {console.error('Native helper fixture failed: '+String(error.stdout || error.message).slice(0,2000)); throw error; } finally { realFs.rmSync(directory,{recursive:true,force:true,maxRetries:20,retryDelay:200}); }
}

function testRecycleHelper() {
  if(process.platform !== 'win32') return;
  const helper=require('path').join(__dirname,'empty-recycle-bin.ps1').replace(/'/g,"''");
  const source=realFs.readFileSync(require('path').join(__dirname,'empty-recycle-bin.ps1'),'utf8');
  assert(source.includes('::Empty([IntPtr]::Zero,$null,7)'), 'fixed Windows operation must use current-user/all-drive semantics and suppress UI');
  assert.doesNotMatch(source,/Clear-RecycleBin|Remove-Item|DeleteFile|\$Recycle\.Bin/, 'no hanging cmdlet or raw filesystem deletion fallback');
  // Remove BOTH native deletion and enumeration functions before evaluation.
  // Fixed test functions replace them; no Windows Recycle Bin is ever touched.
  for(const fixture of [
    {counts:[0],code:'already-empty',clears:0}, {counts:[1,0],code:'emptied',clears:1},
    {counts:[5,5,5,0],code:'emptied',clears:1}, {counts:[5,5,5,5,5],code:'items-remain',clears:1},
    {counts:[null,null,null,null,null],code:'verification-unavailable',clears:1},
    {counts:[1],missing:true,code:'tool-unavailable',clears:0},
    {counts:[1],denied:true,code:'permission-denied',clears:1},
    {counts:[1],accessHresult:true,code:'permission-denied',clears:1},
    {counts:[1],missingEntry:true,code:'tool-unavailable',clears:1},
    {counts:[1],bindingUnavailable:true,code:'tool-unavailable',clears:1},
    {counts:[1],failed:true,code:'clear-failed',clears:1}
  ]) {
    const script=`$ErrorActionPreference='Stop'
      $source=[IO.File]::ReadAllText('${helper}');$tokens=$null;$errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseInput($source,[ref]$tokens,[ref]$errors);if($errors.Count){throw 'Parse failed'}
      $functions=@($ast.FindAll({param($n) $n -is [Management.Automation.Language.FunctionDefinitionAst] -and $n.Name -in @('Read-RecycleCount','Invoke-RecycleClear','Initialize-RecycleApi')},$true))
      if($functions.Count -ne 3){throw 'Unsafe helper substitution'}
      foreach($fn in ($functions | Sort-Object { $_.Extent.StartOffset } -Descending)){$source=$source.Remove($fn.Extent.StartOffset,$fn.Extent.EndOffset-$fn.Extent.StartOffset)}
      if($source -match 'Add-Type|::Empty|Clear-RecycleBin'){throw 'Unmocked deletion binding'}
      $fixture='${JSON.stringify(fixture)}' | ConvertFrom-Json;$script:reads=0;$script:clears=0
      function Read-RecycleCount { $value=$fixture.counts[[Math]::Min($script:reads,$fixture.counts.Count-1)];$script:reads++;return $value }
      function Invoke-RecycleClear { if($fixture.missing){throw [DllNotFoundException]::new('fixture')};$script:clears++;if($fixture.denied){throw [UnauthorizedAccessException]::new('fixture')};if($fixture.accessHresult){throw [Runtime.InteropServices.COMException]::new('fixture',-2147024891)};if($fixture.missingEntry){throw [EntryPointNotFoundException]::new('fixture')};if($fixture.bindingUnavailable){throw [PlatformNotSupportedException]::new('fixture')};if($fixture.failed){throw 'fixture'} }
      function Start-Sleep {param($Milliseconds)}
      $source=$source.Replace('exit 1','')
      $result=Invoke-Expression $source | ConvertFrom-Json
      if($result.code -ne $fixture.code -or $clears -ne $fixture.clears){throw ('Unexpected result '+($result|ConvertTo-Json -Compress))}
      if($reads -gt 5 -or $clears -gt 1){throw 'Unbounded verification'}
      $result | ConvertTo-Json -Compress`;
    const output=childProcess.execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],{windowsHide:true,timeout:10000,encoding:'utf8'});
    assert.strictEqual(JSON.parse(output).code,fixture.code);
  }
  console.log('PASS fixed Shell32 helper with safe substitutions: empty/one/multiple items, delayed verification, unavailable verification, missing DLL/entry/binding, denied/HRESULT/failed clear; one clear and bounded retries');
}

async function testWatchdogOrdering() {
  const source=realFs.readFileSync(require('path').join(__dirname,'../maintenance.js'),'utf8');
  const functions=source.slice(source.indexOf('function consumeMaintenanceProcess'),source.indexOf('// Compile only this fixed Rovarin source'));
  const native=realFs.readFileSync(require('path').join(__dirname,'maintenance-service.cs'),'utf8');
  assert(native.includes('35*60*1000,Timeout.Infinite'));
  assert(native.includes('36*60*1000,Timeout.Infinite'));
  for(const mode of ['completed','native-timeout','outer-timeout','fallback']) {
    let now=0,next=1,kills=0,result;
    const timers=new Map(),child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();
    child.kill=()=>{kills++;child.emit('close',-1);};
    const context={serviceClient:{run:()=>child},appendLog:()=>{},setTimeout:(fn,ms)=>{const token={id:next++,unref(){}};timers.set(token,{fn,at:now+ms});return token;},clearTimeout:token=>timers.delete(token)};
    require('vm').createContext(context);require('vm').runInContext(functions,context);
    const task={id:'windows_repair'},complete=(success,summary,detail)=>{result={success,summary,detail};};
    if(mode==='fallback')context.consumeMaintenanceProcess(child,task,complete);else context.executeServiceAction(task,complete);
    assert.equal([...timers.values()][0].at,(mode==='fallback'?32:37)*60*1000);
    const advance=minutes=>{now=minutes*60*1000;for(const [id,timer] of [...timers])if(timer.at<=now){timers.delete(id);timer.fn();}};
    if(mode==='fallback'){advance(32);assert.equal(kills,1);assert.equal(result.detail.code,'timeout');}
    else {
      advance(35);assert.equal(kills,0,'service work deadline must precede Node termination');
      advance(36);assert.equal(kills,0,'native cleanup/result grace must not be interrupted');
      if(mode==='outer-timeout'){advance(37);assert.equal(kills,1);assert.equal(result.success,false);assert.equal(result.detail.code,'timeout');}
      else {
        const success=mode==='completed';child.stdout.emit('data',Buffer.from(JSON.stringify({type:'result',action:task.id,success,code:success?'completed':'timeout',summary:'Fixture final result',exitCode:success?0:258})+'\n'));child.emit('close',success?0:1);
        assert.equal(result.success,success);assert.equal(result.detail.exitCode,success?0:258);assert.equal(timers.size,0);
        advance(38);assert.equal(kills,0,'final result clears watchdog');
      }
    }
  }
  console.log('PASS simulated service35/client36/Node37 ordering, success/native timeout258, bounded owned-child termination and unchanged fallback32; no Windows repair run');
}

async function testServiceIntegration() {
  const { setServiceClient, runAction, getStatus } = require('../maintenance');
  let mockService = {
    status: async () => ({ state: 'enabled', enabled: true }),
    run: (action) => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => proc.emit('close', -1);
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'progress', action, step: 1, total: 1, message: 'Step 1' }) + '\n'));
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', action, success: true, code: 'completed', summary: 'Service test done', exitCode: 0 }) + '\n'));
        proc.emit('close', 0);
      });
      return proc;
    }
  };
  setServiceClient(mockService);
  const status = await new Promise(resolve => getStatus(resolve));
  assert.strictEqual(status.service.enabled, true);
  assert.strictEqual(status.service.state, 'enabled');

  const task = await new Promise(resolve => runAction('clear_dns', () => {}, resolve));
  assert.strictEqual(task.status, 'completed');
  assert.strictEqual(task.result.summary, 'Service test done');

  mockService.run = (action) => {
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => proc.emit('close', -1);
    setImmediate(() => {
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'progress', action, step: 1, total: 1, message: 'Step 1' }) + '\n'));
      proc.stdout.emit('data', Buffer.from(JSON.stringify({ type: 'result', action, success: false, code: 'partially-completed', summary: 'Service test partial', exitCode: 0 }) + '\n'));
      proc.emit('close', 0);
    });
    return proc;
  };
  const partialTask = await new Promise(resolve => runAction('reset_network', () => {}, resolve));
  assert.strictEqual(partialTask.status, 'partially-completed');
  assert.strictEqual(partialTask.result.detailedResult.code, 'partially-completed');
  assert.strictEqual(partialTask.result.success, false);

  // A final Partial result must also remain false in API-visible history.
  const partialHistory = await new Promise(resolve => getStatus(resolve));
  assert.strictEqual(partialHistory.history[0].success, false);
  assert.strictEqual(partialHistory.history[0].status, 'partially-completed');

  for (const [code, exitCode] of [['timeout', 258], ['operation-failed', 1]]) {
    mockService.run = action => {
      const proc = new EventEmitter(); proc.stdout = new EventEmitter(); proc.stderr = new EventEmitter();
      proc.kill = () => proc.emit('close', -1);
      setImmediate(() => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ type:'progress', action, step:2, total:4, message:'DISM ScanHealth' })+'\n'));
        proc.stdout.emit('data', Buffer.from(JSON.stringify({ type:'result', action, success:false, code, summary:'Windows maintenance stopped; servicing logs retained.', exitCode })+'\n'));
        proc.emit('close', 1);
      }); return proc;
    };
    const failed = await new Promise(resolve => runAction('windows_repair', () => {}, resolve));
    assert.strictEqual(failed.status, 'failed'); assert.strictEqual(failed.result.success, false);
    assert.strictEqual(failed.result.detailedResult.code, code); assert.strictEqual(failed.result.detailedResult.exitCode, exitCode);
    const state = await new Promise(resolve => getStatus(resolve));
    assert.strictEqual(state.history[0].success, false); assert.strictEqual(state.history[0].status, 'failed');
  }
  console.log('PASS API-visible timeout/native failure results, exit codes, progress and failed history without false success');

  mockService.status = async () => ({ state: 'disabled', enabled: false });
  const remoteTask = await new Promise(resolve => runAction('clear_dns', () => {}, resolve, { isLocal: false }));
  assert.strictEqual(remoteTask.status, 'failed');
  assert.strictEqual(remoteTask.result.detailedResult.code, 'service-disabled');

  console.log('PASS service integration: status reporting, privileged service execution, and remote service-disabled enforcement');
}

(process.argv.includes('--watchdog-only') ? testWatchdogOrdering() : process.argv.includes('--service-results-only') ? testServiceIntegration() : main()).catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
