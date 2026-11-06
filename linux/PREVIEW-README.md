# Rovarin Linux experimental preview

Portable preview for local evaluation, not a supported production release.
No installer, background service or automatic startup is included.

1. Install/use Node.js 24.x (the project's tested runtime line) and confirm
   `node --version`. Node is not bundled. No npm install is required.
2. Extract `rovarin-0.6.0-linux-preview.tar.gz` and open a terminal in its
   `rovarin-0.6.0-linux-preview` directory.
3. As your normal Linux user, without sudo, run:

   ```sh
   node linux/rovarin.js setup
   node linux/rovarin.js start
   ```

Setup hides PIN input and asks for confirmation. Six digits, including leading
zeros, are supported; existing 8- and 12-digit policy is retained. Never put a
PIN in arguments, shell commands, environment variables or files. Existing
credentials, even corrupt ones, are never overwritten. Credential storage is
`~/.config/rovarin-linux/config.json` (directory 0700, file 0600). Leave
`ROVARIN_LINUX_CONFIG_DIR` unset for ordinary use. Stop the backend before any
explicit repair of storage permissions or restoration of a known-good backup;
there is no automatic PIN reset or recovery bypass.

Open the localhost address printed by start in your browser and sign in.
Default ports are 7331–7335; `PORT=7331 node linux/rovarin.js start` requests
only that port. Keep the terminal open; Ctrl+C stops the server and cleans up
monitoring resources. Start again with the same command and saved PIN.
The existing server permits only loopback/Tailscale clients. This is not a
public Internet deployment package. No runtime state belongs in this folder.

## Capabilities and limits

Core monitoring, process lists/single-process termination, diagnostics and
browser authentication are experimental Linux implementations. Availability
depends on Linux permissions and hardware; unavailable readings stay unavailable.

Unsupported Linux capabilities return authenticated HTTP 501: Windows application
inventory/launch/startup/uninstall management, maintenance, product updates,
Rovarin uninstall, power controls, native desktop/DPAPI functions, enhanced
Windows sensors and process-tree inspection/termination. There is no Linux
desktop shell or installer. Some shared frontend controls may remain visible.

Real iPhone-over-Tailscale connectivity and hardware GPU/temperature paths
remain **unverified**, not confirmed failures. Do not infer those results from
loopback, browser emulation or Windows-hosted fixture tests.

## Muse: clean Ubuntu extraction test

Use a disposable Linux user for genuinely fresh storage. Verify the external
archive SHA-256, extract as that user, and confirm the folder contains only
README, LICENSE, preview-manifest.json, linux/ and public/ files. Test hidden
entry, confirmation mismatch, cancellation, successful setup returning to the
shell (stdin cleanup), refused repeat setup, private ownership/modes, login,
monitoring/idle behavior, diagnostics, unsupported controls, Ctrl+C/SIGTERM and
restart with unchanged credentials. Confirm no PIN appears in output/history.
Record Node/Ubuntu versions. Test actual iPhone/Tailscale and hardware readings
separately when available; report untested paths explicitly.

Tests and development tools are deliberately absent. Run repository regression
suites from the full development checkout separately. This archive has been
content/extraction-verified on Windows; clean Ubuntu package acceptance is pending.
