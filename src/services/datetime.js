// ============================================================================
// clinic-automation — datetime formatting + local date math
//   (src/services/datetime.js)
// THE INVARIANT THIS MODULE EXISTS TO ENFORGE:
// appointments.slot_start is local-naive 'YYYY-MM-DD HH:mm'. NEVER compare it against toISOString() output.
// toISOString() yields UTC in "YYYY-MM-DDTHH:mm:ss.sssZ" form. Two things then
// go wrong: (1) the instant is UTC, not clinic-local, so the calendar day can
// be the wrong one; (2) the separator ' ' (charCode 32) sorts BEFORE 'T'
// (charCode 84), so a same-day slot compares as LESS THAN its own 00:00 lower
// bound:
//     '2026-10-03 09:00' >= '2026-10-03T00:00:00.000Z'  ===  false
// That silently dropped every same-day row from the admin "Today" card, broke
// the 24h-reminder window, and let a WhatsApp CANCEL cancel an already-past
// visit. Any day/window bound fed to listByRange(from, to) MUST come from
// dayBounds()/nowStr() here, never from a toISOString() slice.
// Why a separate module: slot_start is written by scheduling.fmtSlot and read
// by queries spread across several layers. Formatting a datetime inline is how
// the two formats drifted apart in the first place; this is the ONE place
// allowed to format a datetime. Callers migrate to it in later M9 leaves.
//
// Deliberate decisions:
//   * Local everywhere. nowStr()/todayStr()/parseSlot() read LOCAL components,
//     so a clinic in IST reports the day its receptionist is looking at. No
//     timezone library and no dependency — the global Date is enough.
//   * dayBounds().to is EXCLUSIVE (next day 00:00) because every range query
//     is half-open (`slot_start >= ? AND slot_start < ?`). An inclusive
//     "23:59" bound would silently drop the 23:59 slot.
//   * All calendar shifts anchor at LOCAL NOON. At noon a DST transition cannot
//     move the instant a day either way, so addDays()/dayBounds() can never
//     return 23:00 of the previous day or 01:00 of the next.
//   * diffDays() compares calendar-day components via Date.UTC, so it returns
//     whole days across DST boundaries instead of 0.958 / 1.04.
//   * addMinutes() deliberately does NOT wrap at 24h, mirroring
//     scheduling.js exactly: {hour: 25} is a legitimate "past midnight" answer
//     and silently wrapping it to 01:00 would hide an overbooked slot.
//   * Date-or-string inputs are accepted wherever a date is taken, because
//     callers hand us both (reports.js receives req.query.date as a string,
//     jobs hold Dates).
// Pure module: no config, no db, no express, no require() of any module, no
// I/O and no env reads — safe to use from routes, services, jobs and tests.
// Deps: none (global Date only).
// ============================================================================
'use strict';

// Stored shape of appointments.slot_start / slot_end (local-naive, minute
// resolution). Deliberately stricter than a date-time: seconds or an offset
// mean the caller is holding the WRONG format, which is the bug this guards.
const SLOT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/;

// Stored shape of a bare local date ("YYYY-MM-DD").
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Two-digit zero pad. Mirrors scheduling.js pad() so slot strings stay
// byte-identical. Note it does NOT truncate a value wider than two chars —
// addMinutes() may legitimately return hour 25.
function pad(n) {
  return String(n).padStart(2, '0');
}

// THE canonical slot formatter. Byte-identical to scheduling.fmtSlot: rows
// already in the DB are keyed on UNIQUE(slot_start), so any drift here would
// stop new bookings from matching existing ones.
function fmtSlot(dateStr, hour, minute) {
  return `${dateStr} ${pad(hour)}:${pad(minute)}`;
}

// THE canonical local "YYYY-MM-DD" formatter for a Date (local components).
function fmtDate(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// Parse a 'YYYY-MM-DD' string to a local Date anchored at NOON (see header).
// Throws a named error on a malformed date rather than silently yielding an
// Invalid Date whose getFullYear() would then format as "NaN-NaN-NaN".
function noonDate(dateStr) {
  if (!DATE_RE.test(String(dateStr || ''))) {
    throw new Error(`invalid date "${dateStr}" (expected YYYY-MM-DD)`);
  }
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`invalid date "${dateStr}"`);
  }
  return d;
}

// Coerce a Date | 'YYYY-MM-DD' into a local Date at noon (DST-safe anchor).
function asDate(input) {
  return input instanceof Date ? new Date(input.getTime()) : noonDate(input);
}

// True when s is exactly the stored local-naive slot form.
function isSlotStr(s) {
  return SLOT_RE.test(String(s || ''));
}

// True when s is exactly a bare local date.
function isDateStr(s) {
  return DATE_RE.test(String(s || ''));
}

// Current instant as LOCAL "YYYY-MM-DD HH:mm" — the format slot_start uses.
// This (never an ISO slice) is what a "today"/"now" query bound is built from,
// and it may only be compared against other local-naive strings.
function nowStr() {
  const n = new Date();
  return fmtSlot(fmtDate(n), n.getHours(), n.getMinutes());
}

// Current LOCAL calendar day as "YYYY-MM-DD". Note reports.js/digest.js today
// use new Date().toISOString().slice(0, 10), which is the UTC day and can be
// the wrong calendar day for an IST clinic late in the evening.
function todayStr() {
  return fmtDate(new Date());
}

// Current instant as full ISO/UTC "...THH:mm:ss.sssZ". Use ONLY for audit
// columns (auth.js session stamps, receipt/PDF filenames) — never for a
// slot_start bound. Mind the schema's own DEFAULT is `datetime('now')`, which
// is UTC but in the SPACE form; do not mix the two.
function isoNow() {
  return new Date().toISOString();
}

// Half-open local day interval: { from: "<dateStr> 00:00",
// to: "<NEXT day> 00:00" }. `to` is EXCLUSIVE and rolls month/year/leap over
// correctly (2026-12-31 -> 2027-01-01). Feed straight into listByRange().
function dayBounds(dateStr) {
  const next = noonDate(dateStr);
  next.setDate(next.getDate() + 1);
  return { from: `${dateStr} 00:00`, to: `${fmtDate(next)} 00:00` };
}

// Shift an hour/minute pair by delta minutes.
//
// TWO shapes are accepted, because this helper exists to mirror
// scheduling.addMinutes(hour, minute, delta):
//   addMinutes(hour, minute, delta)            <- the scheduling.js form
//   addMinutes(dateStr, hour, minute, delta)   <- dateStr is accepted but inert,
//                                                 so every slot helper shares one
//                                                 uniform signature
// The arity is DETECTED, never assumed. Previously the 3-arg form silently
// computed `0*60 + 45 + undefined` = NaN, and because JSON.stringify turns NaN
// into null that surfaced as { hour: null, minute: null } — a corrupt slot, not
// an error. Non-numeric input is now rejected outright: a wrong slot time must
// be loud, because it is written to appointments.slot_start.
//
// Mirrors scheduling.addMinutes(): no 24h wrap and no normalization of negative
// results, so 23:00 + 120 => { hour: 25 }.
function addMinutes(a, b, c, d) {
  const fourArgs = d !== undefined;
  const hour = fourArgs ? b : a;
  const minute = fourArgs ? c : b;
  const delta = fourArgs ? d : c;
  const values = fourArgs ? [hour, minute, delta] : [hour, minute, delta];
  for (let i = 0; i < values.length; i += 1) {
    if (typeof values[i] !== 'number' || !Number.isFinite(values[i])) {
      const which = fourArgs ? ['dateStr', 'hour', 'minute', 'delta'][i + 1] : ['hour', 'minute', 'delta'][i];
      throw new Error(
        `addMinutes: ${which} must be a finite number, got ${JSON.stringify(values[i])}`
      );
    }
  }
  const total = hour * 60 + minute + delta;
  return { hour: Math.floor(total / 60), minute: total % 60 };
}

// 'YYYY-MM-DD HH:mm' -> a local Date. The space becomes 'T' so the ES date-time
// parser treats the value as LOCAL time; toISOString() is deliberately NOT used
// (it would re-introduce the UTC drift and convert away the instant we mean to
// keep local). Throws on a non-slot string so the mistake is loud.
function parseSlot(s) {
  if (!isSlotStr(s)) {
    throw new Error(`invalid slot "${s}" (expected "YYYY-MM-DD HH:mm")`);
  }
  return new Date(String(s).replace(' ', 'T'));
}

// Monday of the week containing d, as local "YYYY-MM-DD". Accepts a Date or a
// 'YYYY-MM-DD' string (reports.js receives req.query.weekStart as a string).
// Sunday maps back to the PREVIOUS Monday — the clinic-week convention.
function weekStart(d) {
  const base = asDate(d);
  // getDay(): 0=Sun..6=Sat -> shift the origin to Monday(1).
  const back = (base.getDay() + 6) % 7;
  base.setDate(base.getDate() - back);
  return fmtDate(base);
}

// Shift a local date by n days (n may be negative). Accepts a Date or a
// 'YYYY-MM-DD' string. Returns local "YYYY-MM-DD".
function addDays(dateStr, n) {
  const base = asDate(dateStr);
  base.setDate(base.getDate() + n);
  return fmtDate(base);
}

// Whole calendar days from a to b, i.e. b - a: POSITIVE when b is later. So
// "days idle since the last visit" reads diffDays(lastVisit, todayStr()) and is
// >= 0 for a past visit. Computed from UTC-normalized components so a DST
// transition cannot yield a fractional or off-by-one result.
//
// Accepts every form a caller actually holds:
//   Date                          -> e.g. new Date()
//   'YYYY-MM-DD'                  -> e.g. todayStr()
//   'YYYY-MM-DD HH:mm'            -> appointments.slot_start VERBATIM
// The slot form is not a convenience: the documented "days idle since the last
// visit" call passes a slot_start, and this used to throw
// `invalid date "2026-09-20 14:30" (expected YYYY-MM-DD)` on exactly that input.
// The time of day is dropped because a whole-day difference cannot depend on it.
// Genuinely malformed input still throws — a wrong day count must be loud.
function diffDays(a, b) {
  const dayNumber = (input) => {
    const base = input instanceof Date ? new Date(input.getTime()) : null;
    const d = base || noonDate(isSlotStr(input) ? String(input).slice(0, 10) : input);
    return Date.UTC(d.getFullYear(), d.getMonth(), d.getDate());
  };
  return Math.round((dayNumber(b) - dayNumber(a)) / 86400000);
}

module.exports = {
  SLOT_RE,
  DATE_RE,
  isSlotStr,
  isDateStr,
  pad,
  fmtSlot,
  nowStr,
  todayStr,
  isoNow,
  dayBounds,
  addMinutes,
  parseSlot,
  weekStart,
  addDays,
  diffDays,
};