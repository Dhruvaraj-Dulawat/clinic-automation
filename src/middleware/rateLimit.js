// ============================================================================
// clinic-automation — per-IP rate limiting (src/middleware/rateLimit.js)
// Purpose: put a budget on the PUBLIC routes so POST /api/bookings cannot be
//   spammed (slot hoarding / notification flood) and GET /api/status cannot be
//   used to enumerate patients one number at a time.
// SCOPE — read before mounting: admin login ALREADY has its own brute-force
//   throttle (10 attempts / 10 min per IP) on the login route in
//   src/routes/admin.js. That route is deliberately NOT re-mounted here, so a
//   legitimate admin is never charged twice for the same request.
// ALGORITHM — FIXED WINDOW, one { count, resetAt } record per key. When
//   now >= resetAt the window restarts wholesale. A sliding log was rejected
//   on purpose: it costs O(requests) memory per key, so the flood this module
//   exists to stop is also what would make it leak. Fixed window is O(1) per
//   key and is what X-RateLimit-* headers describe.
// MEMORY BOUND — a limiter that leaks is worse than no limiter, so the bucket
//   map is (a) swept on an unref()'d interval and (b) hard-capped at MAX_KEYS
//   per limiter instance. An attacker rotating source IPs therefore evicts
//   their own oldest buckets instead of growing the heap.
// FAILURE MODE — every internal error FAILS OPEN (next()). A bug in the
//   limiter must never take the clinic's booking page offline.
// STATE — in-process only. A single-process deployment (this project) is
//   consistent with that; behind multiple instances this would need Redis.
// Deps: none. Zero npm packages, no db/config/express require — only Node
//   globals, so the module is safe to unit-test in isolation.
// ============================================================================
'use strict';

// Hard cap on tracked keys per limiter instance. Beyond this, expired keys
// are evicted first and then the oldest-inserted ones (Maps iterate in
// insertion order), so the footprint is bounded no matter how many IPs hit us.
const MAX_KEYS = 10000;

// How often expired buckets are swept. Unref()'d (see ensureSweeper) so the
// sweep can never be the reason the Node process stays alive.
const SWEEP_MS = 60 * 1000;

const DEFAULTS = {
  windowMs: 60 * 1000,
  max: 30,
  key: null,        // (req, res) => string bucket key; defaults to the client IP
  message: 'too_many_requests',
  skip: null,       // (req) => boolean; true bypasses counting entirely
  trustProxy: false, // honour X-Forwarded-For (only true behind a real proxy)
};

// Every live bucket store, plus the single sweep timer shared by all limiters.
// A Set (not one global Map) because two limitPerIp() calls must NOT share
// counters — a `standard` limiter and a `relaxed` limiter on different routes
// would otherwise evict and exhaust each other's buckets.
const stores = new Set();
let sweeper = null;

// Read a request header without caring how the caller cased it. Express
// lowercases req.headers, Node's raw header object is lowercased too, but a
// hand-rolled req or a non-Express mount may use HTTP title case — and a
// misspelled lookup here silently disables proxy-aware limiting, which is the
// kind of bug nobody notices until production. So probe all three spellings.
function header(req, name) {
  const h = (req && req.headers) || {};
  const direct = h[name];
  if (direct !== undefined && direct !== null) return direct;
  const lower = name.toLowerCase();
  const title = lower.replace(/(^|-)([a-z])/g, (_, sep, ch) => sep + ch.toUpperCase());
  for (const k of [lower, lower.toUpperCase(), title]) {
    const v = h[k];
    if (v !== undefined && v !== null) return v;
  }
  return '';
}

// The bucket key for a request. X-Forwarded-For is attacker-controlled unless
// a trusted proxy in front of us sets it, so it is honoured ONLY when the
// deployment opts in via `trustProxy` — otherwise anyone could dodge the limit
// forever with `X-Forwarded-For: <fresh-ip>`. When honoured, the FIRST entry of
// the chain is the original client; the rest are intermediate proxies.
function clientIp(req, trustProxy) {
  if (trustProxy) {
    const first = String(header(req, 'x-forwarded-for')).split(',')[0].trim();
    if (first) return first;
  }
  const direct = (req && req.ip) || (req && req.socket && req.socket.remoteAddress);
  return direct ? String(direct) : 'unknown';
}

// Drop every bucket whose window has already rolled over.
function sweepStore(store) {
  const now = Date.now();
  for (const [key, bucket] of store) {
    if (now >= bucket.resetAt) store.delete(key);
  }
}

// Enforce MAX_KEYS. Expired keys go first (they are pure garbage); if that is
// not enough, the oldest-inserted are dropped, because Map preserves insertion
// order. Recent, still-active buckets therefore survive a flood.
function enforceCap(store) {
  if (store.size <= MAX_KEYS) return;
  sweepStore(store);
  for (const key of store.keys()) {
    if (store.size <= MAX_KEYS) break;
    store.delete(key);
  }
}

// Start the shared sweep timer on first use (lazy, so merely requiring this
// module in a test or a CLI leaves no timer behind). unref() is the important
// part: an un-unref'd setInterval keeps the event loop alive forever and would
// hang `node --test` and any short-lived script.
function ensureSweeper() {
  if (sweeper) return;
  sweeper = setInterval(() => {
    for (const store of stores) sweepStore(store);
  }, SWEEP_MS);
  if (sweeper && typeof sweeper.unref === 'function') sweeper.unref();
}

// Count one request against `key`, starting a fresh window when the old one has
// expired. Returns the bucket so the caller can read count/resetAt.
function hit(store, key, windowMs, now) {
  let bucket = store.get(key);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + windowMs };
    store.set(key, bucket);
  }
  bucket.count += 1;
  enforceCap(store);
  return bucket;
}

// TRUST_PROXY is the deployment-wide switch (src/config.js reads the same key
// into cfg.trustProxy, which src/app.js hands to `app.set('trust proxy')`).
// Reading it here too means this module is correct STANDALONE — a route that
// forgets to pass the option still buckets by the real client instead of
// collapsing every request behind the reverse proxy into one shared bucket.
// Only the four conventional negatives read as false, so TRUST_PROXY=1 / true /
// yes / on all enable it.
function envTrustProxy() {
  try {
    const v = process.env.TRUST_PROXY;
    if (v === undefined || v === null || v === '') return false;
    const s = String(v).trim().toLowerCase();
    return !(s === '0' || s === 'false' || s === 'no' || s === 'off');
  } catch (_) {
    return false;
  }
}

// Coerce caller options, falling back to DEFAULTS for anything nonsensical
// (negative window, NaN, zero/negative max) so a config typo degrades into a
// working limiter rather than a module that throws on every request.
function resolveOptions(options) {
  const given = options || {};
  const opts = Object.assign({}, DEFAULTS, given);
  const windowMs = Number.isFinite(opts.windowMs) && opts.windowMs > 0
    ? Math.floor(opts.windowMs) : DEFAULTS.windowMs;
  const max = Number.isFinite(opts.max) && opts.max > 0
    ? Math.floor(opts.max) : DEFAULTS.max;
  // Explicitness must be judged on the CALLER's object, not the merged one:
  // DEFAULTS.trustProxy is itself a boolean, so testing the merged value would
  // always report "explicitly set to false" and TRUST_PROXY could never win.
  const explicitProxy = typeof given.trustProxy === 'boolean' ? given.trustProxy : null;
  return {
    windowMs,
    max,
    key: typeof opts.key === 'function' ? opts.key : null,
    skip: typeof opts.skip === 'function' ? opts.skip : null,
    message: String(opts.message || DEFAULTS.message),
    // An EXPLICIT boolean always wins (a test or a caller may want to disagree
    // with the environment). Only when the caller stayed silent does
    // TRUST_PROXY decide, which keeps a bare limitPerIp({}) working as before.
    trustProxy: explicitProxy === null ? envTrustProxy() : explicitProxy,
  };
}

// Build a rate-limiting middleware. Usage in src/app.js / a route:
//   router.use(limitPerIp({ ...limiters.standard }));
// Options: { windowMs, max, key, message, skip, trustProxy } — all optional.
// `trustProxy` defaults to the TRUST_PROXY env var (see envTrustProxy).
//
// --- HOW THIS INTERACTS WITH EXPRESS `app.set('trust proxy')` ----------------
// Express ALREADY resolves X-Forwarded-For into req.ip when trust proxy is on,
// so in the normal wiring this module simply reads req.ip and never looks at
// the header itself. The trustProxy option only matters when the middleware is
// mounted somewhere req.ip is NOT already trust-aware.
// The footgun to avoid: turning trustProxy on here while Express still has
// trust proxy OFF makes this module read the client-supplied XFF[0] directly,
// which is attacker-controlled and lets anyone mint a fresh bucket per request.
// Both switches are driven by the same TRUST_PROXY env var precisely so they
// cannot drift apart.
function limitPerIp(options) {
  const { windowMs, max, key: keyFn, skip: skipFn, message, trustProxy } = resolveOptions(options);
  // Per-instance store: keeps counters isolated between limiters.
  const store = new Map();
  stores.add(store);
  ensureSweeper();

  return function rateLimit(req, res, next) {
    // Exempt traffic (webhook health pings, CORS preflight, uptime probes) is
    // neither counted nor given budget headers — it has no budget to spend.
    // A throwing skip() is treated as "do not skip" rather than a 500.
    if (skipFn) {
      try {
        if (skipFn(req)) return next();
      } catch (_) { /* fall through to normal limiting */ }
    }

    // Decide inside the try, act outside it. If next() itself throws (a
    // downstream handler blew up) we must NOT re-enter next() from the catch,
    // or the request gets handled twice.
    let bucket = null;
    let key = null;
    try {
      const ip = clientIp(req, trustProxy);
      // A custom key() lets a route budget by phone/appointment instead of IP.
      // If it throws we still want to limit, so fall back to the IP bucket.
      try {
        key = keyFn ? String(keyFn(req, res) || ip) : ip;
      } catch (_) {
        key = ip;
      }
      bucket = hit(store, key, windowMs, Date.now());
    } catch (_) {
      return next(); // fail OPEN
    }

    // Budget headers go out on ALLOWED requests too: a well-behaved client can
    // see the remaining quota and back off before it hits the wall, instead of
    // discovering the limit only via a 429. Best-effort: a response object
    // that cannot take headers must not fail the request.
    try {
      if (res && typeof res.setHeader === 'function') {
        res.setHeader('X-RateLimit-Limit', String(max));
        res.setHeader('X-RateLimit-Remaining', String(Math.max(0, max - bucket.count)));
        res.setHeader('X-RateLimit-Reset', String(Math.ceil(bucket.resetAt / 1000)));
        if (bucket.count > max) {
          // Whole seconds until the window rolls over, floored at 1s: a
          // Retry-After of 0 invites a tight retry loop that keeps the client
          // blocked forever.
          res.setHeader('Retry-After', String(Math.max(1, Math.ceil((bucket.resetAt - Date.now()) / 1000))));
        }
      }
    } catch (_) { /* headers are advisory */ }

    if (bucket.count > max) {
      try {
        return res.status(429).json({ error: message });
      } catch (_) {
        return next(); // response already gone; do not hang the socket
      }
    }
    return next();
  };
}

// Ready-made budgets. These are frozen option bags — spread them into
// limitPerIp so you can still add trustProxy/skip on top.
const limiters = Object.freeze({
  strict: Object.freeze({ windowMs: 10 * 60 * 1000, max: 10 }),   // admin-ish / sensitive
  standard: Object.freeze({ windowMs: 60 * 1000, max: 30 }),     // public GET + POST
  relaxed: Object.freeze({ windowMs: 60 * 1000, max: 300 }),     // webhook inbound from Meta
});

// Test seam: clear every counter and drop the sweep timer. Existing middleware
// keeps working (its store is emptied, not destroyed); the timer re-arms
// lazily on the next limitPerIp() call.
function _reset() {
  for (const store of stores) store.clear();
  if (sweeper) {
    clearInterval(sweeper);
    sweeper = null;
  }
}

module.exports = { limitPerIp, limiters, clientIp, _reset };

// ---------------------------------------------------------------------------
// Compatibility aliases (kept so both naming conventions work).
//   rateLimit({windowMs, max}) -> limitPerIp({windowMs, max})
//   resetRateLimits()          -> _reset()
// `name` is accepted for readability only and deliberately NOT turned into a
// key: each limitPerIp() call already owns an isolated counter store, and the
// client identity comes from clientIp(). (Mapping a name to the key would make
// every caller share ONE bucket, i.e. a global instead of a per-IP limit.)
// src/app.js and tests/security.test.js use the shorter names; both resolve to
// the SAME implementation — one code path, one set of counters.
// ---------------------------------------------------------------------------
function rateLimit(options = {}) {
  const { name, bucket, ...rest } = options || {};
  return limitPerIp(rest);
}

module.exports.rateLimit = rateLimit;
module.exports.resetRateLimits = _reset;
