// ============================================================================
// clinic-automation — weekly owner digest (src/services/digest.js)
// buildWeeklyDigest(): plain-text summary (daily + 7-day aggregates + flags)
//   for the owner. sendWeeklyDigest(): sends it to OWNER_PHONE via the same
//   send+log path as everything else (services/messaging.js), with a
//   staffNotify fallback when messaging is unavailable — lazy requires inside
//   try/catch so digest.js never crashes a cron boot when siblings are absent.
//   Both the primary send AND the staffNotify fallback report their REAL logged
//   status (see D18 below); neither branch hardcodes sent:true.
// EMAIL STUB: to also email the digest, plug a nodemailer/sendgrid call here
//   (no new deps added — left as a commented hook for the operator).
// Consumed by: GET /api/reports/digest (preview) and the Monday schedule in
// schedule.json "digest" (wired by the operator via node-cron or the VPS
// crontab calling the reports endpoint — see README deploy notes).
// Deps: ./reports.js, ./datetime.js, ./messaging.js, ./staffNotify.js,
//   ../config.js, ../db/repository.js (statusById only, lazily).
//
// --- WHY datetime.js AND NOT toISOString() (D9/D10 family) -----------------
// `new Date().toISOString().slice(0, 10)` is the UTC date. For a clinic east of
// Greenwich (IST is +05:30) that is YESTERDAY for every request between local
// 00:00 and 05:30, so the owner would open their digest to find it already
// stale and the "today" row would be silently wrong. datetime.js is the single
// module allowed to format a local date; use it here.
'use strict';

const reports = require('./reports');
const datetime = require('./datetime');

// Monday of the current week, as a LOCAL "YYYY-MM-DD". Replaces the old
// manual getDay() arithmetic, which had the same UTC/Local footgun.
function mondayOfThisWeek() {
  return datetime.weekStart(new Date());
}

function buildWeeklyDigest() {
  const today = datetime.todayStr();
  const daily = reports.getDailySummary(today);
  const weekly = reports.getWeeklyAggregates(mondayOfThisWeek());
  const flags = reports.getFollowupFlags();
  const lines = [
    `Weekly digest — week of ${weekly.weekStart} to ${weekly.weekEnd}`,
    `Today (${daily.date}): ${daily.bookings} bookings, ${daily.noShows} no-shows, revenue ${daily.revenue} (${daily.newClients} new / ${daily.returningClients} returning)`,
    `This week: ${weekly.total} bookings, revenue ${weekly.revenue} ${JSON.stringify(weekly.byStatus)}`,
    `Flags: ${flags.noResponseAfterReminder.length} no-response-after-reminder, ${flags.overdueNextVisit.length} overdue-next-visit, ${flags.unconfirmedSoon.length} unconfirmed (48h), ${flags.missingIntake.length} completed w/o intake`,
  ];
  if (flags.unconfirmedSoon.length) {
    lines.push('Unconfirmed soon:');
    for (const a of flags.unconfirmedSoon.slice(0, 10)) {
      lines.push(`  - ${a.client ? a.client.name : '?'} ${a.slot_start} (${a.service})`);
    }
  }
  // Email hook (stub — no new deps):
  //   const mailer = require('./mailer'); // not bundled
  //   await mailer.send({ to: process.env.OWNER_EMAIL, subject: 'Weekly digest', text: lines.join('\n') });
  return lines.join('\n');
}

// messaging.send* resolves to whatever the repository's logMessage returned,
// which is the messages ROWID (a number) — not a row object. Normalise both
// shapes so a caller never has to care which one it got.
function messageId(result) {
  if (result === null || result === undefined) return null;
  if (typeof result === 'number') return result;
  if (typeof result === 'object') return result.id || result.message_id || null;
  return null;
}

// D18: the old code read `row.status` off that rowid, so it was ALWAYS
// undefined and the ternary always produced 'sent' — and `sent: true` was
// hardcoded regardless. A digest the provider had rejected was therefore
// reported to the owner as delivered. Read the real status back by id, and
// derive `sent` from it so 'failed' can never masquerade as a success.
//
// The last-resort fallback is 'unknown', NOT 'sent'. This function is the only
// signal the owner gets about whether the weekly digest arrived, so an
// unreadable row must not be reported as a delivery — that is the one direction
// that can quietly hide a broken notification. `sent` is then derived from an
// explicit delivered-set below, so 'unknown' lands on sent:false.

// Labels already reported, so a permanently missing capability cannot reprint the
// same warning on every call until the operator learns to scroll past it. Same
// rationale and the same shape as the de-duplication in reports.js's swallow().
const warnedReads = new Set();

/**
 * Warn ONCE per label, then stay quiet. Never throws — a reporting path must
 * not become a second failure mode.
 *
 * @param {string} label   the capability that failed, e.g. 'messages.statusById'
 * @param {string} detail  the real error message
 * @returns {void}
 */
function warnOnce(label, detail) {
  if (warnedReads.has(label)) return;
  warnedReads.add(label);
  console.warn(`[digest] WARNING: ${label} failed — reporting "unknown" for the send status. ${detail}`);
  console.warn(
    '[digest]   the weekly digest may not have reached the owner. This is NOT a confirmed '
    + 'failure: the message row exists, we just could not read it back. Check OWNER_PHONE and '
    + 'the messages table before assuming the report arrived.'
  );
}

function messageStatus(result) {
  const id = messageId(result);
  if (id !== null) {
    try {
      const row = require('../db/repository').messages.statusById(id);
      if (row && row.status) return String(row.status);
    } catch (e) {
      // Deliberately NOT silent. Swallowing this leaves the operator holding
      // status:'unknown' with no explanation at all, which is the same
      // invisibility D18 exists to remove — one layer further down, where a
      // broken repository or a missing messages table would hide a failed
      // weekly report behind a plausible-looking return value. Name the cause.
      warnOnce('messages.statusById', (e && e.message) || String(e));
    }
  }
  // An older messaging.js may still hand back a full row; honour its status
  // before resorting to the honest default.
  if (result && typeof result === 'object' && result.status) return String(result.status);
  return 'unknown';
}

// Which logged statuses count as a delivery. 'sent' is a real provider send.
// 'mocked' is the local MOCK_MODE path: the row is written but nothing hit the
// network, so it is counted as delivered ONLY in the sense that the pipeline ran
// end to end — the status is returned to the caller alongside `sent` so the two
// are always distinguishable. Anything else ('failed', 'unknown', 'queued') is
// sent:false, so a status this code has never heard of fails safe.
const DELIVERED_STATUSES = new Set(['sent', 'mocked']);

async function sendWeeklyDigest() {
  let owner = '';
  try {
    owner = require('../config').getConfig().ownerPhone || '';
  } catch (_) {
    owner = process.env.OWNER_PHONE || '';
  }
  if (!owner) return { skipped: true, sent: false, reason: 'no OWNER_PHONE configured' };
  const text = buildWeeklyDigest();
  try {
    const messaging = require('./messaging');
    const result = await messaging.sendFreeform(owner, text);
    const status = messageStatus(result);
    return {
      skipped: false,
      sent: DELIVERED_STATUSES.has(status),
      status,
      messageId: messageId(result),
    };
  } catch (e) {
    // The fallback is not a guaranteed delivery. staffNotify.notifyOwner()
    // returns messaging.sendFreeform()'s ROWID — the same rowid contract as the
    // primary path — so it can equally come back 'failed'. Reporting a hardcoded
    // sent:true here would reintroduce D18 one branch down: the primary send
    // just failed, the retry failed too, and the owner is told it arrived.
    // Read the fallback's own status by id and derive `sent` the same way.
    try {
      const staffNotify = require('./staffNotify');
      const viaResult = await staffNotify.notifyOwner(text);
      const viaStatus = messageStatus(viaResult);
      return {
        skipped: false,
        sent: DELIVERED_STATUSES.has(viaStatus),
        status: 'via-staffNotify',
        viaStatus,
        messageId: messageId(viaResult),
      };
    } catch (e2) {
      return { skipped: false, sent: false, reason: String((e2 && e2.message) || e.message || e) };
    }
  }
}

module.exports = {
  buildWeeklyDigest,
  sendWeeklyDigest,
  // Back-compat aliases for the M7 first draft (routes/reports.js).
  buildDigest: buildWeeklyDigest,
  sendDigest: sendWeeklyDigest,
};
