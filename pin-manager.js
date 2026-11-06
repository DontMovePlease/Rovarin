'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const validNewPin = value => typeof value === 'string' && value.length === 6 && /^[0-9]{6}$/.test(value);
const validPin = value => typeof value === 'string' && [6,8,12].includes(value.length) && /^(?:\d{6}|\d{8}|\d{12})$/.test(value);
function dataDirectory(root = __dirname) {
  if (fs.existsSync(path.join(root, 'installation.json'))) return path.join(root, '..', 'data');
  if (!fs.existsSync(path.join(root, '.rovarin-development-state.json'))) {
    if (hasDevelopmentConfig(root)) throw new Error('Development storage marker missing; saved configuration retained.');
    return root;
  }
  const file = configurationFile(root); readConfig(file);
  // Preserve the protected per-checkout directory's ACLs and reject redirected ancestors.
  for (let cursor = path.dirname(file); cursor !== path.dirname(cursor); cursor = path.dirname(cursor)) {
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Unsafe data directory.');
  }
  return path.dirname(file);
}
// Opt-in developer storage keeps sync staging away from the real credential.
// The marker contains no path or secret; installed-mode storage is unchanged.
function developmentConfigFile(root = __dirname, schema = 2) {
  // Packaged developer tools can redirect AppData to a private MSIX copy even
  // when LOCALAPPDATA and realpath report the normal path. Keep v2 state outside
  // that virtualized tree so normal native launches share credentials/ownership.
  const base = schema === 1 ? process.env.LOCALAPPDATA : process.env.USERPROFILE || require('os').homedir();
  if (!base || !path.isAbsolute(base)) throw new Error('Local development storage unavailable.');
  const identity = crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex');
  return path.join(base, schema === 1 ? 'RovarinDevelopment' : '.rovarin-development', identity, 'config.json');
}
function hasDevelopmentConfig(root) {
  return [1, 2].some(schema => {
    try { return fs.existsSync(developmentConfigFile(root, schema)); } catch (_) { return false; }
  });
}
function configurationFile(root = __dirname) {
  if (fs.existsSync(path.join(root, 'installation.json'))) return path.join(dataDirectory(root), 'config.json');
  const marker = path.join(root, '.rovarin-development-state.json');
  if (!fs.existsSync(marker)) {
    if (hasDevelopmentConfig(root)) throw new Error('Development storage marker missing; saved configuration retained.');
    return path.join(root, 'config.json');
  }
  const stat = fs.lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw new Error('Invalid development storage marker.');
  const policy = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (!policy || ![1, 2].includes(policy.schema) || Object.keys(policy).length !== 1) throw new Error('Invalid development storage marker.');
  const file = developmentConfigFile(root, policy.schema);
  const directory = fs.lstatSync(path.dirname(file));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe data directory.');
  // A missing migrated config must never silently generate a replacement PIN.
  if (!fs.existsSync(file)) throw new Error('Migrated development configuration missing.');
  return file;
}

// Recoverable only by the same signed-in Windows user. PINs travel over captured
// stdin/stdout, never process arguments, files, logs, URLs or a remote endpoint.
const protectedPins = new Map();
const enrollmentRecords = new Map();
function protectWindowsPin(action, value) {
  if (process.platform !== 'win32' || !['protect','unprotect'].includes(action)) throw new Error('Windows PIN protection unavailable.');
  const script = "$ErrorActionPreference='Stop';try{Add-Type -AssemblyName System.Security;$r=ConvertFrom-Json ([Console]::In.ReadToEnd());$e=[Text.Encoding]::UTF8.GetBytes('Rovarin.Pin.v1');if($r.action -eq 'protect'){$b=[Text.Encoding]::UTF8.GetBytes([string]$r.value);try{[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))}finally{[Array]::Clear($b,0,$b.Length)}}elseif($r.action -eq 'unprotect'){$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$r.value),$e,'CurrentUser');try{[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))}finally{[Array]::Clear($b,0,$b.Length)}}else{exit 1}}catch{[Console]::Error.Write('Windows PIN protection unavailable.');exit 1}";
  try { return require('child_process').execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'), ['-NoProfile','-NonInteractive','-Command',script], {input:JSON.stringify({action,value}),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:8192}).trim(); }
  catch (_) { throw new Error('Windows PIN protection unavailable.'); }
}
function validCredential(value) {
  return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===5 && value.scheme==='scrypt-dpapi-v1' && [6,8,12].includes(value.length) && typeof value.salt==='string' && /^[a-f0-9]{32}$/.test(value.salt) && typeof value.hash==='string' && /^[a-f0-9]{64}$/.test(value.hash) && typeof value.protected==='string' && value.protected.length<=2048 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.protected);
}
function verifyPin(candidate, config) {
  if (!validPin(candidate)) return false;
  if (config.pinCredential) {
    if (!validCredential(config.pinCredential) || candidate.length!==config.pinCredential.length) return false;
    return crypto.timingSafeEqual(crypto.scryptSync(candidate,Buffer.from(config.pinCredential.salt,'hex'),32),Buffer.from(config.pinCredential.hash,'hex'));
  }
  return validPin(config.pin) && candidate.length===config.pin.length && crypto.timingSafeEqual(Buffer.from(candidate),Buffer.from(config.pin));
}
function encodeCredential(pin) {
  const salt=crypto.randomBytes(16).toString('hex');
  return {scheme:'scrypt-dpapi-v1',length:pin.length,salt,hash:crypto.scryptSync(pin,Buffer.from(salt,'hex'),32).toString('hex'),protected:protectWindowsPin('protect',pin)};
}
function decodeCredential(credential) {
  if (!validCredential(credential)) throw new Error('Invalid protected PIN configuration.');
  const key=JSON.stringify(credential);
  if (protectedPins.has(key)) return protectedPins.get(key);
  const pin=protectWindowsPin('unprotect',credential.protected);
  if (!verifyPin(pin,{pinCredential:credential})) throw new Error('Invalid protected PIN configuration.');
  if(protectedPins.size>=8)protectedPins.delete(protectedPins.keys().next().value);
  protectedPins.set(key,pin);return pin;
}

function rawConfig(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536) throw new Error('Unsafe configuration file.');
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
function readConfig(file) {
  const value = rawConfig(file);
  // A sealed first-enrollment journal commits the selected credential before
  // replacing config. Recover a power loss without reopening enrollment or
  // generating another PIN. The journal is destroyed once config is durable.
  const recordFile = enrollmentFile(file);
  if ((value.pinSetup || value.pinInitializedId) && fs.existsSync(recordFile)) {
    const record = safeRecord(recordFile);
    if (record.prepared) return withPinLock(file, () => {
      const current = rawConfig(file), latest = safeRecord(recordFile);
      if (!latest.prepared) return validateConfig(current, file);
      const journal = JSON.parse(protectWindowsPin('unprotect', latest.prepared));
      if (journal.schema !== 1 || journal.file !== path.resolve(file).toLowerCase() || !journal.config || journal.config.pin || journal.config.pinSetup || journal.id !== journal.config.pinInitializedId) throw new Error('Invalid interrupted PIN setup.');
      if (current.pinSetup) {
        if (current.pinSetup.id !== journal.id) throw new Error('Invalid interrupted PIN setup.');
        validateConfig(journal.config, file);
        atomicWrite(file, journal.config);
      } else if (current.pinInitializedId !== journal.id) throw new Error('Invalid interrupted PIN setup.');
      atomicWrite(recordFile, {schema:1,completed:true});
      return validateConfig(rawConfig(file), file);
    });
  }
  return validateConfig(value, file);
}

function validateConfig(value, file) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved PIN configuration.');
  if (value.pinSetup) {
    if (!file || value.pin || value.pinCredential || value.pinSetup.schema !== 1 || !/^[a-f0-9]{64}$/.test(value.pinSetup.id)) throw new Error('Invalid PIN setup state.');
    const record = safeRecord(enrollmentFile(file));
    if (record.completed || typeof record.sealed !== 'string') throw new Error('PIN setup already completed. Use local Recovery.');
    const expected = JSON.stringify({ schema: 1, file: path.resolve(file).toLowerCase(), id: value.pinSetup.id });
    if (!enrollmentRecords.has(record.sealed)) {
      if (enrollmentRecords.size >= 8) enrollmentRecords.clear();
      enrollmentRecords.set(record.sealed, protectWindowsPin('unprotect', record.sealed));
    }
    if (enrollmentRecords.get(record.sealed) !== expected) throw new Error('PIN setup ownership unavailable.');
    return value;
  }
  if(value.pinCredential){if(Object.hasOwn(value,'pin'))throw new Error('Ambiguous PIN configuration.');return {...value,pin:decodeCredential(value.pinCredential)};}
  if(!validPin(value.pin))throw new Error('Invalid saved PIN configuration.');
  return value;
}
function generatePin(previous, length = 6) {
  if (![6,8,12].includes(length)) throw new Error('Invalid PIN length.');
  let pin;
  do { pin = String(crypto.randomInt(0, 10 ** length)).padStart(length, '0'); } while (pin === previous);
  return pin;
}
function commitConfig(file, value) {
  if (!value.pinSetup && !validPin(value.pin)) throw new Error('Invalid PIN.');
  let stored = value;
  if(process.platform==='win32' && !value.pinSetup){const pinCredential=validCredential(value.pinCredential)&&verifyPin(value.pin,{pinCredential:value.pinCredential})?value.pinCredential:encodeCredential(value.pin);stored={...value,pinCredential};delete stored.pin;}
  // Reject invalid/oversized replacements before retiring the usable credential.
  if (Buffer.byteLength(JSON.stringify(stored, null, 2),'utf8') > 65536) throw new Error('Saved sign-in settings are too large. No PIN was replaced.');
  validateConfig(stored, file);
  atomicWrite(file, stored);
  if (readConfig(file).pin !== value.pin) throw new Error('PIN persistence could not be verified.');
}
function atomicWrite(file, stored) {
  const temp = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(stored, null, 2), 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (_) {}
  }
}

// Credential commits and preference writes share one cross-process lock. Publish
// a completely written owner record by hard link, so a crash never leaves an
// empty lock. Dead owners may be reclaimed; unknown owners fail closed.
function safeRecord(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 16384) throw new Error('Unsafe PIN state record.');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
const heldPinLocks = new Set();
function withPinLock(file, operation) {
  if (heldPinLocks.has(path.resolve(file))) return operation();
  const rootLock = file + '.pin-lock', owner = rootLock + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  const record = JSON.stringify({pid:process.pid,nonce:crypto.randomBytes(16).toString('hex')});
  const guards = [];
  const read = name => {try {safeRecord(name);return fs.readFileSync(name,'utf8');} catch(error){if(error.code==='ENOENT')return null;throw error;}};
  let lock = rootLock;
  fs.writeFileSync(owner, record, {flag:'wx',mode:0o600});
  try {
    for (let depth = 0; ; depth++) {
      if (depth >= 32) throw new Error('PIN update ownership requires local inspection.');
      try { fs.linkSync(owner, lock); guards.push({file:lock,record}); break; }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      const prior = read(lock);
      if (prior === null) {lock=rootLock;guards.length=0;continue;}
      const state = JSON.parse(prior);
      if (!Number.isSafeInteger(state.pid) || state.pid < 1) throw new Error('PIN update ownership unavailable.');
      try {process.kill(state.pid,0);throw new Error('Another PIN update is in progress. Try again.');}
      catch(error){if(error.code!=='ESRCH')throw error;}
      guards.push({file:lock,record:prior});
      // All contenders follow the same dead owner to the same successor. Never
      // unlink a dead root while another process could be claiming that root.
      lock = file + '.pin-lock.' + crypto.createHash('sha256').update(lock+prior).digest('hex');
    }
    if (guards.slice(0,-1).some(guard=>read(guard.file)!==guard.record)) throw new Error('PIN update ownership changed. Try again.');
    heldPinLocks.add(path.resolve(file));
    return operation();
  } finally {
    heldPinLocks.delete(path.resolve(file));
    // Only the holder of the live tail may retire its matching chain.
    if (guards.length && guards.at(-1).record === record) {
      for (const guard of guards) if (read(guard.file) === guard.record) fs.unlinkSync(guard.file);
    }
    fs.unlinkSync(owner);
  }
}

function credentialRevision(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value.pinSetup || [value.pinVersion || '', value.pinCredential || value.pin])).digest('hex');
}
function writeConfig(file, value) {
  return withPinLock(file, () => {
    if (fs.existsSync(file)) {
      const current = readConfig(file);
      // Existing callers can write a new PIN explicitly, but cannot overwrite a
      // credential changed since their protected snapshot was read.
      if (value.pinCredential && JSON.stringify(value.pinCredential) !== JSON.stringify(current.pinCredential)) throw new Error('PIN changed. Reopen this window and try again.');
      if (value.pinVersion !== current.pinVersion) throw new Error('PIN changed. Reopen this window and try again.');
    }
    return commitConfig(file, value);
  });
}
function enrollmentFile(file) { return path.join(path.dirname(file), 'pin-enrollment.json'); }
function prepareEnrollment(file, requireDesktopPin = true) {
  if (process.platform !== 'win32') throw new Error('Windows setup required.');
  return withPinLock(file, () => {
    // The installer calls this only for a genuinely new installation. Neither
    // startup nor a remote request can create or replace this birth record.
    if (fs.existsSync(file) || fs.existsSync(enrollmentFile(file))) throw new Error('Existing PIN state retained. Use local Recovery.');
    const ownLockPrefix=path.basename(file)+'.pin-lock';
    if (fs.readdirSync(path.dirname(file)).some(name=>name !== ownLockPrefix && !name.startsWith(ownLockPrefix+'.'))) throw new Error('Existing local data retained. Restore its PIN configuration.');
    const id = crypto.randomBytes(32).toString('hex');
    const sealed = protectWindowsPin('protect', JSON.stringify({schema:1,file:path.resolve(file).toLowerCase(),id}));
    fs.writeFileSync(enrollmentFile(file), JSON.stringify({schema:1,sealed}), {flag:'wx',mode:0o600});
    commitConfig(file, {pinSetup:{schema:1,id},requireDesktopPin,desktopLocked:false});
    return readConfig(file);
  });
}
function validateNewPin(pin, confirmation) {
  if (!validNewPin(pin)) throw new Error('Enter exactly six digits.');
  if (pin !== confirmation) throw new Error('The new PINs do not match.');
}
function updatePin(file, {action, currentPin, newPin, confirmPin, revision}) {
  validateNewPin(newPin, confirmPin);
  return withPinLock(file, () => {
    const saved = readConfig(file); // DPAPI authorizes the local Windows owner.
    if (typeof revision !== 'string' || revision !== credentialRevision(saved)) throw new Error('PIN changed. Reopen this window and try again.');
    if (action === 'enroll') {
      if (!saved.pinSetup) throw new Error('PIN setup is already complete.');
    } else {
      if (saved.pinSetup || !['change','reset'].includes(action)) throw new Error('Finish PIN setup in the native app.');
      if (action === 'change' && !verifyPin(currentPin, saved)) throw new Error('Current PIN not accepted.');
      if (verifyPin(newPin, saved)) throw new Error('Choose a different new PIN.');
    }
    const next = {...saved, pin:newPin, pinVersion:crypto.randomBytes(16).toString('hex'), pinLifecycleVersion:1, desktopLocked:action === 'reset' ? saved.desktopLocked : false};
    delete next.pinSetup; delete next.pinCredential;
    if (action === 'enroll') {
      next.pinInitializedId = saved.pinSetup.id;
      next.pinCredential = encodeCredential(newPin);
      const stored = {...next}; delete stored.pin;
      const prepared = protectWindowsPin('protect', JSON.stringify({schema:1,file:path.resolve(file).toLowerCase(),id:next.pinInitializedId,config:stored}));
      atomicWrite(enrollmentFile(file), {schema:1,prepared});
    }
    commitConfig(file, next);
    return readConfig(file);
  });
}
function loadConfig(file, { allowCreate = true } = {}) {
  try { return readConfig(file); }
  catch (error) { if (error.code !== 'ENOENT' || !allowCreate) throw error; } // Never replace malformed/inaccessible or migrated data.
  const value = { pin: generatePin() };
  writeConfig(file, value);
  return value;
}
function regeneratePin(root = __dirname, { length = 6 } = {}) {
  const directory = dataDirectory(root);
  if (fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe data directory.');
  const file = configurationFile(root);
  const value = readConfig(file);
  const pin = generatePin(value.pin, length);
  if (length !== 6) throw new Error('New PINs must use six digits.');
  updatePin(file, {action:'reset',newPin:pin,confirmPin:pin,revision:credentialRevision(value)});
  return pin;
}
if (require.main === module) {
  // Fixed native-local command. No PIN, path, or configuration fields accepted.
  try {
    if (process.argv.length !== 3) throw new Error('Invalid invocation.');
    if (process.argv[2] === '--reset-pin') {
      const input = fs.readFileSync(0, 'utf8');
      if (input.length > 1024) throw new Error('Invalid invocation.');
      const request = JSON.parse(input);
      if (!request || Object.keys(request).sort().join(',') !== 'confirmPin,newPin,revision') throw new Error('Invalid invocation.');
      updatePin(configurationFile(), {...request, action:'reset'});
      process.stdout.write('PIN reset. Previous sessions are revoked.\n');
    } else if (process.argv[2] === '--pin-status') {
      const saved = readConfig(configurationFile());
      process.stdout.write(JSON.stringify({setupRequired:!!saved.pinSetup,revision:credentialRevision(saved),personalized:saved.pinLifecycleVersion===1}) + '\n');
    } else if (['--prepare-pin-on','--prepare-pin-off'].includes(process.argv[2])) {
      if (!fs.existsSync(path.join(__dirname,'installation.json'))) throw new Error('Installer setup required.');
      prepareEnrollment(configurationFile(), process.argv[2] === '--prepare-pin-on');
      process.stdout.write('Create your PIN in the native Rovarin app.\n');
    } else if (process.argv[2] === '--data-path') {
      process.stdout.write(dataDirectory() + '\n');
    } else if (process.argv[2] === '--config-path') {
      const file = configurationFile(); readConfig(file);
      process.stdout.write(file + '\n');
    } else if (process.argv[2] === '--regenerate') {
      regeneratePin();
      process.stdout.write('PIN updated. Open the local Setup window to view it.\n');
    } else if (['--desktop-pin-on', '--desktop-pin-off'].includes(process.argv[2])) {
      // Fixed installer-only preference, one canonical config/PIN. No PIN arguments.
      const file = configurationFile();
      const saved = readConfig(file);
      writeConfig(file, { ...saved, requireDesktopPin: process.argv[2] === '--desktop-pin-on', desktopLocked: false });
      process.stdout.write('Desktop PIN preference saved.\n');
    } else throw new Error('Invalid invocation.');
  } catch (error) {
    const reason = error.message === 'Unsafe configuration file.' ? 'UNSAFE_CONFIG_FILE' : ['EACCES','EPERM','ENOENT'].includes(error.code) ? error.code : 'CONFIG_UNAVAILABLE';
    process.stderr.write('PIN update failed [' + reason + ']; check the saved configuration locally.\n'); process.exitCode = 1;
  }
}
// Only the fixed Windows helper can unwrap the current Windows user's DPAPI
// credential. It is never sent to the canonical frontend or placed in a URL.
let desktopTrustPromise;
function desktopTrust() {
  if (!desktopTrustPromise) desktopTrustPromise = new Promise(resolve => {
    if (process.platform !== 'win32') return resolve(null);
    require('child_process').execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scripts', 'native-trust.ps1')],
      { windowsHide: true, timeout: 15000, maxBuffer: 4096 }, (error, stdout) => {
        const key = String(stdout || '').trim();
        resolve(!error && /^[A-Za-z0-9+/]{43}=$/.test(key) ? key : null);
      });
  });
  return desktopTrustPromise;
}
module.exports = { configurationFile, developmentConfigFile, validPin, generatePin, readConfig, writeConfig, loadConfig, dataDirectory, regeneratePin, desktopTrust, verifyPin, validateConfig, validNewPin, validateNewPin, credentialRevision, prepareEnrollment, updatePin };
