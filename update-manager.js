'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');
const { Transform } = require('stream');
const { readConfig, writeConfig } = require('./pin-manager');
// Change this single default before Beta/V1; HTTP clients cannot set the channel.
const DEFAULT_CHANNEL = 'EXPERIMENTAL';
const RELEASE = Object.freeze({ repository: 'DontMovePlease/Rovarin', endpoint: 'https://api.github.com/repos/DontMovePlease/Rovarin/releases', installer: 'RovarinSetup.exe' });
const DAY = 86400000, MAX_INSTALLER = 300 * 1024 * 1024;
function version(value) {
  const match = typeof value === 'string' && /^v?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(value);
  if (!match) return null;
  const parts = match.slice(1).map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}
function compare(a, b) {
  const left = version(a), right = version(b);
  if (!left || !right) throw new Error('invalid-version');
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  return 0;
}
function assetUrl(tag, name) { return `https://github.com/${RELEASE.repository}/releases/download/${tag}/${name}`; }
function releaseCandidate(release, current, channel = DEFAULT_CHANNEL) {
  if (!release || release.draft !== false || typeof release.prerelease !== 'boolean' || (channel === 'STABLE' && release.prerelease) || !['EXPERIMENTAL','STABLE'].includes(channel) || typeof release.published_at !== 'string' || !Number.isFinite(Date.parse(release.published_at)) || !version(release.tag_name)) return null;
  if (release.html_url !== `https://github.com/${RELEASE.repository}/releases/tag/${release.tag_name}`) return null;
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const matches = assets.filter(asset => asset?.name === RELEASE.installer);
  if (matches.length !== 1) return null;
  const asset = matches[0];
  if (asset.state !== 'uploaded' || !Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > MAX_INSTALLER || asset.browser_download_url !== assetUrl(release.tag_name, RELEASE.installer)) return null;
  const digest = /^sha256:([a-f0-9]{64})$/i.exec(asset.digest || '');
  const checksums = assets.filter(a => a?.name === 'RovarinSetup.sha256' && a.state === 'uploaded' && a.size > 0 && a.size <= 1024 && a.browser_download_url === assetUrl(release.tag_name, 'RovarinSetup.sha256'));
  return { tag: release.tag_name, version: version(release.tag_name).join('.'), newer: compare(release.tag_name, current) > 0,
    url: asset.browser_download_url, size: asset.size, sha256: digest?.[1].toLowerCase() || null,
    checksumUrl: checksums.length === 1 ? checksums[0].browser_download_url : null,
    notes: typeof release.body === 'string' ? release.body.replace(/[\u0000-\u001f]/g, ' ').slice(0, 1000) : '',
    notesUrl: release.html_url };
}
// TLS only, fixed GitHub origins; never forward credentials or use client URLs.
function request(url, signal, redirects = 0) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || !['api.github.com','github.com','release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(parsed.hostname) || redirects > 3) { reject(new Error('unsafe-source')); return; }
    const req = https.get(parsed, { signal, headers: { 'User-Agent': 'Rovarin-Updater', Accept: 'application/vnd.github+json', 'Accept-Encoding': 'identity' } }, res => {
      if ([301,302,303,307,308].includes(res.statusCode)) {
        res.resume();
        try { resolve(request(new URL(res.headers.location, parsed).href, signal, redirects + 1)); } catch (_) { reject(new Error('unsafe-source')); }
      } else if (res.statusCode === 404) { res.resume(); reject(new Error('no-full-release')); }
      else if (res.statusCode !== 200) { res.resume(); reject(new Error('github-unavailable')); }
      else resolve(res);
    });
    req.setTimeout(15000, () => req.destroy(new Error('network-timeout')));
    req.once('error', reject);
  });
}
async function boundedText(url, limit, signal, transport = request) {
  const response = await transport(url, signal);
  const chunks = []; let size = 0;
  for await (const chunk of response) { size += chunk.length; if (size > limit) { response.destroy(); throw new Error('response-too-large'); } chunks.push(chunk); }
  return Buffer.concat(chunks).toString('utf8');
}
function plain(target) {
  let cursor = path.resolve(target);
  for (;;) {
    if (fs.existsSync(cursor)) { const stat = fs.lstatSync(cursor); if (stat.isSymbolicLink() || (stat.isFile() && stat.nlink !== 1) || fs.realpathSync(cursor).toLowerCase() !== cursor.toLowerCase()) throw new Error('unsafe-update-path'); }
    const parent = path.dirname(cursor); if (parent === cursor) break; cursor = parent;
  }
}
class UpdateManager {
  constructor({ root = __dirname, configFile, transport = request, channel = DEFAULT_CHANNEL, current = require('./package.json').version } = {}) {
    this.root = root; this.configFile = configFile; this.transport = transport; this.current = current;
    if (!['EXPERIMENTAL','STABLE'].includes(channel)) throw new Error('invalid-channel');
    this.channel = channel;
    this.directory = path.join(root, '..', 'updates'); this.busy = false; this.state = 'not-checked'; this.candidate = null; this.message = 'Check for a newer verified release.';
  }
  installed() {
    try { const marker = JSON.parse(fs.readFileSync(path.join(this.root,'installation.json'))); return process.platform === 'win32' && marker.schema === 1 && marker.channel === 'windows-x64' && path.resolve(process.execPath).toLowerCase() === path.resolve(this.root,'../runtime/node.exe').toLowerCase(); } catch (_) { return false; }
  }
  status() {
    if (this.state === 'handoff') {
      try {
        const file = path.join(this.directory,'handoff.json'); plain(file);
        const result = JSON.parse(fs.readFileSync(file));
        if (['cancelled','failed','complete'].includes(result.phase)) {
          this.busy = false; this.state = result.phase === 'failed' ? 'failed' : 'ready';
          this.message = result.phase === 'failed' ? 'Installer handoff failed; your current version remains available.' : 'Installer finished. Check for updates when ready.';
        }
      } catch (_) {}
    }
    const config = readConfig(this.configFile);
    return { channel: this.channel, currentVersion: this.current, latestVersion: this.candidate?.version || null, state: this.state, message: this.message,
      available: !!this.candidate?.newer && !!this.candidate?.sha256, installed: this.installed(), busy: this.busy,
      autoCheck: config.autoCheckUpdates !== false, lastChecked: config.updateLastChecked || null,
      releaseNotes: this.candidate?.notes || '', releaseUrl: this.candidate?.notesUrl || null };
  }
  reserve() {
    if (this.busy || this.state !== 'ready' || !this.installed()) throw new Error('handoff-unavailable');
    const result = path.join(this.directory,'handoff.json'); plain(result);
    try { fs.unlinkSync(result); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    this.busy = true; this.state = 'handoff'; this.message = 'Opening the verified Windows installer…';
    return this.status();
  }
  cancel() {
    if (this.state === 'handoff') { this.busy = false; this.state = 'ready'; this.message = 'Installer launch was not confirmed; your current version is still available.'; }
    return this.status();
  }
  preference() { const saved = readConfig(this.configFile); writeConfig(this.configFile, { ...saved, autoCheckUpdates: saved.autoCheckUpdates === false }); return this.status(); }
  async check(automatic = false) {
    this.status(); // Observe an installer cancellation before deciding whether the operation is busy.
    if (this.busy) return this.status();
    const saved = readConfig(this.configFile);
    if (automatic && (saved.autoCheckUpdates === false || Date.now() - (saved.updateLastChecked || 0) < DAY)) return this.status();
    this.busy = true; this.state = 'checking'; this.message = 'Checking official GitHub releases…';
    try {
      writeConfig(this.configFile, { ...saved, updateLastChecked: Date.now() });
      const signal = AbortSignal.timeout(20000);
      const releases = [];
      // Bound both API history and metadata; fail closed if pagination is incomplete.
      for (let page = 1; page <= 3; page++) {
        const batch = JSON.parse(await boundedText(RELEASE.endpoint + '?per_page=100&page=' + page, 2 * 1024 * 1024, signal, this.transport));
        if (!Array.isArray(batch) || batch.length > 100) throw new Error('invalid-release-list');
        releases.push(...batch);
        if (batch.length < 100) break;
        if (page === 3) throw new Error('release-history-too-large');
      }
      const candidates = releases.map(release => releaseCandidate(release, this.current, this.channel)).filter(Boolean)
        .sort((a,b) => compare(b.version,a.version) || a.tag.localeCompare(b.tag));
      let candidate = null;
      for (const item of candidates) {
        if (!item.sha256 && item.checksumUrl) {
          try {
            const text = await boundedText(item.checksumUrl, 1024, signal, this.transport);
            const checksum = /^([a-f0-9]{64})[ \t]+\*?RovarinSetup\.exe\s*$/i.exec(text);
            if (checksum) item.sha256 = checksum[1].toLowerCase();
          } catch (_) { if (signal.aborted) throw new Error('check-timeout'); }
        }
        if (item.sha256) { candidate = item; break; }
      }
      this.candidate = candidate;
      this.state = candidate?.newer ? 'available' : 'current';
      this.message = candidate?.newer ? `Rovarin ${candidate.version} is available.` : 'No newer verified release is available in the ' + this.channel.toLowerCase() + ' channel.';
    } catch (error) {
      this.candidate = null; this.state = error.message === 'no-full-release' ? 'current' : 'failed';
      this.message = error.message === 'no-full-release' ? 'No published verified release is available for this channel.' : 'Could not verify the latest release. Your installed version is unchanged; try again later.';
    } finally { this.busy = false; }
    return this.status();
  }
  async download() {
    if (this.busy) throw new Error('update-busy');
    if (!this.installed()) throw new Error('installed-only');
    // Re-fetch the canonical release/digest; cached UI state never authorizes execution.
    await this.check();
    if (!this.candidate?.newer || !this.candidate.sha256 || this.state !== 'available') throw new Error('no-verified-update');
    if (this.busy) throw new Error('update-busy');
    this.busy = true;
    const candidate = { ...this.candidate }, partial = path.join(this.directory,'RovarinSetup.partial'), installer = path.join(this.directory,RELEASE.installer), metadata = path.join(this.directory,'verified.json');
    try {
      plain(this.directory); fs.mkdirSync(this.directory, { recursive: true });
      for (const file of [partial, installer, metadata]) { plain(file); try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; } }
      this.state = 'downloading'; this.message = 'Downloading the verified release…';
      const signal = AbortSignal.timeout(180000), response = await this.transport(candidate.url, signal);
      const hash = crypto.createHash('sha256'); let size = 0;
      const counter = new Transform({ transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > candidate.size || size > MAX_INSTALLER) { callback(new Error('download-too-large')); return; }
        hash.update(chunk); callback(null, chunk);
      } });
      await pipeline(response, counter, fs.createWriteStream(partial, { flags: 'wx', mode: 0o600 }), { signal });
      this.state = 'verifying'; this.message = 'Verifying the installer…';
      if (size !== candidate.size || hash.digest('hex') !== candidate.sha256) throw new Error('checksum-mismatch');
      plain(partial); fs.renameSync(partial, installer);
      fs.writeFileSync(metadata, JSON.stringify({ schema: 1, repository: RELEASE.repository, filename: RELEASE.installer, version: candidate.version, sha256: candidate.sha256, size: candidate.size }), { flag: 'wx', mode: 0o600 });
      this.state = 'ready'; this.message = 'Verified and ready for the Windows installer.';
    } catch (_) {
      for (const file of [partial,installer,metadata]) { try { plain(file); fs.unlinkSync(file); } catch (_) {} }
      this.state = 'failed'; this.message = 'Download or verification failed. No installer was launched; Rovarin is unchanged.';
      throw new Error('download-failed');
    } finally { this.busy = false; }
    return this.status();
  }
}
module.exports = { UpdateManager, DEFAULT_CHANNEL, RELEASE, version, compare, releaseCandidate, request, boundedText, plain };