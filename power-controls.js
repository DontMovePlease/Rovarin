'use strict';
const path = require('path');
const { spawn } = require('child_process');
const ACTIONS = Object.freeze(['sleep', 'restart', 'shutdown']);
class PowerControls {
  constructor(options = {}) {
    this.spawn = options.spawn || spawn;
    this.platform = options.platform || process.platform;
    this.now = options.now || Date.now;
    this.schedule = options.schedule || setTimeout; this.clear = options.clear || clearTimeout;
    this.jobs = new Map(); this.current = null;
  }
  status() {
    return { available: this.platform === 'win32', busy: !!this.current && this.current.until > this.now(), operation: this.current ? { ...this.current.public } : null };
  }
  async prepare(action, requestId, sessionId) {
    if (!ACTIONS.includes(action) || !/^[a-f0-9-]{36}$/i.test(requestId)) throw Object.assign(Error('Invalid power request.'), { code: 'invalid-request' });
    const key = sessionId + ':' + requestId, old = this.jobs.get(key);
    if (old) {
      if (old.public.action !== action) throw Object.assign(Error('Request already belongs to another action.'), { code: 'request-conflict' });
      return { job: old, duplicate: true };
    }
    if (this.platform !== 'win32') throw Object.assign(Error('Power controls require Windows.'), { code: 'unsupported-platform' });
    if (this.status().busy) throw Object.assign(Error('A power request is already pending. Check its status before trying again.'), { code: 'power-busy' });
    const job = { public: { action, state: 'preparing', code: null, message: 'Preparing Windows power request.' }, until: Infinity, child: null, committed: false };
    this.current = job; this.jobs.set(key, job);
    while (this.jobs.size > 64) this.jobs.delete(this.jobs.keys().next().value);
    const update = (state, code, message) => { job.public = { action, state, code, message }; };
    const fail = (code, message) => { update('failed', code, message); job.until = 0; };
    await new Promise((resolve, reject) => {
      let ready = false, buffer = '', bytes = 0, settled = false;
      const finish = error => { if (settled) return; settled = true; error ? reject(error) : resolve(); };
      const timer = this.schedule(() => { if (job.committed) { update('unconfirmed', 'outcome-unconfirmed', 'Windows did not return a final result. The power request may still be pending.'); job.until = this.now() + 60000; } else fail('helper-timeout', 'Windows power preparation timed out.'); job.child?.kill(); finish(Object.assign(Error(job.public.message), { code: job.public.code })); }, 30000);
      timer.unref?.();
      try {
        const executable = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        job.child = this.spawn(executable, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'scripts', 'power-control.ps1'), '-Action', action], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        job.child.stdout.on('data', chunk => {
          bytes += chunk.length;
          if (bytes > 8192) { fail('invalid-result', 'Windows returned an invalid power result.'); job.child.kill(); return; }
          buffer += chunk.toString();
          let index;
          while ((index = buffer.indexOf('\n')) >= 0) {
            const line = buffer.slice(0, index).trim(); buffer = buffer.slice(index + 1);
            let value; try { value = JSON.parse(line); } catch { continue; }
            if (value.state === 'ready' && !ready && !job.committed) { ready = true; update('awaiting-ack', null, 'Ready. Waiting for the request acknowledgment.'); finish(); }
            else if (value.state === 'failed') { fail(typeof value.code === 'string' ? value.code : 'windows-error', typeof value.message === 'string' ? value.message.slice(0, 300) : 'Windows refused the power request.'); job.public.windowsError = Number.isInteger(value.windowsError) ? value.windowsError : null; finish(Object.assign(Error(job.public.message), { code: job.public.code })); }
            else if (job.committed && value.state === 'invoking') update('pending', null, 'Sending the request to Windows. Remote access may disconnect; completion is not verified.');
            else if (job.committed && value.state === 'initiated') update('initiated', null, 'Windows accepted the request. Unsaved work may require attention on the PC; completion is not verified.');
            else if (job.committed && action === 'sleep' && value.state === 'returned') { update('returned', null, 'Windows returned from the Sleep request. The PC may have resumed; refresh to reconnect.'); job.until = 0; }
          }
        });
        job.child.stderr.on('data', () => {}); // Never expose arbitrary subprocess output.
        job.child.stdin.on('error', () => {});
        job.child.once('error', () => { this.clear(timer); fail('helper-unavailable', 'Windows power controls could not start.'); finish(Object.assign(Error(job.public.message), { code: job.public.code })); });
        job.child.once('close', () => { this.clear(timer); if (!ready) { if (job.public.state !== 'failed') fail('helper-unavailable', 'Windows power preparation did not finish.'); finish(Object.assign(Error(job.public.message), { code: job.public.code })); } else if (!job.committed) { fail('not-executed', 'The power request was not executed.'); } else if (['pending', 'accepted'].includes(job.public.state)) { update('unconfirmed', 'outcome-unconfirmed', 'Windows did not return a final result. Check the PC before retrying.'); job.until = this.now() + 60000; } });
      } catch { this.clear(timer); fail('helper-unavailable', 'Windows power controls could not start.'); finish(Object.assign(Error(job.public.message), { code: job.public.code })); }
    });
    return { job, duplicate: false };
  }
  commit(job, authorized) {
    if (job.committed || job.public.state !== 'awaiting-ack') return false;
    if (!authorized()) { this.abort(job); return false; }
    job.committed = true; job.until = this.now() + 60000;
    job.public.state = 'accepted'; job.public.message = 'Request acknowledged. Waiting for Windows.';
    job.child.stdin.end('execute\n');
    return true;
  }
  abort(job) {
    if (job.committed) return;
    job.public.state = 'failed'; job.public.code = 'not-executed'; job.public.message = 'The request was cancelled before execution.'; job.until = 0;
    job.child?.stdin.end(); job.child?.kill();
  }
}
module.exports = { PowerControls, ACTIONS };
