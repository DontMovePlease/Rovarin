'use strict';
// Test-only shared frontend contract. No server imports or credential access.
const assert = require('node:assert/strict');
function object(value, label) { assert(value && typeof value === 'object' && !Array.isArray(value), label); }
function text(value, label) { assert.equal(typeof value, 'string', label); assert(value.length > 0, label); }
function number(value, label) { assert(Number.isFinite(value), label); }
function error(status, body, expected) {
  assert.equal(status, expected); object(body, 'JSON error'); text(body.error, 'error message');
  // Some read-only Windows errors predate success/code; neither is mandatory.
  if ('success' in body) assert.equal(body.success, false);
  if ('code' in body) text(body.code, 'typed error code');
}
function authenticated(status, body, cookies) {
  assert.equal(status, 200); assert.equal(body.success, true);
  assert(cookies.some(c => c.includes('HttpOnly') && c.includes('SameSite=Strict') && !c.includes('Max-Age=0')), 'protected session cookie');
}
function lease(status, body) {
  assert.equal(status, 201); assert.equal(body.success, true);
  text(body.leaseId, 'opaque lease ID'); number(body.expiresInMs, 'lease TTL'); assert(body.expiresInMs > 0);
}
function expired(status, body) { error(status, body, 410); assert.equal(body.expired, true); assert.equal(body.success, false); }
function metrics(m) {
  object(m, 'metrics snapshot'); object(m.cpu, 'cpu'); number(m.cpu.overall, 'cpu overall');
  assert(Array.isArray(m.cpu.perCore), 'per-core array'); m.cpu.perCore.forEach(v => number(v, 'per-core usage'));
  object(m.ram, 'ram'); for (const k of ['totalGB', 'usedPercent']) number(m.ram[k], 'ram.' + k);
  object(m.network, 'network'); for (const k of ['downSpeedKB', 'upSpeedKB']) number(m.network[k], 'network.' + k);
  object(m.system, 'system'); assert(Array.isArray(m.drives), 'drives array');
  object(m.gpu, 'gpu'); assert.equal(typeof m.gpu.available, 'boolean');
  number(m.uptimeSeconds, 'uptime'); object(m.health, 'health'); number(m.health.score, 'health score');
}
function metricsResponse(body) { object(body, 'metrics envelope'); metrics(body.metrics); object(body.history, 'history'); assert(Array.isArray(body.history.timestamps)); }
function processes(body) {
  object(body, 'process envelope'); assert(Array.isArray(body.processes)); assert.equal(typeof body.stale, 'boolean');
  // Empty/initial/inaccessible samples are valid, including null CPU and identity.
  assert(body.sampledAt === null || Number.isFinite(body.sampledAt));
  for (const p of body.processes) {
    assert(Number.isInteger(p.pid) && p.pid >= 0); text(p.name, 'technical process name');
    assert(p.startedAt === null || (typeof p.startedAt === 'string' && Number.isFinite(Date.parse(p.startedAt))));
    assert(p.cpuPercent === null || Number.isFinite(p.cpuPercent)); number(p.ramMB, 'process RAM');
  }
}
function diagnostics(body) {
  text(body.generatedAt, 'generatedAt'); assert(Number.isFinite(Date.parse(body.generatedAt)));
  object(body.overall, 'overall'); text(body.overall.title, 'overall title'); text(body.overall.summary, 'overall summary');
  assert(['supported', 'failed'].includes(body.overall.status)); assert(Array.isArray(body.checks) && body.checks.length > 0);
  const ids = new Set();
  for (const c of body.checks) {
    text(c.id, 'check id'); assert(!ids.has(c.id), 'unique check IDs'); ids.add(c.id);
    text(c.label, 'check label'); text(c.summary, 'check summary');
    assert(['supported', 'unavailable', 'failed'].includes(c.status));
  }
  for (const status of ['supported', 'unavailable', 'failed']) assert.equal(body.overall[status], body.checks.filter(c => c.status === status).length, status + ' count');
}
function unsupported(status, body) { error(status, body, 501); assert.equal(body.error, 'unsupported_on_linux'); }
function event(name, body) {
  if (name === 'message') metrics(body);
  else if (name === 'processes') processes(body);
  else assert.fail('Unexpected core SSE event: ' + name);
}
// Decode complete SSE frames across arbitrary chunks; comments/optional events
// do not substitute for either required core event. Always cancel the reader.
async function stream(response, expected = ['message', 'processes']) {
  assert.equal(response.status, 200); assert.match(response.headers.get('content-type') || '', /text\/event-stream/);
  const reader = response.body.getReader(), decoder = new TextDecoder(), seen = new Set(); let buffer = '', timer;
  try {
    await Promise.race([(async () => {
      while (!expected.every(n => seen.has(n))) {
        const { value, done } = await reader.read(); assert(!done, 'SSE ended before required events');
        buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n');
        let end;
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end); buffer = buffer.slice(end + 2);
          const lines = frame.split('\n'), name = lines.find(l => l.startsWith('event:'))?.slice(6).trim() || 'message';
          const data = lines.filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
          if (data && expected.includes(name)) { event(name, JSON.parse(data)); seen.add(name); }
        }
      }
    })(), new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Core SSE event timeout')), 8000); })]);
  } finally { clearTimeout(timer); await reader.cancel(); }
}
module.exports = { authenticated, error, lease, expired, metrics, metricsResponse, processes, diagnostics, unsupported, event, stream };
