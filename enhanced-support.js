'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const PAWNIO_VERSION = '2.2.0.0';
const PAWNIO_SHA256 = '1f519a22e47187f70a1379a48ca604981c4fcf694f4e65b734aaa74a9fba3032';
function isLocalDesktopRequest(req) {
  const address = String(req.socket.remoteAddress || '').replace(/^::ffff:/, '');
  if (!['127.0.0.1', '::1'].includes(address)) return false;
  try { return ['127.0.0.1', '[::1]', 'localhost'].includes(new URL('http://' + req.headers.host).hostname); }
  catch (_) { return false; }
}
function installationResult(code, failureCode) {
  const failures = {'package-invalid':'Enhanced installer signature, hash or version verification failed.', 'package-unavailable':'The trusted Enhanced installer is unavailable.', 'launch-failed':'The trusted Enhanced installer could not launch.'};
  if (code === -1 && Object.hasOwn(failures,failureCode)) return {success:false,code:failureCode,error:failures[failureCode]+' Rovarin remains usable.'};
  return code === 0 ? { success: true, code: 'installed', rebootRequired: false, message:failureCode === 'already-installed' ? 'Verified Enhanced hardware support is already installed. CPU sensor availability is checked separately.' : 'Enhanced hardware support installer completed. CPU sensor availability is checked separately.' }
    : [3010, 1641].includes(code) ? { success: true, code: 'reboot-required', rebootRequired: true, message:'Enhanced hardware support was installed. Restart Windows to finish setup.' }
    : code === 1460 ? { success: false, code: 'install-unconfirmed', error: 'Installation result is unconfirmed. Check Windows; restart Windows before retrying.' }
    : [1223, 1602].includes(code) ? { success: false, code: 'cancelled', error: 'Installation was cancelled. Rovarin remains usable.' }
    : { success: false, code: 'install-failed', error: 'Enhanced support could not be installed. Rovarin remains usable.' };
}
class EnhancedSupport {
  constructor({ root = __dirname, stateDirectory = root, execute = execFile } = {}) {
    this.root = root; this.stateDirectory = stateDirectory; this.execute = execute; this.inFlight = null; this.uncertain = false;
    this.file = path.join(root, 'vendor', 'PawnIO', '2.2.0', 'PawnIO_setup.exe');
    this.driver = null; this.driverCheckedAt = 0; this.driverProbe = null; this.driverEpoch = 0;
  }
  status(observation = null) {
    let result = null;
    try {
      const saved = JSON.parse(fs.readFileSync(path.join(this.stateDirectory, 'enhanced-install.json'), 'utf8'));
      if (Number.isInteger(saved.exitCode)) result = installationResult(saved.exitCode,saved.failureCode);
      if (result?.rebootRequired && Date.now() - require('os').uptime() * 1000 > saved.completedAt + 5000) result = installationResult(0);
      if (result?.code === 'install-unconfirmed' && Date.now() - require('os').uptime() * 1000 > saved.completedAt + 5000) result = null;
    } catch (_) {}
    const driverInstalled = typeof this.driver?.pawnIoInstalled === 'boolean' ? this.driver.pawnIoInstalled : typeof observation?.pawnIoInstalled === 'boolean' ? observation.pawnIoInstalled : null;
    const sensor = observation?.status === 'available' ? 'available' : observation?.status === 'failed' ? 'failed' : observation ? 'unavailable' : 'not-sampled';
    const note = result?.rebootRequired ? result.message : result && !result.success ? result.error
      : sensor === 'available' ? 'Enhanced CPU temperature sensor is available.'
      : driverInstalled && ['no-sensors','unsupported-cpu'].includes(observation?.code) ? 'Enhanced hardware support is installed, but no supported CPU temperature sensor was detected on this system.'
      : sensor === 'failed' ? (observation.note || 'The CPU temperature provider failed. Hardware support installation and sensor access are separate.')
      : driverInstalled ? 'Enhanced hardware support is installed. CPU sensor access is checked only with active monitoring; permissions may be required.'
      : driverInstalled === false ? 'Enhanced hardware support is not installed. Rovarin remains usable without CPU temperature.'
      : result?.message || 'Enhanced driver status has not been confirmed.';
    return { bundled: fs.existsSync(this.file), version: PAWNIO_VERSION, installing: !!this.inFlight || this.uncertain || result?.code === 'install-unconfirmed', result, driverInstalled, driverStatus:this.driver?.status || 'unavailable', sensor, note };
  }
  detectDriver() {
    if(this.driverProbe)return this.driverProbe;
    if(this.driver && Date.now()-this.driverCheckedAt<30000)return Promise.resolve(this.driver);
    const epoch=this.driverEpoch;
    this.driverProbe = new Promise(resolve=>{
      const done=(error,output)=>{
        let data;try{data=JSON.parse(output);}catch(_){}
        const result = !error && typeof data?.pawnIoInstalled==='boolean' ? {status:'supported',pawnIoInstalled:data.pawnIoInstalled} : {status:error?.code==='ENOENT'?'unavailable':'failed',pawnIoInstalled:null};
        if(epoch===this.driverEpoch){this.driver=result;this.driverCheckedAt=Date.now();}resolve(result);
      };
      try{this.execute(path.join(process.env.SystemRoot || 'C:\\Windows','System32','WindowsPowerShell','v1.0','powershell.exe'), ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(this.root,'scripts','cpu-temperature-provider.ps1'),'-Mode','enhanced','-StatusOnly'], {windowsHide:true,timeout:10000,maxBuffer:16384,encoding:'utf8'},done);}catch(error){done(error,'');}
    }).finally(()=>{this.driverProbe=null;});
    return this.driverProbe;
  }
  install() {
    if (this.status().installing) return Promise.resolve({ success: false, code: 'install-in-progress', error: 'An installation is already running or its result is unconfirmed.' });
    // No client value participates in the executable, path, or argument list.
    this.inFlight = (async () => {
      try {
        const hash = crypto.createHash('sha256').update(await fs.promises.readFile(this.file)).digest('hex');
        if (hash !== PAWNIO_SHA256) return { success: false, code: 'package-invalid', error: 'Bundled Enhanced support failed verification.' };
      } catch (_) { return { success: false, code: 'package-unavailable', error: 'Install Enhanced support using the Rovarin Windows installer.' }; }
      return new Promise(resolve => {
        try { this.execute(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(this.root, 'scripts', 'install-enhanced.ps1')],
          { windowsHide: true, timeout: 300000, maxBuffer: 16384, encoding: 'utf8' }, (error, output) => {
            if (error) { this.uncertain = !!error.killed; resolve(this.uncertain ? installationResult(1460) : { success:false,code:error.code==='ENOENT'?'tool-unavailable':'launch-failed',error:'The local Enhanced installation helper failed to launch or run. Rovarin remains usable.' }); return; }
            try { const data = JSON.parse(output); this.uncertain = !Number.isInteger(data.exitCode); this.driverEpoch++; this.driver=null; this.driverCheckedAt=0; resolve(Number.isInteger(data.exitCode) ? installationResult(data.exitCode,data.failureCode) : installationResult(1460)); }
            catch (_) { this.uncertain = true; resolve({ success: false, code: 'install-unconfirmed', error: 'Installation result could not be confirmed.' }); }
          }); }
        catch (_) { resolve({ success: false, code: 'install-failed', error: 'Could not launch the Enhanced installer.' }); }
      });
    })().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
}
module.exports = { EnhancedSupport, isLocalDesktopRequest, installationResult, PAWNIO_VERSION, PAWNIO_SHA256 };
