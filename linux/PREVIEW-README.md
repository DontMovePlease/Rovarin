# Rovarin v0.6.1 Linux experimental candidate

This is a candidate for independent package acceptance, not a published release.
Muse reported acceptance of November 7 desktop source on Ubuntu 24.04.5 LTS with
Node 24.22.1. That does not certify these newly packaged bytes. Debian and Fedora
remain untested. No performance or Windows feature-parity claim is made.

## Verify and extract

Use Node.js 24.x (24.22.1 was used for source acceptance), system tar and a normal
desktop user with a working user systemd session. Node is not bundled; no npm
install is needed. Keep the downloaded checksum beside the archive:

```sh
sha256sum -c rovarin-0.6.1-linux-preview.tar.gz.sha256
tar -xzf rovarin-0.6.1-linux-preview.tar.gz
cd rovarin-0.6.1-linux-preview
```

preview-manifest.json records SHA-256, size and mode for every payload file,
excluding itself. Only README, LICENSE, that manifest, linux/ and public/ belong
in the root. linux/install.sh is 0755; other files are 0644. No links, Node or
Windows binaries, tests, credentials, logs or developer tools ship.

## Install or upgrade

Stop a manually launched source/portable backend first. As the same normal user,
without sudo, run from the new extracted directory:

```sh
./linux/install.sh
~/.local/bin/rovarin status
~/.local/bin/rovarin open
```

Fresh installation asks for and confirms a hidden six-digit PIN and must return
to the shell. Upgrades preserve existing PIN/preferences; do not uninstall or
use remove-all to upgrade. Damaged credentials are refused, never reset. Never
put PINs in commands, arguments, environment variables or logs.

The menu entry opens the browser UI. Code is under ~/.local/share/rovarin/app;
the unit is ~/.config/systemd/user/rovarin.service. Credentials are separate under
~/.config/rovarin-linux (directory 0700, credential file 0600). Keep the existing
Node executable installed. Requires systemctl --user, flock, gio, systemd-run and
xdg-open. No sudo, root service or lingering-user setting is needed.

```sh
~/.local/bin/rovarin start
~/.local/bin/rovarin stop
~/.local/bin/rovarin restart
~/.local/bin/rovarin enable-startup
~/.local/bin/rovarin disable-startup
~/.local/bin/rovarin uninstall
# Deliberately remove known PIN/preferences too:
~/.local/bin/rovarin remove-all
```

Startup is opt-in. Closing the browser leaves the service running. Normal
uninstall retains settings and unknown files; failed-upgrade backups remain for
inspection. Shared Node and Tailscale installations are never removed.

## Capabilities and limits

Includes monitoring, Processes, Diagnostics, authentication/SSE/leases, desktop
installation, desktop-entry Quick Launch and fresh-PIN management of eligible
user autostart entries. AMD/Intel DRM and recognized CPU hwmon depend on hardware
and permissions; missing readings remain unavailable. Windows maintenance/power,
product updater, native DPAPI and package application removal remain unsupported.
One canonical frontend serves both platforms. Access remains authenticated and
restricted to loopback/Tailscale; do not expose it publicly.

Physical iPhone/Tailscale, broad CPU/GPU hardware and other distributions need
separate evidence. Tests are deliberately absent from the archive.

## Muse package acceptance

Record the exact archive hash, Ubuntu/Node versions, inventory/modes and manifest
checks before testing. Use disposable state for fresh install: hidden enrollment
must return, menu launch must produce one managed backend, and startup must be
opt-in/reversible. Upgrade an accepted-source installation and confirm unchanged
PIN/preferences. Check rollback, stop/restart and retained/default uninstall.
Confirm no PIN disclosure. Focus on package/installation differences; prior broad
source tests need not be repeated without a changed path. Report archive
acceptance separately from source acceptance and mark untested device/hardware
paths explicitly.
