// ============================================================================
// clinic-automation — public status lookup (src/routes/status.js)
//   GET /api/status?phone=+9198…&last4=3210
//
// AUTHORIZATION RULE: BOTH parameters are mandatory. The caller must supply the
// phone number AND the last 4 digits of that number. `last4` used to be
// optional, so a bare `?phone=` lookup returned a patient's name, phone and full
// appointment history (statuses, services, visit dates) to anyone who knew or
// guessed the number — medical records served without verification. That is the
// bug this module now refuses.
//
// NO USER ENUMERATION: unknown phone, wrong last4, missing last4, malformed
// last4 and a phone that normalizes to a bare "+" all return ONE byte-identical
// response — 404 { error: 'no appointments found for these details' } — so the
// endpoint cannot be used to discover which numbers are registered. The single
// exception is a completely ABSENT `?phone=` parameter, which is answered 400
// '?phone= is required': that is a statement about the shape of the request
// rather than about any patient, and no client lookup happens, so it is
// identical for registered and unregistered numbers. The comparison is also run
// against a dummy value when the number is unknown, so response TIME does not
// leak existence either.
//
// CONSTANT-TIME: last4 is compared with crypto.timingSafeEqual (no early exit
// on content), after a length guard because timingSafeEqual throws on unequal
// buffer lengths. It must be EXACTLY 4 digits and is never truncated — a
// 12-digit "last4" is rejected outright rather than silently compared on its
// final 4 characters.
//
// PAYLOAD MINIMITY: client { id, name, phone } plus that client's own
// appointments only. Never notes, email or intake answers.
//
// RATE LIMITING: none here — src/app.js mounts a per-IP limiter on /api/status
// (see its mounts table). Mounted there as `app.use('/api/status', router)`,
// which is why `module.exports = router` must stay the router itself.
// Deps: express, crypto, ../db/repository.js (clients, appointments,
//   normalizePhone).
// ============================================================================
'use strict';

const express = require('express');
const crypto = require('crypto');
// Namespaced repository contract (M1): clients + appointments.findByPhone.
const { clients, appointments, normalizePhone } = require('../db/repository');

const router = express.Router();

// The one body every rejected lookup gets. Kept as a constant so the response
// cannot drift apart between branches.
const NOT_FOUND = { error: 'no appointments found for these details' };

/**
 * Constant-time check that `last4` is the last 4 digits of `phone`.
 * @param {string} phone  stored (normalized) phone number
 * @param {*} last4       caller-supplied code, stripped of non-digits
 * @returns {boolean}     true only for an exact 4-digit match
 */
function tokensMatchLast4(phone, last4) {
  // Exactly 4 digits, no more and no fewer. Stripping happens first so "32 10"
  // is accepted, but an 8- or 12-digit value is rejected rather than truncated.
  const candidate = String(last4 == null ? '' : last4).replace(/\D/g, '');
  if (!/^\d{4}$/.test(candidate)) return false;

  const digits = String(phone == null ? '' : phone).replace(/\D/g, '');
  if (digits.length < 4) return false;

  const expected = Buffer.from(digits.slice(-4), 'utf8');
  const provided = Buffer.from(candidate, 'utf8');
  // timingSafeEqual THROWS when the buffers differ in length, so the length
  // guard has to come first. Both are 4 bytes by here — this is a hard
  // requirement of the API, not a guess about the input.
  if (expected.length !== provided.length) return false;
  return crypto.timingSafeEqual(expected, provided);
}

router.get('/', (req, res) => {
  try {
    // Only a totally absent parameter is a 400 — it says nothing about any
    // patient. Everything below is the uniform 404.
    if (req.query.phone === undefined) return res.status(400).json({ error: '?phone= is required' });

    const phone = normalizePhone(req.query.phone);
    const last4 = String(req.query.last4 == null ? '' : req.query.last4).replace(/\D/g, '');
    const client = clients.findByPhone(phone);

    // Run the comparison even when the number is unknown, against a dummy, so
    // the amount of work (and therefore the latency) is identical whether or not
    // the number is registered. A short-circuit here would hand back a timing
    // oracle that defeats the identical-body guarantee.
    const matched = tokensMatchLast4(client ? client.phone : '+0000000000', last4);

    // One response for every failure: unknown number, wrong code, missing or
    // malformed code, or a phone that normalizePhone() degraded to a bare "+".
    if (!client || !matched) return res.status(404).json(NOT_FOUND);

    res.json({
      client: { id: client.id, name: client.name, phone: client.phone },
      // Called as-is: the repository owns the SQL and caps the list (LIMIT 20).
      appointments: appointments.findByPhone(client.phone),
    });
  } catch (err) {
    res.status(500).json({ error: String(err.message || err) });
  }
});

// Test hook: the pure comparison, unit-testable without HTTP or a database.
// Same pattern as src/routes/webhook.js (module.exports.tokensEqual).
module.exports = router;
module.exports.tokensMatchLast4 = tokensMatchLast4;
module.exports._tokensMatchLast4 = tokensMatchLast4;