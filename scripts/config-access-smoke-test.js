'use strict';
const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert');
const pins=require('../pin-manager');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'rovarin-config-access-'));
try{
 const app=path.join(temp,'app'),data=path.join(temp,'data');fs.mkdirSync(app);fs.mkdirSync(data);
 assert.strictEqual(pins.dataDirectory(app),app,'development operational state remains in checkout');
 assert.strictEqual(pins.configurationFile(app),path.join(app,'config.json'));
 const previousLocal=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=temp;
 try {
  const developer=pins.developmentConfigFile(app),directory=path.dirname(developer);
  fs.mkdirSync(directory,{recursive:true});
  const original={pin:'123456',requireDesktopPin:true,autoCheckUpdates:false,desktopLocked:true};
  pins.writeConfig(developer,original);
  fs.writeFileSync(path.join(app,'.rovarin-development-state.json'),'{"schema":1}');
  assert.strictEqual(pins.configurationFile(app),developer,'backend and Recovery share fixed unsynced config');
  assert.notStrictEqual(pins.developmentConfigFile(path.join(temp,'other')),developer,'checkouts cannot share credentials accidentally');
  assert.strictEqual(pins.readConfig(developer).pin,original.pin);
  pins.regeneratePin(app);
  const rotated=pins.readConfig(developer);assert.notStrictEqual(rotated.pin,original.pin);
  assert.deepStrictEqual({...rotated,pin:original.pin},original,'Recovery preserves every unrelated field');
  assert.strictEqual(fs.lstatSync(developer).nlink,1);
  fs.unlinkSync(developer);
  assert.throws(()=>pins.configurationFile(app),/Migrated development configuration missing/);
  assert(!fs.existsSync(developer),'missing migrated state never generates a replacement PIN');
  fs.writeFileSync(path.join(app,'.rovarin-development-state.json'),'{"schema":1,"path":"untrusted"}');
  assert.throws(()=>pins.configurationFile(app),/Invalid development storage marker/);
  fs.writeFileSync(path.join(app,'.rovarin-development-state.json'),'{broken');
  assert.throws(()=>pins.configurationFile(app));
 } finally { if(previousLocal===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previousLocal; }
 const setup=fs.readFileSync(path.join(__dirname,'setup.ps1'),'utf8');
 assert(setup.includes('--config-path'));assert(!setup.includes("Get-Content (Join-Path $dataDir 'config.json')"));
 fs.writeFileSync(path.join(app,'installation.json'),'{"schema":1,"channel":"windows-x64"}');
 assert.strictEqual(path.resolve(pins.dataDirectory(app)),data,'installed state is canonical sibling data');
 assert.strictEqual(path.resolve(pins.configurationFile(app)),path.join(data,'config.json'),'installed marker takes precedence over developer policy');
 const file=path.join(data,'config.json'),initial=pins.loadConfig(file),pin=initial.pin;
 pins.writeConfig(file,{...initial,requireDesktopPin:false,autoCheckUpdates:false});
 assert.strictEqual(pins.readConfig(file).pin,pin);assert.strictEqual(pins.readConfig(file).requireDesktopPin,false);
 fs.copyFileSync(path.join(__dirname,'..','pin-manager.js'),path.join(app,'pin-manager.js'));
 const invoke=flag=>require('child_process').spawnSync(process.execPath,[path.join(app,'pin-manager.js'),flag],{encoding:'utf8',timeout:5000});
 const resolved=invoke('--config-path');assert.strictEqual(resolved.status,0);assert.strictEqual(path.resolve(resolved.stdout.trim()),file);
 const preserved=fs.readFileSync(file);assert.strictEqual(fs.lstatSync(file).nlink,1);
 const extra=path.join(temp,'upload-staging-link');fs.linkSync(file,extra);
 assert.strictEqual(fs.lstatSync(file).nlink,2);assert.throws(()=>pins.loadConfig(file),/Unsafe configuration file/);
 assert(fs.readFileSync(file).equals(preserved),'unsafe persisted config is not regenerated or overwritten');
 const refused=invoke('--regenerate');assert.strictEqual(refused.status,1);assert(refused.stderr.includes('UNSAFE_CONFIG_FILE'));assert(!refused.stderr.includes(pin));assert.strictEqual(refused.stdout,'');
 assert.strictEqual(invoke('--config-path').status,1,'Setup path resolution also validates config safety');
 assert(fs.readFileSync(file).equals(preserved),'unsafe Recovery never changes credentials');
 fs.unlinkSync(extra);assert.strictEqual(pins.readConfig(file).pin,pin);
 if(process.platform==='win32'){
  fs.chmodSync(file,0o400);assert.strictEqual(pins.readConfig(file).pin,pin);
  assert.throws(()=>pins.writeConfig(file,{...initial,requireDesktopPin:true}),/EPERM|EACCES/);
  assert(fs.readFileSync(file).equals(preserved),'read-only failure preserves existing state');fs.chmodSync(file,0o600);
 }
 pins.writeConfig(file,{...pins.readConfig(file),autoCheckUpdates:true});assert.strictEqual(pins.readConfig(file).pin,pin);
 console.log('PASS canonical installed/development paths, readable/writable/preserved config, transient sync hard-link rejection without PIN reset, recovery after link removal, controlled read-only write failure');
}finally{const target=path.resolve(temp);assert(target.startsWith(path.resolve(os.tmpdir())+path.sep));fs.rmSync(target,{recursive:true,force:true});}
