'use strict';
const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert'),crypto=require('crypto'),{execFileSync}=require('child_process');
module.exports=function test(){
 if(process.platform!=='win32')return;
 const root=path.resolve(__dirname,'..'),temp=fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()),'rovarin-dll-safe-')),q=s=>"'"+s.replace(/'/g,"''")+"'";
 try{
  const source=fs.readFileSync(path.join(__dirname,'app-manager.ps1'),'utf8'),prefix=source.split('$global:cachedSizes = @{}')[0];
  assert(!/Add-Type\s+-Path|OutputAssembly|\$cacheDir|Assembly\]::Load/.test(prefix),'bootstrap must not consume executable cache files');
  const outside=path.join(temp,'outside'),cache=path.join(temp,'cache'),marker=path.join(temp,'executed');fs.mkdirSync(outside);
  const evil='public static class RovarinAppMetadata { static RovarinAppMetadata(){System.IO.File.WriteAllText(@"'+marker+'","executed");} public static bool IsSafeDirectory(string p){return true;} }';
  const prepare=prefix.slice(prefix.indexOf('$nativeSources='),prefix.indexOf('# Executable cache'));
  fs.writeFileSync(path.join(temp,'seed.ps1'),prepare.replaceAll('$PSScriptRoot',q(__dirname))+"\n$sha=[Security.Cryptography.SHA256]::Create();$h=([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($nativeCode)))).Replace('-','').ToLowerInvariant();Add-Type -TypeDefinition "+q(evil)+" -OutputAssembly (Join-Path "+q(outside)+" (\"native-$h.dll\"))");
  const run=file=>execFileSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',file],{windowsHide:true,stdio:'pipe',timeout:45000});run(path.join(temp,'seed.ps1'));
  const dll=path.join(outside,fs.readdirSync(outside)[0]),bytes=fs.readFileSync(dll),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
  for(const kind of ['directory','junction','file-symlink','corrupt','replacement']){
   if(fs.existsSync(cache))fs.rmSync(cache,{recursive:true,force:true});
   if(kind==='junction')fs.symlinkSync(outside,cache,'junction');
   else{fs.mkdirSync(cache);const leaf=path.join(cache,path.basename(dll));if(kind==='file-symlink'){try{fs.symlinkSync(dll,leaf,'file');}catch(e){if(e.code!=='EPERM')throw e;console.log('SKIP actual file-symlink creation: Windows privilege unavailable; no-cache-load invariant still asserted');continue;}}else fs.writeFileSync(leaf,kind==='corrupt'?Buffer.from('not an assembly'):bytes);}
   const probe=prefix.replaceAll('$PSScriptRoot',q(__dirname))+"\nif(-not [RovarinAppMetadata]::IsSafeDirectory("+q(temp)+")){throw 'Trusted metadata unavailable'};if([RovarinAppMetadata].Assembly.Location){throw 'Unexpected disk-loaded metadata assembly'}";
   fs.writeFileSync(path.join(temp,'probe.ps1'),probe);run(path.join(temp,'probe.ps1'));
   assert(!fs.existsSync(marker),'attacker initializer must never run: '+kind);assert.equal(hash(fs.readFileSync(dll)),hash(bytes),'untrusted cache stays untouched');
  }
  console.log('PASS trusted in-memory metadata compilation; substituted DLL/directory/junction/corruption ignored, attacker initializer never executes; file-symlink case is conditional on Windows privileges');
 }finally{fs.rmSync(temp,{recursive:true,force:true});}
};
if(require.main===module)module.exports();
