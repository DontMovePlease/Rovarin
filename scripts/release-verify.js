'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const SUITES = ['test:security', 'test:gpu', 'test:maintenance', 'test:temperature', 'test:processes', 'test:kill', 'test:dev-watcher', 'test:packaging'];
const TEST_FILES = ['security-smoke-test.js', 'gpu-degradation-smoke-test.js', 'maintenance-smoke-test.js', 'temperature-manager-smoke-test.js', 'process-stats-smoke-test.js', 'process-kill-smoke-test.js', 'dev-watcher-smoke-test.js', 'packaging-smoke-test.js'];
const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: 'inherit' });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error('Verification failed; publish was not changed.')));
  });
}
function assertPlain(directory) {
  let cursor = path.resolve(directory);
  while (cursor !== path.dirname(cursor)) {
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Publish path redirects; refusing promotion.');
    cursor = path.dirname(cursor);
  }
}
async function verifyAndPublish(repo, runner = run, outputRepo = repo) {
  repo = path.resolve(repo);
  // Developer-only RC staging may differ; source verification still uses repo.
  // The user-facing outputs always live in the explicitly selected project.
  outputRepo = path.resolve(outputRepo);
  assertPlain(outputRepo);
  if (!fs.statSync(outputRepo).isDirectory()) throw new Error("Release output project is not a directory.");
  const exe = path.join(repo, 'dist/RovarinSetup.exe');
  assertPlain(exe);
  const hash = digest(exe);
  const manifestPath = path.join(repo, 'packaging/payload-manifest.json');
  const manifestHash = digest(manifestPath);
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  const build = JSON.parse(fs.readFileSync(path.join(repo, 'dist/build.json')));
  if (build.sha256 !== hash || build.payloadManifestSha256 !== manifestHash) throw new Error('Build receipt mismatch; rebuild before publishing.');
  // Do not certify an old payload while testing newly edited source files.
  function checkSource() {
    if (digest(exe) !== hash || digest(manifestPath) !== manifestHash) throw new Error('Build changed during verification; publish was not changed.');
    for (const input of build.inputs) {
      if (!['packaging/build.ps1','packaging/Rovarin.iss','packaging/RovarinLauncher.cs','packaging/DesktopShell.cs','packaging/desktop.manifest','packaging/create-icon.ps1'].includes(input.path) || digest(path.join(repo,input.path)) !== input.sha256) throw new Error('Installer source changed; rebuild before publishing.');
    }
    for (const entry of manifest.files) {
      if (digest(path.join(repo, 'packaging/payload', entry.path)) !== entry.sha256) throw new Error('Payload changed; rebuild before publishing.');
      if (!entry.path.startsWith('app/')) continue;
      const relative = entry.path.slice(4);
      const source = path.join(repo, ['desktop.vbs','startup.vbs','startup-disable.vbs'].includes(relative) ? 'packaging' : '', relative);
      if (fs.existsSync(source) && digest(source) !== entry.sha256) throw new Error('Source differs from payload; rebuild before publishing.');
    }
  }
  checkSource();
  for (const file of TEST_FILES) await runner(process.execPath, [path.join(repo, 'scripts', file)], repo);
  await runner(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe'), ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(repo,'scripts/installer-integration-test.ps1')], repo);
  checkSource();
  const publish = path.join(outputRepo, 'publish');
  assertPlain(publish);
  const allowed = ['RovarinSetup.exe','RovarinSetup.sha256','release.json'];
  // Previous verified product bytes are retired only AFTER the new gate passes.
  const previousAllowed = [...allowed, 'PCMonitorSetup.exe', 'PCMonitorSetup.sha256'];
  if (fs.existsSync(publish) && fs.readdirSync(publish).some(name => !previousAllowed.includes(name) || !fs.lstatSync(path.join(publish,name)).isFile() || fs.lstatSync(path.join(publish,name)).isSymbolicLink())) throw new Error('Publish contains unrelated files; refusing replacement.');
  const suffix = crypto.randomBytes(8).toString('hex');
  const staging = path.join(outputRepo, 'publish-staging-' + suffix);
  const previous = path.join(outputRepo, 'publish-previous-' + suffix);
  fs.mkdirSync(staging);
  const cleanup = directory => {
    assertPlain(directory);
    if (!fs.existsSync(directory)) return;
    for (const name of fs.readdirSync(directory)) {
      if (!(directory === previous ? previousAllowed : allowed).includes(name)) throw new Error('Unexpected promotion file.');
      fs.unlinkSync(path.join(directory,name));
    }
    fs.rmdirSync(directory);
  };
  try {
    fs.copyFileSync(exe, path.join(staging, allowed[0]));
    if (digest(path.join(staging, allowed[0])) !== hash) throw new Error('Copy mismatch; publish was not changed.');
    fs.writeFileSync(path.join(staging, allowed[1]), `${hash}  RovarinSetup.exe\n`);
    const version = JSON.parse(fs.readFileSync(path.join(repo,'package.json'))).version;
    fs.writeFileSync(path.join(staging, allowed[2]), JSON.stringify({ version, builtAt: build.builtAt, verifiedAt: new Date().toISOString(), sha256: hash, payloadManifestSha256: manifestHash, signing: 'unsigned', suites: [...SUITES, 'installer-integration'] }, null, 2) + '\n');
    checkSource();
    if (fs.existsSync(publish)) fs.renameSync(publish, previous);
    try { fs.renameSync(staging, publish); }
    catch (error) { if (fs.existsSync(previous)) fs.renameSync(previous, publish); throw error; }
    cleanup(previous);
    if (digest(path.join(publish,allowed[0])) !== digest(exe)) throw new Error('Published artifact mismatch.');
    console.log('PASS verified release promoted; dist and publish SHA-256: ' + hash);
    return hash;
  } finally { cleanup(staging); }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--publish-root' || !args[1])) {
    console.error('Usage: release-verify.js [--publish-root <project directory>]'); process.exitCode = 1;
  } else verifyAndPublish(path.resolve(__dirname, '..'), run, args[1]).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { verifyAndPublish, digest, SUITES };
