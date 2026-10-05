// ============================================================================
// clinic-automation â€” HTTP security headers (src/middleware/security.js)
// Purpose: attach a browser-hardening header set to EVERY response, including
//   the static pages and the JSON 404, so a stolen phone number or an XSS in
//   any page cannot be escalated into clickjacking, MIME sniffing, referrer
//   leakage or framing of a page that shows patient medical data.
// Deps: express only. Every value is overridable through the options object, so
//   this module can be unit tested without booting the app.
// Mount: app.use(securityHeaders()) â€” BEFORE express.static(), otherwise static
//   assets are served without the headers (src/app.js wires this in M9).
//
// --- THE `disable` OPTION: HOW A NAME IS RESOLVED, AND WHAT HAPPENS ON A TYPO -
// SYNC-5. `disable` used to be compared against the emitted header names with a
// raw Set lookup, so ONLY an exact, full, correctly-cased name ever matched.
// 'CSP', 'csp', 'hsts' and 'content-security-policy' were all accepted and
// silently discarded while the header stayed on the response. That is the worst
// failure mode available to a security control: the operator believes the header
// is off when it is on, and nothing in the response contradicts them.
//
// A name is now resolved by canonicalHeaderName(): trimmed, expanded through
// DISABLE_ALIASES if it is a known shorthand, then lower-cased. HTTP header
// names are case-insensitive by specification, so matching is too. Both sides of
// every comparison go through that one function, so a name cannot match the skip
// set but fail the is-this-a-real-header check.
//
// THE CHOICE FOR AN UNRECOGNISED NAME: THROW, AT FACTORY TIME. The brief allowed
// either "omit it and make it visible" or "reject it loudly"; this module throws.
//   * It throws rather than warns because a warn is easy to miss in a noisy boot
//     log, and the consequence of missing it is a header left ON. The whole point
//     of SYNC-5 is that "the opt-out looked like it worked" is the unacceptable
//     outcome; a warning reproduces that outcome one layer up, in the log.
//   * It throws AT FACTORY TIME (once per app, not per request) rather than per
//     response, so the failure is a startup crash an operator cannot miss rather
//     than a per-request penalty.
//   * Cost, accepted deliberately: a typo in the `disable` list at the mount site
//     takes the app down at boot instead of starting with the header still on.
//     For a clinic app whose pages carry patient phone numbers, refusing to start
//     is the correct side to fail on.
//   * Canonical names always work, so the fix for the crash is always in the error
//     message: the unknown entry is quoted back and the emittable set is listed.
// If this ever needs to change, it must change to a loud warning AND the error
// text AND tests/security.test.js must change together.
// ============================================================================
'use strict';

// --- CSP defaults ------------------------------------------------------------
// AUDITED against every file in public/ (index/booking/status/admin.html,
// js/{booking,status,admin,reports}.js, css/style.css). Findings that let us
// keep this policy strict â€” i.e. with NO 'unsafe-inline' anywhere:
//
//   * Scripts are EXTERNAL files (/js/*.js) and there is not one inline
//     <script> block or on*= handler in any page  -> script-src 'self'.
//   * There is not one style= attribute in the HTML and not one `.style.`,
//     setAttribute('style', ...) or cssText assignment in the JS (markup is
//     built with class names only)                      -> style-src 'self'.
//   * style.css has no url(), no @import and no @font-face, so no external
//     font/image origin is ever needed                -> font-src 'self'.
//   * Every fetch() targets a relative /api/* path; the WhatsApp webhook is a
//     SERVER-side node fetch and never runs in the browser
//                                                       -> connect-src 'self'.
//   * No page references an absolute http(s) URL       -> no external origin.
//
// NOTE on innerHTML: admin.js, reports.js, booking.js and status.js all build
// markup with innerHTML. That is deliberately NOT covered by script-src (CSP
// governs script *execution*, not HTML parsing), so it does NOT require
// 'unsafe-inline'. Do not "fix" it by weakening script-src â€” use textContent
// or Trusted Types instead.
//
// Do NOT add require-trusted-types-for 'script' here: every innerHTML call
// site would start throwing until the frontend declares a Trusted Types policy.
const CSP_DEFAULTS = {
  defaultSrc: ["'self'"],
  scriptSrc: ["'self'"],
  styleSrc: ["'self'"],
  imgSrc: ["'self'", 'data:'],
  fontSrc: ["'self'"],
  connectSrc: ["'self'"],
  formAction: ["'self'"],
  frameSrc: ["'none'"],
  objectSrc: ["'none'"],
  baseUri: ["'self'"],
  frameAncestors: ["'none'"],
};

// The non-CSP headers and the reason each one is here.
const DEFAULT_HEADERS = {
  // Clickjacking: the admin dashboard and booking forms must never be framed
  // by an attacker's page. frame-ancestors 'none' in the CSP says the same
  // thing for CSP-aware browsers; X-Frame-Options covers the rest.
  'X-Frame-Options': 'DENY',
  // Stops a browser second-guessing Content-Type, which would let an uploaded
  // .txt or .json response be treated as script.
  'X-Content-Type-Options': 'nosniff',
  // Pages here carry a phone number as a query string (?phone=+9198â€¦). Without
  // this, navigating away would leak it in the Referer header to any external
  // site the patient clicks through to.
  'Referrer-Policy': 'no-referrer',
  // No speculative DNS lookups for the (currently empty) set of external links.
  'X-DNS-Prefetch-Control': 'off',
  // The clinic site needs no camera, microphone or geolocation at all.
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};

// Sent in production only: over plain http the header is ignored anyway, and in
// local dev it would poison localhost in the browser's HSTS cache.
const DEFAULT_HSTS = 'max-age=31536000; includeSubDomains';

// Pick the first usable value, so an option can be set to null/'' to drop a
// directive without having to pass `disable`.
function pick(value, fallback) {
  return value === undefined ? fallback : value;
}

// A source list is a string or an array. An emptied list means "block it
// completely", which in CSP is spelled 'none' â€” emitting a bare `img-src` (no
// value at all) would be an INVALID directive and browsers reject the policy.
function normalizeSources(list) {
  if (Array.isArray(list)) {
    const kept = list.map((v) => String(v).trim()).filter(Boolean);
    return kept.length ? kept : ["'none'"];
  }
  const one = String(list === undefined || list === null ? '' : list).trim();
  return one ? [one] : ["'none'"];
}

// Join the directives into one header value: single line, '; ' separated, with
// no empty segments and no trailing semicolon (all of which some proxies and
// header parsers treat as a malformed policy).
function joinDirectives(directives) {
  return directives
    .filter(Boolean)
    .map((parts) => `${parts[0]} ${normalizeSources(parts[1]).join(' ')}`)
    .join('; ');
}

/**
 * Build the Content-Security-Policy string. Exported so it can be asserted
 * directly in a unit test without an HTTP round-trip.
 * @param {object} [options] - any CSP_DEFAULTS key overrides, plus
 *   `useUnsafeInlineStyles` (adds 'unsafe-inline' to style-src ONLY).
 * @returns {string} single-line policy
 */
function buildCsp(options) {
  const opts = options || {};
  const styleSrc = normalizeSources(pick(opts.styleSrc, CSP_DEFAULTS.styleSrc));
  // Opt-in escape hatch for a future templated page that sets style="" at
  // runtime. Style-only: scripts must never receive 'unsafe-inline'.
  if (opts.useUnsafeInlineStyles && !styleSrc.includes("'unsafe-inline'")) {
    styleSrc.push("'unsafe-inline'");
  }
  return joinDirectives([
    ['default-src', pick(opts.defaultSrc, CSP_DEFAULTS.defaultSrc)],
    ['base-uri', pick(opts.baseUri, CSP_DEFAULTS.baseUri)],
    ['object-src', pick(opts.objectSrc, CSP_DEFAULTS.objectSrc)],
    ['frame-ancestors', pick(opts.frameAncestors, CSP_DEFAULTS.frameAncestors)],
    ['frame-src', pick(opts.frameSrc, CSP_DEFAULTS.frameSrc)],
    ['form-action', pick(opts.formAction, CSP_DEFAULTS.formAction)],
    ['script-src', pick(opts.scriptSrc, CSP_DEFAULTS.scriptSrc)],
    ['style-src', styleSrc],
    ['img-src', pick(opts.imgSrc, CSP_DEFAULTS.imgSrc)],
    ['font-src', pick(opts.fontSrc, CSP_DEFAULTS.fontSrc)],
    ['connect-src', pick(opts.connectSrc, CSP_DEFAULTS.connectSrc)],
  ]);
}

// Resolve isProd. An explicit option always wins; otherwise mirror config.js's
// own definition (isProd === NODE_ENV === 'production') by reading NODE_ENV
// directly.
//
// Deliberately NOT `require('../config').getConfig().isProd`: getConfig() caches
// its result in a module-level variable, so the value would be a snapshot taken
// whenever config was FIRST loaded. In a test process (or any process that
// touches config before NODE_ENV is final) that snapshot sticks and HSTS is
// silently wrong. Reading NODE_ENV keeps this module dependency-free and
// side-effect-free â€” requiring config would also pull in dotenv.
// src/app.js should pass `isProd: cfg.isProd` when it mounts the middleware, so
// production still has config.js as the single source of truth.
function resolveIsProd(explicit) {
  if (typeof explicit === 'boolean') return explicit;
  return process.env.NODE_ENV === 'production';
}

// Shorthand spellings accepted in `disable`, because these are the names an
// operator actually types. HTTP header names are case-insensitive, so 'csp' and
// 'CSP' must behave identically â€” before this table they were accepted and
// silently ignored (SYNC-5), which is worse than not offering the option at
// all: an operator would believe a header was off while it was still on.
const DISABLE_ALIASES = {
  csp: 'Content-Security-Policy',
  'csp-report-only': 'Content-Security-Policy-Report-Only',
  hsts: 'Strict-Transport-Security',
  'x-frame-options': 'X-Frame-Options',
  'x-content-type-options': 'X-Content-Type-Options',
  'referrer-policy': 'Referrer-Policy',
  'x-dns-prefetch-control': 'X-DNS-Prefetch-Control',
  'permissions-policy': 'Permissions-Policy',
  // The short names people actually type. Header lookups are lower-cased, so
  // a camelCase key can never match — hence the explicit camelCase entry.
  xfo: 'X-Frame-Options',
  frame: 'X-Frame-Options',
  nosniff: 'X-Content-Type-Options',
  referrer: 'Referrer-Policy',
  permissions: 'Permissions-Policy',
  dnsPrefetch: 'X-DNS-Prefetch-Control',
  dnsprefetch: 'X-DNS-Prefetch-Control',
  'dns-prefetch': 'X-DNS-Prefetch-Control',
};

/**
 * Canonical, comparable form of a header name: lower-cased, with the shorthand
 * spellings in DISABLE_ALIASES expanded to the real header name.
 *
 * Both sides of every comparison in securityHeaders() go through this, so a
 * name can never match the skip set and then miss the "is this a header we
 * actually emit" check, or vice versa. Deriving the two forms separately is
 * how a disable entry ends up disabling nothing while looking like it worked.
 *
 * Non-strings and blanks map to '', which matches no emitted header, so the
 * caller ignores them instead of reporting them as typos.
 *
 * @param {*} name a header name in any case, or a documented alias
 * @returns {string} the lower-cased canonical name; '' for nullish/blank input
 */
function canonicalHeaderName(name) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';
  return String(DISABLE_ALIASES[trimmed.toLowerCase()] || trimmed).toLowerCase();
}

/**
 * Express middleware factory that sets the security headers and continues.
 * @param {object} [options] - `headers` (extra/replacement headers),
 *   `disable` (array of header names to skip, matched case-insensitively and
 *   accepting the shorthands in DISABLE_ALIASES), `csp` (pre-built policy
 *   string), `isProd`, `hsts`, `reportOnly`, plus every buildCsp() option.
 * @returns {function} (req, res, next) middleware
 */
function securityHeaders(options) {
  const opts = options || {};
  const isProd = resolveIsProd(opts.isProd);

  // Built once per app, not per request: the policy is static configuration.
  const csp = pick(opts.csp, buildCsp(opts));
  const hstsValue = opts.hsts === undefined ? DEFAULT_HSTS : opts.hsts;
  const extra = opts.headers || {};

  const built = Object.assign({}, DEFAULT_HEADERS, extra);
  if (isProd) built['Strict-Transport-Security'] = hstsValue;
  // The policy rides in a dedicated slot so report-only mode cannot leak an
  // enforcing header (and vice versa).
  if (opts.reportOnly) built['Content-Security-Policy-Report-Only'] = csp;
  else built['Content-Security-Policy'] = csp;

  // `disable` is matched CASE-INSENSITIVELY, because HTTP header names are
  // themselves case-insensitive: an operator who writes `disable: ['csp']` or
  // `['CSP']` means exactly the same control as `['Content-Security-Policy']`.
  // The previous exact-match `skip.has(name)` accepted those spellings and
  // silently ignored them, so the header stayed ON while the caller believed it
  // was OFF. A security control that quietly fails to stand down is worse than
  // one that is absent, because the operator's model of their own defences is
  // now wrong - and nothing in the response says so.
  //
  // Matching case-insensitively is the compatible direction: every name that
  // worked before still works, and the spellings that used to fail open now do
  // what the caller asked for.
  //
  // Case-folding ALONE is not enough, though, and this is the part that is easy
  // to get wrong: 'CSP' is an ABBREVIATION of 'Content-Security-Policy', not a
  // case variant of it, so lowercasing reconciles 'csp' with
  // 'content-security-policy' but never with 'CSP' -> it is a different string.
  // An operator who writes `disable: ['CSP']` - the single most natural way to
  // write it - would still get the header. Hence the alias table.
  const requested = [
    ...(opts.disable || []),
    ...(opts.reportOnly ? ['Content-Security-Policy'] : []),
  ];
  // Blank / non-string entries are not attempts to disable anything, so they are
  // ignored rather than treated as typos (resolveDisabled() has always done this).
  const meaningful = requested.filter((n) => typeof n === 'string' && n.trim());
  const skip = new Set(meaningful.map(canonicalHeaderName));

  // A name matching no header this middleware emits can never disable anything,
  // so `disable: ['Content-Security-Policys']` (typo) or `disable: ['CSP2']`
  // would otherwise pass as a successful opt-out: the header stays ON while the
  // operator believes it is OFF.
  //
  // It THROWS, loudly and with a stable `code`. A console warning is trivially
  // lost in boot noise, and the failure it reports — a security header silently
  // left ON — is exactly the kind that must not pass unnoticed. Throwing at
  // factory time (once per app, not per request) makes the mistake impossible
  // to ship: the app refuses to start until the name is corrected.
  const emitted = new Set(
    [...Object.keys(built), ...Object.keys(DEFAULT_HEADERS),
      'Content-Security-Policy', 'Content-Security-Policy-Report-Only',
      'Strict-Transport-Security'].map(canonicalHeaderName)
  );
  for (const name of meaningful) {
    if (emitted.has(canonicalHeaderName(name))) continue;
    const err = new Error(
      `[security] securityHeaders: disable "${name}" matched no header this `
      + 'middleware emits, so nothing was disabled for it. This app emits: '
      + `${[...emitted].sort().join(', ')}`
    );
    err.code = 'SECURITY_HEADER_DISABLE_UNKNOWN';
    throw err;
  }

  return function securityHeadersMiddleware(req, res, next) {
    for (const [name, value] of Object.entries(built)) {
      if (skip.has(canonicalHeaderName(name))) continue;
      // String() because setHeader throws on undefined â€” that would turn a
      // mis-set custom header into a 500 on every request.
      res.setHeader(name, String(value));
    }
    return next();
  };
}

module.exports = { securityHeaders, buildCsp };
