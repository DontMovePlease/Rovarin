'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');
const { createClient, createLocalLifecycleClient } = require('../maintenance-service');
const source = fs.readFileSync(path.join(__dirname, 'maintenance-service.cs'), 'utf8');
const installerSource=fs.readFileSync(path.join(__dirname,'..','packaging','RovarinMaintenance.iss'),'utf8');
const lifecycle = fs.readFileSync(path.join(__dirname, 'maintenance-service-lifecycle.cs'), 'utf8');

// Real named-pipe/job fixtures only: never registers a service or runs servicing tools.
async function testMaintenanceTimeout() {
  if(process.platform!=='win32') throw new Error('Windows native fixture required');
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-timeout-fixture-'));
  try {
    const csc=path.join(process.env.SystemRoot,'Microsoft.NET','Framework64','v4.0.30319','csc.exe');
    for(const mode of ['old-disconnect','timeout','windows-error']) {
      const pidFile=path.join(dir,mode+'.pid');
      const fixtureMethod = '\nstatic int TimeoutFixture() {\n'+
        'string name="RovarinTimeoutQA-"+Guid.NewGuid().ToString("N");var security=new PipeSecurity();security.SetAccessRuleProtection(true,false);security.AddAccessRule(new PipeAccessRule(WindowsIdentity.GetCurrent().User,PipeAccessRights.FullControl,AccessControlType.Allow));\n'+
        'var lines=new System.Collections.Generic.List<string>();Exception readerError=null;\n'+
        'using(var pipe=new NamedPipeServerStream(name,PipeDirection.InOut,1,PipeTransmissionMode.Byte,PipeOptions.Asynchronous,4096,4096,security)) {\n'+
        'var reader=new Thread(delegate(){try{using(var client=new NamedPipeClientStream(".",name,PipeDirection.InOut)){client.Connect(3000);using(var input=new StreamReader(client)){string line;while((line=input.ReadLine())!=null){lines.Add(line);if(line.Contains("\\"type\\":\\"result\\""))break;}}}}catch(Exception e){readerError=e;}});reader.Start();pipe.WaitForConnection();\n'+
        (mode==='old-disconnect' ? 'using(var oldDeadline=new Timer(delegate {pipe.Dispose();},null,1800,Timeout.Infinite)) ExecuteAction(pipe,"dism_check",Process.GetCurrentProcess());\n' : 'ExecuteAction(pipe,"dism_check",Process.GetCurrentProcess());\n')+
        'if(!reader.Join(4000))throw new Exception("fixture reader did not exit");\n'+
        'int progress=0;var results=new System.Collections.Generic.List<System.Collections.Generic.Dictionary<string,object>>();foreach(var line in lines){var msg=(System.Collections.Generic.Dictionary<string,object>)Json.DeserializeObject(line);if((string)msg["type"]=="progress")progress++;if((string)msg["type"]=="result")results.Add(msg);}\n'+
        (mode==='old-disconnect' ? 'if(results.Count!=0)throw new Exception("old pipe closure unexpectedly preserved final result");\n' : 'if(readerError!=null || results.Count!=1 || (bool)results[0]["success"] || (string)results[0]["code"]!="'+(mode==='timeout'?'timeout':'operation-failed')+'" || (int)results[0]["exitCode"]!='+(mode==='timeout'?258:1)+')throw new Exception("wrong final operation result");\n')+
        'if(progress<1)throw new Exception("missing progress");Console.WriteLine("PASS '+mode+': final result/exit code/progress checked");return 0;}}\n';
      let fixture=source.replace('static int SelfTest()',fixtureMethod+'    static int SelfTest()');
      fixture=fixture.replace('try {\n            // Pure policy tests only;', 'try {\n            if(args.Length==1 && args[0]=="--timeout-fixture")return TimeoutFixture();\n            // Pure policy tests only;');
      if(!fixture.includes('return TimeoutFixture();')) throw new Error('Native fixture entry substitution failed');
      fixture=fixture.replace(/"dism.exe"/g,'"ping.exe"').replace(/\/online \/cleanup-image \/(?:checkhealth|scanhealth|restorehealth)/g,mode==='windows-error'?'--invalid-rovarin-fixture':'127.0.0.1 -n 60');
      fixture=fixture.replace('},null,35*60*1000,Timeout.Infinite))','},null,'+(mode==='old-disconnect'?'60000':'1800')+',Timeout.Infinite))');
      fixture=fixture.replace('child.Start();','child.Start();File.WriteAllText('+JSON.stringify(pidFile)+',child.Id.ToString());');
      const cs=path.join(dir,mode+'.cs'),exe=path.join(dir,mode+'.exe');fs.writeFileSync(cs,fixture);
      cp.execFileSync(csc,['/nologo','/target:exe','/platform:x64','/r:System.ServiceProcess.dll','/r:System.Web.Extensions.dll','/out:'+exe,cs,path.join(__dirname,'maintenance-service-lifecycle.cs')],{windowsHide:true,timeout:30000});
      const output=cp.execFileSync(exe,['--timeout-fixture'],{windowsHide:true,timeout:12000,encoding:'utf8'});assert(output.includes('PASS '+mode));
      const pid=Number(fs.readFileSync(pidFile,'utf8'));let alive=true;try{process.kill(pid,0);}catch(e){alive=e.code!=='ESRCH';}assert(!alive,'owned native fixture tool must be stopped');
      console.log(output.trim()+'; no owned tool orphan');
    }
  }finally{fs.rmSync(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100});}
}

async function main() {
  let calls = [];
  const regular = () => ({ isFile: () => true, isSymbolicLink: () => false });
  const client = createClient({ platform: 'win32', programFiles: 'C:\\Program Files', lstatSync: regular,
    execFile(file, args, options, done) { calls.push({ file, args, options }); done(null, args[0] === '--status' ? 'enabled\n' : 'disabled\n'); } });
  assert.deepStrictEqual(await client.status(), { state: 'enabled', enabled: true });
  assert.deepStrictEqual(await client.revoke(), { state: 'disabled', enabled: false });
  assert.strictEqual(calls.length, 2);
  assert.deepStrictEqual(calls.map(c => c.args), [['--status'], ['--revoke']]);
  assert(calls.every(c => c.options.shell === false && c.options.timeout === 6000 && c.options.maxBuffer === 1024));
  assert(calls.every(c => c.file.endsWith('RovarinMaintenanceService.exe')));
  const missing = createClient({ platform: 'win32', lstatSync() { throw Object.assign(new Error(), { code: 'ENOENT' }); }, execFile() { throw new Error('must not execute'); } });
  assert.deepStrictEqual(await missing.status(), { state: 'not-installed', enabled: false });
  const unsafe = createClient({ platform: 'win32', lstatSync: () => ({ isFile: () => true, isSymbolicLink: () => true }) });
  assert.strictEqual((await unsafe.status()).state, 'unsafe-deployment');
  for (const output of ['enabled\nprivate-value', 'bogus', '']) {
    const bad = createClient({ platform: 'win32', lstatSync: regular, execFile(f,a,o,done) {done(null,output);} });
    assert.strictEqual((await bad.status()).state, 'protocol-error');
  }
  const failed = createClient({ platform: 'win32', lstatSync: regular, execFile(f,a,o,done) {done(new Error('private-path'),'', 'private-secret');} });
  assert.deepStrictEqual(await failed.revoke(), { state: 'unavailable', enabled: false });
  const denied = createClient({ platform: 'win32', lstatSync: regular, execFile(f,a,o,done) {done(new Error('denied'),'unauthorized');} });
  assert.strictEqual((await denied.revoke()).state, 'unauthorized');
  const unconfirmed = createClient({ platform: 'win32', lstatSync: regular, execFile(f,a,o,done) {done(null,'enabled');} });
  assert.strictEqual((await unconfirmed.revoke()).state, 'revocation-unconfirmed');
  const localCalls=[];
  const local=createLocalLifecycleClient({ platform:'win32', lstatSync:regular, execFile(f,a,o,done){localCalls.push({a,o});done(null,a[0]==='--request-removal'?'removed':'enabled');} });
  assert.strictEqual((await local.enroll()).state,'enabled');
  assert.strictEqual((await local.provision()).state,'enabled');
  assert.strictEqual((await local.remove()).state,'removed');
  assert.deepStrictEqual(localCalls.map(c=>c.a),[['--request-enrollment'],['--request-provision'],['--request-removal']]);
  assert(localCalls.every(c=>c.o.timeout===120000 && c.o.shell===false));
  const cancelled=createLocalLifecycleClient({platform:'win32',lstatSync:regular,execFile(f,a,o,done){done(new Error(),'uac-cancelled');}});
  assert.strictEqual((await cancelled.enroll()).state,'uac-cancelled');
  let finish;
  const slow = createClient({ platform: 'win32', lstatSync: regular, execFile(f,a,o,done) {finish=done;} });
  const pending=slow.status();
  assert.strictEqual((await slow.status()).state,'busy');finish(null,'disabled');await pending;
  assert.strictEqual(Object.keys(client).join(','),'status,revoke,run,invalidateCache');
  let spawnCalls = [];
  const runClient = createClient({
    platform: 'win32', programFiles: 'C:\\Program Files', lstatSync: regular,
    spawn(file, args, options) { spawnCalls.push({ file, args, options }); return { stdout: { on() {} }, on() {} }; }
  });
  for (const action of ['windows_repair', 'sfc_scan', 'dism_check', 'reset_network', 'clear_dns']) {
    runClient.run(action);
  }
  assert.strictEqual(spawnCalls.length, 5);
  assert(spawnCalls.every(c => c.args[0] === '--run'));
  assert(spawnCalls.every(c => c.options.shell === false && c.options.windowsHide === true));
  assert.throws(() => runClient.run('cmd.exe'), /Unsupported maintenance action/);

  let statusExecCount = 0;
  const cacheClient = createClient({
    platform: 'win32', programFiles: 'C:\\Program Files', lstatSync: regular,
    execFile(f, a, o, done) { statusExecCount++; done(null, 'enabled\n'); }
  });
  assert.strictEqual((await cacheClient.status()).enabled, true);
  assert.strictEqual((await cacheClient.status()).enabled, true);
  assert.strictEqual(statusExecCount, 1);
  cacheClient.invalidateCache();
  assert.strictEqual((await cacheClient.status()).enabled, true);
  assert.strictEqual(statusExecCount, 2);

  assert(source.includes('0x00000008') && source.includes('0x00080000'));
  assert(source.includes('GetNamedPipeClientProcessId') && source.includes('GetNamedPipeServerProcessId') && source.includes('pipe.RunAsClient'));
  assert(source.includes('ProcessSid(peer)!=sid') && source.includes('VerifiedServicePeer(pid)'));
  assert(lifecycle.includes('RegisteredPid()!=pid') && lifecycle.includes('OpenProcess(0x1000'));
  assert(source.includes('AllowOwnerProcessQuery(policy.Owner)') && source.includes('ace.AccessMask==0x1000'));
  assert(lifecycle.includes('ValidateImageDigest') && lifecycle.includes('image-replaced'));
  assert(lifecycle.includes('RecoveryAction{Type=0,Delay=0}') && lifecycle.includes('Reset=86400'));
  assert(lifecycle.includes('Save(new Policy{Owner=policy.Owner,Enabled=false'));
  assert(source.includes('WindowsIdentity.GetCurrent().User.Value') && source.includes('--provision '));
  assert(source.includes('Verb="runas"') && source.includes('IsInRole(WindowsBuiltInRole.Administrator)'));
  assert(!source.includes('cmd.exe') || source.includes('execute|cmd.exe')); // negative policy test only
  assert(source.includes('dism.exe') && source.includes('sfc.exe') && source.includes('netsh.exe') && source.includes('ipconfig.exe'));
  assert(source.includes('CreateJobObject') && source.includes('AssignProcessToJobObject') && source.includes('TerminateJobObject'));
  assert(!source.includes('ServiceInstaller') && lifecycle.includes('CreateService(manager,Name'));
  if (process.platform === 'win32') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-service-stage1-'));
    try {
      const exe = path.join(directory, 'foundation.exe');
      const csc = path.join(process.env.SystemRoot, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
      cp.execFileSync(csc, ['/nologo','/target:exe','/platform:x64','/r:System.ServiceProcess.dll','/r:System.Web.Extensions.dll','/out:'+exe,path.join(__dirname,'maintenance-service.cs'),path.join(__dirname,'maintenance-service-lifecycle.cs')], {timeout:30000,windowsHide:true});
      const result = cp.execFileSync(exe, ['--self-test'], {timeout:10000,windowsHide:true,encoding:'utf8'});
      assert(result.includes('PASS: policy') && result.includes('PASS: lifecycle transaction'));
      for(const args of [[],['--status'],['--revoke'],['--run','clear_dns'],['--request-enrollment'],['--enroll','S-1-5-21-1-2-3-1001'],['--request-provision'],['--provision','S-1-5-21-1-2-3-1001'],['--request-removal'],['--remove']]) {
        const result=cp.spawnSync(exe,args,{timeout:5000,windowsHide:true,encoding:'utf8'});
        assert.strictEqual(result.status,1);assert.strictEqual(result.stdout.trim(),'unavailable');
      }
      const fixture=path.join(directory,'build');
      cp.execFileSync(path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe'),['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'..','packaging','build-maintenance-service.ps1'),'-OutputDirectory',fixture,'-Installer'],{timeout:30000,windowsHide:true});
      assert.deepStrictEqual(fs.readdirSync(fixture).sort(),['RovarinMaintenanceService.exe','RovarinMaintenanceService.exe.sha256','RovarinMaintenanceSetup.exe','RovarinMaintenanceSetup.exe.sha256']);
      const digest=require('crypto').createHash('sha256').update(fs.readFileSync(path.join(fixture,'RovarinMaintenanceService.exe'))).digest('hex');
      assert.strictEqual(fs.readFileSync(path.join(fixture,'RovarinMaintenanceService.exe.sha256'),'utf8').trim(),digest);
      assert(installerSource.includes('PrivilegesRequired=admin') && installerSource.includes('RequestedOwner := ExpandConstant'));
      assert(installerSource.includes('Unsafe maintenance installation path.'));
      assert(installerSource.includes('GetSHA256OfFile') && installerSource.includes('{#ServiceHash}'));
      assert(installerSource.includes('SafeExisting(Image)') && installerSource.includes('--prepare-package-update'));
      assert(!installerSource.includes('powershell.exe'));
      assert(installerSource.includes("if Ancestor and (Rights = 'LC')"));
      assert(installerSource.includes("not SafeUnprivilegedRights('LC', False)"));
      assert(installerSource.includes("not SafeUnprivilegedRights('0x40', True)"));
      assert(installerSource.includes("not SafeUnprivilegedRights('WD', True)"));
      assert(installerSource.includes('Result := RightsPolicySelfTest() and ValidOwner'));
      const setupHash=require('crypto').createHash('sha256').update(fs.readFileSync(path.join(fixture,'RovarinMaintenanceSetup.exe'))).digest('hex');
      assert.strictEqual(fs.readFileSync(path.join(fixture,'RovarinMaintenanceSetup.exe.sha256'),'utf8').trim(),setupHash);
      console.log('PASS: Inno companion compilation, embedded integrity/fixed paths and cleanup guards');
      console.log('PASS: unelevated fixture build and matching checksum; no private payload files');
      console.log('PASS: compiled native policy tests; writable deployment rejected for every live mode');
    } finally {fs.rmSync(directory,{recursive:true,force:true});assert(!fs.existsSync(directory));}
  }
  const build=fs.readFileSync(path.join(__dirname,'../packaging/build.ps1'),'utf8');
  const preview=fs.readFileSync(path.join(__dirname,'desktop-preview.ps1'),'utf8');
  const shell=fs.readFileSync(path.join(__dirname,'../packaging/DesktopShell.cs'),'utf8');
  assert(!build.includes('if ($MaintenanceFoundation)'));
  assert(build.indexOf("$compiler = Join-Path $cache 'inno\\ISCC.exe'") < build.indexOf("'build-maintenance-service.ps1'"),'Resolve/verify Inno before building the default companion on a clean checkout');
  for(const source of [build,preview]) {
    assert(source.includes('build-maintenance-service.ps1') && source.includes('-Installer'));
    assert(source.includes('MaintenanceSetupHash') && source.includes('$maintenanceHash'));
    assert(source.includes("Copy-Item -LiteralPath $setup,($setup+'.sha256')"));
  }
  assert(shell.includes('DesktopShell.OpenMaintenanceSetup()') && shell.includes('FileShare.Read'));
  assert(shell.includes('Verb = "runas"') && shell.includes('WindowsIdentity.GetCurrent().User.Value'));
  assert(shell.includes('Arguments = "/OWNER=" + owner + " /NORESTART"'));
  assert(shell.includes('Convert.ToString(result["state"]) == "not-installed"'));
  assert(shell.includes('new { action = "status" }') && shell.includes('actual["enabled"]'));
  assert(!shell.includes('Arguments = message') && !shell.includes('FileName = message'));
  console.log('PASS: default companion packaging, preview binding, native-only fixed UAC bootstrap and verified enrollment');
  console.log('PASS: backend fixed adapter, failure states, singleton, bounded output; service security invariants');
}
(process.argv.includes('--timeout-only') ? testMaintenanceTimeout() : main()).catch(error => { console.error(error.message); process.exitCode=1; });