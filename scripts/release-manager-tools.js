'use strict';
// Developer-only fixed tool inventory. No installer/runtime inputs are changed.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const updating = new Set();
const key = file => path.normalize(file||'').toLowerCase();
function version(value){
  const match=typeof value==='string' && value.replace(/\.windows\./,'.').match(/^(\d+)\.(\d+)\.(\d+)(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/);
  return match?{numbers:match.slice(1,5).map(v=>Number(v||0)),channel:match[5]?.split('.')[0]||'stable',suffix:match[5]?.split('.')||[]}:null;
}
function compare(a,b){const x=version(a),y=version(b);if(!x||!y||x.channel!==y.channel)return null;for(let i=0;i<4;i++){if(x.numbers[i]!==y.numbers[i])return Math.sign(x.numbers[i]-y.numbers[i]);}for(let i=0;i<Math.max(x.suffix.length,y.suffix.length);i++){const l=x.suffix[i],r=y.suffix[i];if(l===r)continue;if(l===undefined)return -1;if(r===undefined)return 1;if(/^\d+$/.test(l)&&/^\d+$/.test(r))return Math.sign(Number(l)-Number(r));return l<r?-1:1;}return 0;}
function identity(tool,includeVersion=true){return JSON.stringify([key(tool.active),tool.method,tool.package||'',key(tool.prefix),key(tool.entry),key(tool.node),key(tool.npmCli),...(includeVersion?[tool.version,tool.packageVersion]:[])]);}
function stamp(tool){return crypto.createHash('sha256').update(identity(tool)).digest('hex');}
const UPDATABLE = Object.freeze(Object.assign(Object.create(null),{git:'Git.Git',gh:'GitHub.cli'}));
// Fixed names, packages, entry points and official instructions. Never execute
// a package's remote bin metadata, installer response, or a UI-supplied path.
const CODING = Object.freeze([
  {id:'codex',name:'Codex CLI',packages:[['@openai/codex','bin/codex.js']],url:'https://developers.openai.com/codex/cli',use:'AI coding and project work'},
  {id:'opencode',name:'OpenCode',packages:[['@opencode/cli','bin/opencode.exe'],['opencode-ai','bin/opencode']],url:'https://opencode.ai/v2/docs',use:'AI coding and project work'},
  {id:'gemini',name:'Gemini CLI',packages:[['@google/gemini-cli','bundle/gemini.js']],url:'https://geminicli.com/docs/get-started/installation/',use:'AI coding and project work'},
  {id:'agy',name:'Antigravity CLI',url:'https://www.antigravity.google/docs/cli/install/',use:'AI coding and remote work'},
  {id:'antigravity',name:'Antigravity editor command',url:'https://antigravity.google/download',use:'Open the Antigravity editor'},
  {id:'rokit',name:'Rokit',url:'https://github.com/rojo-rbx/rokit',use:'Manage Roblox development tools'},
  {id:'rojo',name:'Rojo',url:'https://rojo.space/docs/',use:'Roblox project development'}
]);
const stable = value => typeof value==='string' && /^\d+\.\d+\.\d+$/.test(value);
function newer(a,b){return compare(a,b)===1;}
function redact(value){return String(value).replace(/(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]+)/g,'[redacted]').replace(/((?:token|password|api[_-]?key|authorization)\s*[:=]\s*)[^\r\n,]+/gi,'$1[redacted]');}
function packageRow(output,id) {
  const rows=output.replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'').split(/\r?\n/).filter(r=>r.split(/\s+/).includes(id));
  if(rows.length!==1) return null;
  const parts=rows[0].trim().split(/\s+/), at=parts.indexOf(id), tail=parts.slice(at+1);
  // --source winget can omit the Source column, and Available is absent
  // for a current package. Accept only one exact ID and validated versions.
  if(tail[tail.length-1]==='winget')tail.pop();
  if(tail.length!==1 && tail.length!==2) return null;
  if(tail.some(v=>! /^[0-9][0-9A-Za-z.+_-]*$/.test(v)))return null;
  return {current:tail[0],available:tail[1]||null};
}
function pinned(root) {
  const build=fs.readFileSync(path.join(root,'packaging/build.ps1'),'utf8');
  const take=(pattern)=>{const match=build.match(pattern);return match?match[1]:'Unable to determine';};
  return [
    {name:'Bundled Node runtime',version:build.match(/^\$nodeVersion\s*=\s*'(\d+\.\d+\.\d+)'/m)?.[1] || take(/nodejs\.org\/dist\/v([^/]+)\//)},
    {name:'PawnIO',version:take(/PawnIO\.Setup\/releases\/download\/([^/]+)\//)},
    {name:'Inno Setup',version:take(/innoVersion='([^']+)'/)},
    {name:'WebView2 SDK',version:take(/webview2-([0-9.]+)\.nupkg/)}
  ];
}
class Tools {
  constructor(root,run,local={}){this.root=root;this.run=run;this.local=local;}
  async probe(command,args){try{return {output:(await this.run(command,args,this.root,20000)).trim()};}catch(error){return {error:redact(error.message)};}}
  async npm(args){const cli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');if(!fs.existsSync(cli))return {error:'Developer npm is unavailable'};return this.probe(process.execPath,[cli,...args]);}
  async coreOwned(id,active){
    if(this.local.coreOwned)return this.local.coreOwned(id,active);
    const base=process.env.ProgramFiles||'C:\\Program Files';
    const expected=id==='gh'?[path.join(base,'GitHub CLI/gh.exe')]:['cmd/git.exe','bin/git.exe'].map(r=>path.join(base,'Git',r));
    if(!expected.some(p=>key(p)===key(active)))return false;
    const name=id==='gh'?'GitHub CLI':'Git';
    const result=await this.probe('powershell.exe',['-NoProfile','-Command',`@(Get-ItemProperty 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*' -ErrorAction SilentlyContinue | Where-Object DisplayName -eq '${name}' | Select-Object DisplayVersion,InstallLocation) | ConvertTo-Json -Compress`]);
    try{const rows=JSON.parse(result.output);const list=Array.isArray(rows)?rows:[rows];return list.length===1 && (id==='gh' || key(list[0].InstallLocation).replace(/[\\/]$/,'')===key(path.join(base,'Git')))?list[0].DisplayVersion:false;}catch{return false;}
  }
  async discover(){
    if(this.local.discover)return this.local.discover();
    const names=[...CODING.map(t=>t.id),'git','gh','node','npm','winget','powershell.exe'].map(n=>"'"+n+"'").join(',');
    const result=await this.probe('powershell.exe',['-NoProfile','-Command',`@(${names}) | ForEach-Object { $name=$_; $commands=@(Get-Command $name -All -ErrorAction SilentlyContinue); foreach($c in $commands){[pscustomobject]@{id=$name;file=$c.Source;kind=$c.CommandType.ToString()}}; & where.exe $name 2>$null | ForEach-Object {if(Test-Path -LiteralPath $_ -PathType Leaf){[pscustomobject]@{id=$name;file=$_;kind='Application'}}} } | ConvertTo-Json -Compress`]);
    try{const data=JSON.parse(result.output);return Array.isArray(data)?data:[data];}catch{return [];}
  }
  binding(resolved,id){
    const all=resolved.filter(t=>t && t.id===id && typeof t.file==='string');
    const copies=[...new Set(all.map(t=>key(t.file).replace(/\.(?:cmd|ps1)$/,'')))];
    return {active:all[0]?.file||'',installations:[...new Set(all.map(t=>t.file))],multiple:copies.length>1};
  }
  async coding(updates,resolved){
    resolved=resolved||await this.discover();const rootResult=await this.npm(['root','-g']), list=await this.npm(['list','-g','--depth=0','--json']);
    let dependencies={};try{dependencies=JSON.parse(list.output).dependencies||{};}catch{}
    const npmRoot=rootResult.output && path.isAbsolute(rootResult.output)?rootResult.output:null;
    const tools=[];
    for(const def of CODING){
      const found=resolved.find(t=>t && t.id===def.id && typeof t.file==='string');if(!found)continue;
      const binding=this.binding(resolved,def.id);
      const tool={id:def.id,name:def.name,group:'coding',installed:true,version:'Unable to determine',status:'Installed',update:'Automatic update unavailable',method:'Unknown',instructions:def.url,use:def.use,canUpdate:false,...binding};
      // Match the active npm shim AND package inventory, not just package existence.
      for(const [pkg,entry] of def.packages||[]){
        if(!npmRoot || !dependencies[pkg]?.version)continue;
        const shim=path.join(path.dirname(npmRoot),def.id);
        if(!['.ps1','.cmd',''].some(ext=>path.normalize(found.file).toLowerCase()===(shim+ext).toLowerCase()))continue;
        const file=path.join(npmRoot,pkg,entry);
        if(!this.local.discover){
          if(!fs.existsSync(file))continue;
          try{
            const metadata=JSON.parse(fs.readFileSync(path.join(npmRoot,pkg,'package.json'),'utf8'));
            const text=fs.readFileSync(found.file,'utf8').replace(/\\/g,'/');
            if(metadata.name!==pkg || metadata.version!==dependencies[pkg].version || !text.includes('node_modules/'+pkg+'/'+entry))continue;
          }catch{continue;}
        }
        const activeNode=this.binding(resolved,'node').active,activeNpm=this.binding(resolved,'npm').active;
        const cli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
        if(!this.local.discover && (key(activeNode)!==key(process.execPath) || !['npm.ps1','npm.cmd','npm'].some(n=>key(activeNpm)===key(path.join(path.dirname(process.execPath),n)))))continue;
        tool.method='npm';tool.package=pkg;tool.prefix=path.dirname(npmRoot);tool.entry=file;tool.packageVersion=dependencies[pkg].version;tool.node=process.execPath;tool.npmCli=cli;
      }
      let result;
      if(tool.entry){result=await this.probe(tool.entry.endsWith('.exe')?tool.entry:process.execPath,tool.entry.endsWith('.exe')?['--version']:[tool.entry,'--version']);}
      else if(path.isAbsolute(found.file) && /\.exe$/i.test(found.file)){result=await this.probe(found.file,['--version']);}
      else result={error:'The command is present but its launcher cannot be verified safely.'};
      // Strict output prevents tool banners/credentials from becoming normal UI.
      const match=result.output?.match(/^(?:codex-cli |opencode v|rokit |Rojo |v)?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\r?\n|$)/);
      if(match)tool.version=match[1];else{tool.detail=result.error||'The version response was not recognized.';tool.update='Unable to check';}
      if(def.id==='rojo' && /[\\/]\.rokit[\\/]bin[\\/]/i.test(found.file)){tool.method='Rokit';tool.update='Automatic update unavailable';tool.detail="Rojo is managed by Rokit, but this project does not currently specify a usable Rojo version. Release Manager won't guess.";}
      if(def.id==='rokit' && key(found.file)===key(path.join(process.env.USERPROFILE||'', '.rokit/bin/rokit.exe'))){tool.method='Rokit self-updater';tool.detail='The official updater can ask for input after replacing its executable. This hidden update workflow cannot guarantee completion safely; use Rokit self-update in a terminal.';if(updates){const latest=await this.probe('gh',['api','repos/rojo-rbx/rokit/releases/latest','--jq','.tag_name']);const latestVersion=latest.output?.replace(/^v/,'');if(stable(latestVersion)){tool.checkedVersion=latestVersion;tool.available=newer(latestVersion,tool.version)?latestVersion:null;}else tool.checkFailed=true;}}
      if(tool.method==='npm'){
        tool.update=updates?'Unable to check':'Not checked';
        if(version(tool.version)?.channel && version(tool.version).channel!=='stable'){tool.update='Automatic update unavailable';tool.detail='This copy uses a prerelease version. Its update channel is not verified here; Release Manager will not move it to stable, preview or nightly.';}
        if(updates && stable(tool.version) && tool.version===tool.packageVersion){
          const latest=await this.npm(['view',tool.package,'dist-tags.latest','--json','--registry=https://registry.npmjs.org/','--fetch-retries=0','--fetch-timeout=15000']);
          let version;try{version=JSON.parse(latest.output);}catch{}
          if(stable(version)){tool.available=newer(version,tool.version)?version:null;tool.update=tool.available?'Update available':'Current';tool.canUpdate=!!tool.available;}
          else tool.detail='The official update service could not confirm a stable version.';
        }
      }
      if(tool.method==='Unknown'){tool.detail='The active copy cannot be mapped to a verified updater. Use the original installer; Release Manager will not guess or switch installation methods.';}
      if(binding.multiple){tool.canUpdate=false;tool.update='Multiple installations found';tool.detail='More than one installation can supply this command. Release Manager will not choose or delete a copy. See Advanced Details.';}
      tool.snapshot=stamp(tool);
      tools.push(tool);
    }
    return tools;
  }
  async status(updates=false) {
    const resolved=await this.discover();
    const definitions=[['git','Git',['--version']],['gh','GitHub CLI',['--version']],['node','Developer Node.js',['--version']],['npm','npm (provided with developer Node)',[]],['winget','WinGet',['--version']],['powershell.exe','Windows PowerShell',['-NoProfile','-Command','$PSVersionTable.PSVersion.ToString()']]];
    const tools=[];
    for(const [id,name,args] of definitions){
      // npm.cmd cannot be execFile'd on Windows without a shell. The fixed npm CLI
      // is run with Node, never cmd.exe or client-provided shell text.
      let result;
      if(id==='npm'){
        const npm=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');
        result=fs.existsSync(npm)?await this.probe(process.execPath,[npm,'--version']):{error:'npm CLI is not beside the developer Node runtime.'};
      } else result=await this.probe(this.binding(resolved,id).active||id,args);
      const version=result.output?.split(/\r?\n/)[0].match(/^(?:git version |gh version |v)?(\d+\.\d+\.\d+(?:\.windows\.\d+)?(?:\.\d+)?)(?:\s|$)/)?.[1];
      tools.push({id,name,installed:!!version,version:version||'Unable to determine',status:version?'Installed':'Not installed / unable to run',update:'Not checked',detail:result.error||'',...this.binding(resolved,id)});
    }
    const node=tools.find(t=>t.id==='node');node.status=node.installed?(node.version.split('.')[0]==='24'?'Compatible with tested Node 24.x baseline':'Untested version; project build uses Node 24.x') : node.status;
    node.detail+=' Automatic Node upgrades are disabled; do not change major versions without project testing.';
    tools.find(t=>t.id==='powershell.exe').detail+=' Windows PowerShell 5.1 and Windows .NET Framework provide the native GUI/build tooling; no automatic PowerShell update.';
    let account='Sign-in required';
    if(tools.find(t=>t.id==='gh').installed){
      const ghCommand=this.binding(resolved,'gh').active||'gh';
      const auth=await this.probe(ghCommand,['auth','status','--hostname','github.com']);
      if(!auth.error){const user=await this.probe(ghCommand,['api','user','--jq','.login']);if(!user.error && /^[A-Za-z0-9-]{1,39}$/.test(user.output))account=user.output;}
    }
    if(updates){
      for(const tool of tools.filter(t=>UPDATABLE[t.id])){
        if(!tool.installed){tool.update='Not installed';continue;}
        if(!tools.find(t=>t.id==='winget').installed){tool.update='Unable to determine';tool.detail='WinGet is unavailable. No update was attempted.';continue;}
        const check=await this.probe('winget',['list','--id',UPDATABLE[tool.id],'--exact','--source','winget','--disable-interactivity']);
        const row=!check.error && packageRow(check.output,UPDATABLE[tool.id]);
        if(!row){tool.update='Unable to determine';tool.detail=check.error||'WinGet could not identify one exact package/version. No changes were made.';continue;}
        const matches=tool.id==='git'?row.current===tool.version.replace(/\.windows\./,'.') || row.current===tool.version.replace(/\.windows\.\d+$/,''):row.current===tool.version;
        const owned=await this.coreOwned(tool.id,tool.active);
        if(!matches || !owned || (typeof owned==='string' && owned!==row.current)){tool.update='Automatic update unavailable';tool.detail='The active executable could not be matched to this installed WinGet package.';continue;}
        if(row.available && !/^\d+(?:\.\d+){1,3}$/.test(row.available)){tool.update='Unable to check';tool.detail='A stable update version could not be verified.';continue;}
        tool.packageVersion=row.current;tool.available=row.available;tool.update=row.available?'Update available':'Current';
      }
    }
    for(const tool of tools){tool.group='core';tool.method=tool.packageVersion?'WinGet':'System / existing installation';tool.package=UPDATABLE[tool.id]||'';tool.canUpdate=tool.update==='Update available';if(updates && !UPDATABLE[tool.id]){tool.update='Automatic update unavailable';tool.detail+=' This system/runtime tool has no verified updater here; use its original installer or Windows Update.';}if(tool.multiple){tool.canUpdate=false;tool.update='Multiple installations found';tool.detail='Multiple installations can supply this command. See Advanced Details; no copy will be updated or removed.';}tool.snapshot=stamp(tool);}
    tools.push(...await this.coding(updates,resolved));
    return {tools,sections:sections(tools),account,repository:'DontMovePlease/Rovarin',pinned:pinned(this.root),message:'Pinned build components are controlled by Rovarin, not updated by Release Manager.'};
  }
  async health(tool){
    if(tool.method==='npm')return this.probe(tool.entry.endsWith('.exe')?tool.entry:tool.node,tool.entry.endsWith('.exe')?['--help']:[tool.entry,'--help']);
    return this.probe(tool.active,['--help']);
  }
  async repositoryState(tool){
    if(this.local.repositoryState)return this.local.repositoryState();
    const listed=await this.run(tool.active,['ls-files','-z'],this.root,20000);
    const digest=crypto.createHash('sha256');
    for(const file of listed.split('\0').filter(Boolean).sort()){
      const target=path.resolve(this.root,file),relative=path.relative(this.root,target);
      if(relative.startsWith('..') || path.isAbsolute(relative))throw new Error('Repository file list could not be verified.');
      digest.update(file);if(!fs.existsSync(target)){digest.update('missing');continue;}
      if(fs.lstatSync(target).isSymbolicLink())throw new Error('Repository contains redirecting files.');
      digest.update(fs.readFileSync(target));
    }
    return digest.digest('hex');
  }
  history(tool,current,result){
    if(this.local.history)return this.local.history(tool,current,result);
    const directory=path.join(this.root,'packaging/cache'),file=path.join(directory,'release-tool-history.json');
    fs.mkdirSync(directory,{recursive:true});
    for(const item of [path.join(this.root,'packaging'),directory,file])if(fs.existsSync(item)&&fs.lstatSync(item).isSymbolicLink())throw new Error('Local history path redirects.');
    let previous=[];try{const data=JSON.parse(fs.readFileSync(file,'utf8'));if(Array.isArray(data))previous=data.filter(row=>row && typeof row.date==='string' && /^[0-9TZ:.-]+$/.test(row.date) && CODING.map(t=>t.name).concat(['Git','GitHub CLI']).includes(row.tool) && version(row.previous) && (version(row.current)||row.current==='Unavailable') && ['Success','Failed'].includes(row.result));}catch{}
    previous.push({date:new Date().toISOString(),tool:tool.name,previous:tool.version,current:version(current?.version)?current.version:'Unavailable',result});
    fs.writeFileSync(file,JSON.stringify(previous.slice(-50),null,2));
  }
  async update(options){
    const lock=key(this.root);if(updating.has(lock))throw new Error('Another tool update is running. Wait for it to finish.');
    updating.add(lock);try{return await this.performUpdate(options);}finally{updating.delete(lock);}
  }
  async updateAll(options,emit=()=>{}){
    if(options.confirm!==true)throw new Error('Updating tools requires explicit confirmation. No changes were made.');
    const candidates=options.candidates;
    if(!Array.isArray(candidates) || !candidates.length || candidates.length>CODING.length+2 || new Set(candidates.map(t=>t.tool)).size!==candidates.length)throw new Error('Choose a reviewed list of verified updates.');
    const allowed=new Set([...Object.keys(UPDATABLE),...CODING.filter(t=>t.packages).map(t=>t.id)]);
    if(candidates.some(t=>!allowed.has(t.tool) || !version(t.available) || !version(t.current) || !/^[a-f0-9]{64}$/.test(t.snapshot||'')))throw new Error('The update list contains unverified details. No changes were made.');
    const lock=key(this.root);if(updating.has(lock))throw new Error('Another tool update is running. Wait for it to finish.');
    updating.add(lock);
    const results=[];
    try{
      for(const [index,candidate] of candidates.entries()){
        const name=CODING.find(t=>t.id===candidate.tool)?.name || (candidate.tool==='git'?'Git':'GitHub CLI');
        emit({type:'status',message:`Updating ${name}... ${index+1} of ${candidates.length}`});
        try{
          await this.performUpdate({...candidate,confirm:true});
          results.push({name,previous:candidate.current,current:candidate.available,result:'Success',message:'Requested version and installation verified.'});
        }catch(error){
          const skipped=error.code==='UPDATE_NOT_STARTED';
          results.push({name,previous:candidate.current,target:candidate.available,result:skipped?'Skipped':'Failed',message:redact(error.message).split(' Technical Details:')[0]});
        }
      }
      let after;try{after=await this.status(true);}catch{after={tools:[],account:'Unable to check',message:'Check Again to refresh tool status.'};}
      const counts=kind=>results.filter(r=>r.result===kind).length;
      return {...after,results,message:`Finished: ${counts('Success')} updated, ${counts('Failed')} failed, ${counts('Skipped')} skipped. Failed updates are not retried automatically.`};
    }finally{updating.delete(lock);}
  }
  async performUpdate(options){
    if(options.confirm!==true)throw new Error('Updating a developer tool requires explicit confirmation. No changes were made.');
    const id=UPDATABLE[options.tool];if(!id && !CODING.some(t=>t.id===options.tool && t.packages))throw new Error('Only Git, GitHub CLI and verified coding packages can be updated. Project-managed components and Node are excluded.');
    const notStarted=message=>Object.assign(new Error(message),{code:'UPDATE_NOT_STARTED'});
    let fresh;try{fresh=await this.status(true);}catch{throw notStarted('The installation could not be rechecked. No update was started.');}
    const tool=fresh.tools.find(t=>t.id===options.tool);
    if(!tool || !tool.canUpdate || tool.update!=='Update available' || tool.available!==options.available || tool.packageVersion!==options.current || tool.snapshot!==options.snapshot)throw notStarted('Update details changed or could not be verified. Check again before confirming.');
    const beforeRepo=tool.id==='git'?await this.repositoryState(tool):null;
    if(tool.id==='gh' && fresh.account==='Sign-in required')throw notStarted('GitHub sign-in must be valid before updating GitHub CLI.');
    // Require a working harmless launch before touching a currently healthy tool.
    const beforeHealth=await this.health(tool);if(beforeHealth.error || !beforeHealth.output)throw notStarted(tool.name+' health check failed. No update was started.');
    const ready=this.binding(await this.discover(),tool.id);
    if(ready.multiple || key(ready.active)!==key(tool.active))throw notStarted('Update details changed or could not be verified. Check again before confirming.');
    let commandError;
    try{
      if(id)await this.run('winget',['upgrade','--id',id,'--exact','--source','winget','--version',tool.available,'--disable-interactivity'],this.root,15*60*1000);
      else{const cli=path.join(path.dirname(process.execPath),'node_modules/npm/bin/npm-cli.js');await this.run(process.execPath,[cli,'install','-g',tool.package+'@'+tool.available,'--prefix',tool.prefix,'--registry=https://registry.npmjs.org/','--no-audit','--no-fund'],this.root,15*60*1000);}
    }catch(error){commandError=redact(error.message);}
    let after;
    try{after=await this.status(true);}catch(error){this.history(tool,null,'Failed');throw new Error(tool.name+' update could not be verified. The installation could not be rechecked. Check Again before retrying. Technical Details: '+redact(error.message));}
    const current=after.tools.find(t=>t.id===tool.id);
    const versionMatches=current && (current.version===tool.available || (tool.id==='git' && [current.version.replace(/\.windows\./,'.'),current.version.replace(/\.windows\.\d+$/,'')].includes(tool.available)));
    const sameCopy=current && !current.multiple && identity(current,false)===identity(tool,false);
    const health=current?.installed && sameCopy?await this.health(current):{error:'The intended executable is missing or no longer active.'};
    let unchangedRepo=tool.id!=='git';
    if(tool.id==='git' && sameCopy){try{unchangedRepo=(await this.repositoryState(current))===beforeRepo;}catch{unchangedRepo=false;}}
    const sameAccount=tool.id!=='gh' || (after.account===fresh.account && after.account!=='Sign-in required');
    if(commandError || !current?.installed || !versionMatches || current.version===tool.version || !sameCopy || health.error || !health.output || !unchangedRepo || !sameAccount){
      this.history(tool,current,'Failed');
      const message=commandError?'The updater failed.':!sameCopy?'Windows is no longer using the verified installation.':!versionMatches?'The requested version was not confirmed.':health.error?'The tool does not respond normally.':!unchangedRepo?'Repository files changed during the operation; review them.':'GitHub authentication could not be verified.';
      const remains=sameCopy && !health.error && health.output && version(current?.version)?' The existing version '+current.version+' still responds.':' The existing installation could not be confirmed healthy.';
      throw new Error(tool.name+' update could not be verified. '+message+remains+' No other tool update was requested. Check Again before retrying.'+(commandError?' Technical Details: '+commandError:''));
    }
    this.history(tool,current,'Success');
    return {...after,message:tool.name+' updated successfully. Previous: '+tool.version+'. Current: '+current.version+'. Reopen any already-running terminals or coding sessions.'};
  }
}
function sections(tools){
  const groups={'Updates Available':[],'Up to Date':[],'Needs Attention':[],'System Tools':[]};
  for(const tool of tools){
    const system=['node','npm','winget','powershell.exe'].includes(tool.id);
    const current=tool.update==='Current' || (tool.checkedVersion===tool.version && !tool.checkFailed);
    const group=system?'System Tools':tool.canUpdate?'Updates Available':current && !tool.multiple?'Up to Date':'Needs Attention';
    let explanation;
    if(system)explanation=tool.installed?'Available for development; not updated here.':'Not found on this PC.';
    else if(tool.canUpdate)explanation=tool.version+' → '+tool.available;
    else if(tool.multiple)explanation='More than one copy found. Review Details before choosing an installation.';
    else if(tool.id==='rojo' && tool.method==='Rokit')explanation='Rokit manages this launcher, but this project has no Rojo version configured.';
    else if(!tool.installed)explanation='Cannot find a working copy on this PC.';
    else if(current)explanation='Up to date — '+tool.version;
    else if(tool.update==='Not checked')explanation='Check for updates to see whether a newer version is available.';
    else if(tool.checkFailed || ['Unable to check','Unable to determine'].includes(tool.update))explanation='Could not check for updates. Check Again when your connection is available.';
    else if(tool.id==='codex')explanation='This native alpha copy has no verified automatic updater. See Details for instructions.';
    else if(tool.id==='rokit')explanation='Its updater needs an interactive terminal. Use the official instructions.';
    else if(tool.id==='gh')explanation='The active copy could not be matched to its installer. See Details.';
    else explanation='Automatic update unavailable: the installation or update channel could not be verified.';
    groups[group].push({id:tool.id,name:tool.name,version:tool.version,explanation});
  }
  return Object.entries(groups).map(([title,items])=>({title,items}));
}
module.exports={Tools,packageRow,pinned,UPDATABLE,CODING,newer,redact,compare,identity,stamp,sections};
