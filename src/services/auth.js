// clinic-automation — admin credential check + session helpers (src/services/auth.js)
// Purpose: verify admin logins with bcrypt, manage the admin session.
// Consumed by: src/routes/admin.js (login/logout/me), src/middleware/auth.js
//   guards on `req.session.admin` — loginSession() below writes that shape.
//
// Credential sources (in order):
//   1. `users` table row for `username` (seeded on boot by src/db/db.js from
//      ADMIN_USERNAME / ADMIN_PASSWORD_HASH). bcrypt-compare the password.
//   2. Bootstrap fallback: if no DB row exists yet (fresh install before first
//      migrate, or users table wiped) AND `username` equals the configured
//      ADMIN_USERNAME, bcrypt-compare against ADMIN_PASSWORD_HASH from config.
//      This lets the very first login succeed so db.js can seed the row.
//
// Env: ADMIN_USERNAME / ADMIN_PASSWORD_HASH via src/config.js (.env).
//   Generate a hash: node -e "console.log(require('bcryptjs').hashSync('pw', 10))"
// PLAINTEXT BOOTSTRAP FALLBACK (documented, opt-in only): if ADMIN_PASSWORD_HASH
//   is absent/unset AND NODE_ENV !== 'production', the operator may set
//   ADMIN_PASSWORD_PLAIN='<temp password>' to allow a single bootstrap login;
//   the server logs a loud warning and the password must be replaced with a
//   bcrypt hash immediately afterwards. In production (or without the opt-in
//   var) a missing hash always fails closed — login returns false.
'use strict';

const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Constant-time string comparison for the plaintext bootstrap path below.
// `===` short-circuits on the first differing byte, so its running time leaks
// how many leading characters of the guess were correct — enough to recover
// ADMIN_PASSWORD_PLAIN one character at a time given enough attempts. This is
// the ONLY plaintext comparison in the app (the bcrypt path above is already
// constant-time by construction), so it is the only place this matters.
// Strategy: compare BYTE lengths first, then compare the bytes.
//
// Why lengths cannot be compared last: crypto.timingSafeEqual THROWS a RangeError
// ("Input buffers must have the same byte length") on a length mismatch, so the
// length test has to come first. Doing it first and returning immediately would
// re-open the very leak this function exists to close, so the mismatch branch
// still performs a timingSafeEqual of the same cost class as the equal-length
// path. That means a wrong-length guess is rejected only after real comparison
// work, instead of being rejected instantly.
//
// Byte length is still observable -- timingSafeEqual cannot hide how long the
// secret is, only how much of a guess is correct. That is accepted here because
// ADMIN_PASSWORD_PLAIN is an opt-in, non-production, temporary bootstrap
// credential (see header), not a long-lived secret; the bcrypt path above is
// the real credential check and leaks nothing.
function safeEqual(a, b) {
  // 'utf8' explicitly, on BOTH sides: Buffer.from(x) with no encoding would be
  // utf8 here too, but stating it keeps the two sides provably symmetric.
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) {
    // Burn a comparison before rejecting, so a length mismatch is not rejected
    // faster than an equal-length mismatch. Self-compare because
    // timingSafeEqual(bufA, bufB) would throw here.
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

// Compare a plaintext password against a stored hash. Returns false (never
// throws) on any mismatch, bad hash, or missing inputs — login must fail
// closed and must not leak *why* it failed via exceptions.
function compareToHash(password, hash) {
  try {
    if (!password || !hash) return false;
    // bcryptjs hashes start with $2a$/$2b$; anything else is not comparable.
    if (!/^\$2[aby]\$/.test(String(hash))) return false;
    return bcrypt.compareSync(String(password), String(hash));
  } catch (_) {
    return false;
  }
}

// Look up the stored bcrypt hash for a username: users table first, then the
// env bootstrap hash when the username matches the configured admin name.
// The read goes through users.passwordHashFor() — src/db/repository.js owns
// the SQL, so this service stays swappable to Postgres unchanged.
function findStoredHash(username) {
  if (!username) return null;
  try {
    const hash = require('../db/repository').users.passwordHashFor(username);
    if (hash) return { hash, source: 'db' };
  } catch (_) {
    // DB/users table unavailable (e.g. pre-migrate) — fall through to env.
  }
  try {
    const { getConfig } = require('../config');
    const cfg = getConfig();
    if (String(username) === String(cfg.adminUsername) && cfg.adminPasswordHash) {
      return { hash: cfg.adminPasswordHash, source: 'env-bootstrap' };
    }
  } catch (_) {
    // No config (no .env yet) — fail closed below.
  }
  return null;
}

// Sync boolean check — the shape src/routes/admin.js calls.
function verifyAdmin(username, password) {
  const found = findStoredHash(username);
  if (!found) return false;
  if (compareToHash(password, found.hash)) return true;
  // Opt-in plaintext bootstrap (see header). Non-production only.
  if (process.env.NODE_ENV !== 'production' && process.env.ADMIN_PASSWORD_PLAIN) {
    if (safeEqual(password, process.env.ADMIN_PASSWORD_PLAIN) && found.source === 'env-bootstrap') {
      console.warn('[auth] WARNING: plaintext ADMIN_PASSWORD_PLAIN bootstrap login used — set ADMIN_PASSWORD_HASH immediately.');
      return true;
    }
  }
  return false;
}

// Async variant returning the safe user object (id/username/role) or null.
// Preferred when callers need the user record, not just a boolean.
async function verifyCredentials(username, password) {
  if (!verifyAdmin(username, password)) return null;
  let id = null;
  let role = 'admin';
  try {
    // users.identityFor() is a { id, role } projection, NOT SELECT *, so the
    // bcrypt hash can never ride along into a session object.
    const row = require('../db/repository').users.identityFor(username);
    if (row) {
      id = row.id;
      role = row.role || 'admin';
    }
  } catch (_) {
    // OK — bootstrap login before the users table exists.
  }
  return { id, username: String(username), role };
}

// Session helpers — canonical shape is `req.session.admin` (what
// src/middleware/auth.js `requireAdmin` checks). `user` may be a username
// string or a { username, role } object.
function loginSession(req, user) {
  const username = typeof user === 'string' ? user : user && user.username;
  const role = (user && user.role) || 'admin';
  req.session.admin = { username, role, at: new Date().toISOString() };
  // Back-compat alias: older M2 drafts read `req.session.user`.
  req.session.user = req.session.admin;
}

function logoutSession(req, cb) {
  const done = typeof cb === 'function' ? cb : () => {};
  if (!req.session) return done();
  req.session.destroy(done);
}

// Returns the logged-in admin (or null). Accepts either session key.
function sessionUser(req) {
  return (req.session && (req.session.admin || req.session.user)) || null;
}
const sessionAdmin = sessionUser;

// safeEqual + compareToHash are exported so the constant-time comparison can be
// asserted directly by a test. A security property nobody can observe is not a
// security property: S9.4.2 requires the bootstrap path to use timingSafeEqual on
// equal-length buffers, and exporting the helper is what makes that checkable
// without going through a login attempt.
module.exports = { verifyAdmin, verifyCredentials, loginSession, logoutSession, sessionUser, sessionAdmin, safeEqual, compareToHash };
