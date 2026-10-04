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
  const vm = require('vm');
  const isolated = { module: { exports: {} }, require: name => name === 'child_process' ? { ...mockChildProcess, execFile() { throw Object.assign(new Error('test admin probe missing'), { code: 'ENOENT' }); } } : require(name) };
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
  const timed={__dirname,process,console,module:{exports:{}},setTimeout:(fn,ms)=>setTimeout(fn,ms===30*60*1000?1:ms),clearTimeout,require:name=>name==='child_process'?{...mockChildProcess,spawn(){const child=new EventEmitter();child.stdout=new EventEmitter();child.stderr=new EventEmitter();child.kill=()=>{timedOutChildren++;child.emit('close',-1);};return child;}}:require(name)};
  vm.runInNewContext(realFs.readFileSync(require('path').join(__dirname,'..','maintenance.js'),'utf8'),timed);
  for(const action of ['windows_repair','sfc_scan','dism_check']){const task=await new Promise(resolve=>timed.module.exports.runAction(action,()=>{},resolve));assert(!task.result.success);}
  assert.strictEqual(timedOutChildren,3,'each live command timeout stops its one owned child');
  console.log('PASS maintenance JSON/result mapping, missing/permission/timeout failures, temp scan failure, admin denial and recovery');
  testRecycleHelper();
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

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
