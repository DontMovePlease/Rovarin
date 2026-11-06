'use strict';
// Linux platform detection and client-access rules for the Rovarin Linux prototype.
// Mirrors the Windows server's loopback/Tailscale-only boundary. No Windows code
// is imported or executed from here; this module is Linux-only by construction.
const os = require('os');
const fs = require('fs');

function cleanIp(remoteAddress) {
  if (!remoteAddress) return '';
  let ip = String(remoteAddress);
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function isLoopback(ip) {
  const clean = cleanIp(ip);
  return clean === '127.0.0.1' || clean === '::1' || clean === 'localhost';
}

function isTailscaleIP(ip) {
  const clean = cleanIp(ip);
  if (!clean) return false;
  if (clean.toLowerCase().startsWith('fd7a:115c:a1e0:')) return true;
  const parts = clean.split('.').map(Number);
  return parts.length === 4 && parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127;
}

// Same boundary as Windows Rovarin: loopback or Tailscale only. Everything else
// gets a 403 before any routing, auth, or filesystem access.
function isAllowedClient(remoteAddress) {
  return isLoopback(remoteAddress) || isTailscaleIP(remoteAddress);
}

function getTailscaleIP() {
  const nets = os.networkInterfaces();
  for (const [name, addrs] of Object.entries(nets)) {
    if (!addrs) continue;
    for (const addr of addrs) {
      if ((addr.family === 'IPv4' || addr.family === 4)
        && (name.toLowerCase().includes('tailscale') || isTailscaleIP(addr.address))) {
        return addr.address;
      }
    }
  }
  return null;
}

// Presence check for optional system tools. Uses PATH lookup only — no spawn.
function toolAvailable(name) {
  const pathDirs = String(process.env.PATH || '/usr/bin:/bin').split(':');
  return pathDirs.some(dir => {
    try { fs.accessSync(dir + '/' + name, fs.constants.X_OK); return true; } catch (_) { return false; }
  });
}

function distroPrettyName() {
  try {
    for (const line of fs.readFileSync('/etc/os-release', 'utf8').split('\n')) {
      const m = line.match(/^PRETTY_NAME=(?:"([^"]+)"|(.+))$/);
      if (m) return (m[1] || m[2] || '').trim();
    }
  } catch (_) {}
  return os.type() + ' ' + os.release();
}

module.exports = {
  platform: process.platform,
  isLinux: process.platform === 'linux',
  isLoopback,
  isTailscaleIP,
  isAllowedClient,
  getTailscaleIP,
  toolAvailable,
  distroPrettyName
};
