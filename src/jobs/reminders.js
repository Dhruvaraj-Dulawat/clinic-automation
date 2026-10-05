// ============================================================================
// clinic-automation — 24h reminder job (src/jobs/reminders.js)
// Every schedule.json "reminders.cron" tick: find booked/confirmed
// appointments starting ~hoursBefore from now (±lookAheadMinutes), send the
// reminder_24h template with CONFIRM/CANCEL quick-replies.
//
// --- IDEMPOTENCY: PER-APPOINTMENT, NOT A HIGH-WATER MARK (D16) --------------
// This used to keep ONE settings key, `reminders.lastSlotSent`, holding the
// greatest slot_start ever reminded, and skipped anything with
// `slot_start > lastSent`. That is wrong the moment appointments are booked out
// of order, which is the NORMAL case: a patient books the 09:00 slot, gets
// reminded, and the mark moves to 09:00; a different patient then books an
// EARLIER slot that same day (or a slot the window re-enters after a
// reschedule). `09:00 > 09:00` is false and `'08:30' > '09:00'` is false, so
// that appointment was NEVER reminded — and because the mark only ever moved
// forward, it could never be reminded later either. A real patient silently
// receives no 24h reminder and nobody is told.
// The fix keys the marker on the APPOINTMENT, not on a timestamp:
//     reminders.sent.<appointmentId> = '1'
// Each appointment is therefore considered exactly once, in any order, and a
// late booking is picked up on the next tick. The old key is left in the table
// (harmless, and deleting it would need a migration); it is simply no longer
// read.
//
// --- MARK ONLY WHAT THE PROVIDER CONFIRMED (D16, second half) ---------------
// Keying the marker on the appointment is only HALF the fix. The marker used to
// be written unconditionally after `await messaging.sendTemplated(...)` — and
// sendTemplated does NOT throw when WhatsApp rejects a send. It catches the
// provider error and RETURNS the logged message row with `status: 'failed'`
// (see services/messaging.js). So a failed send was recorded as "reminded",
// never retried, and the patient silently got nothing: the exact outcome this
// job exists to prevent, now with a positive record claiming it worked.
// The marker is therefore written ONLY when the returned row confirms delivery.
// A send that fails, or a messaging module that throws, is left UNMARKED so the
// next 15-minute tick retries it, and the attempt is logged with the
// appointment id so the failure is visible instead of silent. When the outcome
// is not positively confirmed we deliberately do not mark — one extra reminder
// is a far smaller harm than one silently dropped appointment, which is the
// same policy ./settings.js documents for its failed reads and writes.
//
// Deps: ../db/repository.js (appointments, clients, settings keys),
// ../services/messaging.js, ./settings.js (shared key helpers),
// ../services/datetime.js (the ONE place a datetime is formatted —
// appointments.slot_start is local-naive 'YYYY-MM-DD HH:mm').
// Run via src/jobs/index.js (node-cron). Exports runReminders (canonical,
// S5.1.1) + runOnce (legacy alias). Both accept (options, injected) where
// injected = { repo, messaging } for tests; production requires lazily.
//
// Return shape — stable, and what each field means:
//   checked  every row the local-naive window returned from listByRange,
//            whatever its status and whether or not it was already marked.
//            This is "how much work did this tick look at", NOT a count of
//            reminders. It has not changed meaning in the D16 fix.
//   sent     reminders the provider CONFIRMED ('sent' or 'mocked') and which
//            are now marked. Unchanged name, tightened meaning: a 'failed'
//            row is no longer counted here, because nothing was delivered.
//   failed   attempts that were not confirmed and stay unmarked for retry.
//            New in the D16 fix. `sent + failed` equals the number of
//            appointments that were due and had a known client, so an
//            operator can see a provider outage here rather than infer it
//            from a `sent` that is merely zero.
// ============================================================================
'use strict';

const { getSetting, setSetting } = require('./settings');
const dt = require('../services/datetime');

// Per-appointment idempotency marker. Kept as a function (not a template
// literal at module scope) so the key shape is greppable from one place.
function sentKey(appointmentId) {
  return `reminders.sent.${appointmentId}`;
}

// The only message statuses that mean the patient actually received the
// reminder. 'mocked' counts because WHATSAPP_MOCK_MODE is a real, supported
// deployment (local demo + this suite) and the message was rendered and logged
// end to end — the alternative is an unbreakable reminder loop in mock mode.
const DELIVERED = new Set(['sent', 'mocked']);

/**
 * Normalise whatever `messaging.sendTemplated` resolved to into the persisted
 * `messages` row, or null.
 *
 * WHY THIS EXISTS (the D18 return-shape trap). `sendTemplated` returns whatever
 * `messages.log()` returns, and `messages.log()` returns `info.lastInsertRowid`
 * — a NUMBER. So the real return value is a rowid, NOT a row: reading `.status`
 * straight off it yields `undefined`, `isDelivered` says false, the appointment
 * is never marked, and the job re-sends the same reminder on every 15-minute
 * tick forever. That is a duplicate-reminder storm to real patients, and it is
 * strictly worse than the high-water-mark bug it replaced.
 *
 * Resolving the rowid through `messages.statusById` is what makes this correct
 * against the REAL module. It also keeps working unchanged if `sendTemplated`
 * is later altered to return the row itself, so this does not depend on which
 * side of that contract gets fixed.
 *
 * @param {*} row      the resolved value: a row object, a rowid, or nothing
 * @param {object} repo repository (for the rowid lookup)
 * @returns {object|null} the persisted row, or null when it cannot be resolved
 */
function deliveryRow(row, repo) {
  if (!row) return null;
  if (typeof row === 'object') return row; // already the persisted row
  const id = Number(row);
  if (!Number.isInteger(id) || id <= 0) return null;
  try {
    const ns = repo && repo.messages;
    return ns && typeof ns.statusById === 'function' ? ns.statusById(id) : null;
  } catch (_) {
    // A rowid we cannot read back is not a confirmed delivery. Leave the
    // appointment unmarked and let the next tick retry it.
    return null;
  }
}

/**
 * Did the provider confirm this send?
 * @param {*} row whatever messaging.sendTemplated resolved to (row OR rowid)
 * @param {object} [repo] repository, needed only to resolve a rowid
 * @returns {boolean} true ONLY for a confirmed delivery. A missing row, a row
 *   with no status, or any status we do not recognise are all treated as NOT
 *   delivered, so the appointment stays unmarked and is retried.
 */
function isDelivered(row, repo) {
  const resolved = deliveryRow(row, repo);
  return Boolean(resolved) && DELIVERED.has(String(resolved.status));
}

// Assemble a local-naive 'YYYY-MM-DD HH:mm' from a Date's LOCAL components,
// using datetime.js's canonical pad() and fmtSlot(). datetime.js keeps its own
// fmtDate() internal (callers are meant to use todayStr()/nowStr()), and the
// 24h-from-now window can straddle midnight, so neither of those helpers applies
// here. No format logic is duplicated — only component assembly.
function slotOf(d) {
  return dt.fmtSlot(
    `${d.getFullYear()}-${dt.pad(d.getMonth() + 1)}-${dt.pad(d.getDate())}`,
    d.getHours(),
    d.getMinutes()
  );
}

/**
 * Remind every live appointment whose slot starts ~hoursBefore from now.
 *
 * @param {object}  [options]
 * @param {number}  [options.hoursBefore=24]        centre of the window
 * @param {number}  [options.lookAheadMinutes=20]   half-width of the window
 * @param {object}  [injected] test seam
 * @param {object}  [injected.repo]                 stands in for ../db/repository
 * @param {object}  [injected.messaging]            stands in for ../services/messaging
 * @returns {Promise<{checked: number, sent: number, failed: number}>}
 *   `checked` = live (booked/confirmed) appointments examined in the window.
 *   `sent`    = reminders the provider CONFIRMED and that are now marked. Only
 *               a 'sent'/'mocked' log row counts; a 'failed' one is not a
 *               delivery, so it lands in `failed` instead (D16).
 *   `failed`  = attempts left UNMARKED for the next tick to retry — an
 *               unconfirmed or throwing provider, or a missing client. Any
 *               non-zero value means a real patient may have no reminder.
 *   `sent <= checked` always; the gap is appointments already carrying
 *   `reminders.sent.<id>`. All three counters are per-run, not cumulative.
 */
async function runReminders({ hoursBefore = 24, lookAheadMinutes = 20 } = {}, injected = {}) {
  const repo = injected.repo || require('../db/repository');
  const messaging = injected.messaging || require('../services/messaging');

  // The window bounds MUST be local-naive 'YYYY-MM-DD HH:mm' — the stored shape
  // of slot_start. datetime.js builds them from local components, so a clinic in
  // IST computes its own 09:00-24h-from-now rather than a UTC-shifted one.
  // (A toISOString() bound here is exactly the D9/D10 defect: ' ' sorts before
  // 'T', so every in-window slot compared as LESS THAN the lower bound and the
  // job silently reminded nobody.)
  const target = new Date(Date.now() + hoursBefore * 3600 * 1000);
  const lo = slotOf(new Date(target.getTime() - lookAheadMinutes * 60 * 1000));
  const hi = slotOf(new Date(target.getTime() + lookAheadMinutes * 60 * 1000));

  // Half-open [lo, hi) via listByRange. findUpcoming is deliberately NOT used:
  // it renders ISO/Zulu bounds that never string-match a local slot — ' ' sorts
  // before 'T', so an ISO bound matches nothing and the job reminds nobody.
  const inWindow = repo.appointments.listByRange(lo, hi);
  // `checked` counts the LIVE (booked/confirmed) rows examined, NOT every row
  // the window returned. listByRange applies no status filter, so counting its
  // raw output would let a window full of cancelled/completed appointments
  // report "checked: 40, sent: 0" and imply 40 live patients were considered
  // when none were. Matches the sibling jobs: followups.js returns
  // `due.length` (post-filter) and reengagement.js increments `checked` once
  // per live row.
  const live = inWindow.filter((a) => a.status === 'booked' || a.status === 'confirmed');
  // D16: idempotency is per appointment, so order and re-entry do not matter.
  // The marker check is deliberately NOT part of `checked`: an already-marked
  // appointment was still examined, it just was not messaged again.
  const due = live
    .filter((a) => getSetting(sentKey(a.id), repo) !== '1')
    .sort((a, b) => (a.slot_start < b.slot_start ? -1 : 1));

  let sent = 0;
  let failed = 0;
  for (const appt of due) {
    const client = repo.clients.findById(appt.client_id);
    if (!client) {
      // listByRange INNER JOINs clients, so this is unreachable via that path;
      // it stays as a guard for an injected repo, and it is counted + logged
      // rather than skipped silently — a dropped reminder must never be quiet.
      failed += 1;
      console.warn(`[jobs] reminders appointment ${appt.id}: client ${appt.client_id} not found — left UNMARKED, skipped`);
      continue;
    }
    // Positional messaging signature: sendTemplated(to, template, params).
    let row;
    try {
      row = await messaging.sendTemplated(client.phone, 'reminder_24h', {
        clientName: client.name,
        service: appt.service,
        slotStart: appt.slot_start,
      });
    } catch (err) {
      // The real sendTemplated only throws for an unknown template, but this
      // module is injected in tests and swappable in production. One bad
      // appointment must not abandon the rest of the batch.
      failed += 1;
      console.warn(`[jobs] reminders appointment ${appt.id}: send threw (${err && err.message ? err.message : err}) — left UNMARKED, will retry next tick`);
      continue;
    }
    // D16: mark ONLY what the provider confirmed. See the header — a 'failed'
    // row is not a delivery, and marking it is how a real patient silently
    // stopped being reminded.
if (!isDelivered(row, repo)) {
      failed += 1;
      // Report the RESOLVED status, not the raw return value: with a rowid
      // return, `row.status` is undefined and the log would say "(no status)"
      // for a message that was in fact logged as 'mocked'.
      const resolved = deliveryRow(row, repo);
      const seen = resolved && resolved.status ? resolved.status : '(unreadable)';
      console.warn(`[jobs] reminders appointment ${appt.id}: provider reported status "${seen}" - left UNMARKED, will retry next tick`);
      continue;
    }
    setSetting(sentKey(appt.id), '1', repo);
    sent += 1;
  }
  return { checked: live.length, sent, failed };
}

module.exports = { runOnce: runReminders, runReminders };
