'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const validPin = value => typeof value === 'string' && (value.length === 6 || value.length === 12) && /^(?:\d{6}|\d{12})$/.test(value);
function dataDirectory(root = __dirname) {
  if (fs.existsSync(path.join(root, 'installation.json'))) return path.join(root, '..', 'data');
  if (!fs.existsSync(path.join(root, '.rovarin-development-state.json'))) {
    if (process.env.LOCALAPPDATA && fs.existsSync(developmentConfigFile(root))) throw new Error('Development storage marker missing; saved configuration retained.');
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
function developmentConfigFile(root = __dirname) {
  if (!process.env.LOCALAPPDATA) throw new Error('Local development storage unavailable.');
  const identity = crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex');
  return path.join(process.env.LOCALAPPDATA, 'RovarinDevelopment', identity, 'config.json');
}
function configurationFile(root = __dirname) {
  if (fs.existsSync(path.join(root, 'installation.json'))) return path.join(dataDirectory(root), 'config.json');
  const marker = path.join(root, '.rovarin-development-state.json');
  if (!fs.existsSync(marker)) {
    if (process.env.LOCALAPPDATA && fs.existsSync(developmentConfigFile(root))) throw new Error('Development storage marker missing; saved configuration retained.');
    return path.join(root, 'config.json');
  }
  const stat = fs.lstatSync(marker);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128) throw new Error('Invalid development storage marker.');
  const policy = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (!policy || policy.schema !== 1 || Object.keys(policy).length !== 1) throw new Error('Invalid development storage marker.');
  const file = developmentConfigFile(root);
  const directory = fs.lstatSync(path.dirname(file));
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Unsafe data directory.');
  // A missing migrated config must never silently generate a replacement PIN.
  if (!fs.existsSync(file)) throw new Error('Migrated development configuration missing.');
  return file;
}

// Recoverable only by the same signed-in Windows user. PINs travel over captured
// stdin/stdout, never process arguments, files, logs, URLs or a remote endpoint.
const protectedPins = new Map();
function protectWindowsPin(action, value) {
  if (process.platform !== 'win32' || !['protect','unprotect'].includes(action)) throw new Error('Windows PIN protection unavailable.');
  const script = "$ErrorActionPreference='Stop';try{Add-Type -AssemblyName System.Security;$r=ConvertFrom-Json ([Console]::In.ReadToEnd());$e=[Text.Encoding]::UTF8.GetBytes('Rovarin.Pin.v1');if($r.action -eq 'protect'){$b=[Text.Encoding]::UTF8.GetBytes([string]$r.value);try{[Console]::Out.Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect($b,$e,'CurrentUser')))}finally{[Array]::Clear($b,0,$b.Length)}}elseif($r.action -eq 'unprotect'){$b=[Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String([string]$r.value),$e,'CurrentUser');try{[Console]::Out.Write([Text.Encoding]::UTF8.GetString($b))}finally{[Array]::Clear($b,0,$b.Length)}}else{exit 1}}catch{[Console]::Error.Write('Windows PIN protection unavailable.');exit 1}";
  try { return require('child_process').execFileSync(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'), ['-NoProfile','-NonInteractive','-Command',script], {input:JSON.stringify({action,value}),encoding:'utf8',windowsHide:true,timeout:15000,maxBuffer:8192}).trim(); }
  catch (_) { throw new Error('Windows PIN protection unavailable.'); }
}
function validCredential(value) {
  return value && typeof value==='object' && !Array.isArray(value) && Object.keys(value).length===5 && value.scheme==='scrypt-dpapi-v1' && [6,12].includes(value.length) && typeof value.salt==='string' && /^[a-f0-9]{32}$/.test(value.salt) && typeof value.hash==='string' && /^[a-f0-9]{64}$/.test(value.hash) && typeof value.protected==='string' && value.protected.length<=2048 && /^[A-Za-z0-9+/]+={0,2}$/.test(value.protected);
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

function readConfig(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error('Unsafe configuration file.');
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  return validateConfig(value);
}
function validateConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid saved PIN configuration.');
  if(value.pinCredential){if(Object.hasOwn(value,'pin'))throw new Error('Ambiguous PIN configuration.');return {...value,pin:decodeCredential(value.pinCredential)};}
  if(!validPin(value.pin))throw new Error('Invalid saved PIN configuration.');
  return value;
}
function generatePin(previous, length = 6) {
  if (![6,12].includes(length)) throw new Error('Invalid PIN length.');
  let pin;
  do { pin = String(crypto.randomInt(0, 10 ** length)).padStart(length, '0'); } while (pin === previous);
  return pin;
}
function writeConfig(file, value) {
  if (!validPin(value.pin)) throw new Error('Invalid PIN.');
  let stored = value;
  if(process.platform==='win32'){const pinCredential=validCredential(value.pinCredential)&&verifyPin(value.pin,{pinCredential:value.pinCredential})?value.pinCredential:encodeCredential(value.pin);stored={...value,pinCredential};delete stored.pin;}
  const temp = file + '.' + crypto.randomBytes(12).toString('hex') + '.tmp';
  let fd;
  try {
    fd = fs.openSync(temp, 'wx', 0o600);
    fs.writeFileSync(fd, JSON.stringify(stored, null, 2), 'utf8');
    fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
    fs.renameSync(temp, file);
    if (readConfig(file).pin !== value.pin) throw new Error('PIN persistence could not be verified.');
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
    try { fs.unlinkSync(temp); } catch (_) {}
  }
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
  writeConfig(file, { ...value, pin });
  return pin;
}
if (require.main === module) {
  // Fixed native-local command. No PIN, path, or configuration fields accepted.
  try {
    if (process.argv.length !== 3) throw new Error('Invalid invocation.');
    if (process.argv[2] === '--data-path') {
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
      const saved = loadConfig(file);
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
module.exports = { configurationFile, developmentConfigFile, validPin, generatePin, readConfig, writeConfig, loadConfig, dataDirectory, regeneratePin, desktopTrust, verifyPin, validateConfig };
