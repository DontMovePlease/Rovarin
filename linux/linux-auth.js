'use strict';
// Linux PIN auth for the Rovarin Linux prototype.
// Deliberately NOT the Windows scheme: there is no DPAPI on Linux, so there is
// no recovery material and no native-desktop trust. Credentials are a single
// scrypt hash file, scheme "scrypt-linux-v1", stored 0600 under
// ~/.config/rovarin-linux/config.json (or $ROVARIN_LINUX_CONFIG_DIR for tests).
// Rules carried over from Windows pin-manager.js / AGENTS.md:
//  - PINs are 6, 8 or 12 digits, verified with scrypt + timingSafeEqual.
//  - Server startup NEVER creates or replaces credentials; only the explicit
//    local-only first-run setup may write them. Missing/corrupt config fails
//    closed (login 503), never regenerates, never falls back.
//  - Per-IP lockout: 5 failures -> 60 s lock (429). Sessions are random
//    HttpOnly cookies held in server memory only; a restart requires login.
//  - No PIN in URLs, arguments, logs, or responses. No PIN-reveal endpoint.
//  - Setup is loopback-only and only while no config file exists at all.
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const AUTH_COOKIE = 'rovarin_linux_session';
const SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000; // same as Windows
const MAX_SESSIONS = 64;
const LOGIN_FAILURE_LIMIT = 5;
const LOGIN_LOCK_MS = 60 * 1000;
const PIN_PATTERN = /^(?:\d{6}|\d{8}|\d{12})$/;

function configDir() {
  return process.env.ROVARIN_LINUX_CONFIG_DIR
    || path.join(os.homedir(), '.config', 'rovarin-linux');
}

function configFile() {
  return path.join(configDir(), 'config.json');
}

function validPin(pin) {
  return typeof pin === 'string' && PIN_PATTERN.test(pin);
}

function validCredential(c) {
  return c && typeof c === 'object' && !Array.isArray(c)
    && c.scheme === 'scrypt-linux-v1'
    && [6, 8, 12].includes(c.length)
    && typeof c.salt === 'string' && /^[a-f0-9]{32}$/.test(c.salt)
    && typeof c.hash === 'string' && /^[a-f0-9]{64}$/.test(c.hash);
}

// Returns { exists, healthy, credential|null }. Corrupt/unreadable => healthy
// false. Callers fail closed on !healthy; they never write a replacement.
function assertPrivateDirectory() {
  const dir = configDir();
  const stat = fs.lstatSync(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()
      || fs.realpathSync(dir) !== path.resolve(dir)
      || (process.platform === 'linux' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
    throw new Error('Unsafe credential directory.');
  }
}
function credentialKey(credential) {
  return crypto.createHash('sha256').update(JSON.stringify(credential)).digest('hex');
}
function loadConfig() {
  let raw;
  let fd;
  try {
    // lstat distinguishes a missing file from a dangling symlink.
    const entry = fs.lstatSync(configFile());
    assertPrivateDirectory();
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe credential file.');
    fd = fs.openSync(configFile(), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16384
        || stat.dev !== entry.dev || stat.ino !== entry.ino
        || (process.platform === 'linux' && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) {
      throw new Error('Unsafe credential file.');
    }
    raw = fs.readFileSync(fd, 'utf8');
  }
  catch (err) {
    if (err.code === 'ENOENT') return { exists: false, healthy: false, credential: null };
    return { exists: true, healthy: false, credential: null };
  }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || !validCredential(parsed.pinCredential)) {
      return { exists: true, healthy: false, credential: null };
    }
    return { exists: true, healthy: true, credential: parsed.pinCredential };
  } catch (_) {
    return { exists: true, healthy: false, credential: null };
  }
}

function verifyPin(candidate, credential) {
  if (!validPin(candidate) || !credential) return false;
  if (candidate.length !== credential.length) return false;
  const derived = crypto.scryptSync(candidate, Buffer.from(credential.salt, 'hex'), 32);
  return crypto.timingSafeEqual(derived, Buffer.from(credential.hash, 'hex'));
}

// First-run setup only. Throws { code } on refusal. Refuses when any config
// file already exists (even a corrupt one — operator must remove it by hand);
// refuses mismatched/weak PINs. Writes atomically with 0600 permissions.
function setupPin(pin, confirmPin) {
  if (loadConfig().exists) {
    throw Object.assign(new Error('PIN setup is already complete.'), { code: 'setup-complete' });
  }
  if (!validPin(pin) || pin !== confirmPin) {
    throw Object.assign(new Error('Enter a 6-, 8- or 12-digit PIN twice.'), { code: 'invalid-pin' });
  }
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(pin, Buffer.from(salt, 'hex'), 32).toString('hex');
  const payload = { pinCredential: { scheme: 'scrypt-linux-v1', length: pin.length, salt, hash } };
  const dir = configDir();
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  assertPrivateDirectory();
  const tmp = path.join(dir, '.config-' + crypto.randomBytes(16).toString('hex') + '.tmp');
  try {
    fs.writeFileSync(tmp, JSON.stringify(payload) + '\n', { mode: 0o600, flag: 'wx' });
    // link is atomic and refuses an existing destination, unlike rename.
    fs.linkSync(tmp, configFile());
  } catch (err) {
    if (err.code === 'EEXIST') throw Object.assign(new Error('PIN setup is already complete.'), { code: 'setup-complete' });
    throw new Error('Credential setup could not be completed safely.');
  } finally { try { fs.unlinkSync(tmp); } catch (_) {} }
  return { success: true, length: pin.length };
}

// --- Sessions (in-memory only) ---
const sessions = new Map();
function issueSession() {
  const cfg = loadConfig();
  if (!cfg.healthy) return null;
  for (const [token, s] of sessions) if (s.expiresAt <= Date.now()) sessions.delete(token);
  if (sessions.size >= MAX_SESSIONS) return null;
  const token = crypto.randomBytes(32).toString('base64url');
  const session = { credentialKey: credentialKey(cfg.credential), id: crypto.randomBytes(16).toString('hex'), expiresAt: Date.now() + SESSION_TTL_MS };
  sessions.set(token, session);
  return { token, session };
}
function getSession(req) {
  const cookie = String(req.headers.cookie || '');
  const m = cookie.match(new RegExp('(?:^|;\\s*)' + AUTH_COOKIE + '=([^;]+)'));
  if (!m) return null;
  const session = sessions.get(m[1]);
  if (!session) return null;
  const cfg = loadConfig();
  if (session.expiresAt <= Date.now() || !cfg.healthy || session.credentialKey !== credentialKey(cfg.credential)) { sessions.delete(m[1]); return null; }
  return { token: m[1], ...session };
}
function isSessionActive(id) {
  const cfg = loadConfig();
  const key = cfg.healthy ? credentialKey(cfg.credential) : null;
  for (const [token, session] of sessions) {
    if (session.expiresAt <= Date.now() || session.credentialKey !== key) { sessions.delete(token); continue; }
    if (session.id === id) return true;
  }
  return false;
}
function revokeSession(token) { sessions.delete(token); }
function sessionCookie(token, maxAgeSeconds) {
  return `${AUTH_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSeconds}`;
}
function clearSessionCookie() {
  return `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

// --- Per-IP login lockout ---
const loginAttempts = new Map();
const MAX_TRACKED_IPS = 1000; // bound the map: one entry per distinct failing IP, oldest evicted when full
function loginRateState(ip) {
  const key = String(ip || 'unknown');
  let state = loginAttempts.get(key);
  if (!state) {
    if (loginAttempts.size >= MAX_TRACKED_IPS) loginAttempts.delete(loginAttempts.keys().next().value);
    state = { failures: 0, lockedUntil: 0 }; loginAttempts.set(key, state);
  }
  return { key, state, now: Date.now() };
}
function recordLoginFailure(ip) {
  const { state } = loginRateState(ip);
  state.failures += 1;
  if (state.failures >= LOGIN_FAILURE_LIMIT) state.lockedUntil = Date.now() + LOGIN_LOCK_MS;
  return state;
}
function clearLoginFailures(ip) { loginAttempts.delete(String(ip || 'unknown')); }

module.exports = {
  AUTH_COOKIE, SESSION_TTL_MS, MAX_SESSIONS, LOGIN_FAILURE_LIMIT, LOGIN_LOCK_MS,
  configDir, configFile, validPin, loadConfig, verifyPin, setupPin,
  issueSession, getSession, isSessionActive, revokeSession, sessionCookie, clearSessionCookie,
  loginRateState, recordLoginFailure, clearLoginFailures
};
