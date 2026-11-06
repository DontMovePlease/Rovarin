# Shared HTTP contract regression

No runtime dependencies or live-server CLI. Assertions are imported by existing
isolated suites; they never read a PIN or launch/terminate a process themselves.
Windows uses the security suite's temporary copied server and disposable DPAPI
credential fixture. Linux uses its existing ephemeral server and temporary
scrypt configuration. Keep the complete unified development tree when testing.

From the repository root:

```
node test-support/http-contract-smoke-test.js
node scripts/security-smoke-test.js
node scripts/diagnostics-smoke-test.js
node linux/test-control.js
```

On Ubuntu, Muse additionally runs `node linux/test-linux.js`. The added natural
lease-expiration assertion waits the advertised TTL (currently 45 seconds).
No production timing override was added. Windows cannot validate Linux runtime.
Ubuntu source/backend/browser and shared HTTP contract verification are user-reported passed; this is separate from clean extracted-package acceptance.

The shared contract covers successful login/session cookie protection; JSON auth
errors; lease acquisition/TTL and expired heartbeat; core metrics and history;
process envelopes, nullable unavailable identity/CPU; diagnostics timestamp,
overall counts and check ID/label/status/summary; default `message` metrics and
named `processes` SSE payloads; Linux's typed authenticated 501 responses.
The SSE reader handles chunked UTF-8/CRLF, comments and optional events, has a
deadline and cancels its reader. Negative fixtures check shape/count drift and
fragmented SSE. Reviewed shared contract files are included by exact public-source paths for v0.6.0; they remain outside the Windows installer payload. Other test-support resources are not automatically published.

Not asserted: identical platform fields, sensor presence or readings, process
counts/names, diagnostics check inventory, cookie names, credential storage,
Windows-only event families, all error text/codes, or hardware performance.
The existing Linux suite retains its original Ubuntu/VM-specific acceptance
assertions; the new shared assertions add no host/distro assumptions.

## Verification scope

Windows: final complete security suite passed (including shared HTTP assertions,
72 PIN lifecycle assertions and real lockout/lease/session expiry); diagnostics
regression passed; shared negative/framing/release-exclusion fixtures passed;
37 Linux control/POSIX fixture assertions passed. All five changed/new JavaScript
files passed node --check. Linux source-tree integration checks passed. The real
Linux suite refused this Windows host; the later Ubuntu shared-contract pass is user-reported.
No backend compatibility mismatch was found and no production API was changed.
