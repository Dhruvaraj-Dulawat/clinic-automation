// ============================================================================
// PERMANENT, GATED regression test for public/js/admin.js -- todo S9.8.2 (D4)
// Target: C:/Users/dhruv/clinic-automation/public/js/admin.js
// Origin: ses_worker_s98_2
//
// WHY THIS FILE LIVES IN tests/ INSTEAD OF public/js/__tests__/
// `npm test` globs `node --test "tests/**/*.test.js"`, so a test written to
// src/**/__tests__/ or public/js/__tests__/ is DEAD CODE that npm test reports
// as zero coverage. An earlier version of this suite lived in public/js/ and was
// deleted after passing per the project's throwaway-test convention -- which left
// the whole Deactivate / Restore / Anonymize UI with NO runnable guard at all
// (markdown archives are not executed). It was promoted here instead. If you
// move this file, move it INTO tests/ or it silently stops protecting anything.
//
// It was verified green 15/15 against admin.js md5 7EEA48AAE0, and proven
// non-vacuous: reverting describeLifecycleError's structured-field 409 fallback
// flips exactly one case (the "409 with NO message field" test) to red.
//
// Isolation: the ONLY module under test is the target browser script. It talks
// to two globals -- `document` and `fetch` -- both replaced with local stubs, so
// no network, no real DOM, and NO src/ module is loaded. `node --test` gives
// each file its own process, so the stubbed globals cannot leak into a sibling.
//
// Backend contract, READ from src/routes/clients.js and asserted here as data:
//   GET    /api/clients             -> 200 { clients: [ {..., active: 1|0} ] }
//                                       (inactive rows ARE still listed)
//   DELETE /api/clients/:id         -> 200 { client, deactivated: true }
//                                    -> 409 { error: 'client_has_upcoming_appointment',
//                                             message,
//                                             appointment: {id, slot_start, status} }
//                                    -> 404 { error: 'not_found' }
//   POST   /api/clients/:id/restore -> 200 { restored: true }
//                                    -> 501 { error, missing, message }
//   POST   /api/clients/:id/anonymize -> 200 { anonymized: true }
//                                      -> 501 { error, missing, message }
// ============================================================================
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const TARGET = 'C:/Users/dhruv/clinic-automation/public/js/admin.js';

const ADA = {
  id: 1, name: 'Ada Lovelace', phone: '+919000000001',
  tags: 'vip', notes: null, active: 1, deactivated_at: null, anonymized: 0,
};
const GRACE = {
  id: 2, name: 'Grace Hopper', phone: '+919000000002',
  tags: 'vip', notes: null, active: 0, deactivated_at: '2026-10-03 12:00', anonymized: 0,
};

// --- DOM stub -----------------------------------------------------------------
function makeEl(tag) {
  const el = {
    tag, id: '', className: '', textContent: '', value: '', hidden: false,
    dataset: {}, style: {}, children: [], onclick: null, disabled: false,
    written: [],            // every string ever assigned to .innerHTML
  };
  let html = '';
  Object.defineProperty(el, 'innerHTML', {
    get() { return html; },
    set(v) { el.written.push(String(v)); html = String(v); el.children = []; },
  });
  el.appendChild = (c) => { el.children.push(c); return c; };
  el.insertBefore = (c) => { el.children.unshift(c); return c; };
  el.replaceChildren = (...cs) => { el.children = cs; };
  // notify() calls classList.remove()/add(), so a stub without it fails for a
  // reason that has nothing to do with what is under test.
  el.classList = { add() {}, remove() {}, toggle() {}, contains: () => false };
  el.remove = () => {};
  el.setAttribute = () => {};
  el.getAttribute = () => null;
  el.addEventListener = () => {};
  el.removeEventListener = () => {};
  el.focus = () => {};
  el.blur = () => {};
  return el;
}

const textNode = (s) => ({ tag: '#text', text: String(s), children: [] });

// textContent aggregates DESCENDANTS in a real DOM, so a badge inside a cell
// shows up in that cell's text. Mirror that or every badge assertion is vacuous.
function subtreeText(node) {
  let out = node.textContent || '';
  if (node.tag === '#text') out = node.text || '';
  for (const c of node.children || []) out += subtreeText(c);
  return out;
}

// Poll until `fn()` is truthy. Deterministic: no guessing how many microtask
// turns an async render needs (the `setImmediate`-chain race was flaky).
async function waitFor(fn, what, ms = 4000) {
  const until = Date.now() + ms;
  for (;;) {
    if (fn()) return;
    if (Date.now() > until) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// --- harness ------------------------------------------------------------------
function loadAdmin({
  clients = [ADA, GRACE],
  deleteResponse = null,
  restoreResponse = null,
  anonymizeResponse = null,
} = {}) {
  const calls = [];
  const confirms = [];
  const rejected = [];

  const tbody = makeEl('tbody');
  const table = makeEl('table');
  const els = {};
  for (const id of ['login-card', 'dashboard', 'login-form', 'login-error',
    'logout-btn', 'search-form', 'import-form', 'csv', 'import-result', 'q',
    'clients-table', 'admin-notice']) {
    els[id] = makeEl(id);
  }
  els['q'].value = '';
  els['clients-table'].id = 'clients-table';
  // Pre-create #admin-notice so notify() takes its getElementById() branch and
  // the test never has to model lazy insertion.
  els['admin-notice'].hidden = true;

  const saved = [];
  const set = (n, v) => { saved.push([n, globalThis[n]]); globalThis[n] = v; };

  set('document', {
    addEventListener: (evt, fn) => { if (evt === 'DOMContentLoaded') els.__ready = fn; },
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => [],
    querySelector: (sel) => (sel === '#clients-table tbody' ? tbody : null),
    createElement: (tag) => makeEl(tag),
    createTextNode: (t) => textNode(t),
  });
  set('confirm', (msg) => { confirms.push(msg); return true; });
  set('prompt', () => null);

  const res = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

  set('fetch', async (p, opts = {}) => {
    const path = String(p);
    const method = (opts.method || 'GET').toUpperCase();
    calls.push({ path, method });
    const route = path.split('?')[0];
    // Parse "/api/clients/:id[/action]" properly. Splitting on '/' and taking
    // the last segment yields "restore", not the id -- which silently makes
    // every stubbed error branch unreachable and reports a false PASS.
    const m = /^\/api\/clients\/(\d+)(\/[a-z]+)?$/.exec(route);
    const id = m ? m[1] : null;
    const action = m && m[2] ? m[2] : null;

    if (route === '/api/admin/me') return res(200, { username: 'admin', role: 'admin' });
    if (route === '/csrf') return res(200, { csrfToken: 'tok' });
    if (route === '/api/clients' && method === 'GET') return res(200, { clients });

    if (id && action === null && method === 'DELETE') {
      return deleteResponse ? res(deleteResponse.status, deleteResponse.body)
        : res(200, { client: ADA, deactivated: true });
    }
    if (id && action === '/restore') {
      return restoreResponse ? res(restoreResponse.status, restoreResponse.body)
        : res(200, { client: ADA, restored: true });
    }
    if (id && action === '/anonymize') {
      return anonymizeResponse ? res(anonymizeResponse.status, anonymizeResponse.body)
        : res(200, { client: { id: ADA.id, name: 'Anonymized client ' + ADA.id }, anonymized: true });
    }
    return res(200, {});
  });

  const onRejection = (r) => rejected.push(r);
  process.on('unhandledRejection', onRejection);

  for (const k of Object.keys(require.cache)) if (k.endsWith('admin.js')) delete require.cache[k];
  require(TARGET);
  if (typeof els.__ready !== 'function') throw new Error('no DOMContentLoaded handler registered');

  els.__ready();   // sync handler; it kicks off an async checkMe()

  const h = {
    calls, confirms, rejected, els,
    get rows() { return Array.from(tbody.children); },
    noticeText() { return els['admin-notice'].textContent; },
    noticeShown() { return els['admin-notice'].hidden === false; },
    buttonsIn(row) { return allButtons(row); },
    labelsIn(row) { return this.buttonsIn(row).map((b) => b.textContent); },
    cellText(row) { return row.children.map(subtreeText).join(' | '); },
    // Click a button and let the handler's promise + any follow-up settle.
    async click(re) {
      const seen = [];
      for (const row of this.rows) for (const b of this.buttonsIn(row)) seen.push(b.textContent);
      const b = this.rows.flatMap((r) => this.buttonsIn(r)).filter((x) => re.test(x.textContent))[0];
      assert.ok(b, 'no button matching ' + re + '; saw ' + JSON.stringify(seen));
      await b.onclick();
      await new Promise((r) => setTimeout(r, 25));
    },
    restore() {
      process.removeListener('unhandledRejection', onRejection);
      saved.forEach(([n, v]) => { globalThis[n] = v; });
    },
  };
  return h;
}

// Buttons live inside the row's 4th cell, not directly under <tr>, so search
// the subtree -- a direct-children filter silently finds nothing.
function allButtons(node, out = []) {
  for (const c of node.children || []) {
    if (c.tag === 'button') out.push(c);
    else allButtons(c, out);
  }
  return out;
}

const rendered = (h, n) => waitFor(() => h.rows.length >= n, n + ' rows rendered', 5000);

// ===========================================================================
// 1. "Delete" is gone -- the row action reads Deactivate
// ===========================================================================
test('the row action reads Deactivate, never Delete', async () => {
  const h = loadAdmin();
  try {
    await rendered(h, 2);
    const labels = h.labelsIn(h.rows[0]);
    assert.ok(labels.length > 0, 'no buttons rendered');
    assert.ok(!labels.some((t) => /\bdelete\b/i.test(t)), 'a Delete button survives: ' + JSON.stringify(labels));
    assert.ok(labels.some((t) => /deactivate/i.test(t)), 'no Deactivate button: ' + JSON.stringify(labels));
  } finally { h.restore(); }
});

test('no string literal in the code names Delete as an action', () => {
  const src = fs.readFileSync(TARGET, 'utf8');
  const code = src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n');
  const hits = code.match(/['"`][^'"`]*\b[Dd]elete\b[^'"`]*['"`]/g) || [];
  assert.deepEqual(hits, [], 'a Delete literal survives in code: ' + JSON.stringify(hits));
});

test('the confirm dialog names the client, says deactivation, and says it is reversible', async () => {
  const h = loadAdmin();
  try {
    await rendered(h, 2);
    await h.click(/deactivate/i);
    assert.equal(h.confirms.length, 1, 'confirm() was not called');
    const msg = h.confirms[0];
    assert.ok(!/\bdelete\b/i.test(msg), 'confirm still says delete: ' + msg);
    assert.ok(!/removed|permanently|cannot be undone/i.test(msg), 'confirm promises removal: ' + msg);
    assert.ok(/deactivat/i.test(msg), 'confirm never mentions deactivation: ' + msg);
    assert.ok(/Ada Lovelace/.test(msg), 'confirm omits the client name: ' + msg);
    assert.ok(/kept|history/i.test(msg), 'confirm does not say history is kept: ' + msg);
    assert.ok(/restore/i.test(msg), 'confirm does not say the action is reversible: ' + msg);
  } finally { h.restore(); }
});

test('clicking Deactivate calls DELETE /api/clients/:id', async () => {
  const h = loadAdmin();
  try {
    await rendered(h, 2);
    await h.click(/deactivate/i);
    const dels = h.calls.filter((c) => c.method === 'DELETE');
    assert.equal(dels.length, 1, 'expected one DELETE, got ' + JSON.stringify(h.calls));
    assert.equal(dels[0].path, '/api/clients/1');
  } finally { h.restore(); }
});

// ===========================================================================
// 2. The 409 is a READABLE message naming the blocking appointment
// ===========================================================================
const CONFLICT_BODY = {
  error: 'client_has_upcoming_appointment',
  message: 'This client still has a confirmed appointment on 2026-10-05 09:00. '
    + 'Cancel or complete it first, or anonymize the client instead.',
  appointment: { id: 77, slot_start: '2026-10-05 09:00', status: 'confirmed' },
};

test('a 409 surfaces the blocking slot_start AND status', async () => {
  const h = loadAdmin({ deleteResponse: { status: 409, body: CONFLICT_BODY } });
  try {
    await rendered(h, 2);
    await h.click(/deactivate/i);
    const msg = h.noticeText();
    assert.ok(msg, 'nothing was shown to the user');
    assert.ok(/2026-10-05 09:00/.test(msg), 'notice omits the blocking slot_start: ' + msg);
    assert.ok(/confirmed/i.test(msg), 'notice omits the blocking status: ' + msg);
    assert.ok(!/client_has_upcoming_appointment/.test(msg), 'raw error code leaked to the UI: ' + msg);
    assert.deepEqual(h.rejected.map(String), [], 'the failure escaped as an unhandled rejection');
  } finally { h.restore(); }
});

// The regression that matters: a 409 WITHOUT the human `message` (a proxy, an
// older server, or the field simply omitted) must still read as English built
// from the structured fields -- never the internal error code.
test('a 409 with NO message field still reads as English, from the appointment fields', async () => {
  const h = loadAdmin({
    deleteResponse: {
      status: 409,
      body: {
        error: 'client_has_upcoming_appointment',
        appointment: { id: 77, slot_start: '2026-10-05 09:00', status: 'confirmed' },
      },
    },
  });
  try {
    await rendered(h, 2);
    await h.click(/deactivate/i);
    const msg = h.noticeText();
    assert.ok(msg, 'nothing was shown to the user');
    assert.ok(!/client_has_upcoming_appointment/.test(msg), 'the internal error code was shown raw: ' + msg);
    assert.ok(/2026-10-05 09:00/.test(msg), 'the slot_start was dropped: ' + msg);
    assert.ok(/confirmed/i.test(msg), 'the status was dropped: ' + msg);
    assert.ok(/Ada Lovelace/.test(msg), 'the client name was dropped: ' + msg);
    assert.deepEqual(h.rejected.map(String), [], 'the failure escaped as an unhandled rejection');
  } finally { h.restore(); }
});

test('a 404 and a 500 both surface a message and never an unhandled rejection', async () => {
  for (const pair of [[404, { error: 'not_found' }], [500, { error: 'boom' }]]) {
    const h = loadAdmin({ deleteResponse: { status: pair[0], body: pair[1] } });
    try {
      await rendered(h, 2);
      await h.click(/deactivate/i);
      const msg = h.noticeText();
      assert.ok(msg, pair[0] + ' showed nothing');
      assert.ok(!/\[object Object\]/.test(msg), pair[0] + ' dumped a raw object: ' + msg);
      assert.deepEqual(h.rejected.map(String), [], pair[0] + ' escaped as an unhandled rejection');
    } finally { h.restore(); }
  }
});

// ===========================================================================
// 3. The `active` flag is reflected
// ===========================================================================
test('an inactive client is dimmed and badged, and is offered Restore not Deactivate', async () => {
  const h = loadAdmin();
  try {
    await rendered(h, 2);
    const grace = h.rows[1];
    const labels = h.labelsIn(grace);
    assert.ok(!labels.some((t) => /deactivate/i.test(t)),
      'Deactivate offered for an inactive client: ' + JSON.stringify(labels));
    assert.ok(labels.some((t) => /restore/i.test(t)), 'no Restore button: ' + JSON.stringify(labels));
    assert.ok(/inactive|deactivated/i.test(h.cellText(grace)), 'no inactive badge: ' + h.cellText(grace));
    assert.ok(grace.style && Number(grace.style.opacity) > 0 && Number(grace.style.opacity) < 1,
      'inactive row is not dimmed (opacity=' + JSON.stringify(grace.style.opacity) + ')');
  } finally { h.restore(); }
});

test('an active client is NOT dimmed and NOT badged', async () => {
  const h = loadAdmin();
  try {
    await rendered(h, 2);
    const ada = h.rows[0];
    assert.ok(!(ada.style && Number(ada.style.opacity) > 0 && Number(ada.style.opacity) < 1),
      'an active row was dimmed (opacity=' + JSON.stringify(ada.style.opacity) + ')');
    assert.ok(!/inactive/i.test(h.cellText(ada)), 'an active row was badged inactive: ' + h.cellText(ada));
  } finally { h.restore(); }
});

test('a pre-migration row with no active column is still treated as active', async () => {
  const legacy = { id: 4, name: 'Legacy Row', phone: '+919000000004', tags: '' };
  const h = loadAdmin({ clients: [legacy] });
  try {
    await rendered(h, 1);
    const labels = h.labelsIn(h.rows[0]);
    assert.ok(labels.some((t) => /deactivate/i.test(t)),
      'a legacy row lost its Deactivate button: ' + JSON.stringify(labels));
  } finally { h.restore(); }
});

test('Restore calls POST /api/clients/:id/restore and reports it', async () => {
  const h = loadAdmin();
  try {
    await rendered(h, 2);
    await h.click(/restore/i);
    const posts = h.calls.filter((c) => c.method === 'POST' && /\/restore$/.test(c.path));
    assert.equal(posts.length, 1, 'expected one POST /restore, got ' + JSON.stringify(h.calls));
    assert.equal(posts[0].path, '/api/clients/2/restore');
    assert.ok(/restore/i.test(h.noticeText()), 'success was not reported: ' + h.noticeText());
    assert.deepEqual(h.rejected.map(String), [], 'restore escaped as an unhandled rejection');
  } finally { h.restore(); }
});

// clients.js answers 501 { message } when repository.clients.setActive is absent.
test('a 501 from Restore surfaces the server sentence, not raw JSON', async () => {
  const h = loadAdmin({
    restoreResponse: {
      status: 501,
      body: {
        error: 'restore_unavailable', missing: 'clients.setActive',
        message: 'Restore needs repository.clients.setActive, which src/db/repository.js '
          + 'does not expose yet (todo S9.3.4). The client is unchanged.',
      },
    },
  });
  try {
    await rendered(h, 2);
    await h.click(/restore/i);
    const msg = h.noticeText();
    assert.ok(/repository\.clients\.setActive/.test(msg), 'the 501 explanation was lost: ' + msg);
    assert.ok(!/^\s*\{/.test(msg), 'raw JSON was dumped: ' + msg);
    assert.deepEqual(h.rejected.map(String), [], 'the 501 escaped as an unhandled rejection');
  } finally { h.restore(); }
});

// ===========================================================================
// 4. Anonymize (retention) -- required endpoint, irreversible so it confirms
// ===========================================================================
test('Anonymize calls POST /api/clients/:id/anonymize behind an irreversible confirm', async () => {
  const h = loadAdmin();
  try {
    await rendered(h, 2);
    await h.click(/anonymize/i);
    assert.equal(h.confirms.length, 1, 'anonymize did not confirm first');
    assert.ok(/cannot be undone|permanent/i.test(h.confirms[0]),
      'the confirm does not warn it is irreversible: ' + h.confirms[0]);
    const posts = h.calls.filter((c) => c.method === 'POST' && /\/anonymize$/.test(c.path));
    assert.equal(posts.length, 1, 'expected one POST /anonymize, got ' + JSON.stringify(h.calls));
    assert.equal(posts[0].path, '/api/clients/1/anonymize');
  } finally { h.restore(); }
});

// ===========================================================================
// 5. D8: hostile server text must never become markup (textContent only)
// ===========================================================================
test('a client whose name/tags/phone carry markup is rendered as TEXT, not HTML', async () => {
  const evil = {
    id: 9,
    name: '<img src=x onerror=alert(1)>',
    phone: "');alert(2);//",
    tags: '<script>alert(3)</script>',
    notes: '<b>hi</b>',
    active: 1,
  };
  const h = loadAdmin({ clients: [evil] });
  try {
    await rendered(h, 1);
    const row = h.rows[0];
    const asText = h.cellText(row);
    assert.ok(asText.includes('<img src=x onerror=alert(1)>'), 'the name was not rendered as text: ' + asText);
    assert.ok(asText.includes('<script>alert(3)</script>'), 'the tags were not rendered as text: ' + asText);
    assert.ok(row.written.every((w) => !/\$\{|alert|<img|<script/i.test(w)),
      'markup reached innerHTML: ' + JSON.stringify(row.written));
  } finally { h.restore(); }
});

test('the render path builds no HTML string at all (D8 by construction)', () => {
  // The strongest available invariant: admin.js never assigns innerHTML, so a
  // name/phone/tag containing markup has no route into the document. The
  // behavioural half of this guard is the hostile-payload test above.
  const src = fs.readFileSync(TARGET, 'utf8');
  const writes = src.match(/\.innerHTML\s*=[^;]*/g) || [];
  assert.deepEqual(writes, [], 'an innerHTML write survives: ' + JSON.stringify(writes));
});

