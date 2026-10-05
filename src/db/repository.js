// clinic-automation — repository layer (src/db/repository.js)
// Purpose: single data-access interface over SQLite (better-sqlite3).
// POSTGRES SWAP POINT: this file is the ONLY place SQL lives in the project.
// Every function below is sync + takes plain objects — to migrate, replace conn()
// with a pg Pool and rewrite the SQL bodies, keeping the exported function
// names/signatures unchanged. Callers (routes/services/jobs) must NOT import
// better-sqlite3, call getDb(), or write SQL themselves.
// Phone rule: callers MUST pass normalized phones (see services/csvImport.js
// normalizePhone); UNIQUE(clients.phone) is the dedupe key.
//
// --- D9/D10: DATETIME DISCIPLINE (read before touching any bound) ------------
// appointments.slot_start is LOCAL-NAIVE 'YYYY-MM-DD HH:mm' (see schema.sql).
// Every bound this file hands to a SQL comparison MUST come from
// services/datetime.js. A toISOString() slice is UTC and carries a 'T'/'Z',
// and because ' ' (0x20) sorts BEFORE 'T' (0x54) a local slot then compares as
// LESS THAN its own 00:00 lower bound:
//     '2026-10-03 09:00' >= '2026-10-03T00:00:00.000Z'   ===  false
// Consequences were user-visible: the admin "Today" card listed the wrong set
// (silently EMPTY for UTC and for any negative offset, and only accidentally
// correct for a positive offset such as IST, where local-midnight-in-UTC sorts
// between the previous and current day), the reminder window never fired, and
// a WhatsApp CANCEL could cancel an already-past visit.
// Use slotFromNow()/slotFromInstant()/slotBound() below, or dt.dayBounds().
//
// --- HOW TO ADD AN ACCESSOR --------------------------------------------------
// 1. Put it on the namespace object it belongs to (clients/appointments/
//    messages/receipts/settings/intake/intakeResponses/users) as a method.
//    Namespaces are the canonical API; the flat aliases at the bottom exist only
//    for older callers and are defined EXACTLY ONCE each.
// 2. Get the handle with conn() — never require better-sqlite3 or call getDb()
//    directly, and never use `override` (that is forHandle()'s business).
// 3. PARAMETERISED SQL only. Every value is a `?` placeholder. The one thing
//    you may build into the statement is a caller-supplied LIMIT/OFFSET, and
//    even those go through `.all(...)` like anything else.
// 4. Return `null` for "no such row" and `[]` for "no rows" — never undefined.
// 5. Read a row you return through a projector when the stored shape and the
//    caller-facing shape differ (see messageRow() for D19). Do not return
//    SELECT * just because it is shorter.
// 6. Comment WHY the query exists and what breaks if it is wrong, not what the
//    SQL says. Cite the defect number when there is one.
// 7. Validate an argument that the schema CHECK-constrains rather than letting
//    it match zero rows silently (see assertStatus / assertDirection).
// 8. Then exercise it: a new accessor with no test is a new defect waiting.
// ============================================================================
'use strict';

const { getDb } = require('./db');
const dt = require('../services/datetime');

// Sentinels for "every appointment this clinic will ever have". Spelled in the
// stored local-naive form so they cannot collide with a slot on the boundary
// day (a bare '2999-01-01' would exclude a 2999-01-01 00:00 slot).
const RANGE_FROM_FLOOR = '2000-01-01 00:00';
const RANGE_TO_CEILING = '2999-01-01 00:00';

/**
 * Local-naive slot string for an arbitrary instant, e.g. slotFromInstant(d)
 * === 'YYYY-MM-DD HH:mm'. The calendar fields are read from LOCAL time and
 * zero-padded by datetime.js, so the result is byte-identical to what
 * services/scheduling.js writes and therefore safe to compare with slot_start.
 * @param {Date} instant
 * @returns {string} 'YYYY-MM-DD HH:mm'
 */
function slotFromInstant(instant) {
  const dateStr = `${instant.getFullYear()}-${dt.pad(instant.getMonth() + 1)}-${dt.pad(instant.getDate())}`;
  return dt.fmtSlot(dateStr, dt.pad(instant.getHours()), dt.pad(instant.getMinutes()));
}

/**
 * Local-naive slot string for the instant `deltaMinutes` from now, so
 * slotFromNow(-30 * 1440) is "<30 days ago> at HH:mm" on the clinic's clock.
 * This is the ONLY sanctioned replacement for `new Date(...).toISOString()` in
 * a window bound.
 * @param {number} deltaMinutes offset from the current instant; may be negative
 * @returns {string} 'YYYY-MM-DD HH:mm'
 */
function slotFromNow(deltaMinutes) {
  return slotFromInstant(new Date(Date.now() + deltaMinutes * 60000));
}

/**
 * Coerce a caller-supplied comparison bound into the stored local-naive form,
 * so a mixed-format bound resolves to what the caller meant instead of quietly
 * selecting the wrong rows. Accepts the stored slot form (unchanged), a bare
 * local date (read as that day's 00:00 — the shape half-open queries mean), and
 * a full ISO instant (converted from its UTC value to the clinic's wall clock,
 * since slot_start is not UTC). Anything unrecognised is returned untouched:
 * this argument was never validated here and inventing a throw would break
 * working callers.
 * @param {*} value raw bound from a caller
 * @param {string} fallback used when value is null, undefined or empty
 * @returns {string} a value comparable with slot_start
 */
function slotBound(value, fallback) {
  if (value === null || value === undefined || value === '') return fallback;
  const raw = String(value);
  if (dt.isSlotStr(raw) || dt.isDateStr(raw)) {
    return dt.isDateStr(raw) ? `${raw} 00:00` : raw;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? raw : slotFromInstant(parsed);
}

/**
 * Epoch milliseconds for a stored *_at column. Two shapes are in the database
 * and both are UTC by definition: the schema DEFAULT datetime('now') yields
 * 'YYYY-MM-DD HH:MM:SS' with no zone, and update()/deactivate() write
 * strftime('%Y-%m-%dT%H:%M:%fZ','now') which carries an explicit Z. Comparing
 * them as strings is unsafe (the space form sorts below the T form), so callers
 * that must reason about a UTC column against a LOCAL calendar day go through
 * here and compare instants numerically.
 * @param {*} stamp a created_at / updated_at value
 * @returns {number|null} epoch ms, or null when the value is unparseable
 */
function epochMs(stamp) {
  const raw = String(stamp === null || stamp === undefined ? '' : stamp).trim();
  if (!raw) return null;
  const iso = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}Z`
    : raw;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

// Connection indirection. `override` is only ever set for the duration of one
// synchronous forHandle() call (see below) — better-sqlite3 is synchronous, so
// there is no await point where another caller could observe it.
let override = null;

/**
 * The connection every query in this file runs on: the process-wide singleton,
 * unless a caller explicitly scoped one with forHandle().
 * @returns {object} a better-sqlite3 Database handle
 */
function conn() {
  return override || getDb();
}

/**
 * Run `fn` with every repository method bound to an EXPLICIT db handle instead
 * of the process-wide connection, then restore the previous handle.
 *
 * This is what keeps the legacy `(repo, db)` dependency injection in
 * src/services/reports.js honest: a test that passes its own handle can still
 * reach the whole namespaced API without any SQL leaking back out of here.
 * Synchronous by construction — the handle is restored in a finally block.
 *
 * @param {object} handle better-sqlite3 Database (null/undefined = default)
 * @param {function} fn    callback invoked while the override is installed
 * @returns {*} whatever `fn` returns
 */
function withHandle(handle, fn) {
  const previous = override;
  override = handle || null;
  try {
    return fn();
  } finally {
    override = previous;
  }
}

/**
 * The namespaced repository API bound to `handle`, with no scope to remember.
 * Every method runs inside withHandle(), so the facade reads exactly like the
 * module-level API (`forHandle(myDb).clients.create({...})`) while its queries
 * hit `handle` instead of the process-wide connection.
 * @param {object} [handle] better-sqlite3 Database to bind to
 * @returns {object} repository facade
 */
function forHandle(handle) {
  const bind = (namespace) => {
    const bound = {};
    for (const [name, value] of Object.entries(namespace)) {
      bound[name] = typeof value === 'function'
        ? (...args) => withHandle(handle, () => value(...args))
        : value;
    }
    return bound;
  };
  return {
    clients: bind(clients),
    appointments: bind(appointments),
    messages: bind(messages),
    receipts: bind(receipts),
    settings: bind(settings),
    intake: bind(intake),
    intakeResponses: bind(intakeResponses),
    users: bind(users),
    normalizePhone,
    APPOINTMENT_STATUSES,
    withDb: (fn) => withHandle(handle, fn),
  };
}

function normalizePhone(p) {
  return String(p || '').replace(/[^\d+]/g, '').replace(/^\+?/, '+');
}

// The statuses the appointments table accepts (mirrors the CHECK constraint in
// schema.sql). Validating here turns a typo into a clear domain error instead
// of a raw SqliteError surfacing as an opaque HTTP 500.
const APPOINTMENT_STATUSES = ['booked', 'confirmed', 'cancelled', 'completed', 'no_show'];

function assertStatus(status) {
  if (!APPOINTMENT_STATUSES.includes(status)) {
    const err = new Error(
      `invalid appointment status "${status}" (expected one of: ${APPOINTMENT_STATUSES.join(', ')})`
    );
    err.code = 'STATUS_INVALID';
    throw err;
  }
  return status;
}

// Same validation idea as assertStatus, for the messages.direction CHECK
// constraint (schema.sql): a typo here would otherwise match no rows at all and
// read as "this patient never replied" rather than as a bug.
const MESSAGE_DIRECTIONS = ['inbound', 'outbound'];

function assertDirection(direction) {
  if (!MESSAGE_DIRECTIONS.includes(direction)) {
    const err = new Error(
      `invalid message direction "${direction}" (expected one of: ${MESSAGE_DIRECTIONS.join(', ')})`
    );
    err.code = 'DIRECTION_INVALID';
    throw err;
  }
  return direction;
}

/**
 * D19 WRITE side: fold whatever a caller hands us into the ONE canonical
 * camelCase shape that messageRow() projects back out.
 *
 * This is the half of D19 that was still open. The READ side was fixed
 * (messageRow() below), but messages.log() destructured camelCase ONLY, so a
 * caller using the SQL spelling got its fields silently written as empty
 * strings: to_phone -> '' and wa_message_id -> NULL. Nothing reported it. The
 * snake_case tolerance lived exclusively in the flat `logMessage` alias, and
 * src/routes/webhook.js:96 and src/services/messaging.js:22 both call
 * repo.messages.log(entry) DIRECTLY, so they never went through that alias and
 * were the paths actually losing data.
 *
 * Precedence is camelCase-first: a caller that sets both spellings gets the
 * canonical one, so adding this can never change what an existing correct
 * caller writes.
 *
 * @param {object} [entry] a message row in either spelling
 * @returns {object} the canonical camelCase entry, defaults applied
 */
function messageEntry(entry) {
  const o = entry || {};
  const pick = (camel, snake, fallback) => {
    const v = o[camel];
    if (v !== undefined && v !== null) return v;
    const s = o[snake];
    return s === undefined || s === null ? fallback : s;
  };
  return {
    toPhone: pick('toPhone', 'to_phone', ''),
    fromPhone: pick('fromPhone', 'from_phone', ''),
    direction: pick('direction', 'direction', 'outbound'),
    template: pick('template', 'template', null),
    body: pick('body', 'body', ''),
    status: pick('status', 'status', 'queued'),
    waMessageId: pick('waMessageId', 'wa_message_id', null),
  };
}

/**
 * D19: THE canonical shape of a message row for every `messages` reader.
 * The columns are snake_case because that is SQL's convention; they are
 * projected to camelCase ONCE, here, so callers never have to remember which
 * spelling a given accessor happened to use. Before this, statusById() handed
 * back `to_phone` while log() took `toPhone`, so the same value had two names
 * depending on which direction you read it in.
 * `createdAt` is included because the message log is read newest-first and a
 * caller sorting or windowing rows needs the stamp.
 * @param {object|null} row a raw messages row (or null)
 * @returns {object|null} camelCase message, or null when row is null
 */
function messageRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    toPhone: row.to_phone,
    fromPhone: row.from_phone,
    direction: row.direction,
    template: row.template,
    body: row.body,
    status: row.status,
    waMessageId: row.wa_message_id,
    createdAt: row.created_at,
  };
}

// Placeholders written by clients.anonymize(). The phone is deliberately NOT a
// dialable number: an anonymized row keeps its id (appointments/intake/receipts
// all reference clients(id) ON DELETE RESTRICT) but must never be reachable by
// an inbound WhatsApp message, and WhatsApp only ever sends real numbers. It is
// derived from the id, so anonymizing twice produces the same value and cannot
// collide with itself — the id also guarantees it never collides with a row.
const ANON_NAME_PREFIX = 'Anonymized client ';
const ANON_PHONE_PREFIX = '+0000';
const ANON_PHONE_DIGITS = 8;

/**
 * The deterministic anonymized stand-in for client `id`.
 * @param {number} id
 * @returns {string} a normalized, UNIQUE, non-dialable phone
 */
function anonPhone(id) {
  const digits = String(Math.abs(Number(id) || 0)).padStart(ANON_PHONE_DIGITS, '0');
  return `${ANON_PHONE_PREFIX}${digits}`;
}

const clients = {
  create({ name, phone, email = '', tags = '', notes = '' }) {
    const db = conn();
    const stmt = db.prepare('INSERT INTO clients (name, phone, email, tags, notes) VALUES (?, ?, ?, ?, ?)');
    const info = stmt.run(name, normalizePhone(phone), email, tags, notes);
    return clients.findById(info.lastInsertRowid);
  },
  findById(id) {
    return conn().prepare('SELECT * FROM clients WHERE id = ?').get(id) || null;
  },
  findByPhone(phone) {
    return conn().prepare('SELECT * FROM clients WHERE phone = ?').get(normalizePhone(phone)) || null;
  },
  search(q, limit = 50) {
    const like = `%${q || ''}%`;
    return conn().prepare('SELECT * FROM clients WHERE name LIKE ? OR phone LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT ?').all(like, like, like, limit);
  },
  list(limit = 100, offset = 0) {
    return conn().prepare('SELECT * FROM clients ORDER BY updated_at DESC LIMIT ? OFFSET ?').all(limit, offset);
  },
  update(id, { name, email, tags, notes }) {
    const db = conn();
    db.prepare("UPDATE clients SET name = COALESCE(?, name), email = COALESCE(?, email), tags = COALESCE(?, tags), notes = COALESCE(?, notes), updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?")
      .run(name ?? null, email ?? null, tags ?? null, notes ?? null, id);
    return clients.findById(id);
  },
  // Name + phone may change (unlike update(), which leaves phone immutable).
  // The phone is normalized and checked for clashes here so callers never have
  // to touch SQL to avoid tripping UNIQUE(phone).
  updateProfile(id, { name, phone, email, tags, notes }) {
    const existing = clients.findById(id);
    if (!existing) return null;
    const nextName = name ?? existing.name;
    const nextPhone = phone ? normalizePhone(phone) : existing.phone;
    if (!nextName || !nextPhone || nextPhone === '+') {
      const err = new Error('name and a valid phone are required');
      err.code = 'VALIDATION';
      throw err;
    }
    const clash = clients.findByPhone(nextPhone);
    if (clash && String(clash.id) !== String(id)) {
      const err = new Error('phone already exists');
      err.code = 'PHONE_TAKEN';
      throw err;
    }
    conn().prepare(
      "UPDATE clients SET name = ?, phone = ?, email = ?, tags = ?, notes = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(
      nextName,
      nextPhone,
      email ?? existing.email,
      tags ?? existing.tags,
      notes ?? existing.notes,
      id
    );
    return clients.findById(id);
  },
  // Phone-only change. updateProfile() can also do this, but it is a
  // whole-record write: callers that only know the new phone would have to send
  // the current name/email/tags/notes too, and anything they got wrong silently
  // overwrites a real field. This writes exactly one column.
  // The clash check and the VALIDATION/PHONE_TAKEN error codes are deliberately
  // identical to updateProfile() — UNIQUE(clients.phone) is the dedupe key, so
  // both doors must refuse the same duplicates in the same way.
  updatePhone(id, phone) {
    const existing = clients.findById(id);
    if (!existing) return null;
    const nextPhone = phone ? normalizePhone(phone) : '';
    if (!nextPhone || nextPhone === '+') {
      const err = new Error('a valid phone is required');
      err.code = 'VALIDATION';
      throw err;
    }
    const clash = clients.findByPhone(nextPhone);
    if (clash && String(clash.id) !== String(id)) {
      const err = new Error('phone already exists');
      err.code = 'PHONE_TAKEN';
      throw err;
    }
    conn().prepare(
      "UPDATE clients SET phone = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(nextPhone, id);
    return clients.findById(id);
  },
  // Soft delete. A clinic must keep appointment + intake history for its
  // records, so clients are deactivated (tagged `inactive`) instead of being
  // deleted outright — this also avoids orphaning appointments via the FK.
  deactivate(id) {
    const existing = clients.findById(id);
    if (!existing) return null;
    const tags = String(existing.tags || '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    if (!tags.includes('inactive')) tags.push('inactive');
    conn().prepare(
      "UPDATE clients SET tags = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(tags.join(', '), id);
    return clients.findById(id);
  },
// The lifecycle flag from schema.sql migration 002 (clients.active /
  // clients.deactivated_at). deactivate() above is the older TAG-based soft
  // delete and is left exactly as it was; this is the column-backed one, and
  // the two compose — setActive(id, false) then deactivate(id) is the full
  // "stop serving this person" move.
  // `deactivated_at` is stamped on the clinic's own clock, NOT with
  // datetime('now'): the column is documented local 'YYYY-MM-DD HH:mm' and is
  // compared against local day bounds, and SQLite's datetime('now') is UTC.
  // Reactivating always CLEARS the stamp — leaving a deactivation time on an
  // active row is how "when did we stop serving them?" starts answering with
  // the wrong (most recent) date.
  setActive(id, isActive, stamp = dt.nowStr()) {
    const existing = clients.findById(id);
    if (!existing) return null;
    const active = isActive ? 1 : 0;
    const deactivatedAt = active ? null : stamp;
    conn().prepare(
      "UPDATE clients SET active = ?, deactivated_at = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(active, deactivatedAt, id);
    return clients.findById(id);
  },
  // Retention. A client with visit history can NEVER be hard-deleted:
  // appointments.client_id is ON DELETE RESTRICT (schema.sql), so a plain DELETE
  // fails loudly rather than destroying the medical record. Anonymizing is the
  // supported way to satisfy a data-erasure request while keeping the rows the
  // appointments, intake responses and receipts still point at.
  // Every directly identifying column is replaced:
  //   name   -> 'Anonymized client <id>'   phone -> a non-dialable id-derived stub
  //   email  -> NULL (the column is nullable)  tags/notes -> cleared
  // and the row is marked inactive + anonymized so it can be excluded from any
  // active-client list. Idempotent: the placeholders derive from the id, so a
  // second call writes the same values rather than compounding them.
  anonymize(id, stamp = dt.nowStr()) {
    const existing = clients.findById(id);
    if (!existing) return null;
    conn().prepare(
      "UPDATE clients SET name = ?, phone = ?, email = NULL, tags = '', notes = '', active = 0, deactivated_at = ?, anonymized = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?"
    ).run(`${ANON_NAME_PREFIX}${id}`, anonPhone(id), stamp, id);
    return clients.findById(id);
  },
  // Was this client's FIRST contact on `dateStr`? The daily report splits
  // bookings into new vs returning, and it must be answered with one boolean
  // rather than a raw created_at string the caller has to re-parse. An unknown
  // id is NOT new (nothing is known about them).
  createdOn(id, dateStr) {
    // "Was this client's FIRST contact on `dateStr`?" created_at is stored in
    // UTC, but dateStr is a LOCAL calendar day, so neither slicing the UTC date
    // off the column nor comparing the two as strings answers the question the
    // caller asked: a client created at 02:00 IST is stamped the PREVIOUS day
    // in UTC and would be reported as returning instead of new. Convert the
    // local day to the instants that belong to it and compare epoch ms.
    // An unknown id, a missing stamp, an unparseable dateStr or an unparseable
    // stamp are all "no": nothing is known, so nothing is claimed.
    if (!dt.isDateStr(dateStr)) return false;
    const row = conn().prepare('SELECT created_at FROM clients WHERE id = ?').get(id);
    if (!row) return false;
    const ms = epochMs(row.created_at);
    if (ms === null) return false;
    const bounds = dt.dayBounds(String(dateStr));
    // parseSlot() reads the local wall clock, so getTime() is the true instant
    // of local midnight — the exact UTC edge created_at is measured against.
    return ms >= dt.parseSlot(bounds.from).getTime() && ms < dt.parseSlot(bounds.to).getTime();
  },
  // Minimal client projection. Deliberately NOT findById(): `SELECT *` would
  // add notes/email/tags/created_at to the `client` object embedded in the
  // reports response, which is a public payload shape change. Payloads that
  // reach a patient must stay minimal.
  summary(id) {
    return conn().prepare('SELECT id, name, phone FROM clients WHERE id = ?').get(id) || null;
  },
};

const appointments = {
  // Transactional no-double-book: UNIQUE(slot_start) + IMMEDIATE transaction.
  // Concurrent inserts for the same slot → SQLITE_CONSTRAINT_UNIQUE → caller maps to 409.
  book({ clientId, slotStart, slotEnd, service = 'general' }) {
    const db = conn();
    const tx = db.transaction((c) => {
      return db.prepare('INSERT INTO appointments (client_id, slot_start, slot_end, service, status) VALUES (?, ?, ?, ?, ?)').run(c.clientId, c.slotStart, c.slotEnd, c.service, 'booked');
    });
    const info = tx({ clientId, slotStart, slotEnd, service });
    return appointments.findById(info.lastInsertRowid);
  },
  findById(id) {
    return conn().prepare('SELECT a.*, c.name AS client_name, c.phone AS client_phone FROM appointments a JOIN clients c ON c.id = a.client_id WHERE a.id = ?').get(id) || null;
  },
  findBySlot(slotStart) {
    // Reschedule guard: is a live (booked/confirmed) appointment on this slot?
    return conn().prepare("SELECT * FROM appointments WHERE slot_start = ? AND status IN ('booked','confirmed')").get(slotStart) || null;
  },
  listByRange(from, to) {
    // The one door every range query comes through. Both bounds are pushed
    // through slotBound() so a caller handing over a bare date or an ISO
    // instant gets the local-naive value it meant rather than a comparison
    // that silently matches the wrong rows. Half-open [from, to), as always.
    return conn().prepare('SELECT a.*, c.name AS client_name, c.phone AS client_phone FROM appointments a JOIN clients c ON c.id = a.client_id WHERE slot_start >= ? AND slot_start < ? ORDER BY slot_start').all(slotBound(from, RANGE_FROM_FLOOR), slotBound(to, RANGE_TO_CEILING));
  },
  findUpcoming(hoursBefore, lookAheadMinutes = 20) {
    // Slots starting in [now+hoursBefore-lookAhead, now+hoursBefore+lookAhead),
    // both bounds on the clinic's own clock. These used to be toISOString()
    // slices, i.e. UTC with a 'T' — a form that can never match a local slot,
    // so this window matched only rows days away and returned nothing at all
    // (which is why jobs/reminders.js stopped calling it).
    const centre = (Number(hoursBefore) || 0) * 60;
    const look = Number(lookAheadMinutes) || 0;
    const lo = slotFromNow(centre - look);
    const hi = slotFromNow(centre + look);
    return conn().prepare("SELECT a.*, c.name AS client_name, c.phone AS client_phone FROM appointments a JOIN clients c ON c.id = a.client_id WHERE a.slot_start >= ? AND a.slot_start < ? AND a.status IN ('booked','confirmed')").all(lo, hi);
  },
  updateStatus(id, status) {
    assertStatus(status);
    conn().prepare("UPDATE appointments SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(status, id);
    return appointments.findById(id);
  },
  findByPhone(phone) {
    return conn().prepare('SELECT a.* FROM appointments a JOIN clients c ON c.id = a.client_id WHERE c.phone = ? ORDER BY a.slot_start DESC LIMIT 20').all(normalizePhone(phone));
  },
  listByClient(clientId) {
    return conn().prepare('SELECT * FROM appointments WHERE client_id = ? ORDER BY slot_start DESC').all(clientId);
  },
  findInactiveSince(days) {
    // Clients whose latest appointment is older than `days` (for re-engagement).
    // The cutoff is computed in JS on the clinic's clock and passed as a bound.
    // Letting SQLite build it with datetime('now', ?) made the threshold UTC, so
    // the boundary sat 5h30m off in IST and clients seen that morning were
    // reported as inactive — a re-engagement message about a recent visit.
    const cutoff = slotFromNow(-(Number(days) || 0) * 1440);
    return conn().prepare('SELECT c.*, MAX(a.slot_start) AS last_visit FROM clients c JOIN appointments a ON a.client_id = c.id GROUP BY c.id HAVING last_visit < ? ORDER BY last_visit').all(cutoff);
  },
  todays() {
    // The clinic's LOCAL day, not UTC's. dt.dayBounds().to is the NEXT local
    // midnight and is exclusive, which is exactly the half-open interval
    // listByRange expects — an inclusive "23:59" would drop the 23:59 slot.
    const bounds = dt.dayBounds(dt.todayStr());
    return appointments.listByRange(bounds.from, bounds.to);
  },
  // Recall list: the most recent appointments that ended in `status`
  // (no_show, cancelled), newest slot first, each row carrying its client
  // name/phone through the same JOIN the other appointment readers use.
  // `limit` is caller-tunable because a recall list is an operator screen, not
  // a ledger: the dashboard wants the latest 200.
  recentByStatus(status, limit = 200) {
    assertStatus(status);
    return conn().prepare(
      'SELECT a.*, c.name AS client_name, c.phone AS client_phone FROM appointments a JOIN clients c ON c.id = a.client_id WHERE a.status = ? ORDER BY a.slot_start DESC LIMIT ?'
    ).all(status, limit);
  },
};

const messages = {
  // THE canonical message write (D19). Both spellings are accepted here, in one
  // place, so no caller can lose a field by guessing the wrong key - see
  // messageEntry() above for why that mattered. Returns the ROWID, not a row:
  // statusById(id) takes that id and returns the real delivery status, which is
  // what services/digest.js reads to stop reporting a failed send as sent.
  log(entry) {
    const e = messageEntry(entry);
    const info = conn().prepare('INSERT INTO messages (to_phone, from_phone, direction, template, body, status, wa_message_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(e.toPhone, e.fromPhone, e.direction, e.template, e.body, e.status, e.waMessageId);
    return info.lastInsertRowid;
  },
  // Read a delivery status back (used after a send so the caller can report
  // 'sent' | 'mocked' | 'failed' without touching SQL). Projected through
  // messageRow() so it returns the SAME camelCase shape as listByDirection()
  // and listRecent() — that shared projection is the D19 fix.
  statusById(id) {
    return messageRow(conn().prepare('SELECT * FROM messages WHERE id = ?').get(id));
  },
  // Every message in one direction, newest first. The paired phone/direction
  // readers above (inboundFromPhones / outboundToPhonesByTemplateLike) answer
  // "which patients?"; this answers "what was actually said, and did it send?"
  // for one conversation. `limit` is caller-tunable because this backs an
  // operator screen, not a ledger.
  // Ordering is created_at DESC with id DESC as the tiebreak: created_at has
  // one-second resolution, so a burst of messages shares a stamp and without
  // the id tiebreak a LIMIT could return an arbitrary subset of that burst.
  listByDirection(direction, limit = 100) {
    assertDirection(direction);
    return conn().prepare('SELECT * FROM messages WHERE direction = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(direction, limit).map(messageRow);
  },
  // The message log regardless of direction — the audit view an admin opens to
  // answer "what did the system send/receive today?". Same ordering rule as
  // listByDirection().
  listRecent(limit = 50) {
    return conn().prepare('SELECT * FROM messages ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(limit).map(messageRow);
  },
  // Distinct phones that ever REPLIED (an inbound row with a non-empty
  // sender). Drives "reminded but never answered" in the follow-up report.
  // Returned as `{ phone }` rows so the SQL -> driver projection stays visible.
  inboundFromPhones() {
    return conn().prepare(
      "SELECT DISTINCT from_phone AS phone FROM messages WHERE direction = 'inbound' AND from_phone <> ''"
    ).all();
  },
  // Distinct phones an outbound message matching `pattern` was sent to. The
  // caller passes the LIKE pattern (e.g. '%remind%') because which template
  // names count as a reminder is a reporting decision, not a storage one.
  outboundToPhonesByTemplateLike(pattern) {
    return conn().prepare(
      "SELECT DISTINCT to_phone AS phone FROM messages WHERE direction = 'outbound' AND template LIKE ?"
    ).all(pattern);
  },
};

const receipts = {
  create({ appointmentId = null, clientId, amount, itemsJson, filePath }) {
    const info = conn().prepare('INSERT INTO receipts (appointment_id, client_id, amount, items_json, file_path) VALUES (?, ?, ?, ?, ?)').run(appointmentId, clientId, amount, itemsJson, filePath);
    return info.lastInsertRowid;
  },
  findById(id) {
    return conn().prepare('SELECT * FROM receipts WHERE id = ?').get(id) || null;
  },
  // Every receipt for one client, newest first: the billing history behind a
  // client's profile and the reconciliation list for a single patient.
  // Same shape as findById() on purpose — the receipts namespace returns the
  // stored row throughout, so a caller reading one receipt or a list of them
  // uses one set of field names. `limit` is caller-tunable (a ledger, not a
  // screen, so the default is generous).
  listByClient(clientId, limit = 200) {
    return conn().prepare('SELECT * FROM receipts WHERE client_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
      .all(clientId, limit);
  },
  // Revenue booked on one calendar day = SUM(amount) of the receipts whose
  // created_at falls on that date. COALESCE + Number() means a day with no
  // receipts is 0 rather than null/undefined, and a malformed date string
  // simply matches nothing instead of throwing.
  totalForDate(dateStr) {
    const row = conn().prepare(
      'SELECT COALESCE(SUM(amount), 0) AS total FROM receipts WHERE date(created_at) = date(?)'
    ).get(dateStr);
    return Number(row ? row.total : 0) || 0;
  },
};

// --- Settings (key/value), intake responses and users -----------------------

const settings = {
  get(key) {
    const row = conn().prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : null;
  },
  set(key, value) {
    conn().prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run(key, String(value === null || value === undefined ? '' : value));
  },
};

const intake = {
  // Intake answers are append-only per save: the previous row is replaced so a
  // client never ends up with two conflicting answers for one appointment.
  save(appointmentId, answers) {
    const json = typeof answers === 'string' ? answers : JSON.stringify(answers);
    const db = conn();
    db.prepare('DELETE FROM intake_responses WHERE appointment_id = ?').run(appointmentId);
    const info = db.prepare('INSERT INTO intake_responses (appointment_id, answers_json) VALUES (?, ?)').run(appointmentId, json);
    return db.prepare('SELECT * FROM intake_responses WHERE id = ?').get(info.lastInsertRowid) || null;
  },
  latestFor(appointmentId) {
    return conn().prepare('SELECT * FROM intake_responses WHERE appointment_id = ? ORDER BY id DESC LIMIT 1').get(appointmentId) || null;
  },
  // Canonical name used by src/routes/intake.js (S9.3.4). `latestFor` above is
  // the older name and is kept as the implementation, so both spellings resolve
  // to one query rather than two that could drift.
  getForAppointment(appointmentId) {
    return intake.latestFor(appointmentId);
  },
  existsFor(appointmentId) {
    const row = conn().prepare('SELECT 1 AS ok FROM intake_responses WHERE appointment_id = ? LIMIT 1').get(appointmentId);
    return Boolean(row);
  },
};

// A second door onto the same two queries, not a second implementation. The
// repository contract names this pair `intakeResponses.{save,getForAppointment}`
// and the call sites that used to hand-roll their own SQL say exactly that, so
// this is the name those swaps land on. It DELEGATES on purpose: two definitions
// of one query is the defect D12 was about (seven shadowed keys, each silently
// discarding the other), and intake_responses.appointment_id is UNIQUE, so there
// can only ever be one answer to "what did this patient submit" regardless.
const intakeResponses = {
  save(appointmentId, answers) {
    return intake.save(appointmentId, answers);
  },
  getForAppointment(appointmentId) {
    return intake.latestFor(appointmentId);
  },
};

const users = {
  findByUsername(username) {
    return conn().prepare('SELECT * FROM users WHERE username = ?').get(username) || null;
  },
  // The stored bcrypt hash for a login, or null. Separate from findByUsername
  // so the auth service never has to touch (or accidentally log) a row that
  // also carries the hash plus every other user column.
  passwordHashFor(username) {
    const row = conn().prepare('SELECT password_hash FROM users WHERE username = ?').get(String(username));
    return row && row.password_hash ? row.password_hash : null;
  },
  // The non-secret identity fields for a session payload. Same reason as
  // clients.summary(): the answer to "who is logged in" must never be
  // SELECT *.
  identityFor(username) {
    return conn().prepare('SELECT id, role FROM users WHERE username = ?').get(String(username)) || null;
  },
};

// --- Public surface ----------------------------------------------------------
// Two shapes are exported on purpose:
//   * the namespaced objects (clients/appointments/...) — the canonical API,
//     and the only place SQL lives;
//   * flat aliases kept for existing callers. Each alias is defined EXACTLY ONCE
//     (this block used to redefine 7 of them, silently discarding the earlier
//     implementations and hiding which behaviour was live).
module.exports = {
  clients,
  appointments,
  messages,
  receipts,
  settings,
  intake,
  intakeResponses,
  users,
  normalizePhone,
  APPOINTMENT_STATUSES,

  // Connection scoping — the only way to point this repository at a handle
  // other than the process-wide one (see withHandle/forHandle at the top).
  forHandle,
  withHandle,

  // ---- clients ----
  findClientByPhone: (p) => clients.findByPhone(p),
  findClientById: (id) => clients.findById(id),
  getClientById: (id) => clients.findById(id),
  createClient: (o) => clients.create(o),
  searchClients: (q, limit) => clients.search(
    typeof q === 'object' ? (q.q || '') : q,
    typeof q === 'object' ? (q.limit || 50) : (limit || 50)
  ),
  listClients: (limit, offset) => clients.list(limit, offset),
  updateClient: (id, o) => clients.update(id, o),
  updateClientProfile: (id, o) => clients.updateProfile(id, o),
  deactivateClient: (id) => clients.deactivate(id),

  // ---- appointments ----
  getAppointmentById: (id) => appointments.findById(id),
  findAppointmentById: (id) => appointments.findById(id),
  findAppointmentBySlot: (slotStart) => appointments.findBySlot(slotStart),
  listAppointmentsByClient: (clientId) => appointments.listByClient(clientId),
  listAppointments: ({ from, to, limit } = {}) => conn().prepare(
    'SELECT * FROM appointments WHERE slot_start >= ? AND slot_start < ? ORDER BY slot_start LIMIT ?'
  ).all(slotBound(from, RANGE_FROM_FLOOR), slotBound(to, RANGE_TO_CEILING), limit || 500),
  createAppointment: (o) => {
    try {
      return appointments.book(o);
    } catch (e) {
      // Translate the UNIQUE(slot_start) violation into a domain error so
      // routes can map it to HTTP 409 without knowing about SQLite.
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE' || /UNIQUE/.test(e.message || '')) {
        const err = new Error('slot taken');
        err.code = 'SLOT_TAKEN';
        throw err;
      }
      throw e;
    }
  },
  updateAppointmentStatus: (id, status) => appointments.updateStatus(id, status),

  // ---- messages / receipts / intake / settings ----
  // The snake_case folding that used to live ONLY here is now inside
  // messages.log() itself, because routes/webhook.js and services/messaging.js
  // call messages.log() directly and so never passed through this alias. This
  // is a pure pass-through now: one normaliser, not two that can disagree.
  logMessage: (o) => messages.log(o),
  createReceipt: (o) => receipts.create({
    ...o,
    itemsJson: o.itemsJson ?? (o.items !== undefined ? JSON.stringify(o.items) : '[]'),
  }),
  getReceiptById: (id) => receipts.findById(id),
  saveIntakeResponse: (appointmentId, answers) => intake.save(appointmentId, answers),
  getIntakeByAppointment: (appointmentId) => intake.latestFor(appointmentId),
  getSetting: (key) => settings.get(key),
  setSetting: (key, value) => settings.set(key, value),
};
