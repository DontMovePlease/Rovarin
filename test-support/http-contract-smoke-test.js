'use strict';
const assert = require('node:assert/strict');
const c = require('./http-contract');
const fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '..');
const { permitted } = require('../scripts/release-manager');
const publicFiles = JSON.parse(fs.readFileSync(path.join(root, 'scripts/release-public-files.json')));
for (const name of fs.readdirSync(__dirname)) {
  const relative = 'test-support/' + name;
  const reviewed = require('../scripts/release-linux-preview').sourceFiles.includes(relative);
  assert.equal(permitted(relative), reviewed); assert.equal(publicFiles.includes(relative), reviewed);
}
const manifest = path.join(root, 'packaging/payload-manifest.json');
if (fs.existsSync(manifest)) assert(!JSON.parse(fs.readFileSync(manifest)).files.some(f => /(?:^|\/)test-support\//.test(f.path)));
const report = { generatedAt: new Date().toISOString(), overall: { status: 'supported', title: 'Ready', summary: 'Optional hardware absent', supported: 1, unavailable: 1, failed: 0 }, checks: [{ id: 'os', label: 'OS', status: 'supported', summary: 'Available' }, { id: 'gpu', label: 'GPU', status: 'unavailable', summary: 'No device' }] };
c.diagnostics(report);
for (const mutate of [r => delete r.generatedAt, r => r.generatedAt = 'yesterday', r => r.overall.supported++, r => r.checks[0].status = 'ok', r => delete r.checks[0].summary, r => r.checks[1].id = r.checks[0].id]) {
  const changed = structuredClone(report); mutate(changed); assert.throws(() => c.diagnostics(changed));
}
c.processes({ processes: [{ pid: 1, name: 'inaccessible', startedAt: null, cpuPercent: null, ramMB: 0, platformExtra: true }], sampledAt: null, stale: true });
assert.throws(() => c.processes({ processes: {}, sampledAt: null, stale: true }));
assert.throws(() => c.expired(410, { error: 'Expired', success: false }));
assert.throws(() => c.unsupported(501, { error: 'Something failed' }));
c.unsupported(501, { error: 'unsupported_on_linux' });
(async () => {
  const body = { processes: [], sampledAt: null, stale: true };
  const bytes = Buffer.from(': comment\r\n\r\nevent: processes\r\ndata: ' + JSON.stringify(body) + '\r\n\r\n');
  // Every byte is split, including CRLF, to catch transport-boundary assumptions.
  let index = 0, cancelled = false;
  const response = { status: 200, headers: new Headers({ 'Content-Type': 'text/event-stream' }), body: { getReader: () => ({ read: async () => index < bytes.length ? { value: bytes.subarray(index, ++index), done: false } : { done: true }, cancel: async () => { cancelled = true; } }) } };
  await c.stream(response, ['processes']); assert(cancelled);
  const invalid = { ...response, body: { getReader: () => ({ read: async () => ({ done: true }), cancel: async () => {} }) } };
  await assert.rejects(c.stream(invalid), /ended before/);
  console.log('PASS shared contract rejects shape/count/error drift, accepts unavailable/platform fields and decodes fragmented SSE');
})().catch(error => { console.error(error); process.exitCode = 1; });
