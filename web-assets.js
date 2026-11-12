'use strict';

// Shared frontend inventory. Authentication-specific exposure stays in each server.
const PUBLIC_FILES = Object.freeze([
  'rovarin-icon.png', 'rovarin-touch.png', 'liquid-bootstrap.js', 'liquid-glass.css',
  'liquid-glass.js', 'liquid-shaders.js', 'three-glass.module.js', 'power.js',
  'power.css', 'index.html', 'login.html', 'app.css', 'maintenance.css',
  'processes.css', 'desktop.css', 'app.js', 'maintenance.js', 'processes.js',
  'pin-lifecycle.js', 'pin-lifecycle.css', 'login.js', 'diagnostics.js',
  'diagnostics.css', 'enhanced-support.js', 'uninstall.js', 'apps.js', 'apps.css',
  'app-leftovers.js'
]);
const publicFiles = new Set(PUBLIC_FILES);
const PACKAGED_PUBLIC_FILES = Object.freeze([...PUBLIC_FILES, 'three-LICENSE.txt', 'three-glass.NOTICE.txt']);

function versionAssets(html, revision) {
  if (!/^[a-f0-9]{64}$/.test(revision)) throw new Error('Invalid frontend revision');
  return html.replace(/(href|src)="\/([a-z-]+\.(?:css|js))(?:\?[^" ]*)?"/g,
    (match, attribute, asset) => publicFiles.has(asset) ? `${attribute}="/${asset}?v=${revision}"` : match);
}

// Only non-secret presentation metadata crosses this boundary. Credential
// selection, setup authorization and route/session behavior remain platform-local.
function renderLogin(html, { pinMode, pinSetup = false }) {
  if (!/^(?:manual|6|8|12)$/.test(String(pinMode)) || typeof pinSetup !== 'boolean') throw new Error('Invalid login presentation');
  for (const [name, value] of [['rovarin-pin-setup', String(pinSetup)], ['rovarin-pin-mode', String(pinMode)]]) {
    const pattern = new RegExp('(<meta name="' + name + '" content=")[^"]*(">)', 'g');
    let matches = 0;
    html = html.replace(pattern, (_, before, after) => { matches++; return before + value + after; });
    if (matches !== 1) throw new Error('Missing or duplicate login metadata: ' + name);
  }
  if (pinSetup) {
    for (const id of ['pinInput', 'unlockBtn']) {
      const anchor = `id="${id}"`;
      if (html.split(anchor).length !== 2) throw new Error('Missing or duplicate login control');
      html = html.replace(anchor, `${anchor} disabled hidden`);
    }
  }
  return html;
}

module.exports = { PUBLIC_FILES, PACKAGED_PUBLIC_FILES, versionAssets, renderLogin };
