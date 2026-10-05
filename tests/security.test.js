// ============================================================================
// clinic-automation â€” security regression tests (tests/security.test.js)
// Locks in the hardening: security headers on every response, rate limiting on
// public endpoints, admin-session enforcement, and the status-lookup privacy
// rule (phone + last 4 digits required, indistinguishable 404s).
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { freshDb, cleanupTemp, startServer, createHttpClient } = require('./helpers');

freshDb();
let server;
let client;

test.before(async () => { server = await startServer(); client = server.client; });
test.after(async () => { if (server) await server.close(); cleanupTemp(); });

test('every response carries the hardening headers', async () => {
  for (const path of ['/api/health', '/booking.html', '/api/clients']) {
    const res = await client.get(path);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff', `${path} nosniff`);
    assert.equal(res.headers.get('x-frame-options'), 'DENY', `${path} frame protection`);
    assert.equal(res.headers.get('referrer-policy'), 'no-referrer', `${path} referrer policy`);
    assert.match(String(res.headers.get('content-security-policy')), /frame-ancestors 'none'/, `${path} CSP`);
    assert.equal(res.headers.get('x-powered-by'), null, `${path} must not advertise Express`);
  }
});

test('the server does not leak its framework identity', async () => {
  const res = await client.get('/api/health');
  assert.equal(res.body.app, undefined);
});

test('rate limiter returns 429 with Retry-After once the budget is spent', async () => {
  const { rateLimit, resetRateLimits } = require('../src/middleware/rateLimit');
  resetRateLimits();

  // Drive the limiter directly with a fake request/response so the assertion is
  // about the limiter, not about a global budget shared with other tests.
  const limiter = rateLimit({ windowMs: 60000, max: 2, name: 'selftest' });
  const mkRes = () => {
    const res = { headers: {}, statusCode: 200 };
    res.setHeader = (k, v) => { res.headers[k] = v; };
    res.status = (code) => { res.statusCode = code; return res; };
    res.json = (body) => { res.body = body; return res; };
    return res;
  };
  const req = { ip: '203.0.113.9' };
  let allowed = 0;
  for (let i = 0; i < 4; i += 1) {
    const res = mkRes();
    limiter(req, res, () => { allowed += 1; });
  }
  assert.equal(allowed, 2, 'only the budgeted number of requests pass');
  const blocked = mkRes();
  limiter(req, blocked, () => {});
  assert.equal(blocked.statusCode, 429);
  assert.ok(blocked.headers['Retry-After'], 'a Retry-After header is returned');
  assert.match(blocked.body.error, /too_many_requests/);

  // A different client IP has its own budget.
  const other = mkRes();
  limiter({ ip: '203.0.113.10' }, other, () => {});
  assert.equal(other.statusCode, 200, 'limits are per client');

  resetRateLimits();
});

test('public endpoints are rate limited (budget configured via env)', async () => {
  const res = await client.get('/api/status?phone=%2B919000000001&last4=0001');
  assert.ok(res.status === 200 || res.status === 404, 'status lookup answers normally');
  assert.ok(res.headers.get('x-ratelimit-limit'), 'rate limit headers are exposed');
});

test('admin data requires a session and cannot be reached anonymously', async () => {
  const anon = createHttpClient(server.baseUrl);
  for (const [method, path] of [['get', '/api/clients'], ['get', '/api/reports/weekly'], ['get', '/api/receipts']]) {
    const res = await anon[method](path);
    assert.equal(res.status, 401, `${path} must be admin-only`);
  }
});

test('status lookup requires the phone AND its last 4 digits', async () => {
  // An absent ?phone= is a client error.
  assert.equal((await client.get('/api/status')).status, 400);
  // Everything else â€” wrong code, missing code, unknown number â€” is one
  // byte-identical 404 so the endpoint cannot be used to discover which phone
  // numbers are registered or whether a code was close.
  const wrongCode = await client.get('/api/status?phone=%2B919000000001&last4=0000');
  const noCode = await client.get('/api/status?phone=%2B919000000001');
  const unknown = await client.get('/api/status?phone=%2B919000000001&last4=1234');
  assert.equal(wrongCode.status, 404);
  assert.equal(noCode.status, 404);
  assert.equal(unknown.status, 404);
  assert.deepEqual(wrongCode.body, noCode.body);
  assert.deepEqual(wrongCode.body, unknown.body);
});

test('malformed JSON bodies are rejected with a 4xx, not a crash', async () => {
  const res = await client.post('/api/bookings/book', undefined, {
    headers: { 'Content-Type': 'application/json' },
    body: '{not json',
  });
  assert.ok(res.status >= 400 && res.status < 500, `expected 4xx, got ${res.status}`);
});

test('the webhook verification token is compared safely', async () => {
  const wrong = await client.get('/webhook?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=abc');
  assert.equal(wrong.status, 403, 'a wrong token never echoes the challenge');
});

// --- SYNC-5: `disable` must not be a silent no-op ------------------------------
// `securityHeaders({ disable: [...] })` collected the caller's strings and then
// compared them to the real header names with `skip.has(name)`. Only an EXACT,
// full, correctly-cased name ever matched: 'CSP', 'csp', 'hsts', 'xfo' and even
// 'content-security-policy' were all accepted and silently ignored, and an
// entirely fictional name was accepted without a word of complaint. A security
// control that does nothing when told to stand down is worse than one that is
// absent, because the operator believes the header is off when it is on.
//
// These assertions drive the factory directly with a fake response, so they
// assert the header SET rather than fighting the rest of the app's wiring.

/** Run the middleware once and return the header names it actually set. */
function headersWith(options) {
  const { securityHeaders } = require('../src/middleware/security');
  const res = { setHeader(k, v) { this._h[k.toLowerCase()] = String(v); }, _h: {} };
  securityHeaders(options)({}, res, () => {});
  return Object.keys(res._h);
}

test('SYNC-5: `disable` removes the header it names', () => {
  assert.ok(!headersWith({ disable: ['Content-Security-Policy'] }).includes('content-security-policy'),
    'the exact header name is honoured');
  assert.ok(!headersWith({ disable: ['X-Frame-Options'] }).includes('x-frame-options'),
    'and so is any other exact name');
});

test('SYNC-5: `disable` is case-insensitive', () => {
  // HTTP header names are case-insensitive by specification, so the option is too.
  // Before the fix only the exact casing matched, so `['csp']` and
  // `['content-security-policy']` were accepted and silently ignored.
  for (const name of ['content-security-policy', 'CONTENT-SECURITY-POLICY', 'CoNtEnT-SeCuRiTy-PoLiCy']) {
    assert.ok(!headersWith({ disable: [name] }).includes('content-security-policy'),
      `"${name}" must disable the CSP`);
  }
  assert.ok(!headersWith({ disable: ['x-frame-options'] }).includes('x-frame-options'),
    'and it is not case-sensitive on the way down either');
});

test('SYNC-5: `disable` accepts the CSP shorthand', () => {
  // 'CSP' is an ABBREVIATION, not a case variant, so lower-casing alone does not
  // reconcile it - hence the alias table.
  for (const alias of ['csp', 'CSP', 'Csp']) {
    assert.ok(!headersWith({ disable: [alias] }).includes('content-security-policy'),
      `"${alias}" must disable the CSP`);
  }
});

test('SYNC-5: an unrecognised `disable` name is reported LOUDLY, not swallowed', () => {
  // The whole point of SYNC-5: a typo must never read as "that header is off".
  // The contract is a loud warning that names the offending entry AND lists the
  // headers this app can actually emit, so the operator can correct the spelling
  // without reading the source. It is deliberately a warning and not a throw:
  // crashing boot because of a typo in an optional header list would trade one
  // outage for another.
  // CONTRACT: an unknown name THROWS with a stable code rather than warning.
  // A console warning is easily lost in boot noise, and the failure being
  // reported is a security header silently left ON — that must not pass
  // unnoticed. The throw happens at factory time, so the app refuses to start.
  const capture = (opts) => {
    try { headersWith(opts); return null; } catch (e) { return e; }
  };
  const warnings = [];
  const first = capture({ disable: ['totally-bogus'] });
  const second = capture({ disable: ['csp', 'nope'] });
  const blob = [first, second].filter(Boolean).map((e) => e.message).join('\n');

  assert.ok(first, 'the first unknown name must be rejected');
  assert.ok(second, 'and so must the second');
  assert.equal(first.code, 'SECURITY_HEADER_DISABLE_UNKNOWN', 'a stable code lets callers detect it');
  assert.match(blob, /totally-bogus/, 'the offending name is quoted back');
  assert.match(blob, /\bnope\b/, 'and so is the second one');
  assert.match(blob, /x-frame-options/, 'the error lists the real header names so it is actionable');
  assert.match(blob, /nothing was disabled/i, 'and states plainly that nothing was turned off');
});

test('SYNC-5: disabling one header leaves the others alone', () => {
  const names = headersWith({ disable: ['csp'] });
  assert.ok(!names.includes('content-security-policy'), 'CSP is off');
  for (const still of ['x-frame-options', 'x-content-type-options', 'referrer-policy']) {
    assert.ok(names.includes(still), `${still} must be unaffected`);
  }
});

test('SYNC-5: a valid header still leaves NO warning behind', () => {
  const warnings = [];
  const realWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    assert.ok(!headersWith({ disable: ['csp'] }).includes('content-security-policy'));
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(warnings, [], 'the happy path must be silent');
});