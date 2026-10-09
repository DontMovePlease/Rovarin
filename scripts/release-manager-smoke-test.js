'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const {execFileSync} = require('child_process');
const {Manager,execute,permitted,semver,hash} = require('./release-manager');
const {SUITES,verifyAndPublish} = require('./release-verify');
async function test(root = path.resolve(__dirname,'..')) {
  {
    const sha='a'.repeat(40), email='DontMovePlease@users.noreply.github.com';
    let row=[sha,'DontMovePlease',email,'GitHub','noreply@github.com'].join('\t');
    let response={sha,author:{login:'DontMovePlease'},committer:{login:'web-flow'},commit:{verification:{verified:true,reason:'valid'}}}, checks=0;
    const manager=new Manager(root,{run:async(command,args)=>{
      if(command==='git')return row;
      assert.strictEqual(command,'gh');assert.deepStrictEqual(args,['api','repos/DontMovePlease/Rovarin/commits/'+sha]);checks++;return JSON.stringify(response);
    }});
    await manager.reviewIdentities();assert.strictEqual(checks,1);
    for(const invalid of [
      {...response,sha:'b'.repeat(40)}, {...response,author:{login:'AnotherOwner'}},
      {...response,committer:{login:'AnotherOwner'}}, {...response,commit:{verification:{verified:false,reason:'unsigned'}}}
    ]) { const saved=response;response=invalid;await assert.rejects(manager.reviewIdentities(),/could not be verified/);response=saved; }
    for(const invalid of [[sha,'DontMovePlease','personal@example.invalid','GitHub','noreply@github.com'],[sha,'DontMovePlease',email,'GitHub','personal@example.invalid'],[sha,'DontMovePlease',email,'AnotherOwner','noreply@github.com']]) {
      const saved=row,before=checks;row=invalid.join('\t');await assert.rejects(manager.reviewIdentities(),/personal Git identity/);assert.strictEqual(checks,before);row=saved;
    }
    row=[sha,'DontMovePlease',email,'DontMovePlease',email].join('\t');const before=checks;await manager.reviewIdentities();assert.strictEqual(checks,before);
    console.log('PASS owner noreply history, exact verified GitHub web commits, spoof/foreign/unsigned rejection and personal-email protection');
  }
  const launcher = fs.readFileSync(path.join(root,'scripts/release-manager-launch.ps1'),'utf8');
  assert(launcher.includes('$info.CreateNoWindow = $true'));
  assert(launcher.includes('$info.UseShellExecute = $false'));
  assert(launcher.includes('$child.StandardError.ReadToEndAsync()'));
  assert(launcher.includes('[ReleaseStartupError]::Show($_.Exception.Message'));
  assert(launcher.includes('ShowWindow(form.Handle,9)'));
  assert(!launcher.includes('WindowStyle'));
  const vbs = fs.readFileSync(path.join(root,'Rovarin Release Manager.vbs'),'utf8');
  assert(vbs.includes('WScript.ScriptFullName') && vbs.includes('release-manager-launch.ps1'));
  assert(vbs.includes('Err.Description'));
  console.log('PASS absolute launcher paths, console-only suppression and readable startup error handling');
  const help=JSON.parse(fs.readFileSync(path.join(root,'scripts/release-manager-help.json'),'utf8'));
  for(const name of ['Check Project Status','Preview New Release','Upload Project to GitHub','Publish New Version','Restore Project Progress','Open GitHub','Updates & Tools']) assert(help[name].body && help[name].safety);
  assert.strictEqual(help['Publish New Version'].safety,'PUBLIC DOWNLOAD');
  assert.strictEqual(help['Restore Project Progress'].safety,'LOCAL CHANGE');
  for(const name of ['Check Project Status','Preview New Release','Open GitHub'])assert.strictEqual(help[name].safety,'READ ONLY');
  for(const entry of Object.values(help))assert(!/\b(?:commit|push|origin|HEAD|branch|preflight|staging|SHA|semver)\b/i.test(entry.body));
  const ui=fs.readFileSync(path.join(root,'scripts/release-manager-ui.ps1'),'utf8');
  for(const old of ['Save & Push Source','Dry Run / Preview','Publish New Release','Refresh Status','Developer Tools'])assert(!ui.includes("Button '"+old+"'"));
  assert(ui.includes('$log.Visible=$false') && ui.includes('New-Object HelpScrollPanel'));
  const dialogs=fs.readFileSync(path.join(root,'scripts/release-manager-dialogs.ps1'),'utf8');
  assert(dialogs.includes('Publish Version ') && dialogs.includes('Nothing will be changed.') && ui.includes('GitHub will NOT be changed'));
  const {Tools,packageRow,UPDATABLE}=require('./release-manager-tools');
  assert.deepStrictEqual(Object.values(UPDATABLE).sort(),['Git.Git','GitHub.cli']);
  assert.strictEqual(packageRow('Git Git.Git unknown 2.9 winget','Git.Git'),null);
  assert.strictEqual(packageRow('Git Git.Git 2.45.1 winget','Git.Git').available,null);
  assert.strictEqual(packageRow('Git Git.Git 2.55.0.5','Git.Git').available,null);
  assert.strictEqual(packageRow('GitHub CLI GitHub.cli 2.60.0 2.61.0','GitHub.cli').available,'2.61.0');
  let missing='',signedOut=false,checkFailure=false,ghUpdated=false;const toolCalls=[];
  const toolRun=async(command,args)=>{
    toolCalls.push({command,args});
    if(command===missing)throw new Error('fixture tool unavailable');
    if(command==='git')return 'git version 2.45.1.windows.1';
    if(command==='gh'){if(args[0]==='auth' && signedOut)throw new Error('fixture expired authentication');if(args[0]==='api')return 'DontMovePlease';return 'gh version '+(ghUpdated?'2.61.0':'2.60.0');}
    if(command==='winget'){if(args[0]==='upgrade'){ghUpdated=true;return '';}if(args[0]==='list'){if(checkFailure)throw new Error('fixture update check failed');return args.includes('Git.Git')?'Git Git.Git 2.45.1 2.46.0 winget':(ghUpdated?'GitHub CLI GitHub.cli 2.61.0 winget':'GitHub CLI GitHub.cli 2.60.0 2.61.0 winget');}return 'v1.12.0';}
    if(command==='node')return 'v24.21.0';if(command==='powershell.exe')return '5.1.26100.1';return '11.0.0';
  };
  const tools=new Tools(root,toolRun,{coreOwned:async()=>true,discover:async()=>[{id:'git',file:'git'},{id:'gh',file:'gh'}],history:()=>{}});let inventory=await tools.status(true);
  assert.strictEqual(inventory.account,'DontMovePlease');
  for(const id of ['git','gh'])assert.strictEqual(inventory.tools.find(t=>t.id===id).update,'Update available');
  assert(!toolCalls.some(c=>c.args[0]==='upgrade'));
  for(const tool of ['git','gh']){missing=tool;inventory=await tools.status(true);assert(!inventory.tools.find(t=>t.id===tool).installed);}
  missing='winget';inventory=await tools.status(true);assert.strictEqual(inventory.tools.find(t=>t.id==='git').update,'Unable to determine');missing='';
  signedOut=true;assert.strictEqual((await tools.status()).account,'Sign-in required');signedOut=false;
  checkFailure=true;assert.strictEqual((await tools.status(true)).tools.find(t=>t.id==='gh').update,'Unable to determine');checkFailure=false;
  await assert.rejects(tools.update({tool:'git',confirm:false}),/confirmation/);
  for(const tool of ['node','pawnio','inno','webview2','constructor','__proto__'])await assert.rejects(tools.update({tool,confirm:true}),/Only Git/);
  await assert.rejects(tools.update({tool:'git',current:'2.45.1',available:'9.9.9',confirm:true}),/changed/);
  assert(!toolCalls.some(c=>c.args[0]==='upgrade'));
  await tools.update({tool:'gh',current:'2.60.0',available:'2.61.0',snapshot:(await tools.status(true)).tools.find(t=>t.id==='gh').snapshot,confirm:true});
  const upgrade=toolCalls.find(c=>c.args[0]==='upgrade');assert.deepStrictEqual(upgrade.args,['upgrade','--id','GitHub.cli','--exact','--source','winget','--version','2.61.0','--disable-interactivity']);
  assert(!toolCalls.some(c=>c.args.includes('--all')));
  assert.strictEqual(inventory.pinned.length,4);
  console.log('PASS help/safety labels, tool versions/updates, missing tools/WinGet, expired auth, check failure, cancel/confirmation, pinned exclusions and exact mocked update');
  const {CODING,redact}=require('./release-manager-tools');
  assert(!CODING.some(t=>/ollama|openrouter|groq/i.test(t.id)));
  const npmRoot=path.resolve('packaging/cache/mock-npm/node_modules'),prefix=path.dirname(npmRoot);
  let codingVersion='1.2.3',latest='1.3.0',lookupFailed=false,launchFailed=false,updateFailed=false,unchanged=false;
  let discovery=[{id:'codex',file:path.join(prefix,'codex.ps1')},{id:'opencode',file:path.join(prefix,'opencode.cmd')},{id:'agy',file:path.join(prefix,'agy.exe')},{id:'rokit',file:path.join(prefix,'rokit.exe')},{id:'rojo',file:path.resolve('.rokit/bin/rojo.exe')}];
  const codingCalls=[];
  const codingRun=async(command,args)=>{
    codingCalls.push({command,args});
    if(args.includes('npm-cli.js') || args[0]?.endsWith('npm-cli.js')){
      const verb=args[1];
      if(verb==='root')return npmRoot;
      if(verb==='list')return JSON.stringify({dependencies:{'@openai/codex':{version:codingVersion},'@opencode/cli':{version:codingVersion}}});
      if(verb==='view'){if(lookupFailed)throw new Error('token=secret fixture');return JSON.stringify(latest);}
      if(verb==='install'){if(updateFailed)throw new Error('api_key=private fixture');if(!unchanged)codingVersion=latest;return '';}
    }
    if(command.includes('mock-npm') || command.includes('.rokit') || args[0]?.includes('mock-npm')){if(launchFailed)throw new Error('token=private fixture');return codingVersion;}
    return toolRun(command,args);
  };
  const coding=new Tools(root,codingRun,{discover:async()=>discovery,history:()=>{}});
  let items=(await coding.status(true)).tools;
  for(const id of ['codex','opencode']){assert(items.find(t=>t.id===id).canUpdate);assert.strictEqual(items.find(t=>t.id===id).method,'npm');}
  assert.strictEqual(items.find(t=>t.id==='agy').method,'Unknown');assert(!items.find(t=>t.id==='agy').canUpdate);
  assert(items.find(t=>t.id==='rokit'));assert.strictEqual(items.find(t=>t.id==='rojo').method,'Rokit');
  const activeCodex=discovery[0].file;discovery[0].file=path.join(prefix,'other/codex.exe');
  assert.strictEqual((await coding.status(true)).tools.find(t=>t.id==='codex').method,'Unknown');discovery[0].file=activeCodex;
  const savedVersion=codingVersion;codingVersion='not-a-version';assert(!(await coding.status(true)).tools.find(t=>t.id==='codex').canUpdate);codingVersion=savedVersion;
  const unowned=new Tools(root,toolRun,{coreOwned:async()=>false,discover:async()=>[]});assert(!(await unowned.status(true)).tools.find(t=>t.id==='git').canUpdate);
  await assert.rejects(coding.update({tool:'opencode',confirm:false}),/confirmation/);
  latest=codingVersion;assert.strictEqual((await coding.status(true)).tools.find(t=>t.id==='codex').update,'Current');
  latest='malformed';assert.strictEqual((await coding.status(true)).tools.find(t=>t.id==='codex').update,'Unable to check');
  latest='1.3.0-beta.1';assert(!(await coding.status(true)).tools.find(t=>t.id==='codex').canUpdate);
  latest='1.3.0';lookupFailed=true;items=(await coding.status(true)).tools;assert(!items.find(t=>t.id==='opencode').canUpdate);assert(!JSON.stringify(items).includes('secret'));lookupFailed=false;
  launchFailed=true;items=(await coding.status(true)).tools;assert(!items.find(t=>t.id==='codex').canUpdate);assert(!JSON.stringify(items).includes('private'));launchFailed=false;
  const codingSnapshot=()=>coding.status(true).then(v=>v.tools.find(t=>t.id==='opencode').snapshot);
  updateFailed=true;await assert.rejects(coding.update({tool:'opencode',current:'1.2.3',available:'1.3.0',snapshot:await codingSnapshot(),confirm:true}),/\[redacted\]/);updateFailed=false;
  unchanged=true;await assert.rejects(coding.update({tool:'opencode',current:'1.2.3',available:'1.3.0',snapshot:await codingSnapshot(),confirm:true}),/could not be verified/);unchanged=false;
  const updated=await coding.update({tool:'opencode',current:'1.2.3',available:'1.3.0',snapshot:await codingSnapshot(),confirm:true});assert(updated.message.includes('updated successfully'));
  const install=codingCalls.find(c=>c.args[1]==='install');assert(install.args.includes('@opencode/cli@1.3.0'));assert(install.args.includes('--prefix'));assert(!codingCalls.some(c=>c.args.includes('--all') || c.args.includes('update')));
  discovery=[];assert(!(await coding.status(true)).tools.some(t=>t.group==='coding'));
  assert(!redact('token=private\nghp_ABC123\nsk-abc123').includes('private'));
  console.log('PASS coding allowlist, npm ownership, Codex/OpenCode current/update states, unknown Antigravity, Rokit-owned Rojo, missing/malformed/failed lookup, cancellation, exact mocked update and post-update verification/redaction');
  const {compare}=require('./release-manager-tools');
  assert.strictEqual(compare('2.0.22','2.0.9'),1);assert.strictEqual(compare('0.159.0-alpha.12.1','0.159.0-alpha.9.1'),1);assert.strictEqual(compare('0.159.0-alpha.12.1','0.159.0'),null);assert.strictEqual(compare('2.55.0.windows.5','2.55.0.5'),0);
  const reliabilityRoot=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-tool-reliability-'));
  fs.mkdirSync(path.join(reliabilityRoot,'packaging'),{recursive:true});fs.copyFileSync(path.join(root,'packaging/build.ps1'),path.join(reliabilityRoot,'packaging/build.ps1'));
  const preserved=path.join(reliabilityRoot,'developer-settings.json');fs.writeFileSync(preserved,'fixture configuration and fixture-credential-kept-private');
  try{
    for(const target of ['codex','opencode','gemini','git','gh']){
      const definition=CODING.find(t=>t.id===target),pkg=definition?.packages?.[0][0];
      const npmRoot=path.join(reliabilityRoot,'npm/node_modules'),prefix=path.dirname(npmRoot),active=path.join(prefix,target+(pkg?'.cmd':'.exe'));
      let installed='1.2.3',targetVersion='1.3.0',effect='',lookupFailure=false,malformed=false,owned=true,repository='unchanged',authFailure=false,healthFailure=false,started=0;
      let copies=[{id:target,file:active}];const calls=[];
      const runner=async(command,args)=>{
        calls.push({command,args});
        if(args[0]?.endsWith('npm-cli.js')){
          if(args[1]==='root')return npmRoot;
          if(args[1]==='list')return JSON.stringify({dependencies:pkg?{[pkg]:{version:installed}}:{}});
          if(args[1]==='view'){if(lookupFailure)throw new Error('network token=secret');return JSON.stringify(targetVersion);}
          if(args[1]==='install'){await change();return '';}
        }
        if(command==='winget' && args[0]==='list'){if(lookupFailure)throw new Error('network api_key=secret');return `${target} ${UPDATABLE[target]||'Other'} ${installed} ${installed!==targetVersion?targetVersion+' ':''}winget`;}
        if(command==='winget' && args[0]==='upgrade'){await change();return '';}
        if((command==='gh' || (target==='gh' && command===active)) && args[0]==='auth'){if(authFailure)throw new Error('auth failed');return 'Authenticated';}
        if(target==='gh' && command===active && args[0]==='api')return 'DontMovePlease';
        if(command===active || command.includes('node_modules') || args[0]?.includes('node_modules')){
          if(effect==='missing' && started)throw new Error('missing executable');
          if(args.includes('--help')){if(healthFailure && started)throw new Error('health failed');return 'Usage: fixture';}
          return malformed?'not a version':(target==='git'?'git version ':target==='gh'?'gh version ':'')+installed;
        }
        return toolRun(command,args);
      };
      async function change(){started++;if(effect==='failed')throw new Error('token=secret');if(effect==='unchanged')return;if(effect==='wait')await new Promise(r=>setTimeout(r,50));installed=targetVersion;if(effect==='path')copies=[{id:target,file:path.join(prefix,'other',path.basename(active))}];if(effect==='duplicate')copies.push({id:target,file:path.join(prefix,'other',path.basename(active))});if(effect==='repo')repository='changed';if(effect==='auth')authFailure=true;}
      const tool=new Tools(reliabilityRoot,runner,{discover:async()=>copies,coreOwned:async()=>owned,repositoryState:async()=>repository});
      const option=async()=>{const t=(await tool.status(true)).tools.find(t=>t.id===target);return {tool:target,current:t.packageVersion,available:t.available,snapshot:t.snapshot,confirm:true};};
      assert((await tool.status(true)).tools.find(t=>t.id===target).canUpdate);
      await assert.rejects(tool.update({...await option(),confirm:false}),/confirmation/);assert.strictEqual(started,0);
      targetVersion=installed;assert(!(await tool.status(true)).tools.find(t=>t.id===target).canUpdate);targetVersion='1.3.0';
      targetVersion='1.3.0-preview.1';assert(!(await tool.status(true)).tools.find(t=>t.id===target).canUpdate);targetVersion='1.3.0';
      lookupFailure=true;assert(!(await tool.status(true)).tools.find(t=>t.id===target).canUpdate);lookupFailure=false;
      malformed=true;assert(!(await tool.status(true)).tools.find(t=>t.id===target).canUpdate);malformed=false;
      copies.push({id:target,file:path.join(prefix,'other',path.basename(active))});assert(!(await tool.status(true)).tools.find(t=>t.id===target).canUpdate);copies=[{id:target,file:active}];
      for(const failure of ['failed','unchanged','path','duplicate','missing']){
        installed='1.2.3';effect=failure;started=0;copies=[{id:target,file:active}];await assert.rejects(tool.update(await option()),/could not be verified/);
      }
      installed='1.2.3';effect='';started=0;copies=[{id:target,file:active}];healthFailure=true;await assert.rejects(tool.update(await option()),/could not be verified/);healthFailure=false;
      if(target==='git'){installed='1.2.3';started=0;effect='repo';await assert.rejects(tool.update(await option()),/Repository files changed/);repository='unchanged';}
      if(target==='gh'){installed='1.2.3';started=0;effect='auth';await assert.rejects(tool.update(await option()),/authentication/);authFailure=false;}
      installed='1.2.3';effect='wait';started=0;copies=[{id:target,file:active}];const options=await option(),first=tool.update(options);await assert.rejects(tool.update(options),/Another tool update/);assert((await first).message.includes('updated successfully'));
      assert(!calls.some(c=>c.args.includes('--all') || c.args[0]==='self-update'));
      const history=fs.readFileSync(path.join(reliabilityRoot,'packaging/cache/release-tool-history.json'),'utf8');assert(!/secret|token|credential|command|executable/i.test(history));assert(history.includes('Success') && history.includes('Failed'));
      assert.strictEqual(fs.readFileSync(preserved,'utf8'),'fixture configuration and fixture-credential-kept-private');
      console.log('PASS '+target+' updater: current/cancel/offline/malformed/duplicate/wrong active copy/missing/unchanged/health failure, same-copy target verification and concurrent rejection');
    }
    const unavailable=new Tools(reliabilityRoot,toolRun,{discover:async()=>[{id:'codex',file:path.join(reliabilityRoot,'pnpm/codex.cmd')},{id:'rokit',file:path.join(process.env.USERPROFILE,'.rokit/bin/rokit.exe')},{id:'rojo',file:path.join(process.env.USERPROFILE,'.rokit/bin/rojo.exe')}],history:()=>{}});
    const unavailableStatus=await unavailable.status(true);for(const id of ['codex','rokit','rojo'])assert(!unavailableStatus.tools.find(t=>t.id===id).canUpdate);
    await assert.rejects(unavailable.update({tool:'rokit',confirm:true}),/Only Git/);
    const bounded=new Tools(reliabilityRoot,toolRun);for(let i=0;i<60;i++)bounded.history({name:'OpenCode',version:'1.2.3'},{version:'1.3.0'},'Success');assert.strictEqual(JSON.parse(fs.readFileSync(path.join(reliabilityRoot,'packaging/cache/release-tool-history.json'),'utf8')).length,50);
    console.log('PASS unsupported pnpm/standalone Codex and interactive Rokit fail closed; Rojo never bypasses Rokit; bounded local history excludes secrets');
  }finally{fs.rmSync(reliabilityRoot,{recursive:true,force:true});}
  {
    const {sections}=require('./release-manager-tools');
    const items=[{id:'opencode',name:'OpenCode',installed:true,version:'2.0.20',packageVersion:'2.0.20',available:'2.0.22',snapshot:'a'.repeat(64),canUpdate:true,update:'Update available'},
      {id:'gemini',name:'Gemini CLI',installed:true,version:'0.61.0',packageVersion:'0.61.0',available:'0.62.0',snapshot:'b'.repeat(64),canUpdate:true,update:'Update available'},
      {id:'codex',name:'Codex',installed:true,version:'0.159.0-alpha.12.1',canUpdate:false,update:'Automatic update unavailable'},
      {id:'git',name:'Git',installed:true,version:'2.0.0',canUpdate:false,update:'Current'},
      {id:'node',name:'Node.js',installed:true,version:'24.0.0',canUpdate:false}];
    const grouped=sections(items);assert.deepStrictEqual(grouped.map(g=>g.title),['Updates Available','Up to Date','Needs Attention','System Tools']);
    assert.deepStrictEqual(grouped[0].items.map(t=>t.id),['opencode','gemini']);assert.strictEqual(sections([])[0].items.length,0);assert.strictEqual(sections(items.slice(0,1))[0].items.length,1);
    const candidates=items.filter(t=>t.canUpdate).map(t=>({tool:t.id,current:t.packageVersion,available:t.available,snapshot:t.snapshot}));
    const batch=new Tools(path.join(os.tmpdir(),'rovarin-batch-fixture'),async()=>{throw new Error('Real commands forbidden in batch fixture');});
    batch.status=async()=>({tools:items,sections:sections(items)});
    let active=0,peak=0,calls=[],effect='';
    batch.performUpdate=async options=>{calls.push(options.tool);active++;peak=Math.max(peak,active);try{await new Promise(r=>setTimeout(r,20));if(options.tool==='gemini' && effect)throw Object.assign(new Error(effect),{code:effect==='changed'?'UPDATE_NOT_STARTED':undefined});return {};}finally{active--;}};
    await assert.rejects(batch.updateAll({confirm:false,candidates}),/confirmation/);assert.strictEqual(calls.length,0);
    await assert.rejects(batch.updateAll({confirm:true,candidates:[]}),/reviewed/);
    await assert.rejects(batch.updateAll({confirm:true,candidates:[{...candidates[0],tool:'node'}]}),/unverified/);assert.strictEqual(calls.length,0);
    const progress=[];const first=batch.updateAll({confirm:true,candidates},e=>progress.push(e.message));await assert.rejects(batch.update(candidates[0]),/Another tool update/);const success=await first;
    assert.strictEqual(peak,1);assert.deepStrictEqual(calls,['opencode','gemini']);assert(success.results.every(r=>r.result==='Success'));assert(progress[1].includes('2 of 2'));
    for(effect of ['updater failed','version unchanged','unexpected active copy','changed']){calls=[];const result=await batch.updateAll({confirm:true,candidates});assert.strictEqual(result.results[0].result,'Success');assert.strictEqual(result.results[1].result,effect==='changed'?'Skipped':'Failed');assert.deepStrictEqual(calls,['opencode','gemini']);assert(!result.message.includes('updated successfully'));}
    // Use the real individual preflight to prove stale and ambiguous candidates cannot execute.
    const real=new Tools(path.join(os.tmpdir(),'rovarin-batch-real-preflight'),async()=>{throw new Error('No command may execute');});
    for(const changed of [{...items[0],version:'2.0.21',packageVersion:'2.0.21',snapshot:'c'.repeat(64)},{...items[0],canUpdate:false,multiple:true}]){
      real.status=async()=>({tools:[changed],sections:sections([changed])});const result=await real.updateAll({confirm:true,candidates:[candidates[0]]});assert.strictEqual(result.results[0].result,'Skipped');
    }
    // Batch execution through the unmodified strict updater, with only command I/O mocked.
    const {stamp}=require('./release-manager-tools');
    for(const fault of ['', 'unchanged', 'offline']){
      const installed=items.slice(0,2).map(t=>({...t,method:'npm',package:t.id==='opencode'?'@opencode/cli':'@google/gemini-cli',prefix:'fixture-prefix',active:t.id,entry:t.id+'.exe',node:process.execPath}));
      let writes=0;const actual=new Tools(path.join(os.tmpdir(),'rovarin-batch-command-fixture'),async(command,args)=>{
        assert.strictEqual(command,process.execPath);assert.strictEqual(args[1],'install');assert.strictEqual(args[2],'-g');assert(!args.includes('--all'));
        const tool=installed.find(t=>args[3]===t.package+'@'+t.available);assert(tool);writes++;
        if(tool.id==='gemini' && fault==='offline')throw new Error('fixture offline token=private');
        if(tool.id!=='gemini' || fault!=='unchanged'){tool.version=tool.available;tool.packageVersion=tool.available;tool.canUpdate=false;tool.update='Current';}
        return '';
      },{discover:async()=>installed.map(t=>({id:t.id,file:t.active})),history:()=>{}});
      actual.status=async()=>{const tools=installed.map(t=>({...t,snapshot:stamp(t)}));return {tools,sections:sections(tools)};};actual.health=async()=>({output:'Fixture help'});
      const checked=await actual.status();const reviewed=checked.tools.map(t=>({tool:t.id,current:t.packageVersion,available:t.available,snapshot:t.snapshot}));
      const result=await actual.updateAll({confirm:true,candidates:reviewed});assert.strictEqual(writes,2);assert.strictEqual(result.results[0].result,'Success');assert.strictEqual(result.results[1].result,fault?'Failed':'Success');assert(!JSON.stringify(result).includes('token=private'));
    }
    assert(dialogs.includes("$all.Add_Click") && dialogs.includes("'Update these tools?'") && dialogs.includes('Only these verified installations') && dialogs.includes('mode=\'UpdateTools\''));
    assert(ui.includes('@($script:toolBusyControls)') && dialogs.includes('$script:toolUpdateButtons') && dialogs.includes('$script:worker){return}'));
    assert(!fs.readFileSync(path.join(root,'scripts/release-manager-tools.js'),'utf8').includes("['upgrade','--all']"));
    console.log('PASS four tool groups, zero/one/multiple safe updates, exact confirmation/cancel, sequential shared updater, locks, mixed failures/skips, changed/ambiguous preflight and UI busy controls');
  }
  const temp = fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-release-manager-'));
  const git = (cwd,args) => execFileSync('git',['-c','core.autocrlf=false','-c','user.name=DontMovePlease','-c','user.email=DontMovePlease@users.noreply.github.com',...args],{cwd,windowsHide:true,encoding:'utf8',timeout:15000,stdio:['pipe','pipe','pipe']}).trim();
  let sequence = 0;
  function fixture() {
    const dir = path.join(temp,String(++sequence)); fs.mkdirSync(dir);
    const policy = JSON.parse(fs.readFileSync(path.join(root,'scripts/release-public-files.json'),'utf8'));
    for (const file of policy) if (fs.existsSync(path.join(root,file))) { fs.mkdirSync(path.dirname(path.join(dir,file)),{recursive:true}); fs.copyFileSync(path.join(root,file),path.join(dir,file)); }
    git(dir,['init','-b','main']); git(dir,['config','core.autocrlf','false']); git(dir,['add','--all']); git(dir,['commit','-m','Fixture initial source']);
    const pub = path.join(dir,'packaging/cache/github-publication'); fs.mkdirSync(path.dirname(pub),{recursive:true});
    git(dir,['clone','--no-hardlinks',dir,pub]); git(pub,['remote','set-url','origin','https://github.com/DontMovePlease/Rovarin.git']);
    git(pub,['config','user.name','DontMovePlease']); git(pub,['config','user.email','DontMovePlease@users.noreply.github.com']);
    git(pub,['config','core.autocrlf','false']);
    git(pub,['tag','v0.1.0']);
    fs.writeFileSync(path.join(dir,'AGENTS.md'),'PRIVATE fixture instructions');
    const calls = []; let draft = true, failedBuild = false, failedVerify = false, editDuringVerify = false, remoteTag = false, oldRelease = false, corruptUpload = false;
    const runner = async (command,args,cwd,timeout,input) => {
      calls.push({command:path.basename(command),args:[...args],cwd,timeout});
      if (command === 'git') {
        const verb = args[2];
        if (verb === 'fetch' || verb === 'push') return '';
        if (verb === 'ls-remote') return remoteTag ? 'fixture-sha\trefs/tags/v0.1.1\n' : '';
      }
      if (command === 'gh') {
        if (args[0] === '--version' || args[0] === 'auth') return 'fixture authenticated';
        if (args[0] === 'repo' && args[1] === 'view') return JSON.stringify({nameWithOwner:'DontMovePlease/Rovarin',viewerPermission:'ADMIN'});
        if (args[0] === 'release' && args[1] === 'list') return JSON.stringify(oldRelease ? [{tagName:'v0.1.1'}] : []);
        if (args[0] === 'release' && ['create','upload'].includes(args[1])) return '';
        if (args[0] === 'release' && args[1] === 'edit') { draft = false; return ''; }
        if (args[0] === 'api') {
          const publish = path.join(dir,'publish');
          return JSON.stringify({tag_name:'v0.1.1',draft,html_url:'https://github.com/DontMovePlease/Rovarin/releases/tag/v0.1.1',assets:['RovarinSetup.exe','RovarinSetup.sha256','release.json'].map(name=>{
            const bytes=fs.readFileSync(path.join(publish,name)); return {name,size:bytes.length,state:'uploaded',digest:'sha256:'+(corruptUpload ? '0'.repeat(64) : hash(bytes))};
          })});
        }
        throw new Error('Unexpected fixture gh command');
      }
      if (command === 'powershell.exe' && args.includes('packaging/build.ps1')) { if(failedBuild)throw new Error('fixture build failure'); return ''; }
      if (command === process.execPath && args.includes('scripts/release-verify.js')) {
        if(failedVerify)throw new Error('fixture verification failure');
        fs.mkdirSync(path.join(dir,'dist'),{recursive:true}); fs.mkdirSync(path.join(dir,'publish'),{recursive:true});
        const bytes=Buffer.from('DISPOSABLE MOCK INSTALLER ONLY'); const digest=hash(bytes);
        fs.writeFileSync(path.join(dir,'dist/RovarinSetup.exe'),bytes); fs.writeFileSync(path.join(dir,'publish/RovarinSetup.exe'),bytes);
        fs.mkdirSync(path.join(dir,'packaging/payload/app'),{recursive:true});
        fs.copyFileSync(path.join(dir,'server.js'),path.join(dir,'packaging/payload/app/server.js'));
        fs.writeFileSync(path.join(dir,'packaging/payload-manifest.json'),JSON.stringify({files:[{path:'app/server.js',sha256:hash(fs.readFileSync(path.join(dir,'server.js')))}]}));
        const manifest=hash(fs.readFileSync(path.join(dir,'packaging/payload-manifest.json')));
        const version=JSON.parse(fs.readFileSync(path.join(dir,'package.json'))).version;
        fs.writeFileSync(path.join(dir,'dist/build.json'),JSON.stringify({version,sha256:digest,payloadManifestSha256:manifest,inputs:['packaging/build.ps1','packaging/Rovarin.iss','packaging/RovarinLauncher.cs','packaging/DesktopShell.cs','packaging/desktop.manifest','packaging/create-icon.ps1'].map(p=>({path:p,sha256:hash(fs.readFileSync(path.join(dir,p)))}))}));
        fs.writeFileSync(path.join(dir,'publish/RovarinSetup.sha256'),digest+'  RovarinSetup.exe\n');
        fs.writeFileSync(path.join(dir,'publish/release.json'),JSON.stringify({version,builtAt:new Date().toISOString(),verifiedAt:new Date().toISOString(),signing:'unsigned',sha256:digest,payloadManifestSha256:manifest,suites:[...SUITES,'installer-integration']}));
        if(editDuringVerify)fs.appendFileSync(path.join(dir,'server.js'),'\n// changed during build\n');
        return '';
      }
      return execute(command,args,cwd,timeout,input);
    };
    return {dir,pub,calls,manager:new Manager(dir,{run:runner,approvePublish:async()=>true}),set(values){({failedBuild=failedBuild,failedVerify=failedVerify,editDuringVerify=editDuringVerify,remoteTag=remoteTag,oldRelease=oldRelease,corruptUpload=corruptUpload}=values);}};
  }
  try {
    for(const file of ["scripts/check-maint-status.ps1", "scripts/diagnose-service.ps1", "scripts/execute-crash-recovery-interactive.ps1", "scripts/execute-interrupted-install-interactive.ps1", "scripts/guest-install-rovarin.ps1", "scripts/guest-step-check.ps1", "scripts/guest-test-e2e-api.ps1", "scripts/guest-test-network-reset.ps1", "scripts/install-maintenance-interactive.ps1", "scripts/maintenance-release-vm-validation.ps1", "scripts/run-guest-cmd.ps1", "scripts/test-clean-install.ps1", "scripts/test-crash-recovery.ps1", "scripts/test-elevation.ps1", "scripts/test-mid-provisioning-interruption.ps1", "scripts/test-privileged-operations.ps1", "scripts/test-sfc-scan.ps1", "scripts/test-upgrade-scenario.ps1", "scripts/update-guest-service.ps1", "scripts/upload-maint-fixtures.ps1", "scripts/vm-control.ps1"]) assert(!permitted(file),file);
    for(const file of ['AGENTS.md','PROJECT_STATUS.md','THE-PLAN.md','SECURITY.md','docs/planning.md','config.json','desktop-trust.bin','publish/release.json','dist/setup.exe','packaging/cache/tool.js','../server.js','C:/Users/file','server.pid']) assert(!permitted(file),file);
    for(const file of ['README.md','LICENSE','vendor/LibreHardwareMonitor/0.9.6/README.md','docs/images/overview.png','scripts/release-manager.js']) assert(permitted(file),file);
    assert.strictEqual(semver('0.1.0').patchVersion,'0.1.1'); assert.strictEqual(semver('0.1.0').minorVersion,'0.2.0'); semver('0.2.0-rc.1+test');
    for(const v of ['v0.1.1','01.1.1','1.0','1.2.3-01','1.2.3;bad','65536.1.1'])assert.throws(()=>semver(v));
    console.log('PASS public/private path policy and patch/minor/custom SemVer validation');
    const f=fixture();
    const missingCli=new Manager(f.dir,{run:(command,args,cwd,timeout,input)=>command==='gh'?Promise.reject(new Error('fixture missing CLI')):execute(command,args,cwd,timeout,input)});
    await assert.rejects(missingCli.github(),/GitHub CLI is missing/);
    const signedOut=new Manager(f.dir,{run:(command,args,cwd,timeout,input)=>command==='gh'?(args[0]==='--version'?Promise.resolve('fixture'):Promise.reject(new Error('fixture signed out'))):execute(command,args,cwd,timeout,input)});
    await assert.rejects(signedOut.github(),/signed out/);
    const original=fs.readFileSync(path.join(f.dir,'package.json'));
    const save=await f.manager.plan('Save',{},true); assert.strictEqual(save.changes.length,0);
    assert(!f.calls.some(c=>c.args.includes('push')));
    await assert.rejects(f.manager.plan('Publish',{version:'0.1.1'},true),/Nothing new to publish/);
    fs.appendFileSync(path.join(f.dir,'public/app.css'),'\n/* fixture source change */\n');
    const plan=await f.manager.plan('Publish',{version:'0.1.1'},true);
    assert.strictEqual(plan.version,'0.1.1'); assert(plan.prerelease); assert.deepStrictEqual(plan.assets,['RovarinSetup.exe','RovarinSetup.sha256','release.json']);
    assert(plan.commands.includes('npm run build:installer')); assert(plan.commands.some(c=>c.startsWith('npm run release:verify')));
    assert(fs.readFileSync(path.join(f.dir,'package.json')).equals(original),'dry run did not change version');
    assert(!f.calls.some(c=>c.args.includes('push') || c.args.includes('create') || c.args.includes('upload')));
    await assert.rejects(f.manager.unique('0.1.0',false),/already exists/);
    f.set({remoteTag:true}); await assert.rejects(f.manager.unique('0.1.1'),/exists on GitHub/); f.set({remoteTag:false,oldRelease:true}); await assert.rejects(f.manager.unique('0.1.1'),/GitHub Release/); f.set({oldRelease:false});
    f.manager.synchronize('0.2.0-rc.1'); assert.strictEqual(f.manager.version().version,'0.2.0-rc.1'); f.manager.synchronize('0.1.0');
    const fixtureInstaller=fs.readFileSync(path.join(f.dir,'packaging/Rovarin.iss'),'utf8');
    fs.writeFileSync(path.join(f.dir,'packaging/Rovarin.iss'),fixtureInstaller.replace('"0.1.0"','"0.1.2"'));
    assert.throws(()=>f.manager.version(),/disagree/); fs.writeFileSync(path.join(f.dir,'packaging/Rovarin.iss'),fixtureInstaller);
    fs.copyFileSync(path.join(root,'public/app.css'),path.join(f.dir,'public/app.css'));
    f.manager.synchronize('0.1.1');
    fs.appendFileSync(path.join(f.dir,'scripts/release-manager-help.json'),'\n');
    const bookkeepingReadme=fs.readFileSync(path.join(f.dir,'README.md'),'utf8').replace(/https:\/\/github\.com\/DontMovePlease\/Rovarin\/releases(?=\))/g,'https://github.com/DontMovePlease/Rovarin/releases/download/v0.1.1/RovarinSetup.exe');
    fs.writeFileSync(path.join(f.dir,'README.md'),bookkeepingReadme);
    for(const file of ['package.json','packaging/Rovarin.iss','packaging/RovarinLauncher.cs','packaging/desktop.manifest','README.md'])fs.copyFileSync(path.join(f.dir,file),path.join(f.pub,file));
    git(f.pub,['add','package.json','packaging/Rovarin.iss','packaging/RovarinLauncher.cs','packaging/desktop.manifest','README.md']);git(f.pub,['commit','-m','Fixture version bookkeeping only']);
    await assert.rejects(f.manager.plan('Publish',{version:'0.1.2'},true),/Nothing new to publish/);
    console.log('PASS version-only, download-link-only and tooling-only changes do not permit an empty release even with saved changes after the prior version');
    f.manager.synchronize('0.1.0');
    console.log('PASS Save/Publish dry runs, no-change refusal, duplicate local/remote/release rejection and version agreement');
    git(f.dir,['add','-f','AGENTS.md']); await assert.rejects(f.manager.source(),/still tracked/); git(f.dir,['rm','--cached','AGENTS.md']); assert(fs.existsSync(path.join(f.dir,'AGENTS.md')));
    const pin=String(crypto.randomInt(100000,999999)); fs.writeFileSync(path.join(f.dir,'config.json'),JSON.stringify({pin}));
    fs.appendFileSync(path.join(f.dir,'server.js'),'\n// '+pin+'\n'); await assert.rejects(f.manager.source(),/Possible local credential/); fs.copyFileSync(path.join(root,'server.js'),path.join(f.dir,'server.js'));
    fs.appendFileSync(path.join(f.dir,'server.js'),'\n// '+['C:','Users','FixturePerson','private'].join('\\')+'\n'); await assert.rejects(f.manager.source(),/personal path/); fs.copyFileSync(path.join(root,'server.js'),path.join(f.dir,'server.js'));
    fs.appendFileSync(path.join(f.dir,'server.js'),'\n// ghp_'+'A'.repeat(30)+'\n'); await assert.rejects(f.manager.source(),/Possible local/); fs.copyFileSync(path.join(root,'server.js'),path.join(f.dir,'server.js'));
    // Secret values stay in disposable unsynced storage and never reach output.
    const pins=require('../pin-manager'),previousLocal=process.env.LOCALAPPDATA;
    process.env.LOCALAPPDATA=path.join(temp,'private-local');
    try {
      const canonical=pins.developmentConfigFile(f.dir);
      fs.mkdirSync(path.dirname(canonical),{recursive:true});
      pins.writeConfig(canonical,{pin,requireDesktopPin:true});
      fs.unlinkSync(path.join(f.dir,'config.json'));
      fs.writeFileSync(path.join(f.dir,'.rovarin-development-state.json'),'{"schema":1}');
      assert(!fs.existsSync(path.join(f.dir,'config.json')),'checkout config remains absent');
      assert(f.manager.secrets().includes(pin),'privacy preflight reads canonical unsynced config');
      await f.manager.source();
      fs.appendFileSync(path.join(f.dir,'server.js'),'\n// '+pin+'\n');
      await assert.rejects(f.manager.source(),error=>/Possible local credential/.test(error.message)&&!error.message.includes(pin));
      fs.copyFileSync(path.join(root,'server.js'),path.join(f.dir,'server.js'));
      const policyFile=path.join(f.dir,'scripts/release-public-files.json'),originalPolicy=fs.readFileSync(policyFile);
      fs.writeFileSync(policyFile,JSON.stringify([...JSON.parse(originalPolicy),'config.json']));
      assert.throws(()=>f.manager.policy(),/forbidden/);fs.writeFileSync(policyFile,originalPolicy);
      const alias=path.join(temp,'private-alias');fs.linkSync(canonical,alias);
      assert.throws(()=>f.manager.secrets(),/Cannot safely inspect canonical configuration/);fs.unlinkSync(alias);
      const saved=fs.readFileSync(canonical);fs.unlinkSync(canonical);
      assert.throws(()=>f.manager.secrets(),/Cannot safely inspect canonical configuration/);
      fs.writeFileSync(canonical,saved);
      fs.unlinkSync(path.join(f.dir,'.rovarin-development-state.json'));
      assert.throws(()=>f.manager.secrets(),/Cannot safely inspect canonical configuration/,'missing migration marker must not bypass existing canonical data');
      fs.unlinkSync(canonical);
      assert(!f.manager.secrets().includes(pin),'fresh checkout without config is valid');
      const app=path.join(temp,'installed-privacy','app'),data=path.join(temp,'installed-privacy','data');
      fs.mkdirSync(app,{recursive:true});fs.mkdirSync(data);
      fs.writeFileSync(path.join(app,'installation.json'),'{}');
      const installed=new Manager(app);
      assert.throws(()=>installed.secrets(),/Cannot safely inspect canonical configuration/);
      pins.writeConfig(path.join(data,'config.json'),{pin});
      assert(installed.secrets().includes(pin),'installed sibling config is checked');
      assert(!fs.existsSync(path.join(app,'config.json')),'installed app has no config copy');
    } finally { if(previousLocal===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previousLocal; }
    console.log('PASS canonical unsynced/installed privacy, absent fresh-checkout config, secret/config publication rejection and fail-closed missing/unsafe config (no secrets logged)');
    git(f.pub,['remote','set-url','origin','https://github.com/Elsewhere/Other.git']); await assert.rejects(f.manager.publicPreflight(),/does not match/); git(f.pub,['remote','set-url','origin','https://github.com/DontMovePlease/Rovarin.git']);
    const h=fixture(); fs.writeFileSync(path.join(h.pub,'AGENTS.md'),'private fixture'); git(h.pub,['add','-f','AGENTS.md']);git(h.pub,['commit','-m','Fixture forbidden history']);git(h.pub,['rm','AGENTS.md']);git(h.pub,['commit','-m','Fixture removal']); await assert.rejects(h.manager.publicPreflight(),/Public history includes/);
    console.log('PASS tracked-private audit, local secret/path scanning, wrong-remote rejection and forbidden historical files');
    const g=fixture(); fs.appendFileSync(path.join(g.dir,'public/app.css'),'\n/* save fixture */\n');
    const result=await g.manager.operate('Save',{confirm:true,message:'Fixture save'}); assert(result.pushed); assert.strictEqual(git(g.pub,['log','-1','--format=%s']),'Fixture save'); assert(g.calls.some(c=>c.args.includes('HEAD:refs/heads/main')));
    assert.strictEqual(git(g.dir,['log','-1','--format=%s']),'Fixture save');
    const head=git(g.pub,['rev-parse','HEAD']);git(g.pub,['update-ref','refs/remotes/origin/main',head]);
    const nothing=await g.manager.operate('Save',{confirm:true});assert.strictEqual(nothing.message,'Nothing to save — GitHub is already up to date.');
    assert(!g.calls.some(c=>c.command==='gh' && c.args.includes('create')));
    await assert.rejects(g.manager.operate('Save',{}),/Explicit confirmation/);
    await assert.rejects(g.manager.operate('Save',{confirm:true,fingerprint:'outdated'}),/changed since preview/);
    console.log('PASS real fixture source commits, exact mock push target, no empty commit/release and confirmation fingerprint');
    const release=fixture();fs.appendFileSync(path.join(release.dir,'public/app.css'),'\n/* release fixture */\n');
    const published=await release.manager.operate('Publish',{confirm:true,version:'0.1.1',note:'Fixture note only'});
    assert.strictEqual(published.version,'0.1.1'); assert.strictEqual(git(release.pub,['rev-list','-n','1','v0.1.1']),published.sha);
    assert(fs.readFileSync(path.join(release.dir,'packaging/RovarinLauncher.cs'),'utf8').includes('AssemblyFileVersion("0.1.1.0")'));
    assert(fs.readFileSync(path.join(release.dir,'packaging/desktop.manifest'),'utf8').includes('assemblyIdentity version="0.1.1.0"'));
    const buildIndex=release.calls.findIndex(c=>c.args.includes('packaging/build.ps1')), gateIndex=release.calls.findIndex(c=>c.args.includes('scripts/release-verify.js')), tagIndex=release.calls.findIndex(c=>c.args[2]==='tag' && c.args.includes('-a'));
    assert(buildIndex>=0 && gateIndex>buildIndex && tagIndex>gateIndex);
    const create=release.calls.find(c=>c.command==='gh' && c.args[1]==='create'); assert(create.args.includes('--draft') && create.args.includes('--prerelease') && create.args.includes('--verify-tag') && create.args.includes('--generate-notes') && create.args.includes('--fail-on-no-commits'));
    const upload=release.calls.find(c=>c.command==='gh' && c.args[1]==='upload'); assert.deepStrictEqual(upload.args.slice(3,6).map(x=>path.basename(x)),['RovarinSetup.exe','RovarinSetup.sha256','release.json']);
    fs.writeFileSync(path.join(release.dir,'publish/unrelated.txt'),'fixture'); assert.throws(()=>release.manager.verifyAssets('0.1.1'),/unexpected assets/);
    const cancelled=fixture();fs.appendFileSync(path.join(cancelled.dir,'public/app.css'),'\n/* cancellation fixture */\n');
    cancelled.manager.approvePublish=async summary=>{assert(summary.sha256 && summary.installer && summary.tag==='v0.1.1' && summary.branch==='main');return false;};
    await assert.rejects(cancelled.manager.operate('Publish',{confirm:true,version:'0.1.1'}),/cancelled/);
    assert(!cancelled.calls.some(c=>c.args.includes('push') || c.args.includes('commit') || c.command==='gh' && c.args.includes('create')));
    cancelled.manager.approvePublish=async()=>{fs.appendFileSync(path.join(cancelled.dir,'public/app.css'),'\n/* changed during approval */\n');return true;};
    await assert.rejects(cancelled.manager.operate('Publish',{confirm:true,version:'0.1.1'}),/during final confirmation/);
    assert(!cancelled.calls.some(c=>c.args.includes('push') || c.args.includes('commit') || c.command==='gh' && c.args.includes('create')));
    console.log('PASS final artifact summary and cancelled publication makes no source commit/push/tag/release');
    console.log('PASS mocked full publish pipeline, exact source tag, draft-first digest checks and three-asset allowlist (no network writes)');
    for(const fault of ['failedBuild','failedVerify','editDuringVerify','corruptUpload']) {
      const fail=fixture(); fs.appendFileSync(path.join(fail.dir,'public/app.css'),'\n/* changed */\n'); fail.set({[fault]:true});
      await assert.rejects(fail.manager.operate('Publish',{confirm:true,version:'0.1.1'}));
      if(fault==='failedBuild')assert.strictEqual((await fail.manager.plan('Publish',{version:'0.1.1'},true)).version,'0.1.1','an untagged version can be retried after a failed build');
      if(fault==='corruptUpload')assert(!fail.calls.some(c=>c.command==='gh' && c.args.includes('--draft=false')));
      else assert(!fail.calls.some(c=>c.args.includes('push') || (c.command==='gh' && c.args.includes('create'))));
    }
    console.log('PASS build failure, verification failure, build/source race and corrupt uploaded digest abort before public release');
    const resumed=fixture();fs.appendFileSync(path.join(resumed.dir,'public/app.css'),'\n/* verified continuation */\n');resumed.manager.synchronize('0.1.1');await resumed.manager.run(process.execPath,['scripts/release-verify.js'],resumed.dir);
    const pinned=hash(fs.readFileSync(path.join(resumed.dir,'publish/RovarinSetup.exe')));
    await assert.rejects(resumed.manager.operate('Publish',{confirm:true,version:'0.1.1',verifiedSha256:'0'.repeat(64)}),/checksum changed/);
    const sourceFile=path.join(resumed.dir,'packaging/DesktopShell.cs'),savedSource=fs.readFileSync(sourceFile);fs.appendFileSync(sourceFile,'\n// drift\n');assert.throws(()=>resumed.manager.verifyAssets('0.1.1'),/source changed/);fs.writeFileSync(sourceFile,savedSource);
    const beforeCalls=resumed.calls.length;await resumed.manager.operate('Publish',{confirm:true,version:'0.1.1',verifiedSha256:pinned});
    assert(!resumed.calls.slice(beforeCalls).some(c=>(c.command==='powershell.exe'&&c.args.includes('packaging/build.ps1'))||(c.command===process.execPath&&c.args.includes('scripts/release-verify.js'))));
    assert(resumed.calls.slice(beforeCalls).some(c=>c.command==='gh'&&c.args.includes('--draft=false')));
    console.log('PASS exact verified candidate continuation, unchanged full-gate receipt, source/checksum drift rejection, same protected publication path and no rebuild');
    const local=fixture();fs.appendFileSync(path.join(local.dir,'public/app.css'),'\n/* local save only */\n');
    await assert.rejects(local.manager.operate('Checkpoint',{}),/Explicit confirmation/);
    const localResult=await local.manager.operate('Checkpoint',{confirm:true});assert(localResult.sha);assert(!local.calls.some(c=>c.args.includes('push') || c.args.includes('fetch') || c.command==='gh'));
    console.log('PASS reused local save protects private files and makes no GitHub request');
    const r=fixture(), initial=git(r.dir,['rev-parse','HEAD']);
    fs.unlinkSync(path.join(r.dir,'server.js')); const brokenPlan=await r.manager.plan('Restore',{commit:initial},true);assert.strictEqual(brokenPlan.action,'Restore');fs.copyFileSync(path.join(root,'server.js'),path.join(r.dir,'server.js'));
    fs.appendFileSync(path.join(r.dir,'public/app.css'),'\n/* committed second state */\n');git(r.dir,['add','public/app.css']);git(r.dir,['commit','-m','Fixture second state']);
    fs.appendFileSync(path.join(r.dir,'public/app.css'),'\n/* unfinished tracked work */\n');
    // Approved, untracked source is saved in the same protected stash.
    git(r.dir,['rm','--cached','run_hidden.vbs']); fs.appendFileSync(path.join(r.dir,'run_hidden.vbs'),'\r\n\' unfinished untracked source\r\n');
    const unfinished=fs.readFileSync(path.join(r.dir,'public/app.css'));
    const restore=await r.manager.operate('Restore',{confirm:true,commit:initial});
    assert(restore.stash && restore.backup);assert(fs.readFileSync(path.join(r.dir,'public/app.css')).equals(fs.readFileSync(path.join(root,'public/app.css'))));
    assert(git(r.dir,['show',restore.stash+':public/app.css']).includes('unfinished tracked work'));
    assert(fs.existsSync(path.join(r.dir,'AGENTS.md')) && fs.existsSync(path.join(r.dir,'scripts/release-manager.js')));
    assert.strictEqual(git(r.dir,['rev-parse','refs/rovarin-backups/'+restore.backup]),restore.stash);
    assert(!r.calls.some(c=>c.args[2]==='push' || c.args.includes('--hard') || c.args.includes('--force')));
    assert(git(r.dir,['log','-1','--format=%s']).includes('local only'));
    assert(unfinished.length>0);
    console.log('PASS protected local restore, recovery branch/pinned stash, local docs/tool retained, no push/reset/force');
    // Existing release promotion is still authoritative and preserves known-good bytes on failure.
    const gate=path.join(temp,'gate');fs.mkdirSync(path.join(gate,'dist'),{recursive:true});fs.mkdirSync(path.join(gate,'packaging'));
    fs.writeFileSync(path.join(gate,'dist/RovarinSetup.exe'),'fixture');fs.writeFileSync(path.join(gate,'packaging/payload-manifest.json'),'{"files":[]}');fs.writeFileSync(path.join(gate,'package.json'),'{"version":"0.1.1"}');
    fs.writeFileSync(path.join(gate,'dist/build.json'),JSON.stringify({sha256:hash(Buffer.from('fixture')),payloadManifestSha256:hash(Buffer.from('{"files":[]}')),inputs:[]}));
    await assert.rejects(verifyAndPublish(gate,async()=>{throw new Error('fixture gate failure');}));assert(!fs.existsSync(path.join(gate,'publish')));
    let checks=0;await verifyAndPublish(gate,async()=>{checks++;});assert.strictEqual(checks,9);
    const previous=fs.readFileSync(path.join(gate,'publish/RovarinSetup.exe'));await assert.rejects(verifyAndPublish(gate,async()=>{throw new Error('fixture regression failure');}));assert(fs.readFileSync(path.join(gate,'publish/RovarinSetup.exe')).equals(previous));
    for(const c of [...f.calls,...g.calls,...release.calls,...r.calls]) assert(!c.args.includes('--force') && !c.args.includes('--force-with-lease') && !c.args.includes('--clobber') && !c.args.includes('--hard'));
    console.log('PASS existing eight-suite + installer promotion gate unchanged, failed gate preserves prior artifact, no force/clobber');
  } finally { fs.rmSync(temp,{recursive:true,force:true}); }
}
if(require.main===module)test().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports=test;
