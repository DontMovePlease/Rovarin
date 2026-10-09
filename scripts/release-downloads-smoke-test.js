'use strict';
const assert=require('assert'),fs=require('fs'),os=require('os'),path=require('path');
const {Downloads,summarize}=require('./release-downloads');
const release=(id,tag,count,name='RovarinSetup.exe')=>({id,tag_name:tag,draft:false,published_at:new Date(2026,0,id).toISOString(),assets:[{id:id+1000,name,state:'uploaded',download_count:count,browser_download_url:`https://github.com/DontMovePlease/Rovarin/releases/download/${tag}/${name}`}]});
(async()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-downloads-'));try{
 const latest=release(2,'v0.4.0',0),old=release(1,'v0.3.0',27);old.assets.push({...old.assets[0]}, {name:'RovarinSetup.sha256',download_count:999});
 let s=summarize([old,latest]);assert.equal(s.latest.version,'v0.4.0');assert.equal(s.latest.downloads,0);assert.equal(s.total,27);assert.equal(s.versions.length,2);
 assert.equal(summarize([release(1,'v0.1.0',4,'PCMonitorSetup.exe')]).total,4);
 assert.equal(summarize([]).latest,null);const missing={...old,assets:[]};assert.equal(summarize([missing]).latest.downloads,null);
 for(const invalid of [null,{},[{...latest,assets:null}],[{...latest,assets:[{...latest.assets[0],download_count:-1}]}],[{...latest,assets:[{...latest.assets[0],download_count:'0'}]}]])assert.throws(()=>summarize(invalid));
 let calls=0,fail=false;const d=new Downloads(dir,async(command,args)=>{calls++;assert.equal(command,'gh');assert(args[1].startsWith('repos/DontMovePlease/Rovarin/releases?'));if(fail)throw Error('secret must not be exposed');return JSON.stringify([old,latest]);});
 let r=await d.refresh();assert.equal(r.state,'fresh');assert.equal(calls,1);fail=true;r=await d.refresh();assert.equal(r.state,'stale');assert.equal(r.stats.total,27);assert(!r.error.includes('secret'));
 fail=false;const fresh=new Downloads(dir,async()=>JSON.stringify([release(3,'v0.4.0',12)]));assert.equal((await fresh.refresh()).stats.total,12);
 let pages=0;const paged=new Downloads(dir,async()=>JSON.stringify(++pages===1?Array.from({length:100},(_,i)=>release(i+1,`v0.1.${i}`,1)):[]));assert.equal((await paged.refresh()).stats.total,100);assert.equal(pages,2);
 const concurrent=new Downloads(dir,async()=>{calls++;await new Promise(r=>setTimeout(r,20));return '[]'});const before=calls;await Promise.all([concurrent.refresh(),concurrent.refresh()]);assert.equal(calls-before,1);
 const absent=new Downloads(path.join(dir,'new'),async()=>{throw Error('rate limit')});r=await absent.refresh();assert.equal(r.state,'unavailable');assert.equal(r.stats,null);
 const ui=fs.readFileSync(path.join(__dirname,'release-manager-ui.ps1'),'utf8');assert(ui.includes('Start-Downloads'));assert(ui.includes("mode='Downloads'"));assert(ui.includes('$downloadRefresh.Add_Click'));assert(ui.includes('Cached'));assert(ui.includes('GitHub-recorded'));assert(!ui.includes('downloadsTimer.Start()'));console.log('PASS download counts, zero/missing values, historical naming, deduplication, pagination, malformed/rate/network failures, stale cache, concurrency, launch/manual refresh wiring and no continuous polling');
}finally{fs.rmSync(dir,{recursive:true,force:true});}})().catch(e=>{console.error(e);process.exitCode=1});
