// ============================================================================
// clinic-automation — daily summary + follow-up flags + weekly aggregates
//   (src/services/reports.js)
// Pure queries over the repository. Every read goes through a namespaced
// repository method (receipts.totalForDate, clients.createdOn,
// clients.summary, messages.inboundFromPhones, messages.outboundToPhonesByTemplateLike,
// appointments.recentByStatus, intake.existsFor) — this file contains NO SQL
// and never touches better-sqlite3 or getDb(), so the "swap SQLite for
// Postgres later" promise stays real (src/db/repository.js is the only SQL).
//   dailySummary(dateStr) — bookings that day, no-shows, revenue (SUM of
//     receipts created that day), new vs returning clients, counts by status.
//   followupFlags() — actionable lists: no response after reminder
//     (booked in next 48h, reminder sent, no inbound reply), overdue next
//     visit (no-shows + clients inactive >30 days), no-show + cancelled
//     recall lists, plus unconfirmedSoon / missingIntake helpers consumed by
//     the digest + dashboard.
//   weeklyAggregates(weekStartStr) — 7 per-day rollups (bookings by day +
//     by service) + week totals.
// Aggregation rule: counts are computed HERE from the namespaced
// appointments.listByRange(from, to) rows (which carry client_name /
// client_phone JOINs) — never via flat getRepository-style helpers.
//
// --- DATE CONVENTION (this file no longer formats a datetime itself) ----------
// EVERY date and every window bound below comes from ../services/datetime.js,
// which is the single module allowed to format one. Two shapes are in play and
// mixing them is the D9 defect family this milestone exists to kill:
//   * appointments.slot_start / slot_end are LOCAL-naive "YYYY-MM-DD HH:mm".
//     Range bounds are built with dt.dayBounds()/dt.nowStr() and are therefore
//     half-open ("<date> 00:00" .. "<next date> 00:00") to match the
//     `slot_start >= ? AND slot_start < ?` contract in listByRange().
//   * created_at / updated_at audit columns are written by SQLite
//     `datetime('now')` (UTC, space form) or strftime ISO-with-Z. Those are
//     NEVER used as a slot bound.
// There is no toISOString() in this file, and no local re-implementation of
// pad/fmtSlot/weekStart — that duplication is what let the two formats drift
// apart in the first place. Zero new deps.
//
// --- FAILURE POLICY (deliberate, and the reason it is written down) ----------
// A report must NEVER throw: the dashboard and the WhatsApp digest both call
// these on every render, and a single unreadable table should not 500 the
// owner's day. But silently substituting 0/[] is WORSE than failing — a clinic
// whose revenue query is broken would be told it earned nothing, which is the
// kind of quiet lie that destroys trust in the software. So every fallback goes
// through swallow(), which logs a warning naming the exact query that failed.
// The failure is still non-fatal; it is just no longer invisible.
//
// --- KNOWN CROSS-BOUNDARY DATE DEFECTS (owned by the repository) ------------
// Two repository accessors compare a UTC-stored audit column against the LOCAL
// date this file passes in. Between local 00:00 and 05:30 (IST, +05:30) the two
// disagree by one calendar day, so revenue and the new/returning split can
// answer for yesterday. Measured, not theoretical:
//   TODO(M9-Wave3): receipts.totalForDate() does `date(created_at) = date(?)`
//     on a UTC-stored column — it belongs in the repository, which must convert
//     the requested LOCAL day into the UTC instants that fall inside it.
//   TODO(M9-Wave3): clients.createdOn() slices the first 10 chars off a
//     UTC-stored created_at and compares them to a LOCAL date string.
// Neither is fixable from here without re-introducing SQL into this file, and
// re-introducing the SQL is the defect being removed. Both are recorded as
// SYNC items against src/db/repository.js.
// (Relatedly, digest.js derives `today` with toISOString().slice(0,10) — also
// a UTC day — so it can hand this file the wrong date in that same window.)
//
// Testability: every function takes optional (repo, db) overrides — omit both
// in production. `repo` is consulted first so a test fake wins; an injected
// `db` HANDLE is scoped through repository.forHandle() (the handle never leaks
// SQL back into this file). The two are independent and either alone is enough:
// see resolveRepo() for the full precedence and why it is ordered that way.
// Deps: ../db/repository.js (all data access), ./datetime.js (all formatting).
// ============================================================================
'use strict';

const dt = require('./datetime.js');

/**
 * The repository these reports read through.
 *
 * Precedence, and the reason the handle has to be resolved HERE rather than
 * inside capability(): a bare real repository exposes every capability, so
 * capability() would always find the method on it and never fall through to the
 * handle branch — meaning an injected db handle was silently IGNORED and the
 * report read the process-wide connection instead. In a test that is the
 * operator's real data/clinic.db, which is the worst possible outcome for a
 * "isolated" report. Resolving the facade first makes the handle win.
 *
 *   1. an explicitly injected repo (a test fake) always wins;
 *   2. else an injected db HANDLE, scoped through repository.forHandle();
 *   3. else the process-wide repository (production).
 *
 * Both arguments are optional and independent.
 *
 * @param {object|null} injectedRepo a repo (or partial fake), or null
 * @param {object|null} injectedDb   a better-sqlite3 handle, or null
 * @returns {object} a repository facade
 */
function resolveRepo(injectedRepo, injectedDb) {
  if (injectedRepo) return injectedRepo;
  const real = require('../db/repository');
  if (injectedDb) return real.forHandle(injectedDb);
  return real;
}

// Labels already reported. The weekly rollup asks for revenue 7 times, so an
// unmigrated/missing table would otherwise print 7 identical warnings per call
// and train the operator to ignore them.
const warnedQueries = new Set();

/**
 * Run `fn`, and on failure return `fallback` INSTEAD OF throwing — but say so
 * out loud, naming the query.
 *
 * `fallback` is also used for a legitimate null/undefined result, so callers
 * that expect a number/array should coerce inside `fn` (as the revenue call
 * does with Number(...)) rather than rely on this.
 *
 * @param {string} label   the repository capability, e.g. 'receipts.totalForDate'
 * @param {function} fn    thunk performing the read
 * @param {*} fallback     value to report when the read fails
 * @returns {*} the read result, or `fallback`
 */
function swallow(label, fn, fallback) {
  let value;
  try {
    value = fn();
  } catch (e) {
    if (!warnedQueries.has(label)) {
      warnedQueries.add(label);
      const detail = (e && e.message) || String(e);
      console.warn(
        `[reports] WARNING: ${label} failed — reporting ${JSON.stringify(fallback)} instead. ${detail}`
      );
      console.warn(
        '[reports]   a broken query is NOT the same as an empty result: if this is revenue ' +
        'or a recall list, the owner is being told the clinic is empty when it is not.'
      );
    }
    return fallback;
  }
  return value === undefined || value === null ? fallback : value;
}

// Namespaced range query (contract: appointments.listByRange(from, to)).
// Falls back to the flat listAppointments alias only if the namespaced
// shape is unavailable (defensive — never the other way round).
function rangeList(repo, from, to, limit) {
  if (repo && repo.appointments && typeof repo.appointments.listByRange === 'function') {
    const rows = repo.appointments.listByRange(from, to);
    return typeof limit === 'number' ? rows.slice(0, limit) : rows;
  }
  if (repo && typeof repo.listAppointments === 'function') {
    return repo.listAppointments({ from, to, limit: limit || 2000 });
  }
  throw new Error('[reports] repository has no listByRange/listAppointments');
}

/**
 * Resolve one repository capability, keeping the legacy (repo, db) injection
 * alive without reintroducing SQL here.
 *
 * Order of preference:
 *   1. the repo this report was given — either an injected fake, or the
 *      handle-scoped facade resolveRepo() built from an injected db handle;
 *   2. the real repository bound to the INJECTED db handle — this is what a
 *      partial fake plus an explicit handle resolves to, and it returns the
 *      same numbers the pre-refactor raw query did;
 *   3. the real repository on the process-wide connection.
 *
 * A missing accessor still THROWS here rather than being swallowed: that is a
 * wiring bug in the caller, not a data problem, and it must not be reported to
 * the owner as "no income".
 *
 * @param {object} repo   the repo the caller asked for (may be a partial fake)
 * @param {object} handle an explicit db handle, or null/undefined
 * @param {string} ns     namespace, e.g. 'receipts'
 * @param {string} method method name inside that namespace
 * @returns {function} the bound method
 */
function capability(repo, handle, ns, method) {
  if (repo && repo[ns] && typeof repo[ns][method] === 'function') {
    return (...args) => repo[ns][method](...args);
  }
  const real = require('../db/repository');
  const scoped = handle ? real.forHandle(handle) : real;
  if (!scoped[ns] || typeof scoped[ns][method] !== 'function') {
    throw new Error(`[reports] repository has no ${ns}.${method}`);
  }
  return (...args) => scoped[ns][method](...args);
}

function isValidDate(s) {
  return dt.isDateStr(s);
}

/**
 * A local-naive slot string `ms` milliseconds from now — the only legal way to
 * build a moving window bound here, since slot_start is local-naive.
 *
 * dt has no `addMs`, and dt.addMinutes() deliberately refuses to cross a day,
 * so the Date is built first and both the date and the clock halves are read
 * back off that SAME instant. (Deriving the date from dt.addDays() while taking
 * the clock from the Date would be correct by one hour of DST per crossing;
 * reading both from the Date cannot disagree with itself.)
 *
 * @param {number} ms offset from now, may be negative
 * @returns {string} "YYYY-MM-DD HH:mm" in clinic-local time
 */
function slotFromNow(ms) {
  const d = new Date(dt.parseSlot(dt.nowStr()).getTime() + ms);
  return dt.fmtSlot(
    `${d.getFullYear()}-${dt.pad(d.getMonth() + 1)}-${dt.pad(d.getDate())}`,
    d.getHours(),
    d.getMinutes()
  );
}

// --- Daily summary ----------------------------------------------------------

function getDailySummary(dateStr, injectedRepo, injectedDb) {
  if (!isValidDate(dateStr)) throw new Error('date YYYY-MM-DD required');
  const repo = resolveRepo(injectedRepo, injectedDb);
  const revenueForDate = capability(repo, injectedDb, 'receipts', 'totalForDate');
  const createdOn = capability(repo, injectedDb, 'clients', 'createdOn');
  // Half-open local day, straight into listByRange()'s `>= from AND < to`.
  const { from, to } = dt.dayBounds(dateStr);
  const day = rangeList(repo, from, to, 2000);
  const byStatus = {};
  for (const a of day) byStatus[a.status] = (byStatus[a.status] || 0) + 1;
  // Revenue = SUM(receipts.amount) created that calendar day.
  // Number(...) coerces, because a SUM over an empty table can come back as
  // null/string depending on the driver; `|| 0` keeps "no receipts" at 0.
  const revenue = swallow('receipts.totalForDate (day revenue)',
    () => Number(revenueForDate(dateStr)) || 0, 0);
  // New vs returning: a booking counts as "new" when its client's created_at
  // falls on the same calendar day (first-ever contact); else returning.
  // Per-appointment so one unreadable client row cannot void the whole tally;
  // swallow() de-duplicates the warning to one line per process.
  let newClients = 0;
  for (const a of day) {
    if (swallow('clients.createdOn (new vs returning)', () => createdOn(a.client_id, dateStr), false)) {
      newClients += 1;
    }
  }
  const bookings = day.length;
  const noShows = byStatus.no_show || 0;
  return {
    date: dateStr,
    bookings,
    noShows,
    revenue,
    newClients,
    returningClients: Math.max(0, bookings - newClients),
    byStatus,
    // `counts` is the canonical name for status tallies; `byStatus` kept
    // for older callers (dashboard, digest, frontend).
    counts: { ...byStatus },
    // Back-compat aliases (digest.js M7 draft + older callers).
    total: bookings,
    appointments: day,
  };
}

// --- Follow-up flags --------------------------------------------------------

function getFollowupFlags(injectedRepo, injectedDb) {
  const repo = resolveRepo(injectedRepo, injectedDb);
  const inboundFromPhones = capability(repo, injectedDb, 'messages', 'inboundFromPhones');
  const outboundToPhonesByTemplateLike = capability(repo, injectedDb, 'messages', 'outboundToPhonesByTemplateLike');
  const clientSummary = capability(repo, injectedDb, 'clients', 'summary');
  const recentByStatus = capability(repo, injectedDb, 'appointments', 'recentByStatus');
  const intakeExistsFor = capability(repo, injectedDb, 'intake', 'existsFor');
  // Window bounds are local-naive because slot_start is. Built by datetime.js,
  // never by slicing toISOString() (see the header: that is the D9 defect).
  const nowStr = dt.nowStr();
  const in48h = slotFromNow(48 * 3600 * 1000);
  const pastWeek = slotFromNow(-7 * 86400 * 1000);

  // Phones that replied at least once (inbound message ever logged).
  const repliedPhones = new Set(swallow('messages.inboundFromPhones (who replied)',
    () => inboundFromPhones().map((r) => r.phone), []));

  // Phones that were sent a reminder recently (outbound reminder template).
  const remindedPhones = new Set(swallow('messages.outboundToPhonesByTemplateLike (who was reminded)',
    () => outboundToPhonesByTemplateLike('%remind%').map((r) => r.phone), []));

  const withClient = (a) => {
    if (a.client_name) return { ...a, client: { name: a.client_name, phone: a.client_phone } };
    const c = swallow('clients.summary (fallback client lookup)',
      () => clientSummary(a.client_id), null);
    return { ...a, client: c || null };
  };

  // Booked in the next 48h: reminder sent but no inbound reply on record.
  const upcoming = rangeList(repo, nowStr, in48h, 500);
  const unconfirmedSoon = upcoming.filter((a) => a.status === 'booked').map(withClient);
  const noResponseAfterReminder = unconfirmedSoon.filter((a) => {
    const phone = a.client_phone || (a.client && a.client.phone) || '';
    return remindedPhones.has(phone) && !repliedPhones.has(phone);
  });

  // Overdue next visit: every no-show on record + clients inactive >30 days
  // with no upcoming booking (re-engagement candidates).
  const noShowRecall = swallow('appointments.recentByStatus (no_show recall)',
    () => recentByStatus('no_show', 200).map(withClient), []);
  // Cancelled appointments needing recall (same shape as no-show recall).
  const cancelledRecall = swallow('appointments.recentByStatus (cancelled recall)',
    () => recentByStatus('cancelled', 200).map(withClient), []);
  const inactiveClients = swallow('appointments.findInactiveSince (dormant clients)',
    () => {
      if (!(repo.appointments && typeof repo.appointments.findInactiveSince === 'function')) return [];
      return repo.appointments.findInactiveSince(30)
        .map((c) => ({ client: c, lastVisit: c.last_visit || null }));
    }, []);
  const overdueNextVisit = [...noShowRecall.map(withClient), ...inactiveClients];

  // Completed in the past 7 days with no intake response saved.
  const missingIntake = swallow('intake.existsFor (completed visits missing intake)', () => {
    const recent = rangeList(repo, pastWeek, nowStr, 500);
    return recent
      .filter((a) => a.status === 'completed')
      .filter((a) => !swallow('intake.existsFor (per-visit check)', () => intakeExistsFor(a.id), true))
      .map(withClient);
  }, []);

  return { noResponseAfterReminder, overdueNextVisit, noShowRecall, cancelledRecall, unconfirmedSoon, missingIntake };
}

// --- Weekly aggregates ------------------------------------------------------

function getWeeklyAggregates(weekStartStr, injectedRepo, injectedDb) {
  // Default to the current Monday. dt.weekStart() anchors at local noon, so a
  // DST transition cannot land the default on the wrong calendar day — which
  // `new Date().setDate(...)` could.
  const startStr = weekStartStr || dt.weekStart(new Date());
  if (!isValidDate(startStr)) throw new Error('weekStart YYYY-MM-DD required');
  const repo = resolveRepo(injectedRepo, injectedDb);
  const revenueForDate = capability(repo, injectedDb, 'receipts', 'totalForDate');
  const days = [];
  let total = 0;
  let revenue = 0;
  const byStatus = {};
  const byService = {};
  for (let i = 0; i < 7; i++) {
    // Calendar arithmetic on the DATE STRING, not on milliseconds: adding
    // 86400000 to a Date rolls an hour off twice a year.
    const ds = dt.addDays(startStr, i);
    const { from, to } = dt.dayBounds(ds);
    const list = rangeList(repo, from, to, 2000);
    const dayStatus = {};
    const dayService = {};
    for (const a of list) {
      dayStatus[a.status] = (dayStatus[a.status] || 0) + 1;
      byStatus[a.status] = (byStatus[a.status] || 0) + 1;
      const svc = a.service || 'general';
      dayService[svc] = (dayService[svc] || 0) + 1;
      byService[svc] = (byService[svc] || 0) + 1;
    }
    const dayRevenue = swallow('receipts.totalForDate (weekly revenue)',
      () => Number(revenueForDate(ds)) || 0, 0);
    total += list.length;
    revenue += dayRevenue;
    days.push({ date: ds, bookings: list.length, revenue: dayRevenue, byStatus: dayStatus, byService: dayService });
  }
  // weekEnd is the EXCLUSIVE upper bound — the first day of the next week.
  const endStr = dt.addDays(startStr, 7);
  return { weekStart: startStr, weekEnd: endStr, days, total, revenue, byStatus, byService, counts: { ...byStatus } };
}

module.exports = {
  getDailySummary,
  getFollowupFlags,
  getWeeklyAggregates,
  // Canonical M7 names (routes/digest/frontend use these).
  dailySummary: getDailySummary,
  followupFlags: getFollowupFlags,
  weeklyAggregates: getWeeklyAggregates,
  // Back-compat aliases for the M7 first draft (digest.js / routes).
  followUpFlags: getFollowupFlags,
  weeklyAggregate: getWeeklyAggregates,
};
