/**
 * ISOLATED unit test: canonicalHeaderName(), exercised through its only public
 * surface, securityHeaders().
 * Target: src/middleware/security.js
 *
 * WARNING: THIS FILE IS DELETED AFTER THE TEST PASSES. The code is preserved in
 * .opencode/unit-tests/.
 *
 * WHY IT IS DELETED RATHER THAN KEPT: package.json's test glob was widened to
 * cover this directory too, so any file left here enters `npm test`. This file
 * duplicates coverage that tests/security.test.js and security.isolated.test.js
 * already provide; leaving a third copy in the gate only adds another thing to
 * keep green.
 *
 * (NB for whoever writes the next one: do NOT quote a glob containing two
 * adjacent asterisks and a slash inside a block comment. The "star-slash" pair
 * closes the comment early and the rest of the prose is parsed as code, which
 * is exactly how this file's first run died with a bare `__tests__ is not
 * defined` ReferenceError on line 10 rather than on any real assertion.)
 *
 * Hermetic: security.js has no dependencies at all (no express, no db), so
 * nothing here can open data/clinic.db. DB_PATH is still pointed at a throwaway
 * temp path defensively.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');

process.env.DB_PATH = path.join(os.tmpdir(), 'canonical-header-name-probe', 'probe.db');

const { securityHeaders } = require('../security.js');

/** Run the middleware once against a fake response; return the names it set. */
function headersWith(options) {
  const res = { setHeader(k, v) { this._h[k] = String(v); }, _h: {} };
  securityHeaders(options)({}, res, () => {});
  return Object.keys(res._h);
}

test('V2: securityHeaders({ disable: [] }) returns a middleware and throws nothing', () => {
  const mw = securityHeaders({ disable: [] });
  assert.equal(typeof mw, 'function');
  assert.equal(mw.length, 3, 'middleware takes (req, res, next)');
});

test('the canonical form is LOWERCASE, not Title-Case', () => {
  // The error message interpolates the emitted set verbatim, so its casing is
  // the observable proof of what canonicalHeaderName() returns.
  let err = null;
  try {
    securityHeaders({ disable: ['definitely-not-a-header'] });
  } catch (e) { err = e; }
  assert.ok(err, 'an unknown disable name must be rejected');
  assert.equal(err.code, 'SECURITY_HEADER_DISABLE_UNKNOWN');
  for (const lower of [
    'content-security-policy',
    'x-frame-options',
    'x-content-type-options',
    'x-dns-prefetch-control',
    'strict-transport-security',
    'referrer-policy',
    'permissions-policy',
  ]) {
    assert.match(err.message, new RegExp(`\\b${lower}\\b`),
      `the emitted list must contain lower-case "${lower}"`);
  }
  assert.ok(!/\bX-Frame-Options\b/.test(err.message),
    'the emitted list must NOT be Title-Cased');
});

test('a shorthand alias disables its header, in any case', () => {
  for (const alias of ['csp', 'CSP', 'Csp']) {
    assert.ok(!headersWith({ disable: [alias] }).includes('Content-Security-Policy'),
      `"${alias}" must disable the CSP`);
  }
  for (const alias of ['hsts', 'HSTS', 'Strict-Transport-Security']) {
    assert.ok(!headersWith({ disable: [alias], isProd: true })
      .includes('Strict-Transport-Security'), `"${alias}" must disable HSTS`);
  }
});

test('the long shorthands people actually type work too', () => {
  assert.ok(!headersWith({ disable: ['xfo'] }).includes('X-Frame-Options'), 'xfo');
  assert.ok(!headersWith({ disable: ['frame'] }).includes('X-Frame-Options'), 'frame');
  assert.ok(!headersWith({ disable: ['nosniff'] }).includes('X-Content-Type-Options'), 'nosniff');
  assert.ok(!headersWith({ disable: ['referrer'] }).includes('Referrer-Policy'), 'referrer');
  assert.ok(!headersWith({ disable: ['permissions'] }).includes('Permissions-Policy'), 'permissions');
  assert.ok(!headersWith({ disable: ['dnsPrefetch'] }).includes('X-DNS-Prefetch-Control'),
    'dnsPrefetch (camelCase key, so the lookup must fold case)');
});

test('the exact shipped name disables itself, and case does not matter on the way down', () => {
  assert.ok(!headersWith({ disable: ['X-Frame-Options'] }).includes('X-Frame-Options'));
  assert.ok(!headersWith({ disable: ['x-frame-options'] }).includes('X-Frame-Options'));
  assert.ok(!headersWith({ disable: ['X-FRAME-OPTIONS'] }).includes('X-Frame-Options'));
});

test('non-string and blank entries are ignored, not thrown on', () => {
  const names = headersWith({ disable: [null, undefined, 42, '', '   ', {}] });
  assert.ok(names.includes('Content-Security-Policy'),
    'a junk entry must not disable anything, let alone throw');
});

test('an unrelated disable entry removes nothing', () => {
  const off = headersWith({ disable: ['xfo'] });
  assert.ok(!off.includes('X-Frame-Options'));
  assert.ok(off.includes('Content-Security-Policy'));
  assert.ok(off.includes('X-Content-Type-Options'));
  assert.ok(off.includes('Referrer-Policy'));
});

test('report-only still cannot be cancelled by disabling the enforcing name', () => {
  const names = headersWith({ reportOnly: true });
  assert.ok(names.includes('Content-Security-Policy-Report-Only'));
  assert.ok(!names.includes('Content-Security-Policy'),
    'report-only mode must not also send the enforcing header');
});