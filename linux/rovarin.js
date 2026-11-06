'use strict';
// Foreground development CLI. Never accepts a PIN or a config path in argv.
const fs = require('node:fs');
const path = require('node:path');
class SetupError extends Error {}
function outsideRepository(directory, root = path.resolve(__dirname, '..')) {
  // Resolve existing ancestors too, so a symlink cannot redirect storage into
  // the checkout. The auth module separately validates ownership/mode/links.
  function physical(value) {
    let current = path.resolve(value); const tail = [];
    while (!fs.existsSync(current)) {
      const parent = path.dirname(current);
      if (parent === current) throw new SetupError('Cannot resolve credential storage.');
      tail.unshift(path.basename(current)); current = parent;
    }
    return path.join(fs.realpathSync(current), ...tail);
  }
  const relative = path.relative(physical(root), physical(directory));
  if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
    throw new SetupError('Credential storage must be outside the repository.');
  }
}
function hiddenPin(prompt, input = process.stdin, output = process.stdout, signals = process) {
  if (!input.isTTY || !output.isTTY || typeof input.setRawMode !== 'function') {
    return Promise.reject(new SetupError('Setup requires an interactive terminal; redirected input is refused.'));
  }
  return new Promise((resolve, reject) => {
    let pin = '', invalid = false, finished = false;
    const wasRaw = !!input.isRaw, wasPaused = input.isPaused();
    function finish(error) {
      if (finished) return; finished = true;
      input.removeListener('data', data); input.removeListener('end', cancel); input.removeListener('error', cancel);
      signals.removeListener('SIGINT', cancel); signals.removeListener('SIGTERM', cancel);
      try { input.setRawMode(wasRaw); if (wasPaused) input.pause(); }
      catch (_) { error = true; }
      try { output.write('\n'); } catch (_) { error = true; }
      const value = pin; pin = '';
      if (error || invalid) reject(new SetupError(error ? 'Setup cancelled.' : 'Enter only 6, 8 or 12 digits.'));
      else resolve(value);
    }
    function cancel() { finish(true); }
    function data(chunk) {
      for (const byte of chunk) {
        if (byte === 3 || byte === 4) { cancel(); return; }
        if (byte === 13 || byte === 10) { finish(false); return; }
        if (byte === 8 || byte === 127) { pin = pin.slice(0, -1); continue; }
        if (byte >= 48 && byte <= 57 && pin.length < 12) pin += String.fromCharCode(byte);
        else invalid = true;
      }
    }
    input.on('data', data); input.once('end', cancel); input.once('error', cancel);
    signals.once('SIGINT', cancel); signals.once('SIGTERM', cancel);
    try { input.setRawMode(true); output.write(prompt); input.resume(); }
    catch (_) { finish(true); }
  });
}
async function run(args, { platform = process.platform, auth = require('./linux-auth'),
  readPin = hiddenPin, write = line => console.log(line), start = () => require('./server-linux') } = {}) {
  if (platform !== 'linux') throw new SetupError('This command requires Linux.');
  if (args.length !== 1 || !['setup', 'start'].includes(args[0])) throw new SetupError('Usage: node linux/rovarin.js setup|start (no PIN arguments).');
  outsideRepository(auth.configDir());
  const cfg = auth.loadConfig();
  if (args[0] === 'start') {
    if (!cfg.healthy) throw new SetupError(cfg.exists ? 'Saved credentials are unsafe or unreadable. Restore valid storage before starting; no reset was performed.' : 'Run node linux/rovarin.js setup first.');
    write('Starting Rovarin in this terminal. Open the printed address; press Ctrl+C to stop.');
    start(); return;
  }
  if (cfg.exists) throw new SetupError(cfg.healthy ? 'Credentials already exist. Setup will not replace them.' : 'Existing credentials are unsafe or unreadable. Restore valid storage; setup will not replace them.');
  write('Create a 6-digit PIN (8 or 12 digits also supported). Input is hidden.');
  let pin, confirmation;
  try {
    pin = await readPin('New PIN: ');
    if (!auth.validPin(pin)) throw new SetupError('Enter a 6-, 8- or 12-digit PIN.');
    confirmation = await readPin('Confirm PIN: ');
    try { auth.setupPin(pin, confirmation); }
    catch (error) {
      if (error.code === 'invalid-pin') throw new SetupError('PINs must match and contain 6, 8 or 12 digits.');
      if (error.code === 'setup-complete') throw new SetupError('Another setup completed first. Existing credentials were preserved.');
      throw new SetupError('Credential setup failed. Check storage ownership and private permissions; no existing credentials were replaced.');
    }
    if (!auth.loadConfig().healthy) throw new SetupError('Credentials could not be validated. No automatic reset was performed.');
  } finally { pin = confirmation = undefined; }
  write('PIN configured. Run node linux/rovarin.js start.');
}
// The interactive terminal's stdin handle stays referenced after hidden PIN
// prompts, so a finished setup command would otherwise never return to the
// shell. Release it once the standalone command settles, on success and on
// failure. The long-running start command never settles, so its behavior is
// unchanged. No process.exit(): the loop drains naturally and pending output
// still flushes. Method availability is checked, not assumed.
function releaseStdin() {
  if (process.stdin && typeof process.stdin.unref === 'function') process.stdin.unref();
}
if (require.main === module) run(process.argv.slice(2)).then(() => {
  releaseStdin();
}).catch(error => {
  // Do not print arbitrary exception text/stacks that might contain input.
  console.error(error instanceof SetupError ? error.message : 'Rovarin command failed. Use setup once in an interactive terminal, or start with healthy saved credentials. Existing credentials are never reset.');
  releaseStdin();
  process.exitCode = 1;
});
module.exports = { run, hiddenPin, outsideRepository };
