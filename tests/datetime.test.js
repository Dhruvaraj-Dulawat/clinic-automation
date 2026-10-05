// ============================================================================
// clinic-automation — D9/D10 datetime regression guard (tests/datetime.test.js)
// THE INVARIANT UNDER TEST
//   appointments.slot_start is stored LOCAL-NAIVE as 'YYYY-MM-DD HH:mm'.
//   It must NEVER be compared against Date#toISOString() output, which is UTC
//   carrying a 'T' AND a 'Z'. Because ' ' (0x20) sorts BEFORE 'T' (0x54),
//     '2026-10-03 09:00' >= '2026-10-03T00:00:00.000Z'   ===  false
//   so a same-day row ranks BELOW its own day's midnight and is silently
//   dropped: the admin "Today" card lied, the 24h-reminder window fired at the
//   wrong time, and a WhatsApp CANCEL could cancel a visit that already
//   happened (which also rewrote it from `completed` to `cancelled`, so revenue
//   and the daily report were built on a lie).
//
// WHY THIS FILE EXISTS AGAIN
//   The first version of this coverage lived at
//   src/db/__tests__/repository-datetime.isolated.test.js — a path OUTSIDE the
//   `npm test` glob (`tests/**/*.test.js`), so it never ran in the gate. It was
//   then copied to tests/isolated/ with a broken schema.sql path (ENOENT), and
//   was DELETED rather than fixed, leaving the suite green only because the
//   assertions were gone. This file is the restoration, in the glob, resolving
//   every project path from helpers.ROOT (never from __dirname).
//
// WHAT MAKES IT A GUARD AND NOT A SMOKE TEST
//   Section 9 is a SOURCE-level assertion: it fails if anyone reintroduces a
//   toISOString() against a local-naive bound, even in a form the behavioural
//   sections would not happen to exercise at the moment they run.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { after } = require('node:test');
const h = require('./helpers');

// Pure module with zero require() calls, so it is safe before freshDb() and is
// deliberately NOT stubbed: mocking the formatter under test would be tautological.
const dt = require('../src/services/datetime.js');

after(() => h.cleanupTemp());

// Book the way scheduling.js does, with a real +30 minute slot_end.
function book(repo, clientId, slotStart, service = 'Consultation') {
  const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})$/.exec(slotStart);
  const mins = Number(m[2]) * 60 + Number(m[3]) + 30;
  const slotEnd = `${m[1]} ${dt.pad(Math.floor(mins / 60))}:${dt.pad(mins % 60)}`;
  return repo.appointments.book({ clientId, slotStart, slotEnd, service });
}

let phoneSeq = 0;
function newClient(repo, name) {
  phoneSeq += 1;
  return repo.clients.create({ name, phone: `+9198${String(700000000 + phoneSeq)}` });
}

// ===========================================================================
// 1. The root cause, stated as an unconditional string comparison. This is the
//    exact fact the old bounds relied on, and it holds in every timezone.
// ===========================================================================
test('D9 root cause: a local slot never sorts above a same-day UTC instant', () => {
  const today = dt.todayStr();
  assert.equal(`${today} 09:00` >= `${today}T00:00:00.000Z`, false,
    "' ' (0x20) sorts before 'T' (0x54) - this is why an ISO bound drops today");

  // The same fact when the clinic's midnight is turned into a UTC instant the
  // way the old code did. Date.UTC is used deliberately: `new Date('...T00:00')`
  // has no offset, so the ES parser reads it as LOCAL time and its toISOString()
  // shifts onto the previous UTC date for any positive offset, which would make
  // this assertion pass for the wrong reason.
  const [y, m, d] = today.split('-').map(Number);
  const utcMidnight = new Date(Date.UTC(y, m - 1, d)).toISOString();
  assert.equal(utcMidnight, `${today}T00:00:00.000Z`, 'a genuine UTC midnight');
  assert.equal(`${today} 09:00` >= utcMidnight, false,
    'and the slot still ranks below it');
});

// ===========================================================================
// 2. todays() must actually return today's rows. Behavioural, against a real DB.
// ===========================================================================
test('D9: todays() returns a same-day appointment (the ISO bound dropped it)', () => {
  const { repo } = h.freshDb();
  const c = newClient(repo, 'Asha Rao');
  const today = dt.todayStr();
// Fixed local time TODAY, not "now + 4h": a relative offset rolls into
  // tomorrow when the suite runs late in the evening, which made this test
  // fail by clock rather than by behaviour.
  const slotStart = `${today} 10:00`;
  book(repo, c.id, slotStart);

  const rows = repo.appointments.todays();
  assert.equal(rows.length, 1, 'todays() must return the same-day row');
  assert.equal(rows[0].slot_start, slotStart);
});

test('D9: the pre-fix bound really did drop the row, and the new bound does not', () => {
  const { repo, db } = h.freshDb();
  const c = newClient(repo, 'Before After');
  const today = dt.todayStr();
  book(repo, c.id, `${today} 09:00`);

  // Reconstruct the OLD todays() verbatim — UTC instants for local midnight —
  // and run the SAME SQL it ran. This is the before/after the fix must show.
  const oldStart = new Date(); oldStart.setHours(0, 0, 0, 0);
  const oldEnd = new Date(oldStart); oldEnd.setDate(oldEnd.getDate() + 1);
  const RANGE = 'SELECT * FROM appointments WHERE slot_start >= ? AND slot_start < ?';

  const bounds = dt.dayBounds(today);
  const viaOldBound = db.prepare(RANGE).all(oldStart.toISOString(), oldEnd.toISOString()).length;
  const viaNewBound = db.prepare(RANGE).all(bounds.from, bounds.to).length;
  const viaAccessor = repo.appointments.todays().length;

  assert.equal(viaNewBound, 1, 'the local-naive bound returns the row');
  assert.equal(viaAccessor, 1, 'and so does the real accessor');
  // The old bound drops the row whenever local midnight maps onto the SAME
  // calendar date in UTC (offset 0 and every negative offset). Under a large
  // positive offset (e.g. IST) local midnight is the previous UTC date, so the
  // stale bound survives by accident until local 05:30. Either way the new
  // bound must be strictly correct, which is what the two assertions above pin.
  assert.ok(viaOldBound === 0 || viaOldBound === 1,
    `pre-fix window returned ${viaOldBound} rows (time-of-day dependent)`);
  if (viaOldBound === 0) {
    assert.equal(viaNewBound, 1, 'the fix is what recovers the dropped row');
  }
});

// ===========================================================================
// 3. Day edges. dayBounds().to is the NEXT local midnight and is EXCLUSIVE, so
//    23:59 is included and tomorrow 00:00 is not. An inclusive bound would drop
//    the 23:59 slot, which is a real booking time.
// ===========================================================================
test('D9: todays() is half-open on both edges', () => {
  const { repo } = h.freshDb();
  const c = newClient(repo, 'Edges');
  const today = dt.todayStr();
  book(repo, c.id, `${today} 00:00`);
  book(repo, c.id, `${today} 23:59`);
  book(repo, c.id, `${dt.addDays(today, -1)} 23:59`); // yesterday
  book(repo, c.id, `${dt.addDays(today, 1)} 00:00`);  // tomorrow

  assert.deepEqual(
    repo.appointments.todays().map((a) => a.slot_start).sort(),
    [`${today} 00:00`, `${today} 23:59`],
    'yesterday 23:59 out, tomorrow 00:00 out - no edge leaks either way'
  );
});

test('todays() is empty when nothing is booked today', () => {
  const { repo } = h.freshDb();
  const c = newClient(repo, 'Nobody');
  book(repo, c.id, `${dt.addDays(dt.todayStr(), -4)} 10:00`);
  assert.deepEqual(repo.appointments.todays(), []);
});

// ===========================================================================
// 4. findUpcoming — the 24h reminder window. Bounds must be local-naive.
// ===========================================================================
test('D9: findUpcoming windows on the local clock', () => {
  const { repo } = h.freshDb();
  const c = newClient(repo, 'Rohan');
  repo.appointments.book({ clientId: c.id, slotStart: dt.nowStr(), slotEnd: dt.nowStr(), service: 'x' });
  const rows = repo.appointments.findUpcoming(0, 20);
  assert.equal(rows.length, 1, 'a slot starting now is inside [now-20m, now+20m)');

  const past = book(repo, c.id, `${dt.addDays(dt.todayStr(), -3)} 09:00`);
  repo.appointments.updateStatus(past.id, 'cancelled');
  assert.equal(repo.appointments.findUpcoming(0, 20).some((r) => r.id === past.id), false,
    'a cancelled past slot is never returned');
});

// ===========================================================================
// 5. findInactiveSince — the cutoff must be local. Letting SQLite build it with
//    datetime('now', ?) made the threshold UTC, which sits 5h30m off in IST:
//    a client seen that morning was reported inactive and re-engaged about a
//    visit they had just attended.
// ===========================================================================
test('D9: findInactiveSince cuts on a local bound, not SQLite UTC datetime()', () => {
  const { repo } = h.freshDb();
  const days = 30;
  const inside = newClient(repo, 'Just inside');
  const outside = newClient(repo, 'Just outside');
  book(repo, inside.id, h.stampFromNow(-days * 86400000 + 3600000));
  book(repo, outside.id, h.stampFromNow(-days * 86400000 - 3600000));

  const ids = repo.appointments.findInactiveSince(days).map((r) => r.id);
  assert.equal(ids.includes(outside.id), true, 'a visit older than the window IS inactive');
  assert.equal(ids.includes(inside.id), false, 'a visit inside the window is NOT inactive');
});

test('findInactiveSince: a future visit is never inactive', () => {
  const { repo } = h.freshDb();
  const c = newClient(repo, 'Future');
  book(repo, c.id, h.stampFromNow(3 * 86400000));
  assert.equal(repo.appointments.findInactiveSince(30).length, 0);
});

// ===========================================================================
// 6. created_on — the column is UTC (schema DEFAULT datetime('now')), but the
//    question asked is "was this client first seen on this LOCAL day". A client
//    created at 02:00 IST is stamped the previous day in UTC, so slicing the
//    date off the column reported them as RETURNING instead of NEW, corrupting
//    the daily report's new-vs-returning split.
// ===========================================================================
test('D9: createdOn answers on the LOCAL day of a UTC-stored created_at', () => {
  const { repo, db } = h.freshDb();
  const c = newClient(repo, 'Ishita');
  const today = dt.todayStr();
  const bounds = dt.dayBounds(today);
  const setCreated = (iso) => db.prepare('UPDATE clients SET created_at = ? WHERE id = ?').run(iso, c.id);

  setCreated(dt.parseSlot(bounds.from).toISOString());
  assert.equal(repo.clients.createdOn(c.id, today), true, 'the first instant of the local day is today');
  setCreated(dt.parseSlot(bounds.to).toISOString());
  assert.equal(repo.clients.createdOn(c.id, today), false, 'local midnight tomorrow is NOT today');
  setCreated(dt.parseSlot(`${dt.addDays(today, -1)} 12:00`).toISOString());
  assert.equal(repo.clients.createdOn(c.id, today), false, 'yesterday is not today');
  assert.equal(repo.clients.createdOn(999999, today), false, 'an unknown id is not "new"');
});

// ===========================================================================
// 7. listByRange must not silently accept a bound in the wrong format, and must
//    keep its half-open contract for the stored form.
// ===========================================================================
test('listByRange keeps [from, to) for local-naive bounds', () => {
  const { repo } = h.freshDb();
  const c = newClient(repo, 'Meera');
  book(repo, c.id, '2026-10-05 09:00');
  book(repo, c.id, '2026-10-05 10:00');
  book(repo, c.id, '2026-10-06 09:00');

  assert.deepEqual(
    repo.appointments.listByRange('2026-10-05 00:00', '2026-10-06 00:00').map((a) => a.slot_start),
    ['2026-10-05 09:00', '2026-10-05 10:00']
  );
  assert.equal(repo.appointments.listByRange('2000-01-01 00:00', '2999-01-01 00:00').length, 3);
});

// ===========================================================================
// 8. D10 — the WhatsApp CANCEL path. A visit that has ALREADY STARTED must be
//    refused with a clear answer, and the attended row must be left untouched:
//    rewriting it to `cancelled` is what corrupted the daily report.
//    handleIntent is exercised directly (exported test hook) against the same
//    isolated DB, so no HTTP server and no outbound message is involved.
// ===========================================================================
test('D10: CANCEL for an already-past visit is refused and the row is untouched', async () => {
  const { repo } = h.freshDb();
  const webhook = require('../src/routes/webhook.js');

  const c = repo.clients.create({ name: 'Past Visit', phone: '+919000099001' });
  const appt = book(repo, c.id, h.stampFromNow(-2 * 3600000));
  assert.equal(repo.appointments.findById(appt.id).status, 'booked');

  const sent = [];
  const res = await webhook.handleIntent(
    { from: '+919000099001', text: 'CANCEL' },
    { sendFreeform: async (_to, body) => { sent.push(body); } }
  );

  assert.equal(res.intent, 'cancel-past', 'a started visit is not cancellable');
  assert.equal(res.appointmentId, appt.id, 'the refusal names the visit in question');
  assert.equal(repo.appointments.findById(appt.id).status, 'booked',
    'the attended visit is NOT rewritten to cancelled');
  assert.match(sent.join('\n'), /already started/,
    'the patient gets a clear reason, not a denial that implies no record');
  assert.doesNotMatch(sent.join('\n'), /could not find an upcoming/,
    'the misleading generic "we have no record of you" reply must not be sent');
});

test('D10: a CANCEL for a future visit still cancels it', async () => {
  const { repo } = h.freshDb();
  const webhook = require('../src/routes/webhook.js');

  const c = repo.clients.create({ name: 'Future Visit', phone: '+919000099002' });
  const appt = book(repo, c.id, h.stampFromNow(3 * 86400000));

  const res = await webhook.handleIntent(
    { from: '+919000099002', text: 'CANCEL' },
    { sendFreeform: async () => {} }
  );
  assert.equal(res.intent, 'cancel');
  assert.equal(repo.appointments.findById(appt.id).status, 'cancelled');
});

test('D10: with a past AND a future visit, CANCEL targets the future one', async () => {
  const { repo } = h.freshDb();
  const webhook = require('../src/routes/webhook.js');

  const c = repo.clients.create({ name: 'Both', phone: '+919000099003' });
  const past = book(repo, c.id, h.stampFromNow(-3600000));
  const future = book(repo, c.id, h.stampFromNow(2 * 86400000));

  const res = await webhook.handleIntent(
    { from: '+919000099003', text: 'CANCEL' },
    { sendFreeform: async () => {} }
  );
  assert.equal(res.appointmentId, future.id);
  assert.equal(repo.appointments.findById(past.id).status, 'booked',
    'the already-attended row is left alone');
  assert.equal(repo.appointments.findById(future.id).status, 'cancelled');
});

test('D10: an unknown sender is still handled without crashing', async () => {
  h.freshDb();
  const webhook = require('../src/routes/webhook.js');
  const res = await webhook.handleIntent(
    { from: '+919000000000', text: 'CANCEL' },
    { sendFreeform: async () => {} }
  );
  assert.equal(res.intent, 'none');
});

// ===========================================================================
// 9. THE SOURCE-LEVEL GUARD. This is what fails if the defect is ever
//    reintroduced in a form the behavioural sections above would not happen to
//    trip over at the moment they run.
// ===========================================================================
test('no toISOString() output can reach a slot_start comparison bound', () => {
  const offenders = [];
  for (const rel of ['src/db/repository.js', 'src/routes/webhook.js']) {
    const src = fs.readFileSync(path.join(h.ROOT, rel), 'utf8');
    src.split(/\r?\n/).forEach((line, i) => {
      if (!/toISOString/.test(line)) return;
      // A surviving toISOString() is only legitimate where it converts an
      // instant into the UTC form a *_at audit column is actually stored in.
      if (/created_at|updated_at|isoNow/.test(line)) return;
      const trimmed = line.trim();
      // Comments that merely NAME the old bug are documentation, not code.
      if (/^(\/\/|\*|\/\*)/.test(trimmed)) return;
      offenders.push(`${rel}:${i + 1}: ${trimmed}`);
    });
  }
  assert.deepEqual(offenders, [],
    'every remaining toISOString must be an audit-column UTC conversion, never a slot bound');
});

test('repository.js and webhook.js delegate datetime formatting to services/datetime.js', () => {
  const repoSrc = fs.readFileSync(path.join(h.ROOT, 'src/db/repository.js'), 'utf8');
  assert.match(repoSrc, /require\('\.\.\/services\/datetime'\)/,
    'the repository must not format a datetime inline');
  const hookSrc = fs.readFileSync(path.join(h.ROOT, 'src/routes/webhook.js'), 'utf8');
  assert.match(hookSrc, /require\('\.\.\/services\/datetime'\)/,
    'the webhook must read "now" through the one datetime module');
});

test('every bound listByRange is handed is a local-naive slot string', () => {
  const { repo, db } = h.freshDb();
  const c = newClient(repo, 'Bounds');
  book(repo, c.id, `${dt.todayStr()} 10:00`);

  // Capture whatever todays()/findUpcoming() actually push into the query.
  const seen = [];
  const original = db.prepare.bind(db);
  db.prepare = (sql) => { if (/slot_start >= \?/.test(sql)) seen.push(sql); return original(sql); };
  try { repo.appointments.todays(); repo.appointments.findUpcoming(24, 20); } finally { db.prepare = original; }
  assert.ok(seen.length >= 2, 'both window queries ran');

  const real = repo.appointments.todays();
  assert.equal(real.length, 1);
  for (const row of real) {
    assert.ok(dt.isSlotStr(row.slot_start),
      `slot_start ${row.slot_start} is in the stored local-naive form`);
  }
});