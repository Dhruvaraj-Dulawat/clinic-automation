// ============================================================================
// clinic-automation — CSRF protection (src/middleware/csrf.js)
//   issueCsrfToken(req, res)  mint (once) + mirror the session CSRF token
//   csrfRouter                GET /csrf -> { csrfToken }   (bootstrap endpoint)
//   requireCsrf(options)      double-submit guard for unsafe HTTP methods
//   safeMethods               Set(['GET','HEAD','OPTIONS'])
//   timingSafeEqualStr(a, b)  constant-time compare, never throws
//
// WHY double-submit: every admin mutation (POST/PUT/PATCH/DELETE under
// /api/admin, /api/clients, /api/import, /api/receipts) is state-changing and
// session-authenticated. The session cookie is SameSite=Lax, which blocks the
// classic cross-site <form> POST, but Lax is a browser-side mitigation only —
// it does not help a same-site subdomain, a compromised/legacy browser that
// treats Lax as None, or any client that replays a stolen cookie. CSRF is
// enforced server-side by a token the attacker cannot read.
//
// HOW (double-submit, session-anchored):
//   1. The token lives in req.session.csrfToken — SERVER side, so a caller
//      cannot mint a valid one by writing its own cookie.
//   2. A second, NON-httpOnly cookie (csrf_token) mirrors it so browser JS can
//      read it and echo it back in the `x-csrf-token` header.
//   3. requireCsrf compares the echoed value against the session value in
//      CONSTANT TIME. An attacker's page can cause the cookie to be sent but
//      cannot READ it cross-origin, so it cannot produce a matching header.
// The httpOnly flag on the session cookie is deliberately untouched.
//
// WHY /webhook is exempt: Meta's WhatsApp Cloud API POSTs to /webhook from
// Meta's own servers. It cannot send a custom header, cannot hold a session,
// and never reads a response — a CSRF check there would reject every genuine
// inbound message. The endpoint is authenticated separately by Meta's
// signature/verify-token handshake (see src/routes/webhook.js), so there is
// no ambient credential for a CSRF attack to borrow. The exempt list is a
// requireCsrf() option, not a hardcoded branch, so it stays auditable.
//
// FAIL CLOSED: any internal error returns 403. A CSRF check that silently
// passes on exception is worse than no CSRF check at all.
// Mounted in: src/app.js (`app.use(requireCsrf())` + `/csrf` -> csrfRouter).
// Deps: express, node:crypto. Nothing else — no config/db import needed
//   (production mode is read defensively from src/config.js).
// ============================================================================
'use strict';

const express = require('express');
const crypto = require('crypto');

// 32 random bytes -> 64 hex chars. Never a predictable value (no Math.random).
const TOKEN_BYTES = 32;
// Mirrors the session cookie name used in src/app.js.
const CSRF_COOKIE_NAME = 'csrf_token';
// 12h, matching the express-session cookie maxAge in src/app.js.
const SESSION_MAX_AGE_MS = 1000 * 60 * 60 * 12;
// Methods that cannot change state, so they need no token.
const safeMethods = new Set(['GET', 'HEAD', 'OPTIONS']);
// Paths that are not browser-session driven at all (see header: /webhook).
const DEFAULT_EXEMPT_PATHS = ['/webhook'];

// Constant-time string compare. crypto.timingSafeEqual THROWS when the two
// buffers have different lengths, so the length check must come first — a
// naive `crypto.timingSafeEqual(Buffer(a), Buffer(b))` turns an ordinary
// mismatch (attacker sends a 1-char token) into a 500. Empty-vs-empty is also
// false: two blanks are "no token", never a valid token.
function timingSafeEqualStr(a, b) {
  try {
    const ba = Buffer.from(String(a === undefined || a === null ? '' : a));
    const bb = Buffer.from(String(b === undefined || b === null ? '' : b));
    if (ba.length === 0 || ba.length !== bb.length) return false;
    return crypto.timingSafeEqual(ba, bb);
  } catch (_) {
    return false;
  }
}

// Fresh token from the CSPRNG. 32 bytes -> 64 hex chars.
function mintToken() {
  return crypto.randomBytes(TOKEN_BYTES).toString('hex');
}

// Header lookup that tolerates both Express (which lower-cases header names)
// and hand-built request objects in tests.
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (String(key).toLowerCase() !== want) continue;
    const v = headers[key];
    if (Array.isArray(v)) return v.length ? String(v[0] || '') : '';
    return String(v || '');
  }
  return '';
}

// The token the caller echoed back: header first, then the `_csrf` body field
// for HTML forms that cannot set headers.
function readPresentedToken(req) {
  const headers = (req && req.headers) || {};
  const fromHeader = headerValue(headers, 'x-csrf-token') || headerValue(headers, 'csrf-token');
  if (fromHeader) return fromHeader.trim();
  const body = req && req.body;
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const fromBody = body._csrf || body.csrfToken || body.csrf_token;
    if (fromBody) return String(fromBody).trim();
  }
  return '';
}

// isProd drives the cookie `secure` flag. Read defensively (src/config.js needs
// a .env / SESSION_SECRET) so this module stays requirable during unit tests.
function resolveIsProd(override) {
  if (override !== undefined) return !!override;
  try {
    return !!require('../config').getConfig().isProd;
  } catch (_) {
    return process.env.NODE_ENV === 'production';
  }
}

// Mint the session token if absent, mirror it into the JS-readable cookie and
// return it. Idempotent: calling twice yields the same token, so a page reload
// does not invalidate an in-flight form.
function issueCsrfToken(req, res, options = {}) {
  try {
    const opts = options || {};
    // Without a session there is nowhere to store the source of truth, and a
    // cookie-only token would be forgeable. Refuse rather than half-issue.
    if (!req || !req.session || typeof req.session !== 'object') return null;
    let token = req.session.csrfToken;
    if (typeof token !== 'string' || token === '') {
      token = mintToken();
      req.session.csrfToken = token;
    }
    if (res && typeof res.cookie === 'function') {
      res.cookie(opts.cookieName || CSRF_COOKIE_NAME, token, {
        // Must be READABLE by page JS — that is the entire "submit" half of
        // double-submit. Confidentiality is not needed (or wanted) here.
        httpOnly: false,
        sameSite: opts.sameSite || 'lax',
        secure: resolveIsProd(opts.isProd),
        maxAge: Number.isFinite(opts.maxAge) ? opts.maxAge : SESSION_MAX_AGE_MS,
        path: '/',
      });
    }
    return token;
  } catch (_) {
    return null;
  }
}

// Force a brand-new token. Call on login/logout so a token captured before the
// privilege change cannot be replayed afterwards (CSRF-token fixation).
function rotateCsrfToken(req, res, options = {}) {
  try {
    if (!req || !req.session || typeof req.session !== 'object') return null;
    req.session.csrfToken = mintToken();
    return issueCsrfToken(req, res, options);
  } catch (_) {
    return null;
  }
}

// True when ANY known URL form of this request sits under an exempt prefix.
// `req.path` is relative to the mount point, `req.originalUrl`/`req.url` are
// absolute — checking all of them means the guard works whether it is mounted
// app-wide (`app.use(requireCsrf())`) or per-router (`router.use(...)`).
function isExemptPath(req, exemptPaths) {
  const paths = Array.isArray(exemptPaths) ? exemptPaths : DEFAULT_EXEMPT_PATHS;
  if (!paths.length) return false;
  const candidates = [];
  if (req) {
    if (typeof req.path === 'string') candidates.push(req.path);
    if (typeof req.originalUrl === 'string') {
      candidates.push(req.originalUrl);
      // Strip the query string so ?next=/webhook cannot fake an exemption.
      candidates.push(req.originalUrl.split('?')[0]);
    }
    if (typeof req.url === 'string') candidates.push(req.url.split('?')[0]);
    if (typeof req.baseUrl === 'string' && typeof req.path === 'string') {
      candidates.push(req.baseUrl + req.path);
    }
  }
  return paths.some((p) => {
    const prefix = String(p || '').toLowerCase();
    if (!prefix) return false;
    return candidates.some((c) => typeof c === 'string' && underPrefix(c, prefix));
  });
}

// Does `candidate` sit under `prefix` on a path-SEGMENT boundary? A plain
// startsWith() would also match a sibling route ('/webhooks-public' starts with
// '/webhook'), silently exempting a browser-facing endpoint that must be
// checked.
function underPrefix(candidate, prefix) {
  const c = candidate.toLowerCase();
  if (!c.startsWith(prefix)) return false;
  if (c.length === prefix.length) return true;
  return prefix.endsWith('/') || c[prefix.length] === '/';
}

// Express guard. Safe methods and exempt paths pass straight through; every
// other method must present a token matching req.session.csrfToken.
function requireCsrf(options = {}) {
  const opts = options || {};
  const exemptPaths = opts.exemptPaths || DEFAULT_EXEMPT_PATHS;
  return function csrfGuard(req, res, next) {
    try {
      const method = String((req && req.method) || 'GET').toUpperCase();
      if (safeMethods.has(method)) return next();
      if (isExemptPath(req, exemptPaths)) return next();

      const expected = (req && req.session && req.session.csrfToken) || '';
      // No server-side token means the caller never fetched /csrf, so there is
      // nothing valid to compare against.
      if (!expected) return res.status(403).json({ error: 'csrf_token_missing' });

      const presented = readPresentedToken(req);
      if (!presented || !timingSafeEqualStr(presented, expected)) {
        return res.status(403).json({ error: 'csrf_invalid' });
      }
      return next();
    } catch (_) {
      // Fail CLOSED: an internal error must never turn into "allow".
      try {
        return res.status(403).json({ error: 'csrf_invalid' });
      } catch (__) {
        return undefined;
      }
    }
  };
}

// Bootstrap endpoint the page calls on load: hands out a token + sets the
// mirror cookie. Mounted at /csrf (or /api/csrf).
const csrfRouter = express.Router();
csrfRouter.get('/csrf', (req, res) => {
  const token = issueCsrfToken(req, res);
  if (!token) return res.status(500).json({ error: 'csrf_unavailable' });
  return res.json({ csrfToken: token });
});

module.exports = {
  issueCsrfToken,
  rotateCsrfToken,
  csrfRouter,
  requireCsrf,
  safeMethods,
  timingSafeEqualStr,
  // Extras (used by the wiring/verification tasks and by unit tests).
  csrfCookieName: CSRF_COOKIE_NAME,
  exemptPaths: DEFAULT_EXEMPT_PATHS,
  isExemptPath: (req, paths) => isExemptPath(req, paths),
  readPresentedToken,
};
