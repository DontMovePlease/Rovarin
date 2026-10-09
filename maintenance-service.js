'use strict';

const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');

const ALLOWED_ACTIONS = Object.freeze([
  'windows_repair',
  'sfc_scan',
  'dism_check',
  'reset_network',
  'clear_dns'
]);

function createAdapter(options = {}, localLifecycle = false) {
  const platform = options.platform || process.platform;
  const runExec = options.execFile || execFile;
  const runSpawn = options.spawn || spawn;
  const inspect = options.lstatSync || fs.lstatSync;
  const helper = path.join(options.programFiles || process.env.ProgramFiles || 'C:\\Program Files',
    'RovarinMaintenance', 'RovarinMaintenanceService.exe');
  let busy = false;
  let cachedStatus = null;
  let cacheExpiry = 0;

  function invalidateCache() {
    cachedStatus = null;
    cacheExpiry = 0;
  }

  async function request(action) {
    if (!['status', 'revoke', ...(localLifecycle ? ['request-enrollment', 'request-provision', 'request-removal'] : [])].includes(action)) {
      throw new Error('Unsupported foundation operation');
    }
    if (platform !== 'win32') return { state: 'unsupported', enabled: false };
    if (busy) return { state: 'busy', enabled: false };
    if (action === 'status' && cachedStatus && Date.now() < cacheExpiry) {
      return cachedStatus;
    }
    try {
      const entry = inspect(helper);
      if (!entry.isFile() || entry.isSymbolicLink()) return { state: 'unsafe-deployment', enabled: false };
    } catch (error) {
      return { state: error.code === 'ENOENT' ? 'not-installed' : 'unavailable', enabled: false };
    }
    busy = true;
    try {
      const result = await new Promise(resolve => runExec(helper, ['--' + action], {
        windowsHide: true, timeout: action.startsWith('request-') ? 120000 : 6000, maxBuffer: 1024, encoding: 'utf8', shell: false
      }, (error, stdout) => {
        // Do not expose stderr, identity, policy contents or filesystem paths.
        const state = String(stdout || '').trim();
        if (['uac-cancelled', 'unauthorized', 'owner-conflict', 'provisioning-incomplete'].includes(state)) return resolve({ state, enabled: false });
        if (error) return resolve({ state: 'unavailable', enabled: false });
        if (state !== 'enabled' && state !== 'disabled' && !(action === 'request-removal' && state === 'removed')) return resolve({ state: 'protocol-error', enabled: false });
        // A revoke response can never report success while still enabled.
        if (action === 'revoke' && state !== 'disabled') return resolve({ state: 'revocation-unconfirmed', enabled: false });
        resolve({ state, enabled: state === 'enabled' });
      }));
      if (['enabled', 'disabled'].includes(result.state)) {
        cachedStatus = result;
        cacheExpiry = Date.now() + 3000;
      } else {
        invalidateCache();
      }
      if (action !== 'status') {
        invalidateCache();
      }
      return result;
    } finally { busy = false; }
  }

  function runServiceAction(action) {
    if (!ALLOWED_ACTIONS.includes(action)) throw new Error('Unsupported maintenance action');
    if (platform !== 'win32') throw new Error('Maintenance service is only supported on Windows');
    const entry = inspect(helper);
    if (!entry.isFile() || entry.isSymbolicLink()) throw new Error('Unsafe maintenance service deployment');
    return runSpawn(helper, ['--run', action], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false
    });
  }

  return Object.freeze({
    status: () => request('status'),
    revoke: () => request('revoke'),
    run: (action) => runServiceAction(action),
    invalidateCache,
    ...(localLifecycle ? {
      enroll: () => request('request-enrollment'),
      provision: () => request('request-provision'),
      remove: () => request('request-removal')
    } : {})
  });
}

function createClient(options = {}) { return createAdapter(options, false); }
// Internal local host composition only. No HTTP route or browser/native message exposes these methods.
function createLocalLifecycleClient(options = {}) { return createAdapter(options, true); }

module.exports = {
  ALLOWED_ACTIONS,
  createClient,
  createLocalLifecycleClient
};