// ============================================================================
// clinic-automation — reporting math (tests/reports.test.js)
// The HTTP suite only asserts the reports SHAPE; this file pins the actual
// ARITHMETIC of src/services/reports.js against a hand-seeded fixture DB:
//   getDailySummary()  — bookings / no-shows / revenue / new-vs-returning
//   getWeeklyAggregates() — 7 per-day rollups + week totals + byService
//   getFollowupFlags() — the actionable lists (48h window / reminder vs reply)
// Every timestamp that feeds a number is written explicitly, so nothing here
// depends on the wall clock except the deliberately now-relative 48h flags.
// Target: src/services/reports.js + src/services/digest.js.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { after } = require('node:test');
const h = require('./helpers');

const DAY = h.MONDAY;     // 2026-10-05, a clinic-open Monday
const NEXT = h.TUESDAY;   // 2026-10-06

after(() => h.cleanupTemp());

// Insert a client with a pinned created_at (clients.create() always stamps
// "now", which would make the new-vs-returning split clock-dependent).
function seedClient(db, { name, phone, createdAt }) {
  const info = db
    .prepare('INSERT INTO clients (name, phone, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(name, phone, createdAt, createdAt);
  return Number(info.lastInsertRowid);
}

function seedAppointment(db, { clientId, slotStart, status, service }) {
  const info = db
    .prepare("INSERT INTO appointments (client_id, slot_start, slot_end, service, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '2026-01-01 00:00:00', '2026-01-01 00:00:00')")
    .run(clientId, slotStart, slotStart, service, status);
  return Number(info.lastInsertRowid);
}

function seedReceipt(db, { appointmentId, clientId, amount, createdAt }) {
  db.prepare("INSERT INTO receipts (appointment_id, client_id, amount, items_json, file_path, created_at) VALUES (?, ?, ?, '[]', 'data/receipts/x.pdf', ?)")
    .run(appointmentId, clientId, amount, createdAt);
}

function logMessage(db, { to, from, direction, template }) {
  db.prepare("INSERT INTO messages (to_phone, from_phone, direction, template, body, status, created_at) VALUES (?, ?, ?, ?, 'b', 'mocked', '2026-01-01 00:00:00')")
    .run(to || '', from || '', direction, template);
}

/**
 * Fixture for the fixed-date reports (no clock involvement at all):
 *   clients   c1 Rita  created 2026-10-01  -> returning
 *             c2 Sameer created 2026-10-05  -> new
 *             c3 Kavya  created 2026-10-05  -> new
 *   DAY       5 appointments: booked, completed, no_show, cancelled, confirmed
 *   NEXT      1 appointment (must NOT leak into the DAY summary)
 *   receipts  500 + 250 on DAY (revenue 750), 999 on NEXT (must not leak)
 */
function seedFixedDates(db) {
  const c1 = seedClient(db, { name: 'Rita', phone: '+919000000041', createdAt: '2026-10-01 09:00:00' });
  const c2 = seedClient(db, { name: 'Sameer', phone: '+919000000042', createdAt: `${DAY} 08:00:00` });
  const c3 = seedClient(db, { name: 'Kavya', phone: '+919000000043', createdAt: `${DAY} 08:30:00` });

  const a1 = seedAppointment(db, { clientId: c1, slotStart: `${DAY} 09:00`, status: 'booked', service: 'General consultation' });
  const a2 = seedAppointment(db, { clientId: c1, slotStart: `${DAY} 10:00`, status: 'completed', service: 'Follow-up visit' });
  const a3 = seedAppointment(db, { clientId: c2, slotStart: `${DAY} 11:00`, status: 'no_show', service: 'General consultation' });
  seedAppointment(db, { clientId: c3, slotStart: `${DAY} 12:00`, status: 'cancelled', service: 'Dental concern' });
  seedAppointment(db, { clientId: c3, slotStart: `${DAY} 13:00`, status: 'confirmed', service: 'General consultation' });
  const a6 = seedAppointment(db, { clientId: c1, slotStart: `${NEXT} 09:00`, status: 'confirmed', service: 'Vaccination' });

  seedReceipt(db, { appointmentId: a2, clientId: c1, amount: 500, createdAt: `${DAY} 10:05:00` });
  seedReceipt(db, { appointmentId: a3, clientId: c2, amount: 250, createdAt: `${DAY} 11:10:00` });
  seedReceipt(db, { appointmentId: a6, clientId: c1, amount: 999, createdAt: `${NEXT} 09:05:00` });
}

test('getDailySummary counts bookings, no-shows, new vs returning clients and day revenue', () => {
  const { db } = h.freshDb();
  seedFixedDates(db);
  const reports = require('../src/services/reports');

  const d = reports.getDailySummary(DAY);

  assert.equal(d.date, DAY);
  assert.equal(d.bookings, 5, 'only the DAY appointments');
  assert.equal(d.total, 5, '`total` is the back-compat alias of bookings');
  assert.equal(d.noShows, 1, 'exactly one no_show');
  assert.equal(d.revenue, 750, '500 + 250 from DAY receipts only (the 999 is on NEXT)');
  assert.equal(d.newClients, 3, '2 bookings for Sameer + 2 for Kavya (created on DAY)');
  assert.equal(d.returningClients, 2, 'the 2 Rita bookings');
  assert.equal(d.newClients + d.returningClients, d.bookings, 'new + returning must reconcile');
  assert.deepEqual(d.byStatus, { booked: 1, completed: 1, no_show: 1, cancelled: 1, confirmed: 1 });
  assert.deepEqual(d.counts, d.byStatus, '`counts` mirrors `byStatus`');
  assert.equal(d.appointments.length, 5);

  // A day with nothing on it is all zeroes, never null/undefined.
  const empty = reports.getDailySummary(h.NEXT_MONDAY);
  assert.equal(empty.bookings, 0);
  assert.equal(empty.revenue, 0);
  assert.deepEqual(empty.byStatus, {});

  assert.throws(() => reports.getDailySummary('05-10-2026'), /date YYYY-MM-DD required/);
  assert.throws(() => reports.getDailySummary(''), /date YYYY-MM-DD required/);
});

test('getWeeklyAggregates rolls up 7 days with per-day revenue and by-service totals', () => {
  const { db } = h.freshDb();
  seedFixedDates(db);
  const reports = require('../src/services/reports');

  const w = reports.getWeeklyAggregates(DAY);

  assert.equal(w.weekStart, DAY);
  assert.equal(w.weekEnd, h.NEXT_MONDAY, 'start + 7 days');
  assert.equal(w.days.length, 7, 'one rollup per day of the week');
  assert.deepEqual(w.days.map((d) => d.date), [
    DAY, NEXT, '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10', '2026-10-11',
  ]);
  assert.equal(w.total, 6, '5 on DAY + 1 on NEXT');
  assert.equal(w.revenue, 1749, '750 (DAY) + 999 (NEXT)');

  assert.deepEqual(w.days[0], {
    date: DAY,
    bookings: 5,
    revenue: 750,
    byStatus: { booked: 1, completed: 1, no_show: 1, cancelled: 1, confirmed: 1 },
    byService: { 'General consultation': 3, 'Follow-up visit': 1, 'Dental concern': 1 },
  });
  assert.equal(w.days[1].bookings, 1);
  assert.equal(w.days[1].revenue, 999);
  assert.equal(w.days[6].bookings, 0, 'a day past the fixture is empty');
  assert.equal(w.days[6].revenue, 0);

  assert.deepEqual(w.byStatus, { booked: 1, completed: 1, no_show: 1, cancelled: 1, confirmed: 2 });
  assert.deepEqual(w.byService, {
    'General consultation': 3,
    'Follow-up visit': 1,
    'Dental concern': 1,
    Vaccination: 1,
  });
  assert.deepEqual(w.counts, w.byStatus);
  assert.equal(
    Object.values(w.byService).reduce((a, b) => a + b, 0),
    w.total,
    'every appointment is counted in exactly one service bucket'
  );

  assert.throws(() => reports.getWeeklyAggregates('week-1'), /weekStart YYYY-MM-DD required/);
});

test('getFollowupFlags separates reminded-without-reply from replied and non-reminded', () => {
  const { db } = h.freshDb();
  const reports = require('../src/services/reports');

  const x = seedClient(db, { name: 'Xavier', phone: '+919000000051', createdAt: '2026-01-01 00:00:00' });
  const y = seedClient(db, { name: 'Yara', phone: '+919000000052', createdAt: '2026-01-01 00:00:00' });
  const z = seedClient(db, { name: 'Zane', phone: '+919000000053', createdAt: '2026-01-01 00:00:00' });
  seedClient(db, { name: 'Nadia', phone: '+919000000054', createdAt: '2026-01-01 00:00:00' });
  seedClient(db, { name: 'Cato', phone: '+919000000055', createdAt: '2026-01-01 00:00:00' });
  const stale = seedClient(db, { name: 'Iris', phone: '+919000000056', createdAt: '2026-01-01 00:00:00' });
  seedClient(db, { name: 'Milo', phone: '+919000000057', createdAt: '2026-01-01 00:00:00' });
  seedClient(db, { name: 'Pia', phone: '+919000000058', createdAt: '2026-01-01 00:00:00' });
  seedClient(db, { name: 'Future', phone: '+919000000059', createdAt: '2026-01-01 00:00:00' });

  // Inside the 48h window, all still `booked` (i.e. unconfirmed).
  seedAppointment(db, { clientId: x, slotStart: h.stampFromNow(2 * 3600e3), status: 'booked', service: 'General consultation' });
  seedAppointment(db, { clientId: y, slotStart: h.stampFromNow(3 * 3600e3), status: 'booked', service: 'General consultation' });
  seedAppointment(db, { clientId: z, slotStart: h.stampFromNow(4 * 3600e3), status: 'booked', service: 'General consultation' });
  // Outside the window — must not appear in unconfirmedSoon.
  seedAppointment(db, { clientId: Number(db.prepare('SELECT id FROM clients WHERE phone = ?').get('+919000000059').id), slotStart: h.stampFromNow(5 * 86400e3), status: 'booked', service: 'General consultation' });

  logMessage(db, { to: '+919000000051', direction: 'outbound', template: 'reminder_24h' });
  logMessage(db, { to: '+919000000052', direction: 'outbound', template: 'reminder_24h' });
  logMessage(db, { from: '+919000000052', direction: 'inbound', template: 'freeform' });

  // Recall lists. NB: slot_start is UNIQUE, so each fixture row needs its own
  // minute — stampFromNow() truncates to minutes, hence the +N minute nudges.
  const nadia = Number(db.prepare('SELECT id FROM clients WHERE phone = ?').get('+919000000054').id);
  const cato = Number(db.prepare('SELECT id FROM clients WHERE phone = ?').get('+919000000055').id);
  seedAppointment(db, { clientId: nadia, slotStart: h.stampFromNow(-2 * 86400e3), status: 'no_show', service: 'General consultation' });
  seedAppointment(db, { clientId: cato, slotStart: h.stampFromNow(-3 * 86400e3), status: 'cancelled', service: 'General consultation' });

  // Re-engagement candidate: last visit 90 days ago.
  seedAppointment(db, { clientId: stale, slotStart: h.stampFromNow(-90 * 86400e3), status: 'completed', service: 'General consultation' });

  // Completed in the last 7 days: Milo has no intake, Pia does.
  const milo = Number(db.prepare('SELECT id FROM clients WHERE phone = ?').get('+919000000057').id);
  const pia = Number(db.prepare('SELECT id FROM clients WHERE phone = ?').get('+919000000058').id);
  seedAppointment(db, { clientId: milo, slotStart: h.stampFromNow(-2 * 86400e3 + 30 * 60e3), status: 'completed', service: 'General consultation' });
  const piaAppt = seedAppointment(db, { clientId: pia, slotStart: h.stampFromNow(-3 * 86400e3 + 30 * 60e3), status: 'completed', service: 'General consultation' });
  db.prepare("INSERT INTO intake_responses (appointment_id, answers_json, created_at) VALUES (?, '{}', '2026-01-01 00:00:00')").run(piaAppt);

  const f = reports.getFollowupFlags();

  assert.deepEqual(
    f.unconfirmedSoon.map((a) => a.client_phone).sort(),
    ['+919000000051', '+919000000052', '+919000000053'],
    'only booked appointments inside the next 48h'
  );
  assert.equal(f.unconfirmedSoon.length, 3);
  assert.ok(f.unconfirmedSoon.every((a) => a.client && a.client.name), 'each row carries its client');

  assert.deepEqual(
    f.noResponseAfterReminder.map((a) => a.client_phone),
    ['+919000000051'],
    'Xavier was reminded and never replied; Yara was reminded but replied; Zane was never reminded'
  );

  assert.equal(f.noShowRecall.length, 1);
  assert.equal(f.noShowRecall[0].client_phone, '+919000000054');
  assert.equal(f.cancelledRecall.length, 1);
  assert.equal(f.cancelledRecall[0].client_phone, '+919000000055');

  assert.equal(f.overdueNextVisit.length, 2, 'the no-show recall plus the >30-day inactive client');
  assert.ok(f.overdueNextVisit.some((r) => (r.client && r.client.phone) === '+919000000056' || r.lastVisit),
    'the inactive client is included with its lastVisit marker');

  assert.equal(f.missingIntake.length, 1, "only Milo's completed visit lacks an intake response");
  assert.ok(f.missingIntake.every((a) => a.status === 'completed'));
});

test('getFollowupFlags is empty — not broken — on a database with no rows', () => {
  h.freshDb();
  const reports = require('../src/services/reports');
  const f = reports.getFollowupFlags();
  for (const key of ['noResponseAfterReminder', 'overdueNextVisit', 'noShowRecall', 'cancelledRecall', 'unconfirmedSoon', 'missingIntake']) {
    assert.deepEqual(f[key], [], `${key} defaults to []`);
  }
});

test('weekly digest text and the no-OWNER_PHONE skip path', () => {
  h.freshDb();
  const digest = require('../src/services/digest');

  const text = digest.buildWeeklyDigest();
  assert.match(text, /^Weekly digest — week of \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}/);
  assert.match(text, /This week: \d+ bookings, revenue [\d.]+ /);
  assert.match(text, /Flags: 0 no-response-after-reminder, 0 overdue-next-visit, 0 unconfirmed \(48h\), 0 completed w\/o intake/);
  assert.doesNotMatch(text, /undefined|NaN/, 'no un-interpolated values leak into the owner digest');

  // helpers.js deliberately leaves OWNER_PHONE empty, so the digest must skip
  // rather than attempt a send to "".
  return digest.sendWeeklyDigest().then((r) => {
    assert.deepEqual(r, { skipped: true, sent: false, reason: 'no OWNER_PHONE configured' });
  });
});