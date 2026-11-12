'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { execFileSync, spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const lifecycle = require('../server-lifecycle');
const web = require('../web-assets');
(async () => {
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'rovarin-architecture-'));
let backend;
try {
  const files = [...lifecycle.ROOT_SERVER_FILES, 'package.json'];
  assert.deepEqual([...lifecycle.ROOT_SERVER_FILES].sort(), fs.readdirSync(root).filter(f => f.endsWith('.js')).sort(), 'every root runtime module participates in build/watch/identity');
  assert.deepEqual(JSON.parse(execFileSync(process.execPath, [path.join(root, 'server-lifecycle.js'), '--runtime-files'], {encoding:'utf8'})).root, files);
  for (const file of files) fs.copyFileSync(path.join(root, file), path.join(temp, file));
  const first = lifecycle.runtimeFingerprint(temp);
  fs.writeFileSync(path.join(temp, 'disposable-test.js'), 'not runtime');
  assert.equal(lifecycle.runtimeFingerprint(temp), first, 'unrelated root helpers are outside runtime identity');
  for (const file of ['hardware-telemetry.js', 'web-assets.js', 'package.json']) {
    const original = fs.readFileSync(path.join(temp, file));
    fs.appendFileSync(path.join(temp, file), '\n');
    assert.notEqual(lifecycle.runtimeFingerprint(temp), first, file + ' changes runtime identity');
    fs.writeFileSync(path.join(temp, file), original);
    assert(lifecycle.WATCHED_SERVER_FILES.has(file));
  }
  const absent = path.join(temp, 'missing'); fs.mkdirSync(absent);
  assert.throws(() => lifecycle.runtimeFingerprint(absent), /ENOENT/);
  assert.equal(new Set(files).size, files.length);
  const metadata = path.join(temp, 'metadata'); fs.mkdirSync(metadata);
  fs.writeFileSync(path.join(metadata, 'server.pid'), '123');
  fs.writeFileSync(path.join(metadata, 'server-state.json'), JSON.stringify({pid: 124, status: 'listening', actualPort: 7331}));
  assert.equal(lifecycle.readRuntimeMetadata(metadata).valid, false, 'conflicting generations stay unsafe');
  fs.writeFileSync(path.join(metadata, 'server-state.json'), JSON.stringify({pid: 123, status: 'listening', actualPort: 7331}));
  fs.writeFileSync(path.join(metadata, 'server.instance.json'), JSON.stringify({pid: 125}));
  assert.equal(lifecycle.readRuntimeMetadata(metadata).valid, false, 'instance mismatch stays unsafe');
  fs.writeFileSync(path.join(metadata, 'server.instance.json'), JSON.stringify({pid: 123}));
  assert.equal(lifecycle.readRuntimeMetadata(metadata).valid, true);
  fs.writeFileSync(path.join(metadata, 'server-state.json'), '{broken');
  assert.equal(lifecycle.readRuntimeMetadata(metadata).valid, false);
  console.log('PASS canonical runtime identity, package/module watching, missing inputs and conflicting/malformed metadata refusal');

  const login = fs.readFileSync(path.join(root, 'public/login.html'), 'utf8');
  for (const pinMode of ['manual', '6', '8', '12']) {
    const html = web.renderLogin(login, {pinMode});
    assert(html.includes(`name="rovarin-pin-mode" content="${pinMode}"`));
    assert(!html.includes('id="pinInput" disabled hidden'));
  }
  assert(web.renderLogin(login, {pinMode:'6', pinSetup:true}).includes('id="pinInput" disabled hidden'));
  assert.throws(() => web.renderLogin(login, {pinMode:'<script>'}));
  assert.throws(() => web.renderLogin(login, {pinMode:'7'}));
  assert.throws(() => web.renderLogin(login + login, {pinMode:'6'}));
  assert.throws(() => web.renderLogin('<html></html>', {pinMode:'6'}));
  const revision = 'a'.repeat(64);
  const versioned = web.versionAssets('<link href="/app.css?v=old"><script src="/private.js"></script><a href="https://example.invalid/app.css">', revision);
  assert(versioned.includes('/app.css?v=' + revision));
  assert(versioned.includes('src="/private.js"'));
  assert(versioned.includes('href="https://example.invalid/app.css"'));
  assert.throws(() => web.versionAssets(login, 'untrusted'));
  console.log('PASS shared frontend inventory, login presentation and exact asset versioning');

  let sample = { times: {user:0, nice:0, sys:0, irq:0, idle:0} };
  const cpu = require('../hardware-telemetry').createCpuUsageSampler(() => structuredClone([sample]));
  sample.times = {user:20, nice:0, sys:0, irq:0, idle:80};
  assert.equal(cpu().overall, 20);
  sample.times = {user:1020, nice:0, sys:0, irq:0, idle:80};
  cpu.reset(); // Inactive interval must not contaminate the next active sample.
  sample.times = {user:1020, nice:0, sys:0, irq:0, idle:180};
  assert.equal(cpu().overall, 0);
  console.log('PASS CPU baseline reset excludes inactive work when a monitoring lease resumes');

  if (process.platform === 'win32') {
    // Execute just the real build's parsed copy loops against disposable inputs;
    // no installer build, download, live preview shutdown or publication occurs.
    const staged = path.join(temp, 'staged');
    fs.mkdirSync(path.join(staged, 'public'), {recursive:true});
    fs.mkdirSync(path.join(temp, 'public'));
    for (const file of web.PACKAGED_PUBLIC_FILES) fs.copyFileSync(path.join(root, 'public', file), path.join(temp, 'public', file));
    fs.writeFileSync(path.join(temp, 'public/private.txt'), 'private fixture');
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    const stagingTest = path.join(temp, 'stage.ps1');
    fs.writeFileSync(stagingTest, `$ErrorActionPreference='Stop'
$repo=${quote(temp)}; $app=${quote(staged)}
$runtimeManifest=(& ${quote(process.execPath)} ${quote(path.join(root,'server-lifecycle.js'))} --runtime-files | ConvertFrom-Json)
$rootFiles=@($runtimeManifest.root)+@('run_hidden.vbs','LICENSE')
$tokens=$null;$errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile(${quote(path.join(root,'packaging/build.ps1'))},[ref]$tokens,[ref]$errors)
if($errors.Count){throw 'Invalid build script'}
foreach($condition in @('$rootFiles','$runtimeManifest.public')){
 $loops=@($ast.FindAll({param($item) $item -is [Management.Automation.Language.ForEachStatementAst] -and $item.Condition.Extent.Text -eq $condition},$true))
 if($loops.Count -ne 1){throw 'Build staging loop is missing or ambiguous'}
 & ([scriptblock]::Create($loops[0].Extent.Text))
}
`);
    for (const file of ['run_hidden.vbs','LICENSE']) fs.copyFileSync(path.join(root, file), path.join(temp, file));
    execFileSync('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',stagingTest], {windowsHide:true,timeout:20000});
    assert.deepEqual(fs.readdirSync(staged).filter(f => f !== 'public').sort(), [...files, 'run_hidden.vbs', 'LICENSE'].sort());
    assert.deepEqual(fs.readdirSync(path.join(staged, 'public')).sort(), [...web.PACKAGED_PUBLIC_FILES].sort());
    console.log('PASS actual Windows build copy loops include every runtime/frontend input and exclude private/unlisted files');
    const compiler = path.join(process.env.SystemRoot, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
    const payload = path.join(root, 'packaging/payload/app');
    const harness = path.join(temp, 'ArchitectureTest.cs');
    fs.writeFileSync(harness, `using System;using System.IO;class ArchitectureTest{static int Main(string[] args){bool preview=args[0]=="preview";string app=Path.GetFullPath(args[1]);if(DesktopShell.IsPreviewBuild!=preview||DesktopShell.AppDirectory!=app||DesktopShell.HostHelperScript!=(preview?"desktop-preview-host.ps1":"desktop-host.ps1")||DesktopShell.IconPath!=Path.Combine(AppDomain.CurrentDomain.BaseDirectory,"Rovarin.ico")||DesktopShell.DataDirectory!=Path.Combine(preview?AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\\\'):Path.GetDirectoryName(app),"data"))return 1;Console.WriteLine("PASS compiled "+args[0]+" storage, helper and icon configuration");return 0;}}`);
    for (const [preview, bound] of [[false,false], [false,true], [true,true]]) {
      const directory = path.join(temp, preview ? 'packaging/cache/desktop-preview' : 'app');
      fs.mkdirSync(directory, {recursive:true});
      for (const dll of ['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll']) fs.copyFileSync(path.join(payload, dll), path.join(directory, dll));
      const output = path.join(directory, 'ArchitectureTest.exe');
      const binding = path.join(temp, 'DesktopBinding.cs');
      fs.writeFileSync(binding, 'internal static partial class DesktopShell { internal const string MaintenanceSetupHash = "' + 'b'.repeat(64) + '"; }');
      const defines = [preview ? 'ROVARIN_PREVIEW' : '', bound ? 'ROVARIN_BOUND_MAINTENANCE' : ''].filter(Boolean);
      const args = ['/nologo','/target:exe','/main:ArchitectureTest','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/r:System.Web.Extensions.dll',...['Microsoft.Web.WebView2.Core.dll','Microsoft.Web.WebView2.WinForms.dll'].map(f => '/r:' + path.join(directory, f)), '/out:' + output, ...(defines.length ? ['/define:' + defines.join(',')] : []), ...(bound ? [binding] : []), path.join(root, 'packaging/DesktopShell.cs'), harness];
      execFileSync(compiler, args, {windowsHide:true,timeout:30000});
      process.stdout.write(execFileSync(output, [preview?'preview':'production', preview?temp:directory], {windowsHide:true,encoding:'utf8',timeout:10000}));
    }
    const previewScript = fs.readFileSync(path.join(root, 'scripts/desktop-preview.ps1'), 'utf8');
    assert(previewScript.includes('/define:ROVARIN_PREVIEW,ROVARIN_BOUND_MAINTENANCE'));
    assert(!previewScript.includes('.Replace('));
    assert(!fs.readFileSync(path.join(root,'packaging/build.ps1'),'utf8').includes('$shellSource.Replace('));
    assert(!previewScript.includes('$patches ='));

    require('../pin-manager').writeConfig(path.join(temp,'config.json'), {pin:'123456',autoCheckUpdates:false});
    let startup = '';
    backend = spawn(process.execPath, [path.join(temp,'server.js')], {cwd:temp,windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PORT:'0',PC_MONITOR_PIN:''}});
    backend.stdout.on('data', data => {startup += data;});
    backend.stderr.on('data', data => {startup += data;});
    let origin;
    for (let i=0;i<150;i++) {
      const ready = startup.match(/Localhost access: (http:\/\/127\.0\.0\.1:\d+)/);
      if (ready) {origin=ready[1];break;}
      if (backend.exitCode !== null) throw Error('Presentation fixture exited before startup');
      await new Promise(resolve => setTimeout(resolve,100));
    }
    assert(origin, 'presentation fixture starts within its deadline');
    const request = () => fetch(origin, {headers:{Connection:'close'},signal:AbortSignal.timeout(3000)});
    assert.equal((await request()).status,200);
    const fixtureLogin = path.join(temp,'public/login.html');
    fs.writeFileSync(fixtureLogin, login.replace('rovarin-pin-mode','missing-pin-mode'));
    assert.equal((await request()).status,503, 'broken presentation metadata fails closed without crashing the backend');
    fs.writeFileSync(fixtureLogin, login);
    const restored = await request();
    assert.equal(restored.status,200);
    assert((await restored.text()).includes('name="rovarin-pin-mode" content="6"'));
    assert.equal(backend.exitCode,null);
    console.log('PASS actual HTTP login rendering, malformed-template 503 and recovery in the same disposable backend');
  }
} finally {
  if (backend && backend.exitCode === null) {
    const closed = new Promise(resolve => backend.once('close', resolve));
    backend.kill(); await closed;
  }
  assert(path.resolve(temp).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(temp, {recursive:true,force:true,maxRetries:10,retryDelay:100});
}
})().catch(error => {console.error(error);process.exitCode=1;});
