'use strict';
// Developer-only tooling. The clean public checkout is deliberately separate
// from the local checkpoint history, which contains personal documents/identity.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const TARGET = 'https://github.com/DontMovePlease/Rovarin';
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const split = text => text.split('\0').filter(Boolean);
const lines = text => text.trim().split(/\r?\n/).filter(Boolean);
const PRIVATE = /(^|\/)(?:AGENTS\.md|PROJECT_STATUS\.md|THE-PLAN\.md|SECURITY\.md|CONTRIBUTING\.md|config\.json(?:\..*)?|temperature-settings\.json(?:\..*)?|desktop-trust\.bin|installation\.json|onboarding-complete\.json|server[^/]*\.(?:json|pid|log|lock)|uninstall-trust\.json)$|(?:^|\/)(?:dist|publish(?:-[^/]*)?|node_modules|pet-output|data|desktop-profile|\.git|\.codex|\.agents)(?:\/|$)|^packaging\/(?:cache|payload|test-install)(?:\/|$)|^packaging\/payload-manifest\.json$|\.(?:log|pid|lock|lnk|tmp|state)$/i;
function permitted(file) {
  if (!file || file.includes('\\') || file.includes(':') || file.split('/').some(p => !p || p === '.' || p === '..') || PRIVATE.test(file)) return false;
  if (/\.md$/i.test(file)) return file === 'README.md' || file === 'vendor/LibreHardwareMonitor/0.9.6/README.md';
  return /^[^/]+\.(?:js|bat|vbs)$/.test(file) || ['.gitignore','LICENSE','package.json'].includes(file) ||
    /^scripts\/[a-z0-9_-]+\.(?:js|ps1|cs|json)$/.test(file) || /^public\/[a-z0-9-]+\.(?:html|css|js)$/.test(file) ||
    /^packaging\/[A-Za-z0-9.-]+\.(?:cs|ps1|iss|vbs|manifest)$/.test(file) || /^\.github\/ISSUE_TEMPLATE\/[a-z0-9_-]+\.yml$/.test(file) ||
    /^docs\/images\/[a-z0-9-]+\.png$/.test(file) || /^vendor\/(?:LibreHardwareMonitor\/0\.9\.6|QRCode\/1\.8\.0)\/[A-Za-z0-9/_.-]+$/.test(file);
}
function semver(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(value) || value.length > 80) throw new Error('Use a Semantic Version such as 0.1.1 or 0.2.0. Do not include v.');
  const [major, minor, patch] = value.split(/[.+-]/).slice(0,3).map(Number);
  if ([major,minor,patch].some(n => n > 65535)) throw new Error('Windows version components must be at most 65535.');
  return { major,minor,patch, patchVersion: `${major}.${minor}.${patch + 1}`, minorVersion: `${major}.${minor + 1}.0` };
}
function plain(root, relative, missing = false) {
  let cursor = root;
  if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Repository directory redirects; refusing operation.');
  for (const piece of relative.split('/')) {
    cursor = path.join(cursor,piece);
    if (!fs.existsSync(cursor)) { if (missing) return cursor; throw new Error('Required file is missing: ' + relative); }
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Redirecting path rejected: ' + relative);
  }
  return cursor;
}
function execute(command,args,cwd,timeout = 30000,input) {
  // Explorer may retain PATH from before GitHub CLI was installed.
  if (command === 'gh' && process.platform === 'win32') {
    const installed = path.join(process.env.ProgramFiles || 'C:\\Program Files','GitHub CLI','gh.exe');
    if (fs.existsSync(installed)) command = installed;
  }
  if (command === 'winget' && process.platform === 'win32' && process.env.LOCALAPPDATA) {
    const installed = path.join(process.env.LOCALAPPDATA,'Microsoft/WindowsApps/winget.exe');
    if (fs.existsSync(installed)) command = installed;
  }
  return new Promise((resolve,reject) => {
    execFile(command,args,{cwd,windowsHide:true,encoding:'utf8',timeout,maxBuffer:16*1024*1024,env:{...process.env,GIT_TERMINAL_PROMPT:'0',GCM_INTERACTIVE:'never',GH_PROMPT_DISABLED:'1',GIT_EDITOR:'true'}},(error,stdout,stderr) => {
      if (error) {
        // Never forward raw command output: Git/gh errors can echo credentials.
        const tail = (stderr || stdout || '').split('\n').slice(-10).join('\n').trim();
        const details = (command === 'git' || command === 'gh') ? '' : (tail ? `\n${tail}` : '');
        const e = new Error(`${path.basename(command)} failed${error.killed ? ' or timed out' : ''} (${String(error.code || 'unknown').replace(/[^A-Za-z0-9_-]/g,'')}). Check authentication, permissions and repository state. No further release step ran.${details}`);
        e.code = error.code; reject(e);
      } else resolve(stdout);
    }).stdin?.end(input);
  });
}
class Manager {
  constructor(root,options = {}) {
    this.root = path.resolve(root);
    this.publicRoot = path.join(this.root,'packaging/cache/github-publication');
    this.run = options.run || execute;
    this.emit = options.emit || (() => {});
    this.approvePublish = options.approvePublish;
  }
  git(args,where = this.root,input) { return this.run('git',['-c','core.quotepath=false',...args],where,30000,input); }
  note(message) { this.emit({type:'status',message}); }
  policy() {
    const files = JSON.parse(fs.readFileSync(plain(this.root,'scripts/release-public-files.json'),'utf8'));
    if (!Array.isArray(files) || new Set(files).size !== files.length || files.some(f => typeof f !== 'string' || !permitted(f))) throw new Error('Public file manifest contains a forbidden or invalid path.');
    for (const required of ['README.md','LICENSE','package.json','server.js','scripts/release-public-files.json']) if (!files.includes(required)) throw new Error('Public file manifest is incomplete.');
    return files.sort();
  }
  version() {
    const version = JSON.parse(fs.readFileSync(plain(this.root,'package.json'),'utf8')).version;
    const choices = semver(version);
    const iss = fs.readFileSync(plain(this.root,'packaging/Rovarin.iss'),'utf8');
    const installerVersion = iss.match(/^#define AppVersion "([^"]+)"\r?$/m)?.[1];
    if (installerVersion !== version) throw new Error('package.json and installer AppVersion disagree. Fix the version before publishing.');
    const numeric = `${choices.major}.${choices.minor}.${choices.patch}.0`;
    const launcher=fs.readFileSync(plain(this.root,'packaging/RovarinLauncher.cs'),'utf8');
    const manifest=fs.readFileSync(plain(this.root,'packaging/desktop.manifest'),'utf8');
    if (!launcher.includes(`AssemblyVersion("${numeric}")`) || !launcher.includes(`AssemblyFileVersion("${numeric}")`) || !manifest.includes(`assemblyIdentity version="${numeric}"`)) throw new Error('Native product version disagrees with package.json. Synchronize the desktop version before publishing.');
    return {version,...choices};
  }
  synchronize(version) {
    semver(version); this.version();
    const files=['package.json','packaging/Rovarin.iss','packaging/RovarinLauncher.cs','packaging/desktop.manifest'].map(file=>plain(this.root,file));
    const originals=files.map(file=>fs.readFileSync(file,'utf8'));
    const parsed=semver(version), numeric=`${parsed.major}.${parsed.minor}.${parsed.patch}.0`;
    const updated=[originals[0].replace(/("version"\s*:\s*")[^"]+("\s*,)/,`$1${version}$2`),originals[1].replace(/^#define AppVersion "[^"]+"/m,`#define AppVersion "${version}"`),originals[2].replace(/(Assembly(?:File)?Version\(")[^"]+("\))/g,`$1${numeric}$2`),originals[3].replace(/(assemblyIdentity version=")[^"]+(" name="Rovarin\.Desktop")/,`$1${numeric}$2`)];
    try { files.forEach((file,index)=>fs.writeFileSync(file,updated[index])); this.version(); }
    catch (e) { files.forEach((file,index)=>fs.writeFileSync(file,originals[index])); throw e; }
  }
  secrets() {
    const values = [];
    // These values remain memory-only and are never returned or logged.
    try {
      const pins = require('../pin-manager');
      const file = pins.configurationFile(this.root);
      const expected = fs.existsSync(path.join(this.root,'installation.json')) || fs.existsSync(path.join(this.root,'.rovarin-development-state.json'));
      // A fresh source checkout has no secret yet. Migrated/installed state must
      // pass the same nonredirecting, single-link validator as runtime.
      if (expected || fs.existsSync(file)) {
        plain(path.dirname(file),path.basename(file));
        values.push(pins.readConfig(file).pin);
      }
    } catch { throw new Error('Cannot safely inspect canonical configuration for the privacy preflight.'); }
    for (const entries of Object.values(os.networkInterfaces())) for (const nic of entries || []) {
      const parts = nic.address.split('.').map(Number);
      if (parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) values.push(nic.address);
    }
    return values;
  }
  scan(file,bytes,values) {
    if (!/\.(?:js|json|ps1|cs|iss|vbs|bat|html|css|yml|md|manifest)$/.test(file) && !['.gitignore','LICENSE'].includes(file)) return;
    const text = bytes.toString('utf8');
    if (values.some(v => new RegExp('(^|[^0-9])' + v.replace(/\./g,'\\.') + '([^0-9]|$)').test(text)) || /[A-Za-z]:\\+Users\\+(?!Public\b|Default\b)[^\\\s"']+/i.test(text) || /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/.test(text)) throw new Error('Possible local credential/address/personal path in ' + file + '. Nothing will be pushed.');
  }
  async source(restoring = false) {
    const files = this.policy(), values = this.secrets(), contents = new Map();
    const candidates = split(await this.git(['ls-files','-z','--cached','--others','--exclude-standard']));
    const tracked = split(await this.git(['ls-files','-z']));
    const forbiddenTracked = tracked.filter(f => !permitted(f));
    if (forbiddenTracked.length) throw new Error('Private/unapproved files are still tracked locally: ' + forbiddenTracked.join(', ') + '. Remove tracking while retaining local copies first.');
    const unknown = candidates.filter(f => !files.includes(f) && permitted(f));
    if (unknown.length) throw new Error('New source needs explicit review in scripts/release-public-files.json: ' + unknown.join(', '));
    const staged = split(await this.git(['diff','--cached','--name-only','--diff-filter=ACMRTUXB','-z']));
    if (staged.some(f => !files.includes(f))) throw new Error('Unapproved files are staged. Unstage/review them before saving.');
    for (const file of files) {
      const full = plain(this.root,file,true);
      if (!fs.existsSync(full)) continue; // Intentional deletion is represented in the public diff.
      if (!fs.statSync(full).isFile()) throw new Error('Expected a regular source file: ' + file);
      const bytes = fs.readFileSync(full); this.scan(file,bytes,values); contents.set(file,bytes);
    }
    if (!restoring) for (const required of ['README.md','LICENSE','package.json','server.js','scripts/release-public-files.json']) if (!contents.has(required)) throw new Error('Required public source is missing: ' + required);
    const ignored = split(await this.git(['ls-files','--others','--ignored','--exclude-standard','-z']));
    for (const file of contents.keys()) if (ignored.includes(file)) throw new Error('Manifest would publish an ignored file: ' + file);
    const fingerprint = hash([...contents].map(([f,b])=>f+'\0'+hash(b)).join('\n'));
    return { files,contents,fingerprint };
  }
  async publicPreflight() {
    plain(this.root,'packaging/cache/github-publication/.git/config');
    if ((await this.git(['rev-parse','--show-toplevel'],this.publicRoot)).trim().replace(/\\/g,'/').toLowerCase() !== this.publicRoot.replace(/\\/g,'/').toLowerCase()) throw new Error('Wrong public checkout.');
    const branch = (await this.git(['branch','--show-current'],this.publicRoot)).trim();
    const localBranch = (await this.git(['branch','--show-current'])).trim();
    if (branch !== 'main' || localBranch !== 'main') throw new Error('Both local and public workspaces must be on main. Nothing will be pushed.');
    const remote = (await this.git(['remote','get-url','origin'],this.publicRoot)).trim();
    const pushRemote = (await this.git(['remote','get-url','--push','origin'],this.publicRoot)).trim();
    const valid = url => /^(?:https:\/\/github\.com\/DontMovePlease\/Rovarin(?:\.git)?|git@github\.com:DontMovePlease\/Rovarin(?:\.git)?)$/.test(url);
    if (!valid(remote) || !valid(pushRemote)) throw new Error('Public origin does not match DontMovePlease/Rovarin. Fix it outside this tool.');
    if ((await this.git(['status','--porcelain'],this.publicRoot)).trim()) throw new Error('The public checkout has unfinished changes. Review them before continuing; nothing was overwritten.');
    const name = (await this.git(['config','user.name'],this.publicRoot)).trim();
    const email = (await this.git(['config','user.email'],this.publicRoot)).trim();
    if (name !== 'DontMovePlease' || !/^(?:\d+\+)?DontMovePlease@users\.noreply\.github\.com$/.test(email)) throw new Error('Public Git identity must use DontMovePlease and its GitHub noreply address.');
    if ((await this.git(['config','--get','core.autocrlf'],this.publicRoot)).trim() !== 'false') throw new Error('Public checkout must have core.autocrlf=false to preserve exact build-source bytes. Configure it outside the tool.');
    await this.reviewIdentities();
    this.scan('README.md',Buffer.from(await this.git(['log','--all','--format=%B'],this.publicRoot)),this.secrets());
    const files = this.policy(), commits = lines(await this.git(['rev-list','--all'],this.publicRoot));
    if (commits.length > 2000) throw new Error('Public history needs a separate privacy review (over 2000 commits).');
    const values = this.secrets();
    for (const commit of commits) {
      const historical = split(await this.git(['ls-tree','-r','-z',commit],this.publicRoot)).map(entry => {
        const [header,file] = entry.split('\t'); const [mode,type,oid] = header.split(' '); return {mode,type,oid,file};
      });
      if (historical.some(e => !permitted(e.file) || !files.includes(e.file) || e.type !== 'blob' || !['100644','100755'].includes(e.mode))) throw new Error('Public history includes private/unreviewed/redirecting paths. History rewriting is never automatic.');
      // One bounded batch read per commit avoids launching Git per source file.
      const textFiles = historical.filter(e=>/\.(?:js|json|ps1|cs|iss|vbs|bat|html|css|yml|md|manifest)$/.test(e.file));
      if (textFiles.length) {
        const output = Buffer.from(await this.git(['cat-file','--batch'],this.publicRoot,textFiles.map(e=>e.oid).join('\n')+'\n'));
        let offset = 0;
        for (const entry of textFiles) {
          const end = output.indexOf(10,offset), header = output.subarray(offset,end).toString().split(' '), size = Number(header[2]);
          if (end < 0 || header[0] !== entry.oid || header[1] !== 'blob' || !Number.isSafeInteger(size) || size < 0 || end+1+size > output.length) throw new Error('Historical source scan failed closed.');
          this.scan(entry.file,output.subarray(end+1,end+1+size),values); offset = end+size+2;
        }
      }
    }
    return { branch,remote:TARGET,localBranch };
  }
  async reviewIdentities() {
    const owner = email => /^(?:\d+\+)?DontMovePlease@users\.noreply\.github\.com$/.test(email);
    const entries = lines(await this.git(['log','--all','--format=%H%x09%an%x09%ae%x09%cn%x09%ce'],this.publicRoot));
    for (const entry of entries) {
      const [sha,authorName,authorEmail,committerName,committerEmail] = entry.split('\t');
      if (!owner(authorEmail)) throw new Error('Public history contains an unapproved personal Git identity. Review it separately; history is never rewritten automatically.');
      if (owner(committerEmail)) continue;
      // GitHub web edits use its own public committer address. Never accept an
      // arbitrary email/name spoof: the exact commit must be GitHub-verified.
      if (!/^[a-f0-9]{40}$/.test(sha) || authorName !== 'DontMovePlease' || committerName !== 'GitHub' || committerEmail !== 'noreply@github.com') throw new Error('Public history contains an unapproved personal Git identity. Review it separately; history is never rewritten automatically.');
      const commit = JSON.parse(await this.run('gh',['api','repos/DontMovePlease/Rovarin/commits/'+sha],this.root));
      if (commit.sha !== sha || commit.author?.login !== 'DontMovePlease' || commit.committer?.login !== 'web-flow' || commit.commit?.verification?.verified !== true || commit.commit?.verification?.reason !== 'valid') throw new Error('GitHub web commit identity/signature could not be verified. Nothing will be pushed.');
    }
  }
  async github() {
    try { await this.run('gh',['--version'],this.root); } catch { throw new Error('GitHub CLI is missing. Install it from https://cli.github.com, then run gh auth login once.'); }
    try { await this.run('gh',['auth','status','--hostname','github.com'],this.root); } catch { throw new Error('GitHub CLI is signed out. Run gh auth login once, then reopen Release Manager.'); }
    const repository = JSON.parse(await this.run('gh',['repo','view','DontMovePlease/Rovarin','--json','nameWithOwner,viewerPermission'],this.root));
    if (repository.nameWithOwner !== 'DontMovePlease/Rovarin' || !['ADMIN','MAINTAIN','WRITE'].includes(repository.viewerPermission)) throw new Error('The signed-in GitHub CLI account cannot publish to DontMovePlease/Rovarin. Fix the account/access outside this tool.');
  }
  async differences(source) {
    const tracked = split(await this.git(['ls-files','-z'],this.publicRoot));
    const changes = [];
    for (const file of new Set([...tracked,...source.contents.keys()])) {
      const full = plain(this.publicRoot,file,true), before = fs.existsSync(full) ? fs.readFileSync(full) : null, after = source.contents.get(file);
      if (!after && before) changes.push({file,action:'Remove'});
      else if (after && (!before || !before.equals(after))) changes.push({file,action:before?'Update':'Add'});
    }
    return changes;
  }
  async unique(version,remote = true) {
    semver(version); const tag = 'v'+version;
    if (lines(await this.git(['tag','--list',tag])).length || lines(await this.git(['tag','--list',tag],this.publicRoot)).length) throw new Error(`${tag} already exists. Choose a new version.`);
    if (remote) {
      if ((await this.git(['ls-remote','--tags','origin',`refs/tags/${tag}`,`refs/tags/${tag}^{}`],this.publicRoot)).trim()) throw new Error(`${tag} already exists on GitHub.`);
      const releases = JSON.parse(await this.run('gh',['release','list','--repo','DontMovePlease/Rovarin','--limit','1000','--json','tagName'],this.root));
      if (releases.some(r=>r.tagName===tag)) throw new Error(`${tag} already has a GitHub Release.`);
    }
  }
  async status() {
    let current;
    try { current = this.version(); } catch (e) { current = {version:'Needs repair',versionError:e.message}; }
    const branch = (await this.git(['branch','--show-current'])).trim();
    const changes = lines(await this.git(['status','--porcelain'])).length;
    const tracked = split(await this.git(['ls-files','-z']));
    let remote = 'Not configured',github = 'CLI not installed / signed out';
    try { remote = (await this.publicPreflight()).remote; } catch (e) { remote = e.message; }
    try { await this.github(); github = 'Authenticated'; } catch (e) { github = e.message; }
    return { ...current,branch,changes,remote,github,privateTracked:tracked.filter(f=>!permitted(f)),publicationWorkspace:'packaging/cache/github-publication' };
  }
  async history() {
    const text = await this.git(['log','-25','--format=%H%x09%as%x09%s%x09%D']);
    return lines(text).map(line => { const [sha,date,message,tags] = line.split('\t'); return {sha,date,message,tags}; });
  }
  async plan(action,options = {},offline = false) {
    if (!['Save','Publish','Restore','Checkpoint'].includes(action)) throw new Error('Unknown action.');
    let current;
    try { current = this.version(); } catch(e) { if(action !== 'Restore')throw e;current={version:'Needs repair'}; }
    const source = await this.source(action === 'Restore');
    const common = {action,currentVersion:current.version,fingerprint:source.fingerprint};
    if (action === 'Checkpoint') {
      if ((await this.git(['branch','--show-current'])).trim() !== 'main') throw new Error('The project save location needs review. Open Advanced Details before continuing.');
      const changed = [...new Set([...split(await this.git(['diff','--name-only','-z','HEAD'])),...split(await this.git(['ls-files','--others','--exclude-standard','-z']))])].filter(f=>source.files.includes(f));
      return {...common,changes:changed.map(file=>({file,action:'Save'}))};
    }
    if (action === 'Restore') {
      if (!/^[a-f0-9]{40}$/.test(options.commit || '')) throw new Error('Choose a full commit from History.');
      if ((await this.git(['rev-parse','--verify',options.commit+'^{commit}'])).trim() !== options.commit) throw new Error('Invalid restore commit.');
      return {...common,commit:options.commit,files:source.files,commands:['create local safety branch + source-only stash','git restore --source <chosen commit> --staged --worktree -- <reviewed source paths>','git commit (local restore; no push)']};
    }
    const publicState = await this.publicPreflight();
    if (!offline) await this.github();
    const changes = await this.differences(source);
    const commands = ['sync reviewed source into existing public checkout','git add --all -- <reviewed source paths>','git commit (only when changes exist)','git push origin HEAD:refs/heads/main'];
    if (action === 'Save') return {...common,...publicState,changes,commands};
    const version = options.version || current.patchVersion; semver(version);
    await this.unique(version,!offline);
    const releases = lines(await this.git(['tag','--list','v*','--sort=-version:refname'],this.publicRoot));
    const lastTag = releases[0];
    const meaningful = await this.meaningfulChanges(source,lastTag);
    if (!meaningful.length) throw new Error('Nothing new to publish. Rovarin has no meaningful changes since version '+(lastTag || current.version).replace(/^v/,'')+'. Make changes to the project before creating another release.');
    return {...common,...publicState,version,tag:'v'+version,changes,meaningfulChanges:meaningful,previousVersion:lastTag?.replace(/^v/,''),assets:['RovarinSetup.exe','RovarinSetup.sha256','release.json'],prerelease:semver(version).major===0,commands:['synchronize package.json + Inno AppVersion','npm run build:installer','npm run release:verify (all eight suites + isolated installer lifecycle)',...commands,`git tag -a v${version} <exact build-source SHA>`,`git push origin refs/tags/v${version}`,`gh release create v${version} --verify-tag --generate-notes --fail-on-no-commits --draft`, 'gh release upload <exact allowlisted verified assets> (no --clobber)','gh release edit --draft=false']};
  }
  async meaningfulChanges(source,tag) {
    const rows = tag ? split(await this.git(['ls-tree','-r','-z',tag],this.publicRoot)) : [];
    const oldBlobs = new Map(rows.map(row=>{const [header,file]=row.split('\t');return [file,header.split(' ')[2]];}));
    const oldFiles=[...oldBlobs.keys()];
    const format=(await this.git(['rev-parse','--show-object-format'],this.publicRoot)).trim();
    if(!['sha1','sha256'].includes(format))throw new Error('Unsupported Git object format.');
    const ignore = file => /^scripts\/release-(?:manager|public-files)/.test(file) || file === 'Rovarin Release Manager.vbs';
    const normalize = (file,bytes) => {
      if (!bytes) return null;
      if (!['package.json','packaging/Rovarin.iss','packaging/RovarinLauncher.cs','packaging/desktop.manifest','README.md'].includes(file)) return hash(bytes);
      let text=bytes.toString('utf8').replace(/\r\n/g,'\n');
      if(file==='package.json'){const value=JSON.parse(text);delete value.version;return JSON.stringify(value);}
      if(file==='packaging/Rovarin.iss')text=text.replace(/(#define AppVersion\s+)"[^"]+"/g,'$1"<version>"');
      if(file==='packaging/RovarinLauncher.cs')text=text.replace(/(Assembly(?:File)?Version\(")[^"]+("\))/g,'$1<version>$2');
      if(file==='packaging/desktop.manifest')text=text.replace(/(assemblyIdentity version=")[^"]+(" name="Rovarin\.Desktop")/,'$1<version>$2');
      if(file==='README.md')text=text.replace(/https:\/\/github\.com\/DontMovePlease\/Rovarin\/releases(?:\/download\/v[^/\s)]+\/RovarinSetup\.exe|\/tag\/v[^\s)]+)?/g,'<release-link>').replace(/^(Current version:\s*)[0-9][^\n]*/gmi,'$1<version>');
      return text;
    };
    const changed=[];
    for(const file of new Set([...oldFiles,...source.contents.keys()])){
      if(ignore(file) || !source.files.includes(file))continue;
      if(!['package.json','packaging/Rovarin.iss','packaging/RovarinLauncher.cs','packaging/desktop.manifest','README.md'].includes(file)){
        const bytes=source.contents.get(file);
        const oid=bytes?crypto.createHash(format).update('blob '+bytes.length+'\0').update(bytes).digest('hex'):null;
        if(oid!==(oldBlobs.get(file)||null))changed.push(file);
        continue;
      }
      const before=oldFiles.includes(file)?Buffer.from(await this.git(['show',tag+':'+file],this.publicRoot)):null;
      if(normalize(file,before)!==normalize(file,source.contents.get(file)))changed.push(file);
    }
    return changed;
  }
  async freshRemote() {
    await this.git(['fetch','origin','main','--tags'],this.publicRoot);
    const behind = Number((await this.git(['rev-list','--count','HEAD..origin/main'],this.publicRoot)).trim());
    if (behind) throw new Error('GitHub has newer source. Review/synchronize the public checkout outside this tool before saving. No merge or force push was attempted.');
  }
  async sync(source) {
    const changes = await this.differences(source);
    for (const {file,action} of changes) {
      const full = plain(this.publicRoot,file,true);
      if (action === 'Remove') fs.unlinkSync(full);
      else { fs.mkdirSync(path.dirname(full),{recursive:true}); plain(this.publicRoot,file,true); fs.writeFileSync(full,source.contents.get(file)); }
    }
    const paths = [...new Set([...split(await this.git(['ls-files','-z'],this.publicRoot)),...source.contents.keys()])];
    await this.git(['add','--all','--',...paths],this.publicRoot);
    const staged = split(await this.git(['diff','--cached','--name-only','-z'],this.publicRoot));
    if (staged.some(f=>!source.files.includes(f) || !permitted(f))) throw new Error('Unexpected public staging. Push aborted.');
    return staged;
  }
  async commitAndPush(source,message) {
    this.scan('README.md',Buffer.from(message),this.secrets());
    const localSha = await this.localCheckpoint(source,message);
    const changed = await this.sync(source);
    if (changed.length) await this.git(['commit','-m',message],this.publicRoot);
    await this.publicPreflight();
    await this.verifyCommittedSource(source);
    const ahead = Number((await this.git(['rev-list','--count','origin/main..HEAD'],this.publicRoot)).trim());
    const sha = (await this.git(['rev-parse','HEAD'],this.publicRoot)).trim();
    if (ahead) { this.note('Pushing reviewed source to GitHub main.'); await this.git(['push','origin','HEAD:refs/heads/main'],this.publicRoot); }
    return {sha,localSha,changed:changed.length,pushed:ahead>0,message:!changed.length && !ahead ? 'Nothing to save — GitHub is already up to date.' : 'Source saved locally and pushed.'};
  }
  async localCheckpoint(source,message) {
    const tracked = split(await this.git(['ls-files','-z']));
    const paths = [...new Set([...tracked.filter(f=>source.files.includes(f)),...source.contents.keys()])];
    await this.git(['add','--all','--',...paths]);
    const staged = split(await this.git(['diff','--cached','--name-only','-z']));
    const privateRemovals = split(await this.git(['diff','--cached','--name-only','--diff-filter=D','-z']));
    if (staged.some(f=>!source.files.includes(f) && !(privateRemovals.includes(f) && ['AGENTS.md','PROJECT_STATUS.md','SECURITY.md','THE-PLAN.md'].includes(f)))) throw new Error('Unexpected local staged files. No checkpoint was committed.');
    if (staged.length) await this.git(['commit','-m',message]);
    return (await this.git(['rev-parse','HEAD'])).trim();
  }
  async verifyCommittedSource(source) {
    const format = (await this.git(['rev-parse','--show-object-format'],this.publicRoot)).trim();
    if (!['sha1','sha256'].includes(format)) throw new Error('Unsupported Git object format.');
    const tree = split(await this.git(['ls-tree','-r','-z','HEAD'],this.publicRoot));
    if (tree.length !== source.contents.size) throw new Error('Committed tree does not match the verified source file set.');
    for (const row of tree) {
      const [header,file] = row.split('\t'); const [mode,type,oid] = header.split(' '), bytes = source.contents.get(file);
      if (!bytes || type !== 'blob' || !['100644','100755'].includes(mode) || crypto.createHash(format).update(`blob ${bytes.length}\0`).update(bytes).digest('hex') !== oid) throw new Error('Committed bytes differ from build source: ' + file);
    }
  }
  verifyAssets(version) {
    const names = ['RovarinSetup.exe','RovarinSetup.sha256','release.json'];
    const publish = plain(this.root,'publish');
    if (fs.readdirSync(publish).sort().join('|') !== names.slice().sort().join('|')) throw new Error('Publish folder contains unexpected assets.');
    const assets = names.map(name => plain(this.root,'publish/'+name));
    for (const file of assets) if (!fs.statSync(file).isFile()) throw new Error('Release assets must be regular files.');
    const actual = hash(fs.readFileSync(assets[0]));
    const receipt = JSON.parse(fs.readFileSync(assets[2],'utf8'));
    const build = JSON.parse(fs.readFileSync(plain(this.root,'dist/build.json'),'utf8'));
    const {SUITES} = require('./release-verify');
    const metadataKeys = ['version','builtAt','verifiedAt','sha256','payloadManifestSha256','signing','suites'];
    if (Object.keys(receipt).sort().join('|') !== metadataKeys.sort().join('|') || receipt.signing !== 'unsigned' || !Number.isFinite(Date.parse(receipt.builtAt)) || !Number.isFinite(Date.parse(receipt.verifiedAt))) throw new Error('Unexpected release metadata. Only the existing secret-free schema may be uploaded.');
    this.scan('README.md',Buffer.from(JSON.stringify(receipt)),this.secrets());
    if (receipt.version !== version || build.version !== version || receipt.sha256 !== actual || build.sha256 !== actual || build.payloadManifestSha256 !== receipt.payloadManifestSha256 || hash(fs.readFileSync(plain(this.root,'dist/RovarinSetup.exe'))) !== actual || fs.readFileSync(assets[1],'utf8').trim() !== `${actual}  RovarinSetup.exe` || receipt.payloadManifestSha256 !== hash(fs.readFileSync(plain(this.root,'packaging/payload-manifest.json'))) || !Array.isArray(receipt.suites) || receipt.suites.join('|') !== [...SUITES,'installer-integration'].join('|')) throw new Error('Version, checksum or verified build metadata mismatch. Release aborted.');
    return {assets,sha256:actual};
  }
  async operate(action,options) {
    if (options.confirm !== true) throw new Error('Explicit confirmation is required. Use DryRun to preview safely.');
    const plan = await this.plan(action,options);
    for (const value of [options.message,options.title,options.note]) if (value) this.scan('README.md',Buffer.from(String(value)),this.secrets());
    if (options.fingerprint && options.fingerprint !== plan.fingerprint) throw new Error('Source changed since preview. Review the new plan first.');
    if (action === 'Restore') return this.restore(options,plan);
    if (action === 'Checkpoint') { const current=await this.source();if(current.fingerprint!==plan.fingerprint)throw new Error('Project files changed during review. Please review them again.');const sha=await this.localCheckpoint(current,(options.message || 'Save Rovarin progress').slice(0,300));return {sha,message:plan.changes.length?'Project progress saved on this PC. GitHub was not changed.':'Project is already up to date locally. GitHub was not changed.'}; }
    await this.freshRemote();
    const confirmedSource = await this.source();
    if (confirmedSource.fingerprint !== plan.fingerprint) throw new Error('Source changed while checking GitHub. Review a new plan first.');
    if (action === 'Save') return this.commitAndPush(confirmedSource,(options.message || 'Save Rovarin source').slice(0,300));
    this.note('Updating package.json and installer AppVersion. A failed build keeps this editable version locally; it never creates a GitHub release.');
    this.synchronize(plan.version);
    const source = await this.source();
    this.note('Building installer using the existing npm run build:installer command. This may take several minutes.');
    const pkg = JSON.parse(source.contents.get('package.json'));
    if (pkg.scripts['build:installer'] !== 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File packaging/build.ps1' || pkg.scripts['release:verify'] !== 'node scripts/release-verify.js') throw new Error('Trusted pipeline commands changed. Review them outside this tool.');
    await this.run('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File','packaging/build.ps1'],this.root,30*60*1000);
    this.note('Running the existing complete release gate. No tag/release/upload occurs before it passes.');
    await this.run(process.execPath,['scripts/release-verify.js'],this.root,45*60*1000);
    if ((await this.source()).fingerprint !== source.fingerprint) throw new Error('Source changed during build/verification. Nothing was pushed or tagged.');
    const verified = this.verifyAssets(plan.version);
    const summary = {version:plan.version,tag:plan.tag,branch:plan.branch,repository:TARGET,
      prerelease:plan.prerelease,changes:await this.differences(source),
      installer:verified.assets[0],sha256:verified.sha256};
    if (!this.approvePublish || await this.approvePublish(summary) !== true) throw new Error('Publishing cancelled. Verified local build retained; no source commit, push, tag or GitHub release was created.');
    if ((await this.source()).fingerprint !== source.fingerprint) throw new Error('Source changed during final confirmation. Review and rebuild before publishing.');
    await this.unique(plan.version);
    const saved = await this.commitAndPush(source,`Release ${plan.tag}`);
    if ((await this.source()).fingerprint !== source.fingerprint) throw new Error('Source changed before tagging. Release aborted.');
    // The exact exported tree must match the source which was built.
    if ((await this.differences(source)).length) throw new Error('Committed source differs from build source.');
    await this.unique(plan.version);
    this.note('Tagging the exact verified build-source commit.');
    await this.git(['tag','-a',plan.tag,saved.sha,'-m',`Rovarin ${plan.version}`],this.publicRoot);
    await this.git(['push','origin',`refs/tags/${plan.tag}`],this.publicRoot);
    const args = ['release','create',plan.tag,'--repo','DontMovePlease/Rovarin','--verify-tag','--generate-notes','--fail-on-no-commits','--draft','--title',(options.title || `${plan.version} — ${plan.prerelease ? 'Experimental Alpha' : 'Rovarin'}`).slice(0,200)];
    if (plan.prerelease) args.push('--prerelease');
    // Notes are not credentials and are supplied as a distinct CLI argument.
    if (options.note) args.push('--notes',String(options.note).slice(0,3000));
    await this.run('gh',args,this.root);
    await this.run('gh',['release','upload',plan.tag,...verified.assets,'--repo','DontMovePlease/Rovarin'],this.root,180000);
    const inspect = async () => JSON.parse(await this.run('gh',['api',`repos/DontMovePlease/Rovarin/releases/tags/${plan.tag}`],this.root));
    let release = await inspect();
    const assets = release.assets.map(a=>a.name).sort();
    if (release.tag_name !== plan.tag || !release.draft || assets.join('|') !== plan.assets.slice().sort().join('|')) throw new Error('Draft asset verification failed. The draft was not published; review it on GitHub.');
    for (const asset of release.assets) {
      const local = verified.assets.find(f=>path.basename(f)===asset.name);
      if (asset.size !== fs.statSync(local).size || asset.state !== 'uploaded' || asset.digest !== 'sha256:'+hash(fs.readFileSync(local))) throw new Error('GitHub asset digest/size verification failed. Draft remains unpublished.');
    }
    await this.run('gh',['release','edit',plan.tag,'--repo','DontMovePlease/Rovarin','--draft=false'],this.root);
    release = await inspect();
    if (release.draft) throw new Error('Release remains a draft.');
    return {message:`Rovarin ${plan.tag} published successfully.`,version:plan.version,sha:saved.sha,sha256:verified.sha256,url:release.html_url,assetStatus:'Installer, checksum and metadata uploaded and SHA-256 verified.'};
  }
  async restore(options,plan) {
    this.note('Creating a local recovery branch and preserving unfinished source in a pinned stash. No remote is modified.');
    const backup = 'rovarin-backup-'+new Date().toISOString().replace(/[^0-9]/g,'')+'-'+crypto.randomBytes(3).toString('hex');
    await this.git(['branch',backup,'HEAD']);
    const keepTool = f => f === 'Rovarin Release Manager.vbs' || /^scripts\/release-(?:manager|public-files)/.test(f);
    const candidates = split(await this.git(['ls-files','-z','--cached','--others','--exclude-standard'])).filter(f=>plan.files.includes(f) && !keepTool(f));
    let stash = null;
    const dirty = candidates.length ? (await this.git(['status','--porcelain','--',...candidates])).trim() : '';
    if (dirty) {
      await this.git(['stash','push','--include-untracked','-m',backup,'--',...candidates]);
      stash = (await this.git(['rev-parse','refs/stash'])).trim();
      await this.git(['update-ref','refs/rovarin-backups/'+backup,stash]);
    }
    const target = split(await this.git(['ls-tree','-r','--name-only','-z',options.commit])).filter(f=>plan.files.includes(f) && !keepTool(f));
    const tracked = split(await this.git(['ls-files','-z'])).filter(f=>plan.files.includes(f) && !keepTool(f));
    const paths = [...new Set([...target,...tracked])];
    await this.git(['restore','--source',options.commit,'--staged','--worktree','--',...paths]);
    if ((await this.git(['diff','--cached','--name-only','--',...paths])).trim()) await this.git(['commit','--only','-m',`Restore Rovarin source from ${options.commit.slice(0,8)} (local only)`,'--',...paths]);
    return {message:'Project restored locally. GitHub was not changed.',backup,stash,sha:(await this.git(['rev-parse','HEAD'])).trim(),recovery:stash ? `Unfinished work is retained in ${backup} and pinned stash ${stash}. Use git stash apply ${stash} only after reviewing current work.` : `Previous state is retained on local branch ${backup}.`};
  }
}
async function dispatch(root,options,emit,approvePublish) {
  const manager = new Manager(root,{emit,approvePublish});
  if (options.mode === 'Tools' || options.mode === 'ToolUpdates') {
    const tools = new (require('./release-manager-tools').Tools)(root,execute);
    return tools.status(options.mode === 'ToolUpdates');
  }
  if (options.mode === 'Status') return manager.status();
  if (options.mode === 'History') return manager.history();
  if (options.mode === 'Plan' || options.mode === 'DryRun') return manager.plan(options.action || 'Publish',options,options.mode === 'DryRun');
  if (!['Save','Publish','Restore','Checkpoint','UpdateTool','UpdateTools'].includes(options.mode)) throw new Error('Choose Status, History, Save, Publish, Restore, DryRun or Developer Tools.');
  const cache = path.join(root,'packaging/cache'); fs.mkdirSync(cache,{recursive:true}); plain(root,'packaging/cache');
  const lock = path.join(cache,'release-manager.lock'); let fd;
  try { fd = fs.openSync(lock,'wx'); } catch { throw new Error('Another manager operation may be running. Do not delete its lock until its process has been confirmed stopped.'); }
  fs.writeFileSync(fd,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
  try {
    if(options.mode==='UpdateTool')return await new (require('./release-manager-tools').Tools)(root,execute).update(options);
    if(options.mode==='UpdateTools')return await new (require('./release-manager-tools').Tools)(root,execute).updateAll(options,emit);
    return await manager.operate(options.mode,options);
  }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}
if (require.main === module) {
  const readline = require('readline').createInterface({input:process.stdin,crlfDelay:Infinity});
  let started=false,answer=null;
  readline.on('line',async input=>{
    if(input.length>16000){console.error('Request too large.');process.exit(1);}
    if(started){if(answer){const resolve=answer;answer=null;try{resolve(JSON.parse(input).publish===true);}catch{resolve(false);}}return;}
    started=true;
    const emit = value=>console.log(JSON.stringify(value));
    const approve = summary=>new Promise(resolve=>{
      const timer=setTimeout(()=>{answer=null;resolve(false);},10*60*1000);
      answer=value=>{clearTimeout(timer);resolve(value);};
      if(readline.closed){answer(false);return;}
      emit({type:'approval',summary});
    });
    try { const result = await dispatch(path.resolve(__dirname,'..'),JSON.parse(input),emit,approve); emit({type:'result',result}); }
    catch (error) { emit({type:'error',message:error.message}); process.exitCode = 1; }
    finally {readline.close();process.stdin.destroy();}
  });
  readline.on('close',()=>{if(answer){answer(false);answer=null;}});
}
module.exports = {Manager,dispatch,execute,permitted,semver,hash,TARGET};
