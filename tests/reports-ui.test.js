// ============================================================================
// clinic-automation — admin Reports tab UI regression tests
//   (tests/reports-ui.test.js)
// Target: public/js/reports.js  (todo S9.9.1 / defect D8)
//
// WHY THIS FILE IS NEEDED: public/js/reports.js is a BROWSER file - it has no
// module.exports, it registers a DOMContentLoaded listener and calls fetch().
// Before this file existed the repo had ZERO coverage of it: `node --test
// "tests/**/*.test.js"` runs each file in its own process and nothing loaded or
// exercised that script. A previous version of these tests lived outside the
// glob (under public/js/__tests__/) and was therefore never run by `npm test`,
// and was deleted after recording its results - which is how D8 ended up with no
// executable coverage at all. These assertions therefore live HERE, inside the
// npm glob, so `npm test` actually fails if the escaping regresses.
//
// HOW: the real source is loaded into a `vm.runInNewContext` sandbox with
//   * a fake `document` whose `innerHTML` SETTER RECORDS every write - innerHTML
//     is the only sink where unescaped server data becomes live markup, so
//     recording it observes exactly what the admin's browser would execute; and
//   * a fake `fetch` that records the requested URLs and serves hostile payloads.
// No network, no real DOM, no server, no database.
//
// `Date` is injected as a subclass so `new Date()` is a FIXED instant. That is
// what makes the local-vs-UTC test deterministic: 2025-10-03T20:00:00Z is
// 2026-10-04 in Asia/Kolkata but 2025-10-03 by toISOString(), so a correct local
// implementation and a buggy UTC one cannot both pass. (Runtime TZ switching was
// verified empirically on this host before being relied upon.)
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Normally the real source. REPORTS_JS may point these assertions at a COPY,
// which is how the "can this test actually fail?" proof is run without editing
// the source file: break it in a copy, watch the suite go red, restore nothing.
const TARGET = process.env.REPORTS_JS || path.join(__dirname, '..', 'public', 'js', 'reports.js');

// A zone AHEAD of UTC, so the local calendar day and the UTC day differ at
// FIXED_INSTANT. That difference is what gives the date assertions teeth.
const TZ_EAST = 'Asia/Kolkata';
const FIXED_INSTANT = Date.parse('2025-10-03T20:00:00Z'); // 2025-10-04 01:30 in IST
const EXPECTED_LOCAL_DAY = '2025-10-04';
// 2025-10-04 is a Saturday; the clinic week is Monday-based, so 2025-09-29.
// Must match datetime.js weekStart() and therefore digest.js:36.
const EXPECTED_WEEK_START = '2025-09-29';

const XSS = '<script>alert(1)</script>';

// MUST be async: the render under test is awaited, so the TZ has to stay set for
// the whole awaited window. A synchronous try/finally would restore the TZ as
// soon as the promise was created and the assertions would run under the wrong
// zone - which is precisely how a "local date" test silently stops testing
// anything.
async function withEastTz(fn) {
  const prev = process.env.TZ;
  process.env.TZ = TZ_EAST;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
  }
}

// Minimal element stub. `innerHTML` is redefined per-element by the harness so
// every write anywhere in the tree is captured, not just the mount node.
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    textContent: '',
    children: [],
    appendChild(child) { this.children.push(child); return child; },
  };
}

function payloads(overrides = {}) {
  const daily = {
    date: XSS, bookings: 3, noShows: 1, revenue: 500,
    newClients: 2, returningClients: 1, byStatus: { confirmed: 3 },
    ...overrides.daily,
  };
  const weekly = {
    weekStart: XSS, weekEnd: XSS, total: 4, revenue: 900,
    byStatus: { confirmed: 4 }, ...overrides.weekly,
  };
  const row = { client: { name: XSS }, slot_start: XSS, service: XSS, status: XSS };
  const flags = {
    noResponseAfterReminder: [row], overdueNextVisit: [row],
    noShowRecall: [row], unconfirmedSoon: [row], missingIntake: [row],
    ...overrides.flags,
  };
  return {
    daily, weekly, flags,
    // Keyed off the PATH only, so the ?date= / ?weekStart= values may vary.
    resolve(url) {
      const base = String(url).split('?')[0];
      if (base === '/api/reports/daily') return daily;
      if (base === '/api/reports/weekly') return weekly;
      if (base === '/api/reports/flags') return flags;
      throw new Error('unexpected request: ' + url);
    },
  };
}

// Drives the real source, records every innerHTML write and every request URL.
async function render(p) {
  const writes = [];
  const urls = [];
  let handler = null;

  const sandbox = {
    Date: class extends Date {
      constructor(...args) { super(...(args.length ? args : [FIXED_INSTANT])); }
    },
    document: {
      addEventListener: (evt, fn) => { if (evt === 'DOMContentLoaded') handler = fn; },
      querySelector: (sel) => (sel === '#reports' ? makeEl('div') : null),
      createElement: (tag) => {
        const el = makeEl(tag);
        let v = '';
        Object.defineProperty(el, 'innerHTML', {
          set(x) { v = String(x); writes.push(v); },
          get() { return v; },
        });
        return el;
      },
    },
    fetch: async (url) => {
      urls.push(String(url));
      return { ok: true, status: 200, json: async () => p.resolve(String(url)) };
    },
    console,
  };

  vm.runInNewContext(fs.readFileSync(TARGET, 'utf8'), sandbox, { filename: TARGET });
  assert.equal(typeof handler, 'function', 'reports.js must register a DOMContentLoaded listener');
  const ret = handler();
  assert.ok(ret && typeof ret.then === 'function', 'the listener must return an awaitable promise');
  await ret;
  return { writes, urls, all: writes.join('\n') };
}

// ---------------------------------------------------------------------------

test('D8: no server value ever reaches innerHTML as live markup', async () => {
  const { all } = await withEastTz(() => render(payloads()));
  // Assert on the dangerous SIGNATURE (a live tag), never on the payload text.
  // "alert(1)" legitimately survives as harmless visible text inside escaped
  // markup ("&lt;script&gt;alert(1)&lt;/script&gt;"); the XSS signature is a LIVE
  // "<script>" tag. Asserting on the text instead produces a false failure that
  // tempts someone into "fixing" correct code.
  assert.doesNotMatch(all, /<script/i, 'a live <script> from a server value survived into innerHTML');
  assert.doesNotMatch(all, /<img/i, 'an injected live <img> survived');
  assert.doesNotMatch(all, /onmouseover\s*=/i, 'an attribute breakout survived (unescaped ")');
  assert.doesNotMatch(all, /<script>alert\(1\)<\/script>/, 'the RAW payload must never appear');
  // The escaped form MUST be present, so this cannot pass on a file that simply
  // dropped the data instead of escaping it.
  assert.match(all, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, 'the payload must appear escaped, not merely absent');
});

test('D8: a numeric-looking field cannot smuggle markup either', async () => {
  // The exact D8 bug: `${weekly.total}` / `${daily.bookings}` were interpolated
  // raw. Feed markup through those NUMBER fields; they must be coerced so no
  // markup can survive the coercion.
  const { all } = await withEastTz(() => render(payloads({
    daily: { bookings: XSS, noShows: XSS, revenue: XSS, newClients: XSS, returningClients: XSS },
    weekly: { total: XSS, revenue: XSS },
  })));
  assert.doesNotMatch(all, /<script/i, 'markup smuggled through a numeric field');
  // Number("<script>...") is NaN, so the field must render 0 - never raw text.
  assert.match(all, /<strong>0<\/strong> bookings, 0 no-shows/, 'numeric fields must coerce to 0');
});

test("esc() covers the single quote, so output stays safe in attributes", async () => {
  const { all } = await withEastTz(() => render(payloads({ daily: { date: "O'Brien" } })));
  assert.match(all, /O&#39;Brien/, "the apostrophe must be escaped to &#39;");
  assert.doesNotMatch(all, /O'Brien/, 'a raw apostrophe survived into the HTML');
});

test('an explicit LOCAL date is sent instead of relying on the server UTC default', async () => {
  const { urls } = await withEastTz(() => render(payloads()));
  const dailyUrl = urls.find((u) => u.startsWith('/api/reports/daily'));
  assert.ok(dailyUrl, 'the daily request must be made');
  assert.match(dailyUrl, /\?date=\d{4}-\d{2}-\d{2}$/, 'daily MUST carry an explicit ?date=');
  // Guard the fixture itself: if local and UTC stopped differing this test would
  // pass for the wrong reason, so assert the premise holds.
  assert.equal(new Date(FIXED_INSTANT).toISOString().slice(0, 10), '2025-10-03', 'fixture: the UTC day');
  assert.equal(
    dailyUrl, `/api/reports/daily?date=${EXPECTED_LOCAL_DAY}`,
    'the date sent must be the LOCAL calendar day, not toISOString()',
  );
});

test('the weekly card agrees with digest.js: it asks for the Monday of this week', async () => {
  // src/services/digest.js:36 calls getWeeklyAggregates(datetime.weekStart(...))
  // and labels the result "This week"; this card is titled "This week" too. If
  // the dashboard asked for `today`, the two "this week" figures would disagree
  // on 6 days out of 7 - the dashboard and the owner's own WhatsApp digest.
  const { urls } = await withEastTz(() => render(payloads()));
  const weeklyUrl = urls.find((u) => u.startsWith('/api/reports/weekly'));
  assert.ok(weeklyUrl, 'the weekly request must be made');
  assert.equal(
    weeklyUrl, `/api/reports/weekly?weekStart=${EXPECTED_WEEK_START}`,
    'weekly must send the local Monday, matching datetime.weekStart() / digest.js',
  );
});

test('a failed request degrades to the login hint and still escapes the error text', async () => {
  const writes = [];
  let handler = null;
  const sandbox = {
    Date: class extends Date { constructor(...a) { super(...(a.length ? a : [FIXED_INSTANT])); } },
    document: {
      addEventListener: (e, fn) => { if (e === 'DOMContentLoaded') handler = fn; },
      querySelector: () => makeEl('div'),
      createElement: (tag) => {
        const el = makeEl(tag);
        let v = '';
        Object.defineProperty(el, 'innerHTML', { set(x) { v = String(x); writes.push(v); }, get() { return v; } });
        return el;
      },
    },
    // 403 carrying an attacker-influenced error string.
    fetch: async () => ({ ok: false, status: 403, json: async () => ({ error: '<script>alert(9)</script>' }) }),
    console,
  };
  vm.runInNewContext(fs.readFileSync(TARGET, 'utf8'), sandbox, { filename: TARGET });
  await handler();
  const all = writes.join('\n');
  assert.match(all, /Log in as admin/, 'the fallback hint is rendered');
  assert.doesNotMatch(all, /<script/i, 'the error message reached innerHTML unescaped');
});

test('a null row in a flags list must not collapse the whole Reports tab', async () => {
  // Regression guard: the row mapper dereferences each row, so a null element
  // used to throw and the catch turned the entire tab into the login hint -
  // i.e. one malformed flag silently hid every other report.
  const { all } = await withEastTz(() => render(payloads({
    flags: { noResponseAfterReminder: [null], noShowRecall: [null] },
  })));
  assert.match(all, /No response after reminder/, 'the flags card still renders');
  assert.match(all, /bookings/, 'the Today card still renders - the tab did not collapse');
});