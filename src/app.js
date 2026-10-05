// ============================================================================
// clinic-automation — Express wiring (src/app.js)
// Purpose: build the app (security headers, body parsing, sessions, static
// files, rate limiting, CSRF, route mounts, JSON error contract).
// Env: SESSION_SECRET, NODE_ENV, TRUST_PROXY, SESSION_TTL_HOURS, RATE_LIMIT_*_MAX
//      — all read through src/config.js, never directly here.
//
// SECURITY CONTRACT (why each piece is mounted where it is)
//   * securityHeaders() from ./middleware/security is applied to EVERY response
//     (static pages, JSON APIs and the 404 alike). It lives in its own module so
//     there is exactly one CSP, not two that can drift apart.
//   * Rate limiting is per public route, each with its OWN budget, built from the
//     config presets. Separate instances matter: a burst of availability lookups
//     must not eat a patient's booking budget.
//   * CSRF (./middleware/csrf) is mounted ONLY on the cookie-authenticated admin
//     surface — /api/admin, /api/clients, /api/import, /api/receipts. Those are
//     the endpoints where the browser silently attaches the session cookie, which
//     is the actual CSRF precondition. The public JSON APIs (/api/bookings,
//     /api/intake, /api/status) carry NO ambient credential, so there is nothing
//     for a cross-site page to borrow; they are protected by input validation and
//     rate limiting instead.
//   * CSRF is ENFORCED BY DEFAULT (fail closed). It is not opt-in: a security
//     control that is inert until someone flips an env var is not a control.
//     CSRF_ENFORCE=false exists only as a deliberate, loudly-logged escape hatch
//     for an operator who has proven they cannot send the header — and it
//     REALLY disables the guard (see csrfEnforced/csrfGuard below). An earlier
//     revision only printed "csrf OFF" in the boot log while leaving the guard
//     armed, which is worse than having no flag at all: the operator concludes
//     the control is off and ships, and is actually still being enforced.
//   * Route mounting is explicit and LOUD, and it separates the two failure modes
//     that the original code conflated into a silent skip. If a route file is NOT
//     on disk yet it is skipped and named in ONE warning; if the file IS on disk
//     and require() throws, the app refuses to boot, naming the prefix and
//     keeping the original error as `cause`. The original code swallowed
//     MODULE_NOT_FOUND from anywhere in the chain, so a typo could disable an
//     entire API and the app would still boot "green".
//   * EVERY remaining catch in this file is accounted for: in production it
//     re-throws, and outside production it degrades only after saying so loudly.
//     Do not add a catch that swallows an error and returns a working-looking
//     app — that is how a disabled security control becomes invisible.
// ============================================================================
'use strict';

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const session = require('express-session');
const { securityHeaders } = require('./middleware/security');
const { limitPerIp } = require('./middleware/rateLimit');
const { requireCsrf, csrfRouter } = require('./middleware/csrf');

// Paths that bypass the CSRF guard, with the reason for each. Matched on a path
// SEGMENT boundary (see isExemptPath/underPrefix in src/middleware/csrf.js).
const CSRF_EXEMPT_PATHS = [
  // Meta's Cloud API POSTs here from its own servers: it cannot send a custom
  // header, holds no session, and never reads the response — requiring CSRF
  // would reject every genuine inbound WhatsApp message. The route authenticates
  // itself with Meta's verify-token handshake instead, so there is no ambient
  // credential for a CSRF attack to borrow.
  '/webhook',
];
// NOTE: /api/admin/login is deliberately NOT exempt. Login-CSRF (an attacker
// silently logging the admin into an account the attacker controls, so the admin
// types their password into the attacker's session) is a real attack, and the
// guard costs the login page exactly one GET /csrf.

function csrfEnforced(cfg) {
  const raw = String(process.env.CSRF_ENFORCE || '').trim().toLowerCase();
  if (raw === 'false' || raw === '0' || raw === 'no') {
    // eslint-disable-next-line no-console
    console.warn(
      '[app] SECURITY: CSRF enforcement has been explicitly DISABLED via CSRF_ENFORCE.\n' +
      '        Admin mutations are now protected only by the SameSite=Lax session cookie.'
    );
    return false;
  }
  // Unset, empty, or any other value => enforced. Defaulting to ON is the point.
  return true;
}

// Load config, failing CLOSED. This used to fall back to the hardcoded, PUBLICLY
// KNOWN 'dev-only-fallback-secret-min-32-chars', so a broken .env silently
// produced admin sessions anybody could forge. In production we refuse to boot;
// outside production we mint a random per-process secret, which makes sessions
// merely non-persistent rather than forgeable.
function loadConfig() {
  try {
    return require('./config').getConfig();
  } catch (e) {
    if (process.env.NODE_ENV === 'production') {
      throw new Error(`[app] refusing to start: configuration is invalid — ${e.message}`);
    }
    // eslint-disable-next-line no-console
    console.warn(`[app] WARNING: configuration failed to load (${e.message}); running with DEGRADED settings.`);
    return {
      sessionSecret: crypto.randomBytes(32).toString('hex'),
      isProd: false,
      clinicName: 'Clinic',
      trustProxy: false,
      sessionTtlHours: 12,
      rateLimit: {},
    };
  }
}

// The SQLite-backed store (./services/sessionStore) replaces the unbounded
// MemoryStore, which leaks and drops every session on restart. If it cannot be
// loaded the app still boots OUTSIDE production, but says so loudly rather than
// pretending sessions are durable.
//
// In production this THROWS. The MemoryStore fallback is not a harmless
// convenience there: it is unbounded (the exact leak S9.7.4 exists to close)
// and it logs every member of staff out on each deploy. A clinic whose admin
// dashboard silently forgets its sessions is worse off than one that refuses to
// boot with a clear reason, so prod fails closed.
function buildSessionStore(cfg) {
  try {
    const { createSessionStore } = require('./services/sessionStore');
    if (typeof createSessionStore !== 'function') throw new Error('module does not export createSessionStore()');
    // The store's option is `ttlMs`, NOT `ttlHours`: sessionStore.js reads
    // options.ttlMs and never mentions ttlHours. Passing `ttlHours` was accepted
    // and silently discarded, so the store's own fallback TTL stayed pinned at
    // the 12h default no matter what SESSION_TTL_HOURS said. Convert here so the
    // fallback agrees with cookie.maxAge below instead of contradicting it.
    const ttlHours = Math.max(1, Number(cfg.sessionTtlHours) || 12);
    const store = createSessionStore({ ttlMs: ttlHours * 60 * 60 * 1000 });
    // eslint-disable-next-line no-console
    console.log('[app] session store: sqlite (src/services/sessionStore.js)');
    return { store, persistent: true };
  } catch (e) {
    if (cfg.isProd) {
      throw new Error(`[app] refusing to start: the SQLite session store is unavailable — ${e.message}`);
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[app] WARNING: SQLite session store unavailable (${e.message}); falling back to the DEFAULT\n` +
      '        MemoryStore — sessions will not survive a restart and are lost on deploy.'
    );
    return { store: undefined, persistent: false };
  }
}

// Does `mod` resolve to a real file? `require('./routes/clients')` succeeds for
// './routes/clients', './routes/clients.js' AND './routes/clients/index.js', so
// all three must be probed — testing only the extension-less form would report
// every single route as "missing" and silently boot with no API at all.
function resolveModuleFile(mod) {
  const base = path.join(__dirname, mod);
  for (const candidate of [base, `${base}.js`, path.join(base, 'index.js')]) {
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch (_) {
      // Not this one — keep probing.
    }
  }
  return null;
}

function createApp() {
  const cfg = loadConfig();
  const app = express();

  // Behind nginx/Caddy/Cloudflare set TRUST_PROXY=1 so req.ip is the real
  // client. Left false the app must NOT believe X-Forwarded-For, because a
  // client can set that header to anything.
  app.set('trust proxy', cfg.trustProxy);
  app.disable('x-powered-by');
  // isProd is passed EXPLICITLY so config.js stays the single source of truth for
  // it. Left to itself the middleware reads process.env.NODE_ENV, which is a
  // second, subtly different definition — and getConfig() caches, so the two can
  // disagree inside one process. Mounted before express.static() below, or the
  // HTML pages ship with no headers at all.
  app.use(securityHeaders({ isProd: cfg.isProd }));
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: true, limit: '1mb' }));

  const { store, persistent } = buildSessionStore(cfg);
  app.use(session({
    name: 'clinic.sid',
    secret: cfg.sessionSecret,
    store, // undefined => express-session's default MemoryStore
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: !!cfg.isProd,
      maxAge: Math.max(1, Number(cfg.sessionTtlHours) || 12) * 60 * 60 * 1000,
    },
  }));

  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.get(['/api/health', '/api/healthz'], (req, res) => res.json({ ok: true, sessions: persistent ? 'sqlite' : 'memory' }));

  // Token bootstrap for the browser double-submit. csrfRouter declares
  // `GET /csrf`, so it MUST be mounted at the root: `app.use('/csrf', router)`
  // strips that prefix and then looks for /csrf/csrf, leaving the admin page
  // with no way to obtain a token at all. The second mount reuses the same
  // router to expose /api/csrf (the '/api' prefix is stripped, so '/csrf'
  // matches again).
  app.use(csrfRouter);
  app.use('/api', csrfRouter);

  // One limiter INSTANCE per public route so budgets cannot be drained across
  // routes. Presets come from config (env-tunable via RATE_LIMIT_*_MAX).
  const preset = (name) => (cfg.rateLimit && cfg.rateLimit[name]) || {};
  const limiterFor = (name, label) => limitPerIp(Object.assign({ name: label }, preset(name)));
  // Login is the one brute-forceable route in the app, so it gets the strict
  // profile. Mounted on the PATH, not on '/api/admin', or it would also throttle
  // the dashboard and lock staff out mid-shift.
  app.use('/api/admin/login', limiterFor('strict', 'login'));

  // The CSRF guard, or a loud no-op when the operator has explicitly disabled
  // enforcement. The flag has to actually DO something: previously the return
  // value of csrfEnforced() was only interpolated into the boot log, so
  // CSRF_ENFORCE=false printed "csrf OFF" while the guard stayed armed.
  const csrfEnabled = csrfEnforced(cfg);
  const csrfGuard = csrfEnabled
    ? requireCsrf({ exemptPaths: CSRF_EXEMPT_PATHS })
    : function csrfDisabled(req, res, next) {
      // Per-request, not once at boot: the boot line scrolls away, this does not.
      // eslint-disable-next-line no-console
      console.warn(`[app] CSRF DISABLED — letting ${req.method} ${req.originalUrl} through unchecked`);
      return next();
    };
  // Local import to avoid a circular require at module load time.
  const requireAdminSession = (req, res, next) => require('./middleware/auth').requireAdmin(req, res, next);

  // Explicit route table: a missing or broken route file is a STARTUP ERROR, not
  // a silently degraded API. Middlewares are listed per prefix, session guard
  // FIRST so an anonymous caller is rejected with a plain 401 `unauthenticated`
  // before any CSRF bookkeeping runs. Reversing that order makes every anonymous
  // probe answer 403 `csrf_token_missing`, which both leaks CSRF state and hides
  // the fact that the caller simply is not logged in.
  const mounts = [
    ['/api/clients', './routes/clients', [requireAdminSession, csrfGuard]],
    // No session guard here ON PURPOSE: /login must be reachable by a caller who
    // has no session yet (that is the point of it), and routes/admin.js applies
    // requireAdmin to the routes that actually return data (/dashboard,
    // /export.csv). /me and /logout expose no patient data by design.
    ['/api/admin', './routes/admin', [csrfGuard]],
    ['/api/import', './routes/import', [requireAdminSession, csrfGuard]],
    ['/api/receipts', './routes/receipts', [requireAdminSession, csrfGuard]],
    // Public JSON APIs: no cookie credential => rate limit, not CSRF.
    ['/api/bookings', './routes/bookings', [limiterFor('standard', 'bookings')]],
    ['/api/intake', './routes/intake', [limiterFor('standard', 'intake')]],
    ['/api/status', './routes/status', [limiterFor('standard', 'status')]],
    ['/webhook', './routes/webhook', [limiterFor('relaxed', 'webhook')]],
    // Defence in depth. routes/reports.js already does `router.use(requireAdmin)`
    // (verified), but this is patient data, and it was the one admin entry in
    // this table carrying no middleware at all — which reads like an oversight
    // and once prompted a false P0 report. Declaring the guard here makes every
    // authenticated surface in this table uniform, so a future edit that drops
    // the in-router guard can no longer silently expose it.
    ['/api/reports', './routes/reports', [requireAdminSession]],
  ];
  // Collected across the loop and reported ONCE at the end, so a half-landed
  // boot produces a single actionable line instead of one per missing file.
  const missingRoutes = [];
  for (const [prefix, mod, middlewares] of mounts) {
    // TWO different failures, deliberately handled differently:
    //   * The file is not on disk yet  -> skip it, remember it, warn loudly once.
    //     Boot-order tolerance is the whole reason this loop tolerates anything,
    //     and a route still being written must not take the app down.
    //   * The file IS on disk and require() threw -> a real bug in shipped code.
    //     Booting anyway would 404 an entire API surface while reporting success,
    //     which is precisely the D5 failure mode. Refuse, and keep the cause.
    if (!resolveModuleFile(mod)) {
      missingRoutes.push(prefix);
      continue;
    }
    let loaded;
    try {
      loaded = require(mod);
    } catch (e) {
      // `cause` keeps the original stack, so a typo deep inside the route module
      // is still visible in the boot log instead of only its message.
      throw new Error(`[app] failed to load route ${mod} for ${prefix}: ${e.message}`, { cause: e });
    }
    app.use(prefix, ...middlewares, loaded.router || loaded);
  }
  if (missingRoutes.length) {
    // In production a missing route module is a deployment fault, not a
    // work-in-progress. Skipping it would boot "green" and serve a whole API
    // surface as 404 through the catch-all below — the exact D5 shape this
    // file's header says the loud mount exists to prevent. This mirrors the two
    // other production decisions here: bad config (:91) and an unavailable
    // session store (:126) both refuse to start.
    if (cfg.isProd) {
      throw new Error(
        `[app] refusing to start: ${missingRoutes.length} route module(s) are missing from disk, ` +
        `so their endpoints would 404: ${missingRoutes.join(', ')}`
      );
    }
    // eslint-disable-next-line no-console
    console.warn(
      `[app] WARNING: ${missingRoutes.length} route module(s) are not on disk yet, so they were ` +
      `SKIPPED and their endpoints will 404 until they land: ${missingRoutes.join(', ')}`
    );
  }
  // eslint-disable-next-line no-console
  console.log(`[app] mounted ${mounts.length - missingRoutes.length}/${mounts.length} route groups (csrf ${csrfEnabled ? 'enforced' : 'OFF'})`);

  // JSON 404 + error handler (fail-fast contract: { error } bodies).
  app.use('/api', (req, res) => res.status(404).json({ error: 'not_found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    if (status >= 500) console.error('[app] unhandled error:', err);
    // Once headers are out the response is committed, so the only correct move
    // is to hand the error to Express to destroy the socket.
    if (res.headersSent) return next(err);
    // A 5xx message is whatever the failing layer happened to say: it can carry
    // SQL fragments, absolute file paths, or "connect ECONNREFUSED 10.0.0.5:5432".
    // None of that belongs in a body the public can read, so in production a 5xx
    // collapses to a generic string. 4xx messages are authored by us and are the
    // API's contract, so they are passed through untouched.
    const message = status >= 500 && cfg.isProd ? 'internal_error' : (err.message || 'internal_error');
    return res.status(status).json({ error: message });
  });
  return app;
}

// Only createApp is public. `securityHeaders` used to be re-exported here, but
// nothing imported it from this module — the canonical import is
// require('./middleware/security'). Re-exporting it created a second path to the
// same middleware and invited the "which copy is mounted?" question that D5 was
// raised about.
module.exports = { createApp };