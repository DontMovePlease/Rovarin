'use strict';
// Test-only native boundary fixture, never loaded by the application launcher.
if(process.env.ROVARIN_REMOVAL_POLICY_TEST_DIRECTORY){
 const fs=require('fs'),path=require('path'),directory=path.resolve(process.env.ROVARIN_REMOVAL_POLICY_TEST_DIRECTORY);
 if(!directory.startsWith(path.resolve(require('os').tmpdir())+path.sep)||!/^rovarin-(system-ui-state|leftover-ui)-/.test(path.basename(directory))||fs.lstatSync(directory).isSymbolicLink())throw Error('Unsafe policy fixture directory');
 const pins=require('../pin-manager');pins.configurationFile=()=>path.join(directory,'config.json');pins.dataDirectory=()=>directory;pins.desktopTrust=async()=>null;
 if(!fs.existsSync(path.join(directory,'config.json')))pins.writeConfig(path.join(directory,'config.json'),{pin:process.env.PC_MONITOR_PIN});
}
const childProcess=require('child_process');const original=childProcess.execFile;
const fixture=(name,key,type='exe',quiet=true)=>({name,version:'1.0',publisher:'Disposable test publisher',locator:{scope:'user',key},fingerprint:require('crypto').createHash('sha256').update(key).digest('hex'),type,batchCapable:quiet,elevationLikely:false,sizeKB:1024});
let startupEnabled=false;
let apps=[fixture('Fixture Alpha','qa-alpha'),fixture('Fixture Beta','qa-beta','msi'),fixture('Fixture Manual','qa-manual','manual',false)];
apps[0].sizeKB=500*1024;apps[1].sizeKB=1536*1024;apps[2].sizeKB=null;apps[0].description='Local document viewer';apps[2].locator.scope='appx';apps[2].protected=true;apps[2].type='appx';apps[2].description='Local Store package description';
// Optional owned filesystem fixture for cleanup tests; never used by the launcher.
if(process.env.ROVARIN_LEFTOVERS_TEST_ROOT){
 const fs=require('fs'),path=require('path'),root=path.resolve(process.env.ROVARIN_LEFTOVERS_TEST_ROOT);
 if(!root.startsWith(path.resolve(require('os').tmpdir())+path.sep)||!path.basename(root).startsWith('rovarin-leftover-ui-'))throw Error('Unsafe cleanup test root');
 for(const app of apps.slice(0,2)){app.installLocation=path.join(root,app.name);fs.mkdirSync(app.installLocation,{recursive:true});fs.writeFileSync(path.join(app.installLocation,'fixture.txt'),'disposable');}
}
childProcess.execFile=function(file,args,options,callback){
 if(args?.includes(require('path').join(__dirname,'app-manager.ps1'))){let request;return {stdin:{on(){},end(input){request=JSON.parse(input);setTimeout(()=>{if(request.action==='inventory')callback(null,JSON.stringify({success:true,apps,packagesAvailable:true}));else if(request.action==='startup-inventory')callback(null,JSON.stringify({success:true,items:[{locator:{source:'registry-user',key:'qa-startup'},fingerprint:'1'.repeat(64),source:'registry-user',name:'Fixture Startup',displayName:'Fixture Startup',publisher:'Fixture publisher',scope:'user',enabled:startupEnabled,readOnly:false},{locator:{source:'packaged-startup',key:'Fixture|Startup'},fingerprint:'2'.repeat(64),source:'packaged-startup',name:'Fixture Package',displayName:'Fixture Package',scope:'user',enabled:null,readOnly:true,method:'Packaged app startup'},{locator:{source:'app-service',key:'FixtureService'},fingerprint:'3'.repeat(64),source:'app-service',name:'FixtureService',displayName:'Fixture Background',scope:'machine',enabled:true,readOnly:true,method:'Automatic background service'}],warnings:[]}));else if(request.action==='startup-toggle'){startupEnabled=request.enabled;callback(null,JSON.stringify({success:true,code:'completed',enabled:request.enabled}));}else{apps=apps.filter(row=>row.locator.key!==request.locator.key);callback(null,JSON.stringify({success:true,code:'completed'}));}},30);}}};}
 return original.apply(this,arguments);
};
