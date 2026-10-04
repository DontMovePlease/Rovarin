'use strict';
const assert = require('assert'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { Readable } = require('stream');
const { UpdateManager, RELEASE, compare, version, releaseCandidate, request, boundedText } = require('../update-manager');
const { readConfig, writeConfig } = require('../pin-manager');
const digest = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const makeRelease = (v='0.1.10', bytes=Buffer.from('disposable installer fixture - NEVER execute')) => ({ tag_name:'v'+v, draft:false, prerelease:false, published_at:'2026-10-01T00:00:00Z', html_url:`https://github.com/${RELEASE.repository}/releases/tag/v${v}`, body:'Test release notes', assets:[{ name:RELEASE.installer, size:bytes.length, state:'uploaded', digest:'sha256:'+digest(bytes), browser_download_url:`https://github.com/${RELEASE.repository}/releases/download/v${v}/${RELEASE.installer}` }] });
async function tests() {
  for (const [a,b,expected] of [['0.1.9','0.1.10',-1],['0.1.10','0.2.0',-1],['0.9.9','1.0.0',-1],['v0.1.1','0.1.1',0],['1.0.0','0.9.9',1]]) assert.strictEqual(compare(a,b),expected);
  for (const invalid of ['v01.1.1','0.1','0.1.1-beta','0.1.1/path','999999999999999999.1.1',null]) assert.strictEqual(version(invalid),null);
  const bytes=Buffer.from('disposable installer fixture - NEVER execute');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-update-'));
  const app=path.join(directory,'app');fs.mkdirSync(app);
  const configFile=path.join(directory,'config.json'); writeConfig(configFile,{pin:'654321',requireDesktopPin:true,retained:'user preference'});
  let release=makeRelease(), download=bytes, downloads=0, requests=0, fail=false;
  const transport=async url=>{
    requests++;
    if (url.startsWith(RELEASE.endpoint+'?')) return Readable.from([Buffer.from(JSON.stringify(Array.isArray(release) ? release : [release]))]);
    if (url.endsWith('.sha256')) return Readable.from([Buffer.from(digest(bytes)+'  RovarinSetup.exe\n')]);
    downloads++;
    if (fail) return Readable.from((async function*(){yield bytes.subarray(0,4);throw Error('interrupted')})());
    return Readable.from([download]);
  };
  const manager=new UpdateManager({root:app,configFile,transport,current:'0.1.9'});
  try {
    assert.strictEqual(manager.status().autoCheck,true);
    const alpha = new UpdateManager({root:app,configFile,transport,current:'0.1.1'});
    release=makeRelease('0.1.2');release.prerelease=true;
    assert.strictEqual((await alpha.check()).latestVersion,'0.1.2');assert.strictEqual(alpha.status().available,true);
    const stable = new UpdateManager({root:app,configFile,transport,current:'0.1.1',channel:'STABLE'});
    assert.strictEqual((await stable.check()).available,false);
    release.prerelease=false;assert.strictEqual((await alpha.check()).available,true);assert.strictEqual((await stable.check()).available,true);
    const badTag={...makeRelease('9.0.0'),tag_name:'not-a-version'};
    const draft={...makeRelease('8.0.0'),draft:true};
    const wrong=makeRelease('7.0.0');wrong.assets[0].name='other.exe';
    const noChecksum=makeRelease('6.0.0');delete noChecksum.assets[0].digest;
    const newerAlpha={...makeRelease('0.2.0'),prerelease:true};
    release=[makeRelease('0.1.1'),badTag,draft,noChecksum,wrong,makeRelease('0.1.99'),newerAlpha,makeRelease('0.1.2')];
    assert.strictEqual((await alpha.check()).latestVersion,'0.2.0','highest numeric usable release, not array order');
    assert.strictEqual((await stable.check()).latestVersion,'0.1.99','stable ignores newer prerelease');
    release=[makeRelease('0.1.0')];assert.strictEqual((await alpha.check()).available,false);
    release=[makeRelease('0.1.1')];assert.strictEqual((await alpha.check()).available,false,'never offers itself');
    release=makeRelease();release.assets.push(null);
    assert.strictEqual((await manager.check()).available,true);
    assert.strictEqual(manager.status().latestVersion,'0.1.10');
    release=makeRelease('0.1.9');assert.strictEqual((await manager.check()).state,'current');
    release=makeRelease('0.1.8');assert.strictEqual((await manager.check()).available,false);
    release=makeRelease();release.tag_name='bad';assert.strictEqual((await manager.check()).available,false);
    release=makeRelease();release.assets[0].name='Unrelated.exe';assert.strictEqual(releaseCandidate(release,'0.1.9'),null);
    for(const field of ['draft']) {release=makeRelease();release[field]=true;assert.strictEqual(releaseCandidate(release,'0.1.9'),null);}
    release=makeRelease();release.html_url='https://github.com/attacker/Rovarin/releases/tag/v0.1.10';assert.strictEqual(releaseCandidate(release,'0.1.9'),null);
    release=makeRelease();release.assets[0].browser_download_url='https://evil.invalid/RovarinSetup.exe';assert.strictEqual(releaseCandidate(release,'0.1.9'),null);
    release=makeRelease();delete release.assets[0].digest;assert.strictEqual((await manager.check()).available,false);
    release.assets.push({name:'RovarinSetup.sha256',state:'uploaded',size:84,browser_download_url:`https://github.com/${RELEASE.repository}/releases/download/v0.1.10/RovarinSetup.sha256`});
    assert.strictEqual((await manager.check()).available,true,'canonical checksum fallback');
    release=makeRelease(); manager.installed=()=>true; // fixture-only eligibility, never launches a program
    const result=await manager.download();assert.strictEqual(result.state,'ready');
    assert.strictEqual(digest(fs.readFileSync(path.join(directory,'updates/RovarinSetup.exe'))),digest(bytes));
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(directory,'updates/verified.json'))).repository,RELEASE.repository);
    download=Buffer.from('invalid digest fixture of same exact size'.padEnd(bytes.length,' ').slice(0,bytes.length));
    await assert.rejects(manager.download(),/download-failed/);assert.strictEqual(manager.status().state,'failed');
    assert(!fs.existsSync(path.join(directory,'updates/RovarinSetup.exe')),'checksum failure cannot execute');
    download=bytes;fail=true;await assert.rejects(manager.download());assert(!fs.existsSync(path.join(directory,'updates/RovarinSetup.partial')),'partial cleaned');fail=false;
    release=makeRelease();const active=manager.download();await assert.rejects(manager.download(),/update-busy/);await active;
    const reserved=manager.reserve();assert.strictEqual(reserved.busy,true);assert.strictEqual(reserved.state,'handoff');
    await assert.rejects(manager.download(),/update-busy/);
    manager.cancel();assert.strictEqual(manager.status().busy,false);
    manager.reserve();fs.writeFileSync(path.join(directory,'updates/handoff.json'),JSON.stringify({phase:'cancelled'}));assert.strictEqual(manager.status().busy,false);
    const before=requests;await manager.check(true);assert.strictEqual(requests,before,'daily throttle');
    manager.preference();assert.strictEqual(manager.status().autoCheck,false);
    const reopened=new UpdateManager({root:app,configFile,transport,current:'0.1.9'});assert.strictEqual(reopened.status().autoCheck,false,'preference survives restart');
    await reopened.check(true);assert.strictEqual(requests,before,'disabled auto makes no network call');
    const saved=readConfig(configFile);assert.strictEqual(saved.pin,'654321');assert.strictEqual(saved.requireDesktopPin,true);assert.strictEqual(saved.retained,'user preference');
    manager.preference();assert.strictEqual(manager.status().autoCheck,true);
    for(const url of ['http://github.com/x','https://evil.invalid/a','https://user:pass@github.com/a','https://github.com:444/a']) await assert.rejects(request(url,AbortSignal.timeout(1000)),/unsafe-source/);
    await assert.rejects(boundedText(RELEASE.endpoint,1,AbortSignal.timeout(1000),transport),/response-too-large/);
    const aborted=AbortSignal.abort(); // stream pipeline must abort and clean the partial file
    const prior=manager.transport;manager.transport=async(url,signal)=>{if(url.startsWith(RELEASE.endpoint+'?'))return prior(url,signal);const stream=Readable.from([bytes]);stream.destroy(Object.assign(Error('timeout'),{name:'AbortError'}));return stream;};
    await assert.rejects(manager.download());assert(!fs.existsSync(path.join(directory,'updates/RovarinSetup.partial')));
    console.log('PASS update versions/Experimental-and-Stable/official assets/digest and checksum/stream failure cleanup/single-flight/daily preference/config preservation/URL boundaries');
  } finally {fs.rmSync(directory,{recursive:true,force:true,maxRetries:5,retryDelay:100});}
}
module.exports=tests;
if(require.main===module)tests().catch(e=>{console.error(e);process.exitCode=1});