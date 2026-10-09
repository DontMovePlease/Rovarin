'use strict';
// Developer-side release reporting only. No product telemetry or credentials.
const fs=require('fs'),path=require('path');
const endpoint='repos/DontMovePlease/Rovarin/releases';
const installerNames=new Set(['RovarinSetup.exe','PCMonitorSetup.exe']);
function summarize(releases,refreshedAt=new Date().toISOString()) {
  if(!Array.isArray(releases) || !Number.isFinite(Date.parse(refreshedAt)))throw Error('Invalid release data.');
  const versions=[],seenReleases=new Set(),seenAssets=new Map();let total=0;
  for(const r of releases){
    if(!Number.isSafeInteger(r.id)||typeof r.draft!=='boolean'||typeof r.tag_name!=='string'||!Array.isArray(r.assets))throw Error('Incomplete release data.');
    if(r.draft)continue;
    if(!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(r.tag_name)||!Number.isFinite(Date.parse(r.published_at)))throw Error('Invalid published release.');
    if(seenReleases.has(r.id))continue;seenReleases.add(r.id);
    let count=null;const own=new Set();
    for(const a of r.assets){
      if(!installerNames.has(a.name))continue;
      if(!Number.isSafeInteger(a.id)||a.id<=0||a.state!=='uploaded'||!Number.isSafeInteger(a.download_count)||a.download_count<0||a.browser_download_url!==`https://github.com/DontMovePlease/Rovarin/releases/download/${r.tag_name}/${a.name}`)throw Error('Incomplete installer asset data.');
      if(seenAssets.has(a.id) && (seenAssets.get(a.id).release!==r.id||seenAssets.get(a.id).count!==a.download_count))throw Error('Conflicting asset identity.');
      if(own.has(a.id))continue;own.add(a.id);seenAssets.set(a.id,{release:r.id,count:a.download_count});
      count=(count??0)+a.download_count;
    }
    if(count!==null)total+=count;
    if(!Number.isSafeInteger(total))throw Error('Invalid aggregate count.');
    versions.push({version:r.tag_name,publishedAt:r.published_at,downloads:count});
  }
  versions.sort((a,b)=>Date.parse(b.publishedAt)-Date.parse(a.publishedAt)||b.version.localeCompare(a.version));
  return {refreshedAt,latest:versions[0]||null,total,versions,missingInstallers:versions.filter(v=>v.downloads===null).length};
}
function validateCache(s){
  if(!s || !Array.isArray(s.versions)||!Number.isFinite(Date.parse(s.refreshedAt)))throw Error('Invalid cached statistics.');
  let total=0,missing=0;const names=new Set();
  for(const v of s.versions){if(!/^v\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(v.version)||names.has(v.version)||!Number.isFinite(Date.parse(v.publishedAt))||!(v.downloads===null||Number.isSafeInteger(v.downloads)&&v.downloads>=0))throw Error('Invalid cached statistics.');names.add(v.version);if(v.downloads===null)missing++;else total+=v.downloads;}
  if(s.total!==total||s.missingInstallers!==missing||JSON.stringify(s.latest)!==JSON.stringify(s.versions[0]||null))throw Error('Invalid cached totals.');
  return s;
}
class Downloads {
  constructor(root,run){this.root=root;this.run=run;this.busy=null;}
  cacheFile(){const dir=path.join(this.root,'packaging/cache');fs.mkdirSync(dir,{recursive:true});let cursor=dir;while(cursor!==path.dirname(cursor)){if(fs.lstatSync(cursor).isSymbolicLink())throw Error('Statistics cache redirects.');cursor=path.dirname(cursor);}const file=path.join(dir,'release-downloads.json');if(fs.existsSync(file)&&(!fs.lstatSync(file).isFile()||fs.lstatSync(file).isSymbolicLink()))throw Error('Unsafe statistics cache.');return file;}
  refresh(){if(this.busy)return this.busy;this.busy=this.fetch().finally(()=>{this.busy=null;});return this.busy;}
  async fetch(){
    let cached=null,file;try{file=this.cacheFile();if(fs.existsSync(file))cached=validateCache(JSON.parse(fs.readFileSync(file,'utf8')));}catch{}
    try{
      const started=Date.now(),releases=[];
      for(let page=1;page<=50;page++){
        if(Date.now()-started>90000)throw Error('Statistics deadline exceeded.');
        const batch=JSON.parse(await this.run('gh',['api',`${endpoint}?per_page=100&page=${page}`,'-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28'],this.root,15000));
        if(!Array.isArray(batch)||batch.length>100)throw Error('Invalid paginated response.');
        releases.push(...batch);if(batch.length<100){const stats=summarize(releases);if(file){const temp=file+'.'+require('crypto').randomBytes(8).toString('hex')+'.tmp';try{fs.writeFileSync(temp,JSON.stringify(stats,null,2)+'\n',{flag:'wx'});fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}return {state:'fresh',stats,error:null};}
      }
      throw Error('Release history exceeded bounded pagination.');
    }catch{return {state:cached?'stale':'unavailable',stats:cached,error:'Could not refresh GitHub downloads. Check your connection or GitHub API limit, then try Refresh.'};}
  }
}
module.exports={Downloads,summarize,validateCache};
