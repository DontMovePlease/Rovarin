'use strict';
// Test-only native boundary fixture, never loaded by the application launcher.
const childProcess=require('child_process');const original=childProcess.execFile;
const fixture=(name,key,type='exe',quiet=true)=>({name,version:'1.0',publisher:'Disposable test publisher',locator:{scope:'user',key},fingerprint:require('crypto').createHash('sha256').update(key).digest('hex'),type,batchCapable:quiet,elevationLikely:false,sizeKB:1024});
let apps=[fixture('Fixture Alpha','qa-alpha'),fixture('Fixture Beta','qa-beta','msi'),fixture('Fixture Manual','qa-manual','manual',false)];
apps[0].sizeKB=500*1024;apps[1].sizeKB=1536*1024;apps[2].sizeKB=null;apps[0].description='Local document viewer';apps[2].locator.scope='appx';apps[2].protected=true;apps[2].type='appx';apps[2].description='Local Store package description';
childProcess.execFile=function(file,args,options,callback){
 if(args?.includes(require('path').join(__dirname,'app-manager.ps1'))){let request;return {stdin:{on(){},end(input){request=JSON.parse(input);setTimeout(()=>{if(request.action==='inventory')callback(null,JSON.stringify({success:true,apps,packagesAvailable:true}));else{apps=apps.filter(row=>row.locator.key!==request.locator.key);callback(null,JSON.stringify({success:true,code:'completed'}));}},30);}}};}
 return original.apply(this,arguments);
};
