 'use strict';
const assert=require('assert/strict');
const {AppManager}=require('../app-manager');
const helper=require('fs').readFileSync(require('path').join(__dirname,'app-manager.ps1'),'utf8');
const run=helper.slice(helper.indexOf('function Startup-Inventory'),helper.indexOf('# Some user software'));
assert(run.includes('readOnly = $false'),'current-user Run entries are supported, independent of a folder-file variable');
assert(!run.includes('$file.Extension'),'Run capability must not depend on a shortcut file');
const folder=helper.slice(helper.indexOf('$userStartup =',helper.indexOf('function Startup-Inventory')),helper.indexOf("$commonStartup =",helper.indexOf('function Startup-Inventory')));
assert(folder.includes("readOnly = ($file.Extension -ine '.lnk')"),'unsupported startup file types stay read-only');
(async()=>{
 const entry={locator:{source:'scheduled-task',key:'\\Owned\\Fixture'},source:'scheduled-task',scope:'user',fingerprint:'a'.repeat(64),name:'Fixture',enabled:true,readOnly:false,taskManageable:true,canRestore:false};
 let calls=[],enabled=true,restore=false;
 const manager=new AppManager({operation:async request=>{calls.push(request);if(request.action==='startup-inventory')return {success:true,items:[{...entry,enabled,canRestore:restore}]}; enabled=request.restore?true:request.enabled;restore=!request.restore;return {success:true,code:'completed',enabled};}});
 let row=(await manager.startupInventory()).items[0]; assert.equal(row.readOnly,false);
 await manager.toggleStartup(row.id,false); assert.equal(manager.startupCache,null,'mutation invalidates task snapshot');
 row=(await manager.startupInventory()).items[0];assert.equal(row.enabled,false);assert.equal(row.canRestore,true);
 await manager.toggleStartup(row.id,'restore');row=(await manager.startupInventory()).items[0];assert.equal(row.enabled,true);assert.equal(row.canRestore,false);
 assert(calls.filter(x=>x.action==='startup-toggle').every(x=>x.locator.key===entry.locator.key));
 await assert.rejects(manager.toggleStartup(row.id,'restore'),/unsupported/);
 await assert.rejects(manager.toggleStartup('C:\\bad.exe',false),/invalid-request/);
 manager.operation=async()=>({success:false,code:'startup-changed'});await assert.rejects(manager.toggleStartup(row.id,false),/startup-changed/);assert.equal(manager.startupChanging,false);
 const blocked=new AppManager({operation:async()=>({success:true,items:[{...entry,taskManageable:false},{...entry,locator:{source:'app-service',key:'Protected'},source:'app-service'}]})});
 for(const item of (await blocked.startupInventory()).items){assert(item.readOnly);await assert.rejects(blocked.toggleStartup(item.id,false),/elevation-required/);}
 console.log('PASS task capability, original-state restore, snapshot invalidation, opaque identities, stale rejection and service fail-closed');
})().catch(e=>{console.error(e);process.exitCode=1;});
