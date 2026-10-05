// clinic-automation — client CRUD API (src/routes/clients.js)
// Routes (all admin-guarded via requireAdmin, mounted at /api/clients):
//   GET    /            list (latest first) or search with ?search= / ?q=
//   GET    /:id         single client or 404
//   POST   /            create { name, phone, email?, tags?, notes? } -> 201
//   PUT    /:id         update name/phone/email/tags/notes (merged)
//   PATCH  /:id         partial update (name/email/tags/notes)
//   POST   /:id/tags    { tag } — append one tag (dedupe, comma-separated)
//   DELETE /:id         DEACTIVATE (active=0). Never a hard delete.
//   POST   /:id/restore      reactivate (active=1)
//   POST   /:id/anonymize    scrub PII, keep the row
// This file contains NO SQL — every read/write goes through the repository
// (src/db/repository.js), which is the single swap point for a future
// Postgres migration. Phones are normalized by the repository; a duplicate
// phone -> 409 { error }.
//
// --- D4 (retention semantics) -------------------------------------------------
// `clients` gained `active`, `deactivated_at` and `anonymized` in migration 002,
// and appointments.client_id is ON DELETE RESTRICT. A hard DELETE on a client
// with history therefore now raises SQLITE_CONSTRAINT instead of cleaning up,
// so the route layer must never ask for one:
//   * DELETE  -> active=0. No appointment is touched, receipts/reports/intake
//     stay auditable, and no FK is violated.
//   * A client with an UPCOMING booked/confirmed appointment cannot be
//     deactivated (409): that would silently vanish a patient who is expected.
//   * GET / still returns inactive rows, each carrying `active` (1/0), so the
//     admin can see and reverse the decision.
//
// --- COLUMN-BACKED LIFECYCLE, NOT TAGS ----------------------------------------
// The three mutating lifecycle endpoints are all COLUMN-backed: they drive
// clients.active / deactivated_at / anonymized, which is what the retention
// policy and the admin UI actually read.
//   DELETE /:id            -> clients.setActive(id, 0)  (stamps deactivated_at)
//   POST   /:id/restore    -> clients.setActive(id, 1)  (clears  deactivated_at)
//   POST   /:id/anonymize  -> clients.anonymize(id)     (scrubs PII, keeps row)
// repository.clients.deactivate() still exists and still pushes the string
// 'inactive' into the TAGS column. It is deliberately NOT called from here: a tag
// is editable by the admin UI, so a tag-based "delete" is reversible by anyone
// with edit rights and never satisfies the retention request it appears to. The
// column-backed accessor is the only thing that can be relied on.
//
// These three accessors are REQUIRED. If they are ever absent again (a revert,
// a bad merge) the endpoints answer 501 naming the missing accessor rather than
// falling back to something that looks like it worked — a 200 that changed
// nothing is the one failure an operator cannot detect.
//
// NOTE: the clients table has no `consent` column — a `consent` key in a
// PATCH body is accepted-and-ignored (intake consent lives in M4
// intake_responses, not on the client row).
'use strict';

const express = require('express');
const { requireAdmin } = require('../middleware/auth');
const repo = require('../db/repository');
const dt = require('../services/datetime');

const { clients, appointments } = repo;

const router = express.Router();
router.use(requireAdmin);

// Statuses that mean "this patient is expected to walk in". Deactivating a
// client who still has one of these is refused. Mirrors the 'booked','confirmed'
// filter in repository.appointments.findUpcoming.
const UPCOMING_STATUSES = new Set(['booked', 'confirmed']);

// --- Required-accessor guard -------------------------------------------------
// See the COLUMN-BACKED LIFECYCLE header. Resolved once at module load (the
// repository's namespaces are plain frozen-in-practice objects, so this cannot
// go stale within a process) and reported through a single warning per missing
// name rather than one line per request.
const HAS = {
  setActive: typeof clients.setActive === 'function',
  anonymize: typeof clients.anonymize === 'function',
};
const warned = new Set();
function warnMissing(name) {
  if (warned.has(name)) return;
  warned.add(name);
  console.warn(
    `[clients] repository.clients.${name} is missing — ${name} endpoints answer 501. `
    + 'A tag-based clients.deactivate() exists but is NOT a substitute (editable, '
    + 'and it does not set active/deactivated_at). See src/routes/clients.js header.'
  );
}

// True when the lifecycle accessor is present. Warns once and returns false
// otherwise, so callers can turn that into a 501 in one line.
function have(name) {
  if (HAS[name]) return true;
  warnMissing(name);
  return false;
}

// Every listed row carries a real `active` 1/0. The column exists from migration
// 002, but defaulting it here means a pre-migration DB still reports every row
// as active instead of leaving the flag undefined for the UI to misread.
function withActive(row) {
  const out = Object.assign({ active: 1 }, row);
  out.active = row && row.active !== undefined && row.active !== null ? (row.active ? 1 : 0) : 1;
  return out;
}

// Whitelist for writable columns (keeps unknown keys like `consent` out of SQL).
const WRITABLE = ['name', 'email', 'tags', 'notes'];
function pickWritable(body) {
  const out = {};
  for (const k of WRITABLE) {
    if (body[k] !== undefined) out[k] = body[k];
  }
  return out;
}

// Does this client have a visit still to come? Filtered from the repository's
// existing listByClient() rather than a new query, so this route still holds no
// SQL. slot_start is LOCAL-naive 'YYYY-MM-DD HH:mm' and so is dt.nowStr(), which
// makes the string comparison correct without any date maths (a toISOString()
// bound here would be 5h30m off for an IST clinic and would let a visit that has
// already started be treated as "upcoming").
function upcomingAppointment(clientId) {
  const now = dt.nowStr();
  const rows = appointments.listByClient(clientId) || [];
  return rows.find((a) => UPCOMING_STATUSES.has(a.status) && String(a.slot_start || '') >= now) || null;
}

router.get('/', (req, res) => {
  try {
    // Accept both ?search= (canonical) and ?q= (older drafts + admin UI).
    const q = req.query.search !== undefined ? req.query.search : req.query.q;
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 500);
    const rows = q ? clients.search(String(q), limit) : clients.list(limit, 0);
    // Inactive rows are deliberately still listed — they are history, not noise.
    res.json({ clients: rows.map(withActive) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/', (req, res) => {
  try {
    const { name, phone, email, tags, notes } = req.body || {};
    if (!name || !phone) return res.status(400).json({ error: 'name and phone required' });
    const row = clients.create({ name, phone, email, tags, notes });
    res.status(201).json({ client: withActive(row) });
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'phone already exists' });
    res.status(500).json({ error: e.message });
  }
});

router.get('/:id', (req, res) => {
  try {
    const row = clients.findById(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ client: withActive(row) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Update: absent fields merge from the existing row (so partial PUTs behave
// like PATCH). Name + phone go through the repository's updateProfile(), which
// normalizes the phone and turns a clash with another client into PHONE_TAKEN
// — this route no longer writes SQL itself.
router.put('/:id', (req, res) => {
  try {
    const body = req.body || {};
    const row = clients.updateProfile(req.params.id, body);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ client: withActive(row) });
  } catch (e) {
    if (e.code === 'PHONE_TAKEN' || e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'phone already exists' });
    }
    if (e.code === 'VALIDATION') return res.status(400).json({ error: e.message });
    res.status(500).json({ error: e.message });
  }
});

router.patch('/:id', (req, res) => {
  try {
    const row = clients.update(req.params.id, pickWritable(req.body || {}));
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ client: withActive(row) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Append a single tag (comma-separated `tags` column, deduped).
router.post('/:id/tags', (req, res) => {
  try {
    const existing = clients.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    const tag = String((req.body || {}).tag || '').trim();
    if (!tag) return res.status(400).json({ error: 'tag required' });
    const current = String(existing.tags || '').split(',').map((t) => t.trim()).filter(Boolean);
    if (!current.includes(tag)) current.push(tag);
    const row = clients.update(req.params.id, { tags: current.join(', ') });
    res.json({ client: withActive(row) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE is a DEACTIVATE, never a hard delete (see D4 header).
router.delete('/:id', (req, res) => {
  try {
    const existing = clients.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });

    // Already inactive -> idempotent success, no need to re-run the guard.
    if (!withActive(existing).active) {
      return res.json({ client: withActive(existing), deactivated: true });
    }

    const upcoming = upcomingAppointment(req.params.id);
    if (upcoming) {
      return res.status(409).json({
        error: 'client_has_upcoming_appointment',
        message: `This client still has a ${upcoming.status} appointment on ${upcoming.slot_start}. `
          + 'Cancel or complete it first, or anonymize the client instead.',
        appointment: { id: upcoming.id, slot_start: upcoming.slot_start, status: upcoming.status },
      });
    }

    // 501 rather than a tag-based fallback: see the header. Refusing is the
    // only safe answer, because the tag path would report a successful
    // deactivate while leaving active = 1 — the row would look untouched.
    if (!have('setActive')) {
      return res.status(501).json({
        error: 'deactivate_unavailable',
        missing: 'clients.setActive',
        message: 'Deactivate needs repository.clients.setActive, which src/db/repository.js does '
          + 'not expose. The client is unchanged.',
      });
    }
    const row = clients.setActive(req.params.id, 0);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ client: withActive(row), deactivated: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Undo a deactivation.
router.post('/:id/restore', (req, res) => {
  try {
    const existing = clients.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!have('setActive')) {
      return res.status(501).json({
        error: 'restore_unavailable',
        missing: 'clients.setActive',
        message: 'Restore needs repository.clients.setActive, which src/db/repository.js does not '
          + 'expose. The client is unchanged.',
      });
    }
    const row = clients.setActive(req.params.id, 1);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ client: withActive(row), restored: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Retention request: strip name/phone/email/notes/tags but KEEP the row so
// receipts, appointments and reports stay auditable. Never touches appointments.
router.post('/:id/anonymize', (req, res) => {
  try {
    const existing = clients.findById(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not_found' });
    if (!have('anonymize')) {
      return res.status(501).json({
        error: 'anonymize_unavailable',
        missing: 'clients.anonymize',
        message: 'Anonymize needs repository.clients.anonymize, which src/db/repository.js does not '
          + 'expose. The client is unchanged — no PII was scrubbed.',
      });
    }
    const row = clients.anonymize(req.params.id);
    if (!row) return res.status(404).json({ error: 'not_found' });
    res.json({ client: withActive(row), anonymized: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

module.exports = router;