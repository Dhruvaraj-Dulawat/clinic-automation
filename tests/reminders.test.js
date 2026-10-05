// ============================================================================
// clinic-automation - 24h reminder idempotency (tests/reminders.test.js)
// Target: src/jobs/reminders.js
//
// WHY THIS FILE EXISTS: the D16 reminder defect was invisible to the suite.
// reminders.js had ZERO coverage, so BOTH halves of the bug shipped unnoticed:
//   1. a single global `reminders.lastSlotSent` high-water mark, so any
//      appointment whose slot_start sorted at or below it was skipped FOREVER
//      (a late booking simply never got its reminder, and nothing warned);
//   2. that mark was advanced UNCONDITIONALLY after sendTemplated(), which does
//      not throw when WhatsApp rejects a send - it RETURNS a log row with
//      status 'failed'. So a failed send was recorded as "reminded" and was
//      never retried.
//
// WHAT IS REAL HERE AND WHAT IS FAKED, and why:
//   * REAL: a throwaway SQLite database via tests/helpers.js freshDb(), the
//     real repository, the real `settings` table, the real `appointments`
//     rows, and the real local-naive window arithmetic in reminders.js. The
//     marker therefore has to survive a real DB round-trip, and the window has
//     to actually select the rows we expect - both are part of the defect.
//   * FAKED: only `messaging.sendTemplated`. That is the one seam the module
//     documents for tests (injected = { repo, messaging }), and faking it is
//     what lets these tests drive the 'failed' path deterministically, which
//     cannot be produced reliably through a real provider.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { after } = require('node:test');
const path = require('node:path');
const h = require('./helpers');

after(() => h.cleanupTemp());

const SRC = h.SRC;
const WINDOW = { hoursBefore: 24, lookAheadMinutes: 60 };
const MS = { hour: 3600 * 1000, minute: 60 * 1000 };
const LEGACY_KEY = 'reminders.lastSlotSent';

const slotKey = (id) => `reminders.sent.${id}`;

/** A local-naive 'YYYY-MM-DD HH:mm' `minutes` from now — the stored slot shape. */
/**
 * A local-naive 'YYYY-MM-DD HH:mm' for the instant `ms` away from `base`.
 * `base` is an ARGUMENT so a caller that needs two stamps of ONE booking
 * derives both from ONE Date.now() reading - see book() below.
 */
const stampFrom = (base, ms) => h.localStamp(new Date(base + ms));

/** A local-naive 'YYYY-MM-DD HH:mm' `minutes` from now - the stored slot shape. */
const slotFromNow = (minutes) => stampFrom(Date.now(), minutes * MS.minute);

// --- doubles ---------------------------------------------------------------

/**
 * A fake messaging module.
 * @param {object} [opts]
 * @param {string|function} [opts.status] status for the Nth send (1-based), or a
 *   function (n) => status. The literal 'THROW' makes that send throw instead.
 * @returns {{calls: Array, sendTemplated: Function}}
 */
function fakeMessaging(opts = {}) {
  const calls = [];
  return {
    calls,
    async sendTemplated(toPhone, template, params) {
      calls.push({ toPhone, template, params });
      const next = typeof opts.status === 'function' ? opts.status(calls.length) : opts.status;
      const status = next === undefined ? 'sent' : next;
      if (status === 'THROW') throw new Error('provider exploded');
      // BOTH real shapes are named here, because this suite exists to police
      // exactly this contract and a wrong claim about it is worse than no claim.
      //
      // THE REAL CONTRACT (asserted against the real module in
      // 'CONTRACT: the real messaging.sendTemplated resolves to the persisted
      // ROW, not a rowid' below): sendTemplated returns `loggedRow({...})`.
      // loggedRow calls messages.log() - which DOES end in `return
      // info.lastInsertRowid`, a NUMBER - and then reads that row back through
      // `messages.statusById(id)`. So the real return is the PERSISTED ROW (an
      // object carrying `.status`), or `{ id, status }` if the row is unreadable.
      //
      // THE ROWID BRANCH (covered separately in 'a provider that resolves to a
      // bare ROWID is still a confirmed delivery' below): reminders.js
      // `deliveryRow()` also normalises a bare number via the same statusById
      // lookup, so that path must stay covered even though it is no longer what
      // sendTemplated produces.
      //
      // This double hands back a plain object carrying `.status` so the job tests
      // can drive the 'failed' branch without a real provider. That is a
      // CONVENIENCE, not a faithful copy - do not "fix" a reminder bug by
      // trusting this shape.
      return { id: calls.length, toPhone, direction: 'outbound', template, body: 'stub', status };
    },
  };
}

/**
 * Run reminders.js against a fresh real DB, capturing console.warn so the
 * failure logging is BOTH asserted on and kept out of the suite output.
 */
async function tick(opts = {}) {
  const ctx = h.freshDb();
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  const messaging = opts.messaging || fakeMessaging(opts);
  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    const result = await runReminders(Object.assign({}, WINDOW, opts.options), {
      repo: ctx.repo,
      messaging,
    });
    return { result, messaging, warns, ctx };
  } finally {
    console.warn = realWarn;
  }
}

/** Book n appointments one `minutes` from now, each with its own client. */
let phoneSeq = 0;
function book(ctx, offsets) {
  const { repo } = ctx;
  return offsets.map((minutes) => {
    phoneSeq += 1;
    // House fixture convention, matched to the rest of tests/ rather than to this
    // file alone: '+91' + the literal '9000000' + a 3-digit discriminator, which
    // is exactly how api/csrf/intake-authz/pdf/reports/repository/unit/webhook
    // seed patients (e.g. +919000000001, +919000000999, +919000007777).
    //
    // This used to build '+91900000' + String(1000 + phoneSeq). That has the same
    // digit COUNT (13 chars, 12 digits) but shifts a zero out of the run, so it
    // produced +919000001001 - a number that appears nowhere else in the project
    // and that no other suite's fixture pattern would match. The 1000+ also made
    // the discriminator 4 digits wide (1001, 1002, ...) instead of 3 (001, 002).
    // Corrected here so one grep for '+919000000' finds every patient fixture.
    const client = repo.clients.create({
      name: `Patient ${phoneSeq}`,
      phone: `+919000000${String(phoneSeq).padStart(3, '0')}`,
    });
    // ONE clock reading for BOTH stamps. Two separate slotFromNow() calls each
    // read Date.now() independently, so a minute boundary falling between them
    // produced slot_end 31 minutes after slot_start - a malformed fixture that
    // fails for a reason unrelated to D16. One `base` makes the pair exact.
    const base = Date.now();
    return repo.appointments.book({
      clientId: client.id,
      slotStart: stampFrom(base, minutes * MS.minute),
      slotEnd: stampFrom(base, (minutes + 30) * MS.minute),
      service: 'Consultation',
    });
  });
}

/**
 * Ids currently carrying a per-appointment marker. Reads the settings table
 * directly rather than keying off known ids, so it also catches a marker
 * written for an appointment the test did not create.
 */
const marked = (ctx) => {
  const rows = ctx.db.prepare("SELECT key FROM settings WHERE key LIKE 'reminders.sent.%'").all();
  return rows.map((r) => Number(r.key.split('.').pop())).sort((a, b) => a - b);
};

// ---------------------------------------------------------------------------
// (c) steady state: each appointment is reminded exactly once
// ---------------------------------------------------------------------------

test('an empty window is a clean no-op, and no legacy key is invented', async () => {
  // tick() owns the database, so do NOT call freshDb() here as well — a second
  // freshDb() closes the handle the first one returned.
  const { result, ctx } = await tick();
  assert.deepEqual(result, { checked: 0, sent: 0, failed: 0 });
  assert.equal(ctx.repo.settings.get(LEGACY_KEY), null, 'sanity: no legacy key written');
});

test('three in-window appointments -> 3 sent, then 0 on every later tick', async () => {
  const ctx = h.freshDb();
  const appts = book(ctx, [23 * 60 + 30, 24 * 60, 24 * 60 + 30]);
  const messaging = fakeMessaging();
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));

  const run = () => runReminders(WINDOW, { repo: ctx.repo, messaging });

  const r1 = await run();
  assert.deepEqual(r1, { checked: 3, sent: 3, failed: 0 });
  assert.equal(messaging.calls.length, 3);
  assert.deepEqual(marked(ctx), appts.map((a) => a.id).sort((a, b) => a - b));

  // Tick 2 and 3 must be complete no-ops: this is the double-send guard.
  for (const n of [2, 3]) {
    const r = await run();
    assert.equal(r.sent, 0, `tick ${n} re-sent an already-reminded appointment`);
    assert.equal(r.failed, 0);
    assert.equal(r.checked, 3, 'the window is still examined even when nothing is due');
    assert.equal(messaging.calls.length, 3, `tick ${n} made extra provider calls`);
  }

  // Each reminder carries the data the template needs, to the right patient.
  const firstCall = messaging.calls[0];
  assert.equal(firstCall.template, 'reminder_24h');

  // The EXACT number seeded for THIS appointment, not merely "something that
  // looks like a phone". reminders.js sorts `due` ascending by slot_start and
  // book() returns appointments in ascending-slot order, so calls[0] is
  // appts[0]. Deriving the expectation from the stored row — rather than from
  // the shared `phoneSeq` counter — keeps it correct however many bookings an
  // unrelated test adds above this one, and it is what actually proves the
  // value reached the provider unmangled.
  const firstPatient = ctx.repo.clients.summary(appts[0].client_id);
  assert.equal(firstCall.toPhone, firstPatient.phone,
    'the send carries this appointment\'s exact seeded number, not a lookalike');
  assert.match(firstCall.toPhone, /^\+\d{10,15}$/, 'and the stored number is E.164-ish');
  assert.equal(firstCall.params.clientName, firstPatient.name,
    'clientName is the matching patient, not another one\'s');
  assert.ok(firstCall.params.service, 'service is passed through');
  assert.match(firstCall.params.slotStart, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    'slotStart must be the local-naive stored shape, not an ISO instant');
});

test('a slot OUTSIDE the window is never messaged', async () => {
  const ctx = h.freshDb();
  book(ctx, [22 * 60, 24 * 60, 26 * 60]); // only the middle one is in-window
  const messaging = fakeMessaging();
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  const r = await runReminders(WINDOW, { repo: ctx.repo, messaging });
  assert.equal(r.checked, 1, 'only the +24h slot is inside [23h, 25h)');
  assert.equal(r.sent, 1);
  assert.equal(messaging.calls.length, 1);
});

test('a CANCELLED in-window appointment is examined but never messaged', async () => {
  const ctx = h.freshDb();
  const [a, b] = book(ctx, [24 * 60, 24 * 60 + 30]);
  ctx.repo.appointments.updateStatus(a.id, 'cancelled');
  const messaging = fakeMessaging();
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  const r = await runReminders(WINDOW, { repo: ctx.repo, messaging });
  assert.equal(r.checked, 1, 'checked counts LIVE rows only');
  assert.equal(r.sent, 1);
  assert.deepEqual(messaging.calls.map((c) => c.params.slotStart), [b.slot_start],
    'the cancelled appointment must not be messaged');
  assert.deepEqual(marked(ctx), [b.id]);
});

// ---------------------------------------------------------------------------
// (a) a LATE booking inside an already-processed window is still reminded
// ---------------------------------------------------------------------------

test('D16-a: a late booking sorting BELOW the already-reminded slots is still reminded exactly once', async () => {
  const ctx = h.freshDb();
  const first = book(ctx, [23 * 60 + 30, 24 * 60, 24 * 60 + 30]);
  const messaging = fakeMessaging();
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  const run = () => runReminders(WINDOW, { repo: ctx.repo, messaging });

  assert.equal((await run()).sent, 3, 'the first tick reminds the original three');

  // THE DEFECT: this appointment is booked afterwards, and its slot sorts
  // BETWEEN two slots that have already been reminded. The old global
  // high-water mark held max(slot_start) = +24h30m, and the filter was
  // `slot_start > lastSent`, so this row was skipped FOREVER - a real patient
  // silently received no 24h reminder and nothing logged it.
  const late = book(ctx, [23 * 60 + 45]);
  assert.ok(late[0].slot_start < first[2].slot_start,
    'precondition: the late booking sorts BELOW an already-reminded slot');

  const r2 = await run();
  assert.equal(r2.checked, 4, 'the new row is inside the window');
  assert.equal(r2.sent, 1, 'and it must be reminded despite the earlier mark');
  assert.equal(messaging.calls.length, 4);
  assert.equal(messaging.calls[3].params.slotStart, late[0].slot_start,
    'the 4th send must be the late booking');

  // ...exactly once, not on every subsequent tick.
  assert.equal((await run()).sent, 0, 'the late booking must not be re-sent');
  assert.equal(messaging.calls.length, 4);
  assert.deepEqual(marked(ctx), first.concat(late).map((a) => a.id).sort((a, b) => a - b));
});

test('D16 (legacy watermark): a pre-existing reminders.lastSlotSent suppresses nothing', async () => {
  const ctx = h.freshDb();
  const appts = book(ctx, [23 * 60 + 30, 24 * 60, 24 * 60 + 30]);
  // Simulate a database upgraded from the watermark implementation: the key is
  // still there, holding a slot LATER than every appointment we are about to
  // send. Under the old filter all three would be skipped and the clinic would
  // remind nobody, forever. Backward compatibility here means "ignore it".
  ctx.repo.settings.set(LEGACY_KEY, slotFromNow(48 * 60));

  const messaging = fakeMessaging();
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  const r = await runReminders(WINDOW, { repo: ctx.repo, messaging });

  assert.equal(r.checked, 3);
  assert.equal(r.sent, 3, 'a legacy watermark must not suppress a real reminder');
  assert.deepEqual(marked(ctx), appts.map((a) => a.id).sort((a, b) => a - b));
});

test('the legacy reminders.lastSlotSent key is never written', async () => {
  const ctx = h.freshDb();
  book(ctx, [24 * 60]);
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  await runReminders(WINDOW, { repo: ctx.repo, messaging: fakeMessaging() });
  assert.equal(ctx.repo.settings.get(LEGACY_KEY), null,
    'the global watermark must stay gone, not be revived alongside the per-id markers');
});

// ---------------------------------------------------------------------------
// (b) a FAILED send is not marked, and IS retried on the next tick
// ---------------------------------------------------------------------------

test('D16-b: a FAILED send is not marked as reminded and is retried on the next tick', async () => {
  const ctx = h.freshDb();
  const appts = book(ctx, [23 * 60 + 30, 24 * 60, 24 * 60 + 30]);

  // sendTemplated does NOT throw on a provider error - it returns the logged
  // row with status 'failed'. That is exactly why the old unconditional
  // setSetting() recorded a failure as a success.
  let phase = 'fail';
  const messaging = fakeMessaging({ status: () => (phase === 'fail' ? 'failed' : 'sent') });
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  const run = () => runReminders(WINDOW, { repo: ctx.repo, messaging });

  const r1 = await run();
  assert.equal(r1.sent, 0, 'a failed send is not a delivery');
  assert.equal(r1.failed, 3, 'every attempt is reported as failed');
  assert.equal(messaging.calls.length, 3);
  assert.deepEqual(marked(ctx), [], 'NOTHING may be marked while delivery is unconfirmed');
  assert.deepEqual(
    appts.map((a) => ctx.repo.settings.get(slotKey(a.id))),
    [null, null, null],
    'the settings table must carry no per-id marker for a failed send');

  // Provider recovers -> the very next tick must retry all three, once.
  phase = 'ok';
  const r2 = await run();
  assert.equal(r2.sent, 3, 'the retry must go out');
  assert.equal(r2.failed, 0);
  assert.equal(messaging.calls.length, 6, 'three retries were attempted');
  assert.deepEqual(marked(ctx), appts.map((a) => a.id).sort((a, b) => a - b));

  // And then it is genuinely done.
  const r3 = await run();
  assert.equal(r3.sent, 0, 'a successful retry must not repeat forever');
  assert.equal(messaging.calls.length, 6);
});

test('a failed send is logged loudly with its appointment id, not swallowed', async () => {
  const ctx = h.freshDb();
  const [appt] = book(ctx, [24 * 60]);
  const messaging = fakeMessaging({ status: 'failed' });
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));

  const warns = [];
  const realWarn = console.warn;
  console.warn = (...a) => warns.push(a.map(String).join(' '));
  try {
    await runReminders(WINDOW, { repo: ctx.repo, messaging });
  } finally {
    console.warn = realWarn;
  }

  const blob = warns.join('\n');
  assert.ok(blob.length > 0, 'a failed send must produce output, or the clinic never learns');
  assert.match(blob, /reminders/i);
  assert.ok(blob.includes(String(appt.id)), `the log must name appointment ${appt.id}; got:\n${blob}`);
  assert.match(blob, /failed/i);
});

test("a status we do not recognise is treated as NOT delivered (fail safe)", async () => {
  const ctx = h.freshDb();
  book(ctx, [24 * 60]);
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  const realWarn = console.warn;
  console.warn = () => {};
  try {
    // 'queued' is a real status messaging.js can log. It is not a confirmation,
    // so the appointment must stay unmarked and be retried.
    const r = await runReminders(WINDOW, { repo: ctx.repo, messaging: fakeMessaging({ status: 'queued' }) });
    assert.equal(r.sent, 0, 'only sent/mocked confirm a delivery');
    assert.equal(r.failed, 1);
  } finally {
    console.warn = realWarn;
  }
  assert.deepEqual(marked(ctx), [], 'queued is not proof of delivery');

  // ...and a later tick with a real status does deliver it.
  const realWarn2 = console.warn;
  console.warn = () => {};
  try {
    const r = await runReminders(WINDOW, { repo: ctx.repo, messaging: fakeMessaging() });
    assert.equal(r.sent, 1, 'the retry must go out once the provider confirms');
  } finally {
    console.warn = realWarn2;
  }
});

test('a messaging module that THROWS leaves the appointment unmarked and does not abandon the batch', async () => {
  const ctx = h.freshDb();
  const appts = book(ctx, [23 * 60 + 30, 24 * 60, 24 * 60 + 30]);
  // First send throws, the rest succeed — the shape of a one-off provider fault.
  const messaging = fakeMessaging({ status: (n) => (n === 1 ? 'THROW' : 'sent') });
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));

  const realWarn = console.warn;
  console.warn = () => {};
  let r;
  try {
    r = await runReminders(WINDOW, { repo: ctx.repo, messaging });
  } finally {
    console.warn = realWarn;
  }

  assert.equal(r.sent, 2, 'the throw must not abort the remaining appointments');
  assert.equal(r.failed, 1);
  assert.deepEqual(marked(ctx), appts.slice(1).map((a) => a.id).sort((a, b) => a - b),
    'only the two confirmed deliveries are marked');

  // The thrown one is retried next tick.
  const realWarn2 = console.warn;
  console.warn = () => {};
  try {
    const r2 = await runReminders(WINDOW, { repo: ctx.repo, messaging: fakeMessaging() });
    assert.equal(r2.sent, 1, 'exactly the unmarked appointment is retried');
    assert.equal(r2.failed, 0);
  } finally {
    console.warn = realWarn2;
  }
  assert.deepEqual(marked(ctx), appts.map((a) => a.id).sort((a, b) => a - b));
});

// ---------------------------------------------------------------------------
// Contract the module documents — guards against a future "simplification"
// ---------------------------------------------------------------------------

test('runOnce is still an alias of runReminders (the legacy export)', () => {
  const { runOnce, runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  assert.equal(runOnce, runReminders);
});

test('the module holds no SQL of its own', () => {
  // The job was migrated off raw SQL so the database stays swappable; a
  // reintroduced prepare() would silently re-couple it to better-sqlite3.
  const src = require('fs').readFileSync(path.join(SRC, 'jobs', 'reminders.js'), 'utf8');
  assert.equal((src.match(/\.prepare\(/g) || []).length, 0, 'reminders.js must not run SQL');
  // The real repository IS required — but only lazily, inside runReminders, so
  // `require`-ing this file never opens a database. A module-scope require
  // would break that, and would also drag better-sqlite3 into any caller.
  const topLevelDb = src.split('\n').filter((line) =>
    /^const\s+\w+\s*=.*require\(['"]\.\.\/db\//.test(line));
  assert.deepEqual(topLevelDb, [],
    'the database must not be required at module scope:\n' + topLevelDb.join('\n'));
});

test('the window is local-naive, never an ISO instant', async () => {
  // D9/D10 family: ' ' (0x20) sorts before 'T' (0x54), so an ISO lower bound
  // makes every same-day slot compare as LESS THAN the bound and the job
  // silently reminds nobody. This asserts real rows are actually selected.
  const ctx = h.freshDb();
  const [appt] = book(ctx, [24 * 60]);
  const messaging = fakeMessaging();
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));
  const r = await runReminders(WINDOW, { repo: ctx.repo, messaging });
  assert.equal(r.checked, 1, 'a +24h local slot must fall inside the computed window');
  // Compare against the row the booking actually STORED, not against a second
  // reading of the wall clock. slotFromNow(24 * 60) re-derives from Date.now()
  // HERE, so any minute boundary crossed since the booking made this fail for a
  // reason that has nothing to do with the window. The stored value is the
  // stronger assertion anyway: it is the exact string the provider was handed.
  assert.equal(messaging.calls[0].params.slotStart, appt.slot_start,
    'the provider receives the stored local-naive slot_start verbatim');
  assert.match(appt.slot_start, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/,
    'and that stored value really is local-naive, not an ISO instant');
});

// ---------------------------------------------------------------------------
// (d) messages.log() - the layer BENEATH send* - still resolves to a rowid
// ---------------------------------------------------------------------------

test('the real contract is a ROWID, not a row, and the job still marks it delivered', async () => {
  // WHY THIS TEST EXISTS SEPARATELY, AND WHICH CONTRACT IT PINS. It pins
  // messages.log(), which ends at `return info.lastInsertRowid`
  // (src/db/repository.js) - a NUMBER. Note carefully that this is no longer
  // what messaging.send* hands to its callers: messaging.js logs through
  // loggedRow(), which reads the row back with messages.statusById(), so
  // sendTemplated/sendFreeform/sendDocument now resolve to the ROW (see the
  // 'CONTRACT: the real messaging.sendTemplated...' test below). The rowid
  // survives only INSIDE messaging.js, and reminders.js deliveryRow() still
  // has to cope with a numeric return defensively - which is what this test
  // covers, using its own double rather than the real messaging module.
  //
  // Every other test in this file uses fakeMessaging(), which returns an OBJECT
  // carrying `.status`. That let reminders.js read `.status` straight off the
  // return value and pass 14/14 while PRODUCTION marked nothing: no row is ever
  // marked, so the same 24h reminder went out again on every 15-minute tick.
  // A test double that returns the shape the code WANTS rather than the shape
  // that EXISTS is worse than no test, because it converts a P0 into a green
  // suite. So this test uses the real contract: write a real messages row,
  // return only its rowid.
  const ctx = h.freshDb();
  const appts = book(ctx, [24 * 60]);
  const calls = [];
  const rowidMessaging = {
    calls,
    async sendTemplated(toPhone, template, params) {
      calls.push({ toPhone, template, params });
      const id = ctx.repo.messages.log({
        toPhone,
        direction: 'outbound',
        template,
        body: 'stub',
        status: 'mocked',
      });
      // Assert the LAYER's contract here: messages.log() is the thing that
      // returns a bare rowid, and reminders.js deliveryRow() must resolve
      // exactly that. If log() ever starts returning a row, this test says WHY
      // it changed rather than going quietly green on a stale assumption.
      assert.equal(typeof id, 'number',
        'messages.log() must resolve to a rowid - reminders.js reads .status off it');
      assert.equal(id && id.status, undefined, 'and a rowid carries no .status');
      return id; // <-- the entire point of this test: a bare NUMBER
    },
  };
  const { runReminders } = require(path.join(SRC, 'jobs', 'reminders.js'));

  const r1 = await runReminders(WINDOW, { repo: ctx.repo, messaging: rowidMessaging });
  assert.equal(r1.sent, 1,
    'a rowid whose persisted row says "mocked" IS a confirmed delivery');
  assert.equal(r1.failed, 0, 'it must not be miscounted as a failure');
  assert.deepEqual(marked(ctx), [appts[0].id],
    'it must be MARKED - an unmarked appointment is re-sent on every tick forever');

  // Second tick on the same real contract: this is the whole point of the
  // idempotency marker, and it is the half a shape-only double cannot prove.
  const r2 = await runReminders(WINDOW, { repo: ctx.repo, messaging: rowidMessaging });
  assert.equal(r2.sent, 0, 'a rowid-returning provider must still be idempotent');
  assert.equal(calls.length, 1, 'exactly ONE provider call across two ticks');
});

test('CONTRACT: the real messaging.sendTemplated resolves to the persisted ROW, not a rowid', async () => {
  // WHY THIS TEST EXISTS (D18 / the double that lied). Every test above drives
  // reminders.js through `fakeMessaging`, which returns a row OBJECT. That made
  // the idempotency assertions pass while production was broken, because the
  // REAL send* resolved to `info.lastInsertRowid` - a NUMBER. Reading `.status`
  // off a number yields undefined, DELIVERED never matched, no appointment was
  // ever marked, and the 15-minute cron re-sent the same reminder to a real
  // patient on every tick, forever. A double cannot catch a contract mismatch
  // in the module it doubles, so this asserts the contract against the REAL
  // messaging module and the REAL repository. If send* ever reverts to a bare
  // rowid, this fails.
  const ctx = h.freshDb();
  const messaging = require(path.join(SRC, 'services', 'messaging.js'));

  const ret = await messaging.sendTemplated('+919000000777', 'reminder_24h', {
    clientName: 'Contract',
    slotStart: slotFromNow(24 * 60),
  });

  assert.notEqual(typeof ret, 'number',
    'sendTemplated resolved to a rowid - jobs/reminders.js cannot read .status off a number, '
    + 'so isDelivered() is false for EVERY send and reminders repeat forever');
  assert.equal(typeof ret, 'object', 'sendTemplated must resolve to the persisted row');
  assert.equal(typeof ret.status, 'string', 'the row must carry a status string');
  assert.ok(['sent', 'mocked'].includes(ret.status),
    'a successful send must report a delivered status, got: ' + JSON.stringify(ret.status));
  assert.equal(typeof ret.id, 'number', 'the row must carry its own id');

  // And the status must be the PERSISTED one, not one invented by the caller:
  // read the row back out of the database and require them to agree.
  const persisted = ctx.repo.messages.statusById(ret.id);
  assert.ok(persisted, 'the returned row id must exist in the messages table');
  assert.equal(ret.status, persisted.status,
    'the returned status must be the one actually written to the messages table');
});