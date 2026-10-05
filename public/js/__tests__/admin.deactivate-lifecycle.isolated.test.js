// ============================================================================
// ISOLATED unit test for public/js/admin.js  -- todo leaf S9.8.2 (D4 lifecycle)
// Target: C:/Users/dhruv/clinic-automation/public/js/admin.js
// Session: ses_worker_s98_2
//
// **WARNING: THIS FILE WILL BE DELETED AFTER THE TEST PASSES.**
// Test code preserved in: .opencode/unit-tests/
//
// Isolation: the ONLY module under test is the target browser script. It talks
// to two globals -- `document` and `fetch` -- both replaced with local stubs, so
// no network, no real DOM, and NO src/ module is loaded. The backend contract
// below was READ from src/routes/clients.js (270 lines, mtime 13:01:00) and is
// asserted here as data, not as a live call:
//
//   GET    /api/clients            -> 200 { clients: [ {..., active: 1|0} ] }
//                                      (inactive rows ARE still listed)
//   DELETE /api/clients/:id        -> 200 { client, deactivated: true }
//                                   -> 409 { error: 'client_has_upcoming_appointment',
//                                            message, appointment: { id,
//                                            slot_start, status } }
//                                   -> 404 { error: 'not_found' }
//   POST   /api/clients/:id/restore   -> 200 { client, restored: true }
//                                      -> 501 { error, missing, message }
//   POST   /api/clients/:id/anonymize -> 200 { client, anonymized: true }
//                                      -> 501 { error, missing, message }
// ============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const TARGET = 'C:/Users/dhruv/clinic-automation/public/js/admin.js';

// ---------------------------------------------------------------------------
// Fixture rows. `active` is 1/0 exactly as clients.js `withActive()` emits it.
// ---------------------------------------------------------------------------
const ADA = {
  id: 1, name: 'Ada Lovelace', phone: '+919000000001',
  tags: 'vip', notes: null, active: 1, deactivated_at: null, anonymized: 0,
};
const GRACE = {
  id: 2, name: 'Grace Hopper', phone: '+919000000002',
  tags: 'vip', notes: null, active: 0, deactivated_at: '2026-10-03 12:00', anonymized: 0,
};

// ---------------------------------------------------------------------------
// A DOM stub with just enough fidelity for this script: createElement,
// createTextNode, appendChild, textContent, className, style, onclick,
// innerHTML (recorded, so a test can assert nothing interpolated reaches it),
// getElementById, querySelector, querySelectorAll, addEventListener.
// ---------------------------------------------------------------------------
function makeEl(tag) {
  // `className` and `classList` are two views of ONE set, because admin.js uses
  // both: it assigns `el.className = 'small'` when creating the status line and
  // then calls `el.classList.add(...)` / `.remove(...)` in notify(). A stub that
  // only had `className` made notify() throw
  // `TypeError: Cannot read properties of undefined (reading 'remove')`, which
  // failed every test that clicked a row action. Backing both with a single Set
  // keeps them consistent no matter which API the script reaches for.
  const classes = new Set();
  const el = {
    tag,
    get className() { return [...classes].join(' '); },
    set className(v) {
      classes.clear();
      String(v === null || v === undefined ? '' : v).split(/\s+/).filter(Boolean).forEach((c) => classes.add(c));
    },
    // This node's OWN text. The textContent ACCESSOR below derives the public
    // value from it plus every descendant, exactly as the real DOM does.
    ownText: '',
    value: '',
    hidden: false,
    id: '',
    dataset: {},
    style: {},
    children: [],
    onclick: null,
    written: [],   // every string ever assigned to .innerHTML
  };
  el.classList = {
    add: (...names) => { names.forEach((c) => classes.add(c)); },
    remove: (...names) => { names.forEach((c) => classes.delete(c)); },
    contains: (c) => classes.has(c),
    toggle: (c, force) => {
      const want = force === undefined ? !classes.has(c) : !!force;
      if (want) classes.add(c); else classes.delete(c);
      return want;
    },
  };
  let html = '';
  // The real DOM's textContent GETTER returns this node's own text CONCATENATED
  // with every descendant's. admin.js depends on that: it does
  // `tags.textContent = c.tags` and then `tags.appendChild(badge('inactive'))`,
  // so in a real browser the cell reads "vip inactive". Holding textContent as a
  // flat string made the appended badge invisible to every reader of the cell,
  // which is why "an inactive client is dimmed and badged" failed while the
  // PRODUCTION code was correct. The setter still discards all children, which
  // is what the DOM does too.
  const textOf = (node) => {
    if (!node) return '';
    if (node.tag === '#text') return node.text == null ? '' : String(node.text);
    const own = node.ownText === undefined ? '' : String(node.ownText);
    return own + (node.children || []).map(textOf).join('');
  };
  Object.defineProperty(el, 'textContent', {
    get() { return textOf(el); },
    set(v) { el.ownText = v === null || v === undefined ? '' : String(v); el.children = []; },
    configurable: true,
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { el.written.push(String(v)); html = String(v); el.children = []; },
  });
  el.appendChild = (c) => { el.children.push(c); return c; };
  el.insertBefore = (c) => { el.children.unshift(c); return c; };
  // admin.js:199 clears the body with tbody.replaceChildren() before appending.
  // Without this stub that call THREW inside the async render, the rejection was
  // swallowed by the settle() chain, no rows were ever produced, and all 14
  // assertions below failed on `undefined.children` instead of testing anything.
  // Assign rather than mutate: the innerHTML setter replaces `children` wholesale.
  el.replaceChildren = (...nodes) => { el.children = nodes.slice(); return el; };
  el.setAttribute = () => {};
  el.addEventListener = () => {};
  el.removeEventListener = () => {};
  return el;
}

function textNode(s) { return { tag: '#text', text: String(s), children: [] }; }

// ---------------------------------------------------------------------------
// Harness: install globals, load the target fresh, fire DOMContentLoaded.
// `deleteResponse` lets a test make DELETE fail exactly the way the server can.
// ---------------------------------------------------------------------------
function loadAdmin({
  clients = [ADA, GRACE],
  deleteResponse = null,     // { status, body } to override the DELETE result
  restoreResponse = null,
  anonymizeResponse = null,
} = {}) {
  const calls = [];
  const confirms = [];
  const rejected = [];
  const inserted = [];

  const tbody = makeEl('tbody');
  const table = makeEl('table');
  table.id = 'clients-table';
  const wrap = makeEl('div');
  wrap.appendChild(table);
  const body = makeEl('body');
  body.appendChild(wrap);
  // admin.js notify() does: table.parentNode.insertBefore(el, wrap) on
  // wrap.parentNode -- so both links must exist, and insertBefore must record.
  wrap.parentNode = body;
  table.parentNode = wrap;
  table.appendChild = (c) => { if (c === tbody) return c; return table.children.push(c) && c; };
  tbody.parentNode = table;
  body.insertBefore = (child) => { inserted.push(child); body.children.unshift(child); return child; };

  const els = {};
  for (const id of ['login-card', 'dashboard', 'login-form', 'login-error',
    'logout-btn', 'search-form', 'import-form', 'csv', 'import-result', 'q']) {
    els[id] = makeEl(id);
  }
  els['q'].value = '';

  const restoreGlobals = [];
  const set = (name, value) => {
    restoreGlobals.push([name, globalThis[name]]);
    globalThis[name] = value;
  };

  set('document', {
    body,
    addEventListener: (evt, fn) => { if (evt === 'DOMContentLoaded') els.__ready = fn; },
    getElementById: (id) => (id === 'clients-table' ? table : els[id] || null),
    querySelectorAll: () => [],
    querySelector: (sel) => (sel === '#clients-table tbody' ? tbody : null),
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => textNode(t),
  });
  set('confirm', (msg) => { confirms.push(msg); return true; });
  set('prompt', () => null);

  const jsonRes = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  set('fetch', async (p, opts = {}) => {
    const path = String(p);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ path, method });
    const route = path.split('?')[0];
    // The client id is the segment AFTER /api/clients, NOT the last segment.
    // `route.split('/').pop()` yields 'restore' for '/api/clients/2/restore', so
    // `route === '/api/clients/' + id + '/restore'` compared
    // '/api/clients/2/restore' against '/api/clients/restore/restore' and never
    // matched. Both overrides below were therefore DEAD CODE: every Restore and
    // Anonymize call fell through to the final `jsonRes(200, {})`, so a 501 a
    // test explicitly asked for never arrived and the error path was never
    // exercised at all. The Anonymize test still passed because it only inspects
    // h.calls (the raw request path), which is why this hid so well.
    const segs = route.split('/');
    const id = segs[3];              // ['', 'api', 'clients', '<id>', '<action>?']

    if (route === '/api/admin/me') return jsonRes(200, { username: 'admin', role: 'admin' });
    if (route === '/csrf') return jsonRes(200, { csrfToken: 'tok' });
    if (route === '/api/clients' && method === 'GET') return jsonRes(200, { clients });

    if (route === '/api/clients/' + id) {
      if (method === 'DELETE') {
        return deleteResponse
          ? jsonRes(deleteResponse.status, deleteResponse.body)
          : jsonRes(200, { client: ADA, deactivated: true });
      }
    }
    if (route === '/api/clients/' + id + '/restore') {
      return restoreResponse
        ? jsonRes(restoreResponse.status, restoreResponse.body)
        : jsonRes(200, { client: ADA, restored: true });
    }
    if (route === '/api/clients/' + id + '/anonymize') {
      return anonymizeResponse
        ? jsonRes(anonymizeResponse.status, anonymizeResponse.body)
        : jsonRes(200, { client: { id: ADA.id, name: 'Anonymized client 1' }, anonymized: true });
    }
    return jsonRes(200, {});
  });

  const onRejection = (r) => rejected.push(r);
  process.on('unhandledRejection', onRejection);

  for (const k of Object.keys(require.cache)) if (k.includes('admin.js')) delete require.cache[k];
  require(TARGET);

  const settle = () => new Promise((r) => setImmediate(r))
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => new Promise((r) => setImmediate(r)))
    .then(() => new Promise((r) => setImmediate(r)));

  // admin.js registers a SYNCHRONOUS DOMContentLoaded handler (it ends with an
  // unawaited checkMe()), so its return value is undefined -- fire it, then let
  // the fetch/refresh chain drain instead of chaining .then() onto it.
  if (typeof els.__ready !== 'function') throw new Error('DOMContentLoaded handler was never registered');

  const done = (els.__ready(), settle()).then(() => ({
    rows: Array.from(tbody.children),
    tbody, calls, confirms, rejected,
    notice() {
      // notify() lazily creates #admin-notice and inserts it above the table.
      const existing = els['admin-notice'];
      if (existing) return existing;
      return inserted.find((e) => e.id === 'admin-notice') || null;
    },
    noticeText() { const n = this.notice(); return n ? n.textContent : ''; },
    buttonsIn(row) { return buttonsUnder(row); },
    // Drain before unstubbing. admin.js kicks off refreshAndReport() after every
    // mutation; if the globals are torn down while that is still in flight it
    // throws `Cannot read properties of undefined (reading 'getElementById')`
    // AFTER the test ended, which node reports as an unhandledRejection and the
    // assertions below then (correctly) fail on.
    restore: async () => {
      await settle();
      await settle();
      process.removeListener('unhandledRejection', onRejection);
      restoreGlobals.forEach(([n, v]) => { globalThis[n] = v; });
    },
  }));

  // Capture lazily-inserted notices (notify inserts above #clients-table).
  return done;
}

// Buttons live in the row's `actions` cell, i.e. GRANDchildren of <tr> --
// admin.js does tr.appendChild(actions) and actions.appendChild(button). Filtering
// tr.children for 'button' therefore finds nothing, which is why every lifecycle
// assertion here used to come up empty. Walk the subtree instead.
function buttonsUnder(node, out = []) {
  for (const c of (node && node.children) || []) {
    if (!c) continue;
    if (c.tag === 'button') out.push(c);
    buttonsUnder(c, out);
  }
  return out;
}

// Convenience: find a button by label inside a rendered row.
const btn = (row, re) => buttonsUnder(row).filter((c) => c && re.test(c.textContent))[0];

// ===========================================================================
// 1. "Delete" is gone -- the row action reads Deactivate
// ===========================================================================
test('the row action reads Deactivate, never Delete', async () => {
  const h = await loadAdmin();
  try {
    const labels = h.buttonsIn(h.rows[0]).map((b) => b.textContent);
    assert.ok(!labels.some((t) => /\bdelete\b/i.test(t)), 'a Delete button survives: ' + JSON.stringify(labels));
    assert.ok(labels.some((t) => /deactivate/i.test(t)), 'no Deactivate button: ' + JSON.stringify(labels));
  } finally { await h.restore(); }
});

test('no string literal in the code names Delete as an action', () => {
  const src = fs.readFileSync(TARGET, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const hits = code.match(/['"`][^'"`]*\b[Dd]elete\b[^'"`]*['"`]/g) || [];
  assert.deepEqual(hits, [], 'a Delete literal survives in code: ' + JSON.stringify(hits));
});

test('the confirm dialog names the client, says deactivation, and says it is reversible', async () => {
  const h = await loadAdmin();
  try {
    await btn(h.rows[0], /deactivate/i).onclick();
    assert.equal(h.confirms.length, 1, 'confirm() was not called');
    const msg = h.confirms[0];
    assert.ok(!/\bdelete\b/i.test(msg), 'confirm still says delete: ' + msg);
    assert.ok(!/removed|permanently|cannot be undone/i.test(msg), 'confirm promises removal: ' + msg);
    assert.ok(/deactivat/i.test(msg), 'confirm never mentions deactivation: ' + msg);
    assert.ok(/Ada Lovelace/.test(msg), 'confirm omits the client name: ' + msg);
    assert.ok(/kept|history/i.test(msg), 'confirm does not say history is kept: ' + msg);
    assert.ok(/restore/i.test(msg), 'confirm does not say the action is reversible: ' + msg);
  } finally { await h.restore(); }
});

test('clicking Deactivate calls DELETE /api/clients/:id', async () => {
  const h = await loadAdmin();
  try {
    await btn(h.rows[0], /deactivate/i).onclick();
    const dels = h.calls.filter((c) => c.method === 'DELETE');
    assert.equal(dels.length, 1, 'expected exactly one DELETE, got ' + JSON.stringify(h.calls));
    assert.equal(dels[0].path, '/api/clients/1');
  } finally { await h.restore(); }
});

// ===========================================================================
// 2. The 409 is a READABLE message naming the blocking appointment
// ===========================================================================
test('a 409 surfaces the blocking appointment slot_start AND status', async () => {
  const h = await loadAdmin({
    deleteResponse: {
      status: 409,
      body: {
        error: 'client_has_upcoming_appointment',
        message: 'This client still has a confirmed appointment on 2026-10-05 09:00. '
          + 'Cancel or complete it first, or anonymize the client instead.',
        appointment: { id: 77, slot_start: '2026-10-05 09:00', status: 'confirmed' },
      },
    },
  });
  try {
    await btn(h.rows[0], /deactivate/i).onclick();
    const msg = h.noticeText();
    assert.ok(msg, 'nothing was shown to the user');
    assert.ok(/2026-10-05 09:00/.test(msg), 'notice omits the blocking slot_start: ' + msg);
    assert.ok(/confirmed/i.test(msg), 'notice omits the blocking status: ' + msg);
    assert.ok(!/client_has_upcoming_appointment/.test(msg), 'raw error code leaked to the UI: ' + msg);
    assert.deepEqual(h.rejected.map(String), [], 'the failure escaped as an unhandled rejection');
  } finally { await h.restore(); }
});

// The regression that matters: if a proxy/older server returns the 409 WITHOUT
// the human `message`, the UI must still build a readable sentence from the
// structured fields rather than dumping the internal error code.
test('a 409 with NO message field still reads as English, built from appointment fields', async () => {
  const h = await loadAdmin({
    deleteResponse: {
      status: 409,
      body: {
        error: 'client_has_upcoming_appointment',
        appointment: { id: 77, slot_start: '2026-10-05 09:00', status: 'confirmed' },
      },
    },
  });
  try {
    await btn(h.rows[0], /deactivate/i).onclick();
    const msg = h.noticeText();
    assert.ok(msg, 'nothing was shown to the user');
    assert.ok(!/client_has_upcoming_appointment/.test(msg), 'the internal error code was shown raw: ' + msg);
    assert.ok(/2026-10-05 09:00/.test(msg), 'the slot_start was dropped: ' + msg);
    assert.ok(/confirmed/i.test(msg), 'the status was dropped: ' + msg);
    assert.ok(/Ada Lovelace/.test(msg), 'the client name was dropped: ' + msg);
    assert.deepEqual(h.rejected.map(String), [], 'the failure escaped as an unhandled rejection');
  } finally { await h.restore(); }
});

test('a 404 and a 500 both surface a message and never an unhandled rejection', async () => {
  for (const [status, body] of [[404, { error: 'not_found' }], [500, { error: 'boom' }]]) {
    const h = await loadAdmin({ deleteResponse: { status, body } });
    try {
      await btn(h.rows[0], /deactivate/i).onclick();
      await new Promise((r) => setImmediate(r));
      const msg = h.noticeText();
      assert.ok(msg, status + ' showed nothing');
      assert.ok(!/^\s*\[object Object\]/.test(msg), status + ' dumped a raw object: ' + msg);
      assert.deepEqual(h.rejected.map(String), [], status + ' escaped as an unhandled rejection');
    } finally { await h.restore(); }
  }
});

// ===========================================================================
// 3. The `active` flag is reflected
// ===========================================================================
test('an inactive client is dimmed and badged, and is offered Restore not Deactivate', async () => {
  const h = await loadAdmin();
  try {
    const grace = h.rows[1];
    const labels = h.buttonsIn(grace).map((b) => b.textContent);
    assert.ok(!labels.some((t) => /deactivate/i.test(t)),
      'Deactivate offered for an already-deactivated client: ' + JSON.stringify(labels));
    assert.ok(labels.some((t) => /restore/i.test(t)), 'no Restore button: ' + JSON.stringify(labels));
    const text = JSON.stringify(grace.children.map((c) => c.textContent));
    assert.ok(/inactive|deactivated/i.test(text), 'no inactive badge rendered: ' + text);
    assert.ok(grace.style && grace.style.opacity && Number(grace.style.opacity) < 1,
      'inactive row is not dimmed (style.opacity=' + JSON.stringify(grace.style.opacity) + ')');
  } finally { await h.restore(); }
});

test('an active client is NOT dimmed and NOT badged', async () => {
  const h = await loadAdmin();
  try {
    const ada = h.rows[0];
    assert.ok(!(ada.style && ada.style.opacity), 'an active row was dimmed');
    const text = JSON.stringify(ada.children.map((c) => c.textContent));
    assert.ok(!/inactive/i.test(text), 'an active row was badged inactive: ' + text);
  } finally { await h.restore(); }
});

test('a pre-migration row with no active column is still treated as active', async () => {
  const legacy = { id: 4, name: 'Legacy Row', phone: '+919000000004', tags: '' };
  const h = await loadAdmin({ clients: [legacy] });
  try {
    const labels = h.buttonsIn(h.rows[0]).map((b) => b.textContent);
    assert.ok(labels.some((t) => /deactivate/i.test(t)),
      'a legacy row lost its Deactivate button: ' + JSON.stringify(labels));
  } finally { await h.restore(); }
});

// `active` is normalised ONCE, at admin.js:203
//   const isActive = c.active === undefined || c.active === null ? true : !!c.active;
// so `0`, `false`, `'0'` and `''` all read as inactive, while an ABSENT or null
// field reads as active (a pre-migration row has no such column). The two tests
// above only pin the `0` and the absent cases, so a regression that narrowed the
// check to `c.active === 0` would keep both green while breaking a server that
// sends `false`. This drives every representation through the SAME assertions.
test('`active` is normalised, not compared to one literal', async () => {
  const cases = [
    { flag: 0, inactive: true, why: 'integer 0' },
    { flag: false, inactive: true, why: 'boolean false' },
    { flag: '0', inactive: true, why: 'the string "0"' },
    { flag: '', inactive: true, why: 'an empty string' },
    { flag: 1, inactive: false, why: 'integer 1' },
    { flag: true, inactive: false, why: 'boolean true' },
    { flag: null, inactive: false, why: 'an explicit null (absent column)' },
  ];
  for (const { flag, inactive, why } of cases) {
    const h = await loadAdmin({
      clients: [{ id: 7, name: 'Flag Row', phone: '+919000000007', tags: 'vip', active: flag }],
    });
    try {
      const row = h.rows[0];
      const labels = h.buttonsIn(row).map((b) => b.textContent);
      const text = JSON.stringify(row.children.map((c) => c.textContent));
      const dimmed = Boolean(row.style && row.style.opacity);
      assert.equal(/inactive/i.test(text), inactive,
        `active=${JSON.stringify(flag)} (${why}) badge mismatch: ` + text);
      assert.equal(dimmed, inactive,
        `active=${JSON.stringify(flag)} (${why}) dim mismatch: opacity=` + JSON.stringify(row.style.opacity));
      assert.equal(labels.some((t) => /restore/i.test(t)), inactive,
        `active=${JSON.stringify(flag)} (${why}) Restore-button mismatch: ` + JSON.stringify(labels));
      assert.equal(labels.some((t) => /deactivate/i.test(t)), !inactive,
        `active=${JSON.stringify(flag)} (${why}) Deactivate-button mismatch: ` + JSON.stringify(labels));
    } finally { await h.restore(); }
  }
});

test('Restore calls POST /api/clients/:id/restore and reports it', async () => {
  const h = await loadAdmin();
  try {
    await btn(h.rows[1], /restore/i).onclick();
    const posts = h.calls.filter((c) => c.method === 'POST' && /restore$/.test(c.path));
    assert.equal(posts.length, 1, 'expected one POST to /restore, got ' + JSON.stringify(h.calls));
    assert.equal(posts[0].path, '/api/clients/2/restore');
    assert.ok(/restore/i.test(h.noticeText()), 'success was not reported: ' + h.noticeText());
    assert.deepEqual(h.rejected.map(String), [], 'restore failure escaped as an unhandled rejection');
  } finally { await h.restore(); }
});

// clients.js answers 501 { message } when repository.clients.setActive is absent.
// The UI must show that sentence, not a raw JSON blob.
test('a 501 from Restore surfaces the server sentence, not raw JSON', async () => {
  const h = await loadAdmin({
    restoreResponse: {
      status: 501,
      body: { error: 'restore_unavailable', missing: 'clients.setActive', message: 'Restore needs repository.clients.setActive, which src/db/repository.js does not expose yet (todo S9.3.4). The client is unchanged.' },
    },
  });
  try {
    await btn(h.rows[1], /restore/i).onclick();
    const msg = h.noticeText();
    assert.ok(/repository\.clients\.setActive/.test(msg), 'the 501 explanation was lost: ' + msg);
    assert.ok(!/^\s*\{/.test(msg), 'raw JSON was dumped: ' + msg);
    assert.deepEqual(h.rejected.map(String), [], 'the 501 escaped as an unhandled rejection');
  } finally { await h.restore(); }
});

// ===========================================================================
// 4. Anonymize (retention) -- required endpoint, irreversible so it confirms
// ===========================================================================
test('Anonymize calls POST /api/clients/:id/anonymize behind an irreversible confirm', async () => {
  const h = await loadAdmin();
  try {
    await btn(h.rows[0], /anonymize/i).onclick();
    assert.equal(h.confirms.length, 1, 'anonymize did not confirm first');
    assert.ok(/cannot be undone|permanent/i.test(h.confirms[0]),
      'the confirm does not warn it is irreversible: ' + h.confirms[0]);
    const posts = h.calls.filter((c) => c.method === 'POST' && /anonymize$/.test(c.path));
    assert.equal(posts.length, 1, 'expected one POST to /anonymize, got ' + JSON.stringify(h.calls));
    assert.equal(posts[0].path, '/api/clients/1/anonymize');
  } finally { await h.restore(); }
});

// ===========================================================================
// 5. D8: hostile server text must never become markup (textContent only)
// ===========================================================================
test('a client whose name and tags carry markup is rendered as TEXT, not HTML', async () => {
  const evil = {
    id: 9,
    name: '<img src=x onerror=alert(1)>',
    phone: "');alert(2);//",
    tags: '<script>alert(3)</script>',
    notes: '<b>hi</b>',
    active: 1,
  };
  const h = await loadAdmin({ clients: [evil] });
  try {
    const row = h.rows[0];
    const asText = row.children.map((c) => c.textContent).join('|');
    assert.ok(/<img src=x onerror=alert\(1\)>/.test(asText), 'the name was not rendered as text: ' + asText);
    assert.ok(/<script>alert\(3\)<\/script>/.test(asText), 'the tags were not rendered as text: ' + asText);
    // Walk the WHOLE rendered subtree, not just the <tr> itself: a write could
    // land on any cell or button. Asserting `writes.every(...)` over an EMPTY
    // array returns true unconditionally, so the old form passed precisely
    // because it had matched nothing -- a guard that cannot fail. Assert the
    // exact set instead, which is empty-or-fail.
    const writes = allInnerHtmlWrites(row);
    assert.deepEqual(writes, [],
      'markup reached an innerHTML sink in the rendered row: ' + JSON.stringify(writes));
  } finally { await h.restore(); }
});

// Every string ever assigned to an innerHTML sink inside this subtree.
// The DOM shim records each assignment on the element, so a faithful walk is
// what makes the D8 assertion below mean something.
function allInnerHtmlWrites(node, out = []) {
  if (!node) return out;
  if (node.tag !== '#text' && Array.isArray(node.written)) out.push(...node.written);
  for (const c of node.children || []) allInnerHtmlWrites(c, out);
  return out;
}

// Source-level twin of the walker above: every `.innerHTML = ...;` assignment in
// a chunk of JS text. Shared by the guard and its non-vacuity self-test so the
// two can never drift apart.
function innerHtmlWrites(src) {
  return String(src).match(/\.innerHTML\s*=\s*[^;]+;/g) || [];
}

// The D8 contract for THIS file is STRONGER than "interpolate nothing": admin.js
// contains no innerHTML write AT ALL, and its own header says so. The old
// assertion was `writes.length > 0` - "the two innerHTML writes" - which
// presupposed two writes that do not exist, so the guard could only ever report
// its own broken premise. Assert the real invariant.
test('admin.js contains NO innerHTML write, so server text can never become markup', () => {
  const src = fs.readFileSync(TARGET, 'utf8');
  assert.deepEqual(innerHtmlWrites(src), [],
    'an innerHTML write was reintroduced into admin.js: ' + JSON.stringify(innerHtmlWrites(src)));
});

// Non-vacuity self-test. The assertion above is only meaningful if the matcher
// CAN match something, so prove it detects a real planted write - including the
// interpolated form that would reintroduce the XSS. Without this, a regex that
// silently matched nothing would keep the guard green forever.
test('the innerHTML-write guard is non-vacuous: it detects a planted write', () => {
  const planted = [
    'el.innerHTML = \'<b>static</b>\';',
    'row.innerHTML = `<td>${client.name}</td>`;',
    'cell.innerHTML = userInput;',
  ];
  for (const p of planted) {
    const found = innerHtmlWrites(p);
    assert.equal(found.length, 1, 'the guard matched ' + found.length + ' writes in: ' + p);
    // The match starts AT `.innerHTML` -- the regex deliberately does not capture
    // the receiver expression -- and runs to the end of the statement.
    assert.ok(found[0].startsWith('.innerHTML'), 'unexpected match shape: ' + found[0]);
    assert.ok(found[0].endsWith(';'), 'the match must span to the statement end: ' + found[0]);
  }
  // textContent is the SAFE sink and must never be mistaken for a write.
  assert.deepEqual(innerHtmlWrites('  name.textContent = who;'), [],
    'textContent was misread as an innerHTML write');
  // And the interpolated form must be recognised as interpolating.
  const withTemplate = innerHtmlWrites('row.innerHTML = `<td>${client.name}</td>`;')[0];
  assert.ok(/\$\{/.test(withTemplate),
    'a template-literal write was not recognised as interpolating: ' + withTemplate);
});
