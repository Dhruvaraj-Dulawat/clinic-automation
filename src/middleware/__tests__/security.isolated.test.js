/**
 * ISOLATED Unit Test for security.js — SYNC-5
 * Target: C:/Users/dhruv/clinic-automation/src/middleware/security.js
 * Session: ses_security_sync5
 *
 * **WARNING**: THIS FILE WILL BE DELETED AFTER TEST PASSES
 * Test code preserved in: .opencode/unit-tests/
 *
 * SYNC-5 (MEDIUM, silent fail-open on a SECURITY control):
 * `securityHeaders({ disable: ['CSP'] })` still emits Content-Security-Policy. The
 * option is accepted and ignored, because the skip set was built from the raw
 * strings while the lookup used exact-case header names. A security control that
 * silently does nothing when asked to stand down is worse than one that is
 * absent — a reviewer/operator believes the header is off when it is on.
 *
 * Isolation: this module has NO dependencies (no db/config/express require — only
 * Node globals), so it is unit-testable standalone. Nothing is written to disk
 * and data/clinic.db is never opened.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { securityHeaders } = require('../security.js');

// Drive the middleware with fake req/res so no socket and no express is needed.
function run(options) {
  const headers = {};
  const res = { setHeader: (k, v) => { headers[k] = v; } };
  let called = false;
  securityHeaders(options)({ headers: {} }, res, () => { called = true; });
  assert.equal(called, true, 'middleware must always call next()');
  return headers;
}

const names = (h) => Object.keys(h);

// ---------------------------------------------------------------------------
// SYNC-5: the reported defect
// ---------------------------------------------------------------------------
test('SYNC-5: disable:["CSP"] actually removes Content-Security-Policy', () => {
  const h = run({ disable: ['CSP'] });
  assert.equal(
    names(h).includes('Content-Security-Policy'), false,
    'disable:["CSP"] was silently ignored — CSP still emitted'
  );
});

test('SYNC-5: disable is case-insensitive (lowercase + mixed case)', () => {
  for (const spelling of ['csp', 'Csp', 'cSP', 'CONTENT-SECURITY-POLICY', 'content-security-policy']) {
    const h = run({ disable: [spelling] });
    assert.equal(
      names(h).includes('Content-Security-Policy'), false,
      `disable:["${spelling}"] was silently ignored`
    );
  }
});

test('SYNC-5: every shipped header can be disabled case-insensitively', () => {
  const all = run({});
  assert.ok(all['Content-Security-Policy'], 'CSP must be on by default');
  assert.ok(all['X-Frame-Options'], 'X-Frame-Options must be on by default');
  assert.ok(all['X-Content-Type-Options'], 'X-Content-Type-Options must be on by default');

  for (const name of names(all)) {
    for (const spelling of [name, name.toLowerCase()]) {
      const h = run({ disable: [spelling] });
      assert.equal(
        names(h).includes(name), false,
        `disable:["${spelling}"] did not remove "${name}"`
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Regression guards: the working spellings must keep working, and nothing else
// may change as a side effect.
// ---------------------------------------------------------------------------
test('the exact header name still disables it (no regression)', () => {
  const h = run({ disable: ['Content-Security-Policy'] });
  assert.equal(names(h).includes('Content-Security-Policy'), false);
  // Only that one header goes; the rest of the policy stays.
  assert.equal(h['X-Frame-Options'], 'DENY');
  assert.equal(h['X-Content-Type-Options'], 'nosniff');
});

test('an unknown disable entry is REFUSED, and nothing is silently disabled', () => {
  // Contract: an unrecognised name THROWS rather than quietly disabling nothing.
  // A typo must never be mistaken for "that header is off" — the header would
  // still be emitted while the operator believed they had removed it.
  const before = names(run({}));
  assert.throws(
    () => run({ disable: ['X-Nonsense-Header'] }),
    (e) => e && e.code === 'SECURITY_HEADER_DISABLE_UNKNOWN',
    'an unknown header name must be rejected loudly'
  );
  // And the throw happens BEFORE anything is applied, so a plain run is unaffected.
  assert.deepEqual(names(run({})), before);
});

test('disable:[] and a missing disable change nothing', () => {
  const base = JSON.stringify(run({}));
  assert.equal(JSON.stringify(run({ disable: [] })), base);
  assert.equal(JSON.stringify(run({})), base);
  assert.equal(JSON.stringify(run({ disable: null })), base);
});

test('multiple entries can be disabled at once', () => {
  const h = run({ disable: ['csp', 'x-frame-options'] });
  assert.equal(names(h).includes('Content-Security-Policy'), false);
  assert.equal(names(h).includes('X-Frame-Options'), false);
  assert.equal(h['X-Content-Type-Options'], 'nosniff', 'untouched headers survive');
});

test('report-only still wins over an enforcing CSP, and stays disableable', () => {
  const ro = run({ reportOnly: true });
  assert.equal(names(ro).includes('Content-Security-Policy'), false, 'report-only must not enforce');
  assert.ok(ro['Content-Security-Policy-Report-Only'], 'report-only header must be present');

  const roOff = run({ reportOnly: true, disable: ['content-security-policy-report-only'] });
  assert.equal(
    names(roOff).includes('Content-Security-Policy-Report-Only'), false,
    'the report-only header must also be disableable case-insensitively'
  );
});

test('non-string entries in disable are ignored, not thrown on', () => {
  const before = names(run({})).length;
  assert.equal(names(run({ disable: [null, undefined, 42, {}] })).length, before);
});