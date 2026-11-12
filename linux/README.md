# Experimental Linux backend

The canonical repository now contains both backends and one shared `public/`.
Windows remains authoritative for existing Windows behavior. v0.6.0 includes a
published experimental portable Linux preview, not production support or Windows
feature parity. Newer source changes are separate from the accepted archive.

## Development desktop milestone (not in the published archive)

The current source adds per-user desktop installation, a branded application-menu
entry and background lifecycle controls. Muse's independent Ubuntu 24.04.5 LTS /
Node 24.22.1 source acceptance was reported on November 7, including corrections
to systemd WorkingDirectory, enrollment stdin exit and failed-upgrade rollback.
The synchronized desktop.js and rovarin.js match the supplied MD5 values
2137eb1959a5ac6a270ed2cc4c31b793 and 29cae3fb6949f44a7d526747f7482dab.
Debian/Fedora remain untested. Source acceptance does not certify a new archive.
Keep the accepted v0.6.0 archive unchanged.

On an Ubuntu/Debian desktop with Node.js 24.x installed once, run from this full
source tree as your normal user, without sudo:

```sh
sh linux/install.sh
```

Fresh installation invokes the existing hidden terminal PIN setup; upgrades
preserve the existing credential and preferences. A damaged credential is never
reset. Afterwards open **Rovarin** from the application menu. The launcher uses
the browser UI and opens the actual assigned localhost port after verifying the
backend's user, command line and process start identity. No desktop framework is
added. The terminal launcher permits first-run setup; browser windows are normal
browser windows, not Rovarin-owned embedded renderers.

```sh
~/.local/bin/rovarin open
~/.local/bin/rovarin start
~/.local/bin/rovarin stop
~/.local/bin/rovarin restart
~/.local/bin/rovarin status
~/.local/bin/rovarin enable-startup
~/.local/bin/rovarin disable-startup
~/.local/bin/rovarin uninstall
# Explicitly remove known PIN/preferences too:
~/.local/bin/rovarin remove-all
```

Login startup is opt-in. This workflow requires a working per-user systemd
manager, `/usr/bin/flock`, `gio`, `systemd-run` and `xdg-open`. It uses no root
service, elevation or lingering-user setting. The unit uses a kernel flock to
avoid duplicate managed backends, restarts failed backends and shuts down through
SIGTERM. User-launched apps use separate transient scopes so stopping Rovarin
does not intentionally kill them. The new packaged candidate still requires
independent Linux package acceptance of systemd, GUI session and cgroup behavior.

Stop a manually launched preview before using the installed service. The managed
lock prevents duplicate service instances; it does not take over or terminate an
unmanaged source/preview process. Closing a browser leaves this background
service running; use `rovarin stop` when you want it stopped. Windows Smart
Standby is not implemented by this Linux service.

Installed code is under `~/.local/share/rovarin/app`; the unit is
`~/.config/systemd/user/rovarin.service`. Credentials remain outside the app at
`~/.config/rovarin-linux`. Only known, hash-matched installed files and owned
integration files are removed. Unknown files and prior/failed-upgrade code backups
are preserved for inspection, including on explicit full settings removal.
No system Node/Tailscale installation is removed. If the launcher was removed
already, full settings removal can be invoked from a retained source tree with
`node linux/desktop.js remove-all`.

Node bundling was assessed but is not enabled: a future runtime package needs
architecture-specific official binaries, verified signed SHASUMS, license notices
and clean Linux acceptance. The installer currently records the existing Node
executable; do not remove that runtime while using the installed app. See the
[official Node downloads/verification guidance](https://nodejs.org/en/download).

Applications now reads regular desktop entries from the user's local applications
directory, `/usr/local/share/applications` and `/usr/share/applications`. Entries
are bounded, permission checked and identified by opaque content-bound IDs.
Names and supported PNG icons are displayed; safe missing-icon fallbacks remain.
Quick Launch re-resolves registrations and launches a private snapshot via the OS,
without accepting browser commands, arguments or paths. Only regular user-owned
autostart entries can be toggled, with a current PIN; system entries are read-only.
Localized-name variants, nested/exported Flatpak/Snap entries, SVG/theme variants
and package uninstall are not yet covered.

GPU sampling preserves NVIDIA and adds read-only DRM sysfs fallback for AMD
utilization/VRAM/temperature and Intel counters where exposed. Missing Intel
utilization/VRAM remains unavailable; frequency is never substituted. CPU
classification requires a recognized CPU hwmon driver and label; a GPU Core label
cannot trigger CPU alerts, and thermal zones remain experimental. These paths
have synthetic coverage, not broad hardware acceptance.

Additional tests from the repository root:

```sh
node linux/test-desktop-integration.js
node linux/test-drm.js
node linux/test-control.js
node linux/test-onboarding.js
node linux/test-linux.js
```

The first four support portable fixtures; `test-linux.js` requires actual Linux.
The published acceptance below applies only to the original archive, not these
new installation, app-launch, startup, or hardware paths.

## Published preview and future candidate preparation

From the unified development repository, run `node linux/package-preview.js`.
This requires Node and system `tar` for independent extraction verification;
there are no package dependencies. Output is the ignored
`dist/linux-preview/rovarin-0.6.1-linux-preview.tar.gz`, adjacent `.sha256` and
`.manifest.json`. Linux version metadata is independent in runtime-files.js;
Windows package metadata and published artifacts remain at v0.6.0.
Existing output is never overwritten; preserve/move an earlier candidate before
explicitly generating another. Recheck with `node linux/package-preview.js --verify`
and `node linux/test-preview-package.js`. Verification compares the archive to
the current allowlisted source, so later source edits require a new candidate.

The generator includes only explicitly allowlisted Linux runtime modules,
canonical frontend/license-notice assets, root LICENSE, preview README and a per-file hash manifest.
No Node binary, tests, credentials, Windows executables or developer resources
are included. The packaged instructions come from `linux/PREVIEW-README.md`.
Historical acceptance: Muse reported clean acceptance of the earlier archive (SHA-256 b90090a642ae75adc80853a00d495e32d544af1349caf4de58ed8c7bc4f67a6a) on Ubuntu 24.04.5 LTS, Node v24.22.1 and Chrome 157 under a disposable normal user. Fresh enrollment/private credentials, login, CPU/RAM/storage/network, Processes, Diagnostics, SSE, idle leases, restart and shutdown passed with no package-specific defects.
The new shared-theme candidate has SHA-256 ea969a5d94dea58f7e5d3e0a32fc048589e4f1d7ab811f19ec18b12ac3a47dcb and has now passed fresh independent clean Ubuntu acceptance reported by Muse. The historical accepted archive/receipt are preserved under dist/linux-preview/accepted-b90090a6. The published v0.6.0 preview is pinned to this accepted hash; the older archive remains historical evidence. The embedded PREVIEW-README.md retains its original pre-acceptance wording so the accepted archive/source bytes remain unchanged.
Real iPhone-over-Tailscale, hardware GPU/temperature and live disallowed-client rejection remain unverified,
not confirmed failures. Windows release packaging/publication policy is unchanged.

## Source launch commands

Select the backend explicitly from the repository root:

- Windows: `npm run dev` (existing watcher) or `npm start`.
  Existing native launchers, startup, DPAPI PIN enrollment and recovery are unchanged.
- Linux: first run `node linux/rovarin.js setup`, then `node linux/rovarin.js start`
  (use the tested Node 24.x line).
  Optional single port: `PORT=7331 node linux/rovarin.js start`.
  Default fallback is 7331–7335. Restart this development process after edits.
  Do not run the Windows development watcher on Linux.

Separate entry points are the minimal platform boundary for this milestone.
No common launcher or backend extraction is required. The Linux entry point
refuses non-Linux hosts; the Windows entry points import no Linux modules.
There are no npm runtime dependencies.

## First-run setup and foreground launch

From the unified repository root, as your normal Linux user (no sudo):

```sh
node linux/rovarin.js setup
node linux/rovarin.js start
```

Setup asks for a PIN twice in an interactive terminal. Input is hidden; nothing
is echoed, including masking characters. Six digits, including leading zeros,
are supported, as are the existing 8- and 12-digit PINs. Do not put the PIN in
arguments, environment variables, shell commands, redirected input or files.
Invalid/mismatched entry exits without enrolling; rerun setup to try again.
Ctrl+C cancels setup and restores terminal input. Redirected input is refused.

The CLI calls the existing Linux scrypt enrollment/validation functions. Storage
is ~/.config/rovarin-linux/config.json (directory 0700, file 0600, owned by you).
An existing credential, even corrupt or unreadable, is never overwritten.
Concurrent setup attempts cannot replace the winning credential. The CLI refuses
storage inside the repository, including paths redirected there by symlinks.
Leave ROVARIN_LINUX_CONFIG_DIR unset in normal use; it is an external-directory
test override, not a PIN input.

Start validates saved credentials before running the existing server in this
terminal. Open its printed localhost URL in a browser and sign in with your PIN.
The existing loopback/Tailscale restriction and 7331-7335 fallback are unchanged;
PORT selects a single port. Press Ctrl+C in that terminal to stop. SIGTERM also
uses existing cleanup for leases, streams, samplers and helper children. No
background service, autostart entry or separate stop/PID file is created.

If storage is damaged or its ownership/permissions are unsafe, setup and start
fail closed. Preserve the file and repair known permission/ownership damage or
restore a known-good private backup as an explicit local operator action. A
restored hash retains its original PIN; it cannot reveal a forgotten PIN. Restart
the backend after restoration so old in-memory sessions are discarded. There is
no automatic reset or recovery bypass. Do not delete credentials as a recovery
shortcut. Stop the server before any deliberate storage maintenance.

The direct development command node linux/server-linux.js remains available,
with its existing loopback-only HTTP enrollment API. The terminal CLI is the
recommended onboarding path and never requires a PIN-bearing curl command.

## Shared contract and platform ownership

Both servers serve the canonical `public/` and implement its HTTP contracts:
PIN login/logout, monitoring leases, metrics, processes, SSE, diagnostics and
temperature availability. Routing, sessions and telemetry orchestration remain
separate implementations for now; sharing those internals is outside this phase.

Linux modules:
- `server-linux.js`: HTTP routing, static allowlist, leases and SSE.
- `platform.js`: client network boundary, distribution and optional tool detection.
- `linux-metrics.js`: Linux /proc, filesystem and optional tool samplers.
- `linux-processes.js`: process inventory, identity-checked SIGTERM, and process-tree preview/termination.
- `linux-auth.js`: separate scrypt credential storage and sessions.
- `linux-apps.js`: desktop-entry inventory, verified Quick Launch and owned autostart controls.
- `linux-maintenance.js`: native Linux maintenance controller (boost, clean_temp, empty_recycle_bin, clear_dns, journal vacuum, package cache analysis).
- `linux-power.js`: typed Linux power controls (sleep, restart, shutdown via loginctl/systemctl) with request/PIN confirmation.
- `desktop.js`, `install.sh`: per-user installation and systemd/browser lifecycle.
- `runtime-files.js`: explicit installation/preview runtime and shared-asset inputs.

Windows-only routes require authentication, then return HTTP 501 with
`unsupported_on_linux`: Windows application removal/leftover cleanup (`/api/apps/uninstall`, `/api/apps/leftovers/*`), Windows updates (`/api/updates`), Rovarin uninstaller (`/api/system/uninstall`), native desktop DPAPI trust/host messaging (`/api/desktop/*`), and enhanced hardware sensors (`/api/temperature/enhanced`, `/api/temperature/enhanced/install`).
They do not invoke Windows helpers. Missing sensors remain unavailable;
system thermal zones are never represented as CPU package temperature. Linux maintenance, power, and process-tree operations are implemented in v0.6.1 source and tested in control fixtures (`linux/test-control.js`); real-Ubuntu package acceptance for the v0.6.1 archive remains pending.

Linux credentials remain separate at `~/.config/rovarin-linux/config.json`
with scrypt hashes and POSIX permissions (0600). No DPAPI recovery material is
shared. Startup creates no credentials. The CLI above is recommended; existing HTTP enrollment remains the
loopback-only `POST /api/setup` with JSON `pin` and matching `confirmPin`
(6, 8 or 12 digits), only while no config exists. Use an interactive local
client without putting a real PIN in shell history. There is no PIN reveal or
automatic credential recovery endpoint. `ROVARIN_LINUX_CONFIG_DIR` is a test
override; keep it outside this checkout.

Only loopback/Tailscale clients are accepted; this does not establish a tested
physical-device connection. Do not expose the experimental backend publicly.

## Verification scope

From the unified repository root:

```sh
node linux/test-integration.js
node linux/test-onboarding.js
node linux/test-control.js
node linux/test-linux.js
```

The integration suite checks syntax, shared frontend placement, entry points and release
exclusions. Onboarding and control tests use disposable storage and POSIX/terminal fixtures on Windows. On Ubuntu, onboarding additionally checks real modes plus foreground CLI startup, shared HTTP shapes and SIGINT/SIGTERM cleanup. The runtime suite requires real Linux (exit 2 on other hosts), starts an isolated server
and disposable process fixture, and exercises auth, telemetry, leases, SSE,
process termination and unsupported routes. It never uses real user credentials.

Ubuntu source/backend/browser and shared-contract checks are user-reported passed. The synced standalone setup stdin cleanup and its PTY regression are present. Windows fixture passes do not establish real POSIX/terminal behavior. Muse independently verified the new hash, all 37 regular files/36 manifest entries, real-PTY cancel/mismatch/invalid/success/repeat enrollment, 0700/0600 storage, login/metrics/SSE, desktop theme switching/persistence/live Processes, mobile no-overflow, and SIGTERM/Ctrl+C clean exit with unchanged credentials and package contents.

## Provenance and release protection

The Linux implementation was integrated into the canonical repository with one shared frontend. Separate prototype/backups are retained.

Windows packaging copies explicit root/helper files and public/vendor trees;
linux/ remains excluded from the Windows installer. Release Manager now permits exactly reviewed Linux runtime/instruction files and shared contract support through its explicit public-source manifest; other Linux developer/test files remain excluded. Existing config/log/PID ignores plus the
credential staging ignore protect local artifacts. Keep runtime state outside
the checkout; ignored state is not permission to publish it.

Linux publication uses the existing Release Manager with pinned archive/checksum validation, source matching and the unchanged Windows release gate. The portable v0.6.0 experimental prerelease is published; there is no Linux installer. Preserve the accepted archive. Later shared-frontend/branding changes require a new candidate and fresh Ubuntu package acceptance before another release. Shared contracts are implemented; see [test-support/README.md](../test-support/README.md).


## Manual removal

Stop with Ctrl+C before deleting the extracted preview folder. This preserves ~/.config/rovarin-linux and its PIN. Remove that private directory only when deliberately erasing Linux credentials; there is no automatic reset. Node and Tailscale are shared tools and are not removed.

## Desktop appearance

Simplified is the new desktop default and does not create a graphics renderer. Settings offers the restored original Liquid Glass desktop theme, independently of graphics quality. Switching is immediate and stored on this device. Mobile keeps its existing appearance and gestures. Run node linux/test-desktop-theme.js in the full development tree for the shared browser checks; real Linux/browser acceptance is separate.
