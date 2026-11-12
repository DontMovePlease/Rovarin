'use strict';
// Only disposable directories and this test's own native process are modified.
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert'),Module=require('module'),{execFileSync}=require('child_process');
const root=path.resolve(__dirname,'..');
function load(fsOverride=fs,childOverride){
 const filename=path.join(root,'maintenance.js'),mod=new Module(filename,module);
 mod.filename=filename;mod.paths=Module._nodeModulePaths(root);
 mod.require=function(name){return name==='fs'?fsOverride:name==='child_process'&&childOverride?childOverride:Module.prototype.require.call(this,name);};
 mod._compile(fs.readFileSync(filename,'utf8')+'\nmodule.exports.boostFixture={cleanBoostTemp,trimBackgroundMemory,BOOST_MEMORY_SOURCE,createBoostPressurePolicy};',filename);
 return mod.exports.boostFixture;
}
const fixture=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'rovarin-boost-test-'));
async function main(){
 const policy=load().createBoostPressurePolicy(),total=16*1073741824;
 for(let t=0;t<45000;t+=5000)assert.equal(policy.sample(total,1073741824,t),false,'sustained pressure required');
 assert(policy.sample(total,1073741824,45000));assert(policy.sample(total,2.2*1073741824,50000),'hysteresis');
 assert(!policy.sample(total,4*1073741824,55000),'recovery');
 policy.completed(55000);for(let t=60000;t<655000;t+=5000)assert(!policy.sample(total,1073741824,t),'cooldown');
 assert(policy.sample(total,1073741824,655000));assert(!policy.sample(total,1073741824,700000),'inactive sampling gap resets sustained state');
 assert(!policy.sample(total,NaN,705000),'unknown memory neutral');
 console.log('PASS pressure duration, absolute available memory, hysteresis, recovery, cooldown, inactive gap and invalid-memory refusal');
 const {cleanBoostTemp,BOOST_MEMORY_SOURCE}=load();
 const temp=path.join(fixture,'temp');fs.mkdirSync(temp);
 const old=path.join(temp,'old.tmp'),recent=path.join(temp,'recent.tmp');
 fs.writeFileSync(old,Buffer.alloc(2048));fs.writeFileSync(recent,'recent');
 const now=Date.now()+8*86400000;fs.utimesSync(recent,now/1000,now/1000);
 fs.writeFileSync(path.join(temp,'config.json'),'preserve');fs.mkdirSync(path.join(temp,'folder.tmp'));fs.writeFileSync(path.join(temp,'folder.tmp','nested.tmp'),'preserve');
 fs.writeFileSync(path.join(temp,'hardlinked.temp'),'preserve');fs.linkSync(path.join(temp,'hardlinked.temp'),path.join(fixture,'hardlink-copy'));
 fs.mkdirSync(path.join(fixture,'outside'));fs.writeFileSync(path.join(fixture,'outside','outside.tmp'),'preserve');fs.symlinkSync(path.join(fixture,'outside'),path.join(temp,'linked.tmp'),'junction');
 const result=await cleanBoostTemp(temp,now);
 assert.equal(result.deletedCount,1);assert.equal(result.bytesFreed,2048);assert.equal(result.recoveryRetained,false);assert(!fs.existsSync(old));
 for(const p of ['recent.tmp','config.json','folder.tmp/nested.tmp','hardlinked.temp','linked.tmp/outside.tmp'])assert(fs.existsSync(path.join(temp,p)),p+' preserved');
 await assert.rejects(cleanBoostTemp(path.join(temp,'linked.tmp'),now),/Unsafe temp root/);
 console.log('PASS old eligible file only; recent, documents, nested folders, junction targets and hardlinks preserved; redirected root refused');
 const cutoffTemp=path.join(fixture,'cutoff_test');fs.mkdirSync(cutoffTemp);
 const file30h=path.join(cutoffTemp,'old_30h.tmp'),file12h=path.join(cutoffTemp,'recent_12h.tmp');
 fs.writeFileSync(file30h,Buffer.alloc(1024));fs.writeFileSync(file12h,Buffer.alloc(1024));
 const base=Date.now(),testNow=base+30*3600*1000;
 const time12hAgo=(testNow-12*3600*1000)/1000;
 fs.utimesSync(file12h,time12hAgo,time12hAgo);
 const oldScratch=path.join(cutoffTemp,'rovarin-scratch-old');fs.mkdirSync(oldScratch);
 fs.writeFileSync(path.join(oldScratch,'item.tmp'),Buffer.alloc(512));
 const normalDir=path.join(cutoffTemp,'user_normal_dir');fs.mkdirSync(normalDir);
 const cutoffRes=await cleanBoostTemp(cutoffTemp,testNow,{allowScratchDirs:true});
 assert.equal(cutoffRes.deletedCount,3,'30h file, nested item, and old scratch dir deleted');
 assert.equal(cutoffRes.bytesFreed,1024+512,'freed both file and scratch contents');
 assert.equal(fs.existsSync(file30h),false,'30h file deleted');
 assert.equal(fs.existsSync(file12h),true,'12h file preserved');
 assert.equal(fs.existsSync(oldScratch),false,'old scratch dir removed');
 assert.equal(fs.existsSync(normalDir),true,'user directory preserved');
 assert(cutoffRes.scannedCount>=4,'scanned count tracked');
 console.log('PASS 24-hour cutoff removes 30h old file and scratch directory, preserves 12h recent file and normal folder');
 const race=path.join(fixture,'race');fs.mkdirSync(race);fs.writeFileSync(path.join(race,'changed.tmp'),'old');
 const promises=Object.create(fs.promises);promises.rename=async(from,to)=>{fs.writeFileSync(from,'new concurrent content');await fs.promises.rename(from,to);};
 const raced=await load({...fs,promises}).cleanBoostTemp(race,now);
 assert.equal(raced.deletedCount,0);assert.equal(fs.readFileSync(path.join(race,'changed.tmp'),'utf8'),'new concurrent content');assert.equal(raced.recoveryRetained,false);
 console.log('PASS changed-file capture is restored without deletion');
 const collision=path.join(fixture,'collision');fs.mkdirSync(collision);fs.writeFileSync(path.join(collision,'changed.tmp'),'old');
 const racedPromises=Object.create(fs.promises);racedPromises.rename=async(from,to)=>{fs.writeFileSync(from,'captured concurrent content');await fs.promises.rename(from,to);fs.writeFileSync(from,'replacement');};
 const retained=await load({...fs,promises:racedPromises}).cleanBoostTemp(collision,now);
 assert.equal(retained.deletedCount,0);assert(retained.recoveryRetained);assert.equal(fs.readFileSync(path.join(collision,'changed.tmp'),'utf8'),'replacement');
 const recovery=fs.readdirSync(collision).find(n=>n.startsWith('rovarin-boost-recovery-'));assert.equal(fs.readFileSync(path.join(collision,recovery,'0.tmp'),'utf8'),'captured concurrent content');
 console.log('PASS concurrent replacement never overwritten; unconfirmed captured bytes retained for recovery');
 if(process.platform==='win32'){
  const child=require('child_process');
  const wrapper=await load(fs,{...child,execFile(file,args,options,callback){
    const encoded=args.indexOf('-EncodedCommand')+1;const script=Buffer.from(args[encoded],'base64').toString('utf16le');
    assert(script.includes('Process.GetProcesses(),root,serverPid,securityRoots'));
    // Exercise the complete PowerShell/catalog/result wrapper, but enumerate only
    // the hidden test helper itself. Never enumerate/trim personal applications.
    args[encoded]=Buffer.from(script.replace('Process.GetProcesses(),root,serverPid,securityRoots','new[]{Process.GetCurrentProcess()},root,serverPid,securityRoots'),'utf16le').toString('base64');
    return child.execFile(file,args,options,callback);
  }}).trimBackgroundMemory();
  assert.equal(wrapper.success,true,'production wrapper/catalog must succeed');assert.equal(wrapper.eligible,0);assert.equal(wrapper.workingSetReducedBytes,0);
  const malformed=await load(fs,{execFile(file,args,options,callback){callback(null,'{"success":true,"eligible":99}','');}}).trimBackgroundMemory();assert.equal(malformed.success,false);
  console.log('PASS real PowerShell/security-catalog/result wrapper against hidden helper only; malformed helper data fails closed');
  const source=path.join(fixture,'BoostFixture.cs'),exe=path.join(fixture,'BoostFixture.exe');
  fs.writeFileSync(source,BOOST_MEMORY_SOURCE+String.raw`
public static class BoostFixture {
 [STAThread] public static int Main() {
  using(var form=new System.Windows.Forms.Form()) {
   form.Text="Rovarin disposable memory fixture";form.WindowState=System.Windows.Forms.FormWindowState.Minimized;form.Show();System.Windows.Forms.Application.DoEvents();
   var memory=new byte[128*1024*1024];for(int i=0;i<memory.Length;i+=4096)memory[i]=37;
   var pid=System.Diagnostics.Process.GetCurrentProcess().Id;
   var excluded=RovarinBoostMemory.RunCandidates(new[]{System.Diagnostics.Process.GetProcessById(pid)},System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location),-1);
   if(excluded.eligible!=0)throw new Exception("Protected root was not excluded");
   var caller=RovarinBoostMemory.RunCandidates(new[]{System.Diagnostics.Process.GetProcessById(pid)},System.IO.Path.GetTempPath()+"absent-source-root",pid);
   if(caller.eligible!=0)throw new Exception("Server process was not excluded");
   var security=RovarinBoostMemory.RunCandidates(new[]{System.Diagnostics.Process.GetProcessById(pid)},System.IO.Path.GetTempPath()+"absent-source-root",-1,new[]{System.IO.Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location)});
   if(security.eligible!=0)throw new Exception("Registered security directory was not excluded");
   var result=RovarinBoostMemory.RunCandidates(new[]{System.Diagnostics.Process.GetProcessById(pid)},System.IO.Path.GetTempPath()+"absent-source-root",-1);
   if(!result.success||result.eligible!=1||result.trimmed!=1||result.workingSetReducedBytes<=0)throw new Exception("Owned minimized fixture trim did not pass");
   for(int i=0;i<memory.Length;i+=4096)if(memory[i]!=37)throw new Exception("Application memory changed");
   form.WindowState=System.Windows.Forms.FormWindowState.Normal;System.Windows.Forms.Application.DoEvents();
   var active=RovarinBoostMemory.RunCandidates(new[]{System.Diagnostics.Process.GetProcessById(pid)},System.IO.Path.GetTempPath()+"absent-source-root",-1);
   if(active.eligible!=0)throw new Exception("Unminimized application was not excluded");
   Console.WriteLine("PASS held-handle native trim of disposable minimized app, protected root/caller/active exclusions, application memory intact; resident reduction bytes="+result.workingSetReducedBytes);GC.KeepAlive(memory);
  }return 0;
 }
}`);
  execFileSync(path.join(process.env.SystemRoot,'Microsoft.NET/Framework64/v4.0.30319/csc.exe'),['/nologo','/target:winexe','/r:System.Windows.Forms.dll','/r:System.Drawing.dll','/out:'+exe,source],{windowsHide:true,timeout:30000});
  const output=execFileSync(exe,[],{windowsHide:true,timeout:30000,encoding:'utf8'});assert(output.includes('PASS held-handle'));console.log(output.trim());
 }
}
main().catch(e=>{console.error(e.stack);process.exitCode=1;}).finally(()=>{assert(path.dirname(fixture)===fs.realpathSync.native(os.tmpdir())&&path.basename(fixture).startsWith('rovarin-boost-test-'));fs.rmSync(fixture,{recursive:true,force:true});});
