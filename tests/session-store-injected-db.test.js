// ============================================================================
// clinic-automation — SYNC-9 regression: a session store built with `{ db }`
// (tests/session-store-injected-db.test.js)
//
// THE DEFECT THIS FILE EXISTS TO KILL
// -----------------------------------
// SessionStore._db() used to resolve an INJECTED handle like this:
//
//     _db() {
//       const handle = this._handle;
//       if (handle && handle.open !== false) return handle;   // <-- returned HERE
//       ...
//       const fresh = ensureSessionsTable(resolved);          // <-- never reached
//     }
//
// ensureSessionsTable() sat ONLY on the getDb() branch, so a store handed a
// handle through `{ db }` skipped the schema guarantee entirely. Against a
// database with no `sessions` table, EVERY operation failed with "no such
// table: sessions", and sweepExpired(db) — documented as "accepts a handle so a
// test can sweep a throwaway database" — logged the failure and answered 0,
// which is indistinguishable from "nothing to sweep": a caller could not detect
// that the sweep never ran.
//
// It survived a green suite because every store built with `{ db }` in
// tests/session-store.test.js was preceded by an explicit ensureSessionsTable()
// call in that file's own helper, so the broken branch was structurally
// UNREACHABLE rather than merely untested.
//
// PRODUCTION WAS NEVER AFFECTED: src/app.js calls createSessionStore({ ttlHours })
// with no `db`, so it always took the getDb() path. This file covers the test /
// consumer surface plus the exported helper.
//
// THE CONTRACT ASSERTED HERE (stated behaviour, not a magic number)
// -----------------------------------------------------------------
//   1. An injected handle gets the SAME schema guarantee as a getDb() one: the
//      store creates `sessions` (idempotently) instead of demanding the caller
//      migrate the database first.
//   2. A sweep that CANNOT run must be VISIBLE and must be DISTINGUISHABLE from
//      a sweep that ran and found nothing. The module never throws from a sweep
//      (a failed sweep must not take down a request), so the return value and
//      the log are the only channels a caller has.
//      These tests assert "!== 0" for that case rather than a literal sentinel,
//      because the sentinel's numeric value is an implementation detail that has
//      changed more than once during this fix. "Distinguishable from nothing to
//      sweep" means exactly one thing: NOT zero.
//   3. A store outlives individual database connections. src/db/db.js exposes
//      closeDb() and callers may close a handle directly, so a CLOSED injected
//      handle must be dropped and re-resolved, never handed back. A permanently
//      cached handle is a dead connection, and because express-session calls
//      touch() on every request the visible symptom is "admin login is broken"
//      while /api/health (which touches no session) keeps passing.
//   4. A handle that is not a better-sqlite3 handle at all (a test double) has
//      no exec(); it must still be reused as-is, because the module documents
//      that refusing to would break every caller injecting a fake.
//   5. Every store callback fires ASYNCHRONOUSLY and reports failures as an
//      Error argument rather than throwing. `call()` below fails the test
//      outright if any callback answers synchronously, so this rule is enforced
//      on every single call instead of being trusted.
//
// HERMETICITY — and why the closed-handle case injects a REPLACEMENT handle
// ---------------------------------------------------------------------------
// This file must never touch data/clinic.db. That is not free: when _db() drops
// a closed handle it falls through to require('../db/db').getDb(), which opens
// DB_PATH, and config.js's default DB_PATH is the REAL production database (and
// dotenv back-fills DB_PATH from .env, so it is not even blank). A closed-handle
// case that injects nothing after closing the handle therefore writes into
// data/clinic.db — precisely the contamination reported as SYNC-38. Every case
// below that can reach getDb() installs a throwaway handle with
// db.setDbForTests() first and removes it in a finally, so getDb() can never
// resolve to the production file.
//
// Zero new dependencies: node core + better-sqlite3, already a production
// dependency. Each case builds its own SQLite file under os.tmpdir() and removes
// it (plus -wal/-shm/-journal sidecars) on process exit.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TARGET = path.join(SRC, 'services', 'sessionStore.js');

// better-sqlite3 resolves from the project, not from tests/.
const projectRequire = createRequire(path.join(ROOT, 'package.json'));
const Database = projectRequire('better-sqlite3');

const TMP_ROOT = path.join(os.tmpdir(), 'opencode', 'clinic-automation-tests');
fs.mkdirSync(TMP_ROOT, { recursive: true });

let counter = 0;
function nextDbPath() {
  counter += 1;
  // Random component: a pid+counter name collides with a previous run's leftover
  // file when the OS reuses a pid, and the suite then fails on contamination.
  return path.join(
    TMP_ROOT,
    `sessinj-${process.pid}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}.db`
  );
}

const files = [];
process.on('exit', () => {
  for (const f of files) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.rmSync(f + suffix, { force: true }); } catch (_) { /* best effort */ }
    }
  }
});

/**
 * A REAL, EMPTY database - deliberately not built through src/db/db.js, because
 * db.js's schema.sql has no `sessions` table (sessionStore owns it) and running
 * it would only add unrelated tables. This is the exact shape of the "throwaway
 * handle" the module documents: open, writable, and missing the schema.
 */
function tableLessDb() {
  const dbPath = nextDbPath();
  files.push(dbPath);
  return new Database(dbPath);
}

/**
 * A database that cannot be WRITTEN to, so the store genuinely cannot create the
 * table it needs and a failure is therefore unavoidable rather than hypothetical.
 * The file is created and closed first because opening a NON-EXISTENT path
 * readonly throws in the constructor, which would test the wrong thing. This is
 * still a real better-sqlite3 handle (it has exec()), so it takes the same branch
 * production takes on a read-only mount.
 */
function readOnlyDb() {
  const dbPath = nextDbPath();
  files.push(dbPath);
  const seed = new Database(dbPath);
  seed.close();
  return new Database(dbPath, { readonly: true });
}

const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name);

const storeModule = require(TARGET);
// SCHEMA_REPAIRED and SWEEP_FAILED are taken by NAME from the module's exports
// rather than written as the literals -1 / -2. The module exports them precisely
// so a caller can assert against the name, so a test that hard-codes the number
// would break on a harmless renumbering and would keep passing if the sentinel
// were dropped entirely. A destructured name that disappears arrives as undefined
// and fails loudly instead.
const {
  SessionStore, sweepExpired, ensureSessionsTable, resetSerializationWarning,
  SCHEMA_REPAIRED,
} = storeModule;

/**
 * Promisified store call that also fails if the callback fires synchronously.
 * Every store method must answer via setImmediate: answering inline re-enters
 * express-session while its per-request state is still mid-update and deadlocks
 * it. That rule is part of the contract, so the harness enforces it on every
 * call rather than trusting the implementation to remember it.
 */
function call(store, method, ...args) {
  return new Promise((resolve, reject) => {
    let sync = true;
    store[method](...args, (err, value) => {
      if (sync) reject(new Error(`${method} answered SYNCHRONOUSLY`));
      if (err) reject(err);
      else resolve(value);
    });
    sync = false;
  });
}

const SESSION = () => ({ admin: { u: 'admin' }, cookie: { maxAge: 60_000 } });

/** Run body() with console.error captured; return its value and everything logged. */
function captureConsoleError(body) {
  const original = console.error;
  const lines = [];
  console.error = (...args) => { lines.push(args.map(String).join(' ')); };
  try {
    return { result: body(), logged: lines };
  } finally {
    console.error = original;
  }
}

// ============================================================================
// 1. THE REGRESSION: an injected handle gets the schema guarantee
// ============================================================================

test('SYNC-9: a store built with { db } auto-creates the sessions table', async () => {
  const db = tableLessDb();
  try {
    // Precondition, asserted so this test can never silently stop testing the
    // thing it was written for: if a future schema.sql adds `sessions`, this
    // fixture no longer proves anything and must be rebuilt.
    assert.equal(
      tableNames(db).includes('sessions'),
      false,
      'fixture precondition: this database must NOT have a sessions table'
    );

    // The store is handed the handle and nothing else - no ensureSessionsTable()
    // call anywhere, which is the whole point.
    const store = new SessionStore({ db, sweepMs: 0 });

    await call(store, 'set', 'sidA', SESSION());
    assert.equal(tableNames(db).includes('sessions'), true,
      'the store must create the sessions table on an injected handle');

    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('sidA').n, 1,
      'set() must have written the row'
    );

    // Round-trip through every remaining Store method, so this is not merely a
    // "the CREATE TABLE ran" check: a store that created the table but could not
    // use it would sail past the assertion above.
    const got = await call(store, 'get', 'sidA');
    assert.equal(got && got.admin.u, 'admin', 'get() must read the row back');
    await call(store, 'touch', 'sidA', SESSION());
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('sidA').n, 1,
      'touch() must update in place, not duplicate the row'
    );
    await call(store, 'destroy', 'sidA');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('sidA').n, 0,
      'destroy() must delete the row'
    );
  } finally {
    try { db.close(); } catch (_) { /* already closed */ }
  }
});

// ============================================================================
// 2. sweepExpired(db) must REPAIR the schema, then report REAL counts
// ============================================================================

test('SYNC-9: sweepExpired(db) repairs a missing table, then reports real counts', () => {
  const db = tableLessDb();
  try {
    assert.equal(tableNames(db).includes('sessions'), false, 'precondition: no table yet');

    // The regression: this used to log "no such table: sessions" and answer 0
    // without creating anything.
    const first = sweepExpired(db);
    assert.equal(typeof first, 'number', 'sweepExpired must answer a number');

    // The table did not exist, so this sweep really DID work - it repaired the
    // schema - and there was genuinely nothing to delete. Both facts matter, and
    // the single value 0 can only carry one of them: 0 is what a sweep returns when
    // it ran and found nothing. Answering 0 here would therefore report a real
    // repair as a quiet no-op, which is the same indistinguishability this file
    // exists to kill. SCHEMA_REPAIRED is the documented way to say "real work
    // happened, and it was not a sweep", and asserting the named constant (rather
    // than a literal -1) keeps this a contract test that survives renumbering.
    assert.equal(first, SCHEMA_REPAIRED,
      'a sweep that had to CREATE the sessions table must report SCHEMA_REPAIRED '
      + 'so the caller can tell a repair from a quiet no-op (got '
      + first + ')');
    assert.equal(tableNames(db).includes('sessions'), true,
      'sweepExpired must CREATE the table it needs instead of failing silently');

    // The table must have the module's shape, not an ad-hoc one: the store
    // prepares its statements against exactly these columns.
    const cols = db.prepare('SELECT name FROM pragma_table_info(?)').all('sessions').map((r) => r.name);
    for (const needed of ['sid', 'expires_at', 'data']) {
      assert.ok(cols.includes(needed),
        `sessions must have a ${needed} column (got: ${cols.join(', ')})`);
    }

    // NON-VACUITY. "The repair returned something sensible" can be satisfied by a
    // store that never sweeps anything at all, so drive the real job: one row
    // already expired, one still live, and require that the sweep removes exactly
    // the expired one and reports exactly one deletion.
    const insert = db.prepare('INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)');
    insert.run('gone', Date.now() - 60_000, JSON.stringify({ admin: { u: 'x' } }));
    insert.run('live', Date.now() + 60 * 60_000, JSON.stringify({ admin: { u: 'y' } }));

    assert.equal(sweepExpired(db), 1, 'the sweep must count exactly the one expired row it deleted');
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('gone').n, 0,
      'the expired row must actually be gone'
    );
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('live').n, 1,
      'a LIVE session must never be swept'
    );

    // A repeat sweep is a genuine 0 - which only means something now that 1 has
    // been shown to be achievable on this very handle.
    assert.equal(sweepExpired(db), 0, 'a second sweep has nothing left to remove');
  } finally {
    try { db.close(); } catch (_) { /* already closed */ }
  }
});

// ============================================================================
// 3. A sweep that genuinely CANNOT run must be VISIBLE and DISTINGUISHABLE
// ============================================================================

test('SYNC-9: a sweep that cannot run is distinguishable from an empty one', () => {
  const db = readOnlyDb();
  try {
    // resetSerializationWarning() re-arms the module's once-per-process logging
    // flag. Without it the message may already have been consumed by an earlier
    // case, and the log assertion below would then depend on test order.
    resetSerializationWarning();

    const { result, logged } = captureConsoleError(() => sweepExpired(db));

    // THE POINT. A real row count is never negative and never negative-or-zero
    // ambiguity aside, the historical failure answered exactly 0 here, so 0 is the
    // one value this assertion must reject. Asserting "!== 0" states the
    // documented requirement ("distinguishable from nothing to sweep") without
    // pinning the sentinel's numeric value, which is an implementation detail
    // that has changed repeatedly during this fix.
    assert.ok(Number.isInteger(result),
      `sweepExpired must answer an integer, got ${typeof result} (${result})`);
    assert.notEqual(result, 0,
      `a sweep that could not run answered ${result}, which is indistinguishable from `
      + '"nothing to sweep" - the caller cannot tell a broken database from a quiet one');

    // Secondary, and deliberately a named export rather than a literal: the
    // module documents SWEEP_FAILED as "exported so a caller can tell a real
    // count from a sentinel without magic numbers", so a caller is entitled to
    // rely on it. Asserting the export (not -2) keeps this honest if the value is
    // ever renumbered, while still failing loudly if the export is dropped.
    assert.equal(result, storeModule.SWEEP_FAILED,
      'the failure should be reported as the exported SWEEP_FAILED sentinel');

    // Visible, not silent. sweepExpired documents that it never throws (a failed
    // sweep must not take down a request), so the log is the only channel left.
    assert.ok(logged.length > 0,
      'the failure must be LOGGED - sweepExpired does not throw, so the log is the '
      + 'only way an operator or a caller can see it');
    assert.match(logged.join('\n'), /sessionStore/i,
      `the log must name the module so it can be traced (got: ${JSON.stringify(logged)})`);

    // POSITIVE CONTROL, deliberately in the SAME test. Without it the assertion
    // above would also pass against a sweepExpired that always returns -1, i.e.
    // a guard that proves nothing. A healthy database must still answer a
    // truthful 0.
    const healthy = tableLessDb();
    try {
      ensureSessionsTable(healthy);
      const quiet = sweepExpired(healthy);
      assert.equal(quiet, 0,
        'a healthy database with nothing expired must answer a truthful 0');
    } finally {
      try { healthy.close(); } catch (_) { /* already closed */ }
    }
  } finally {
    try { db.close(); } catch (_) { /* already closed */ }
  }
});

// ============================================================================
// 4. A handle with no exec() is still reused as-is (documented contract)
// ============================================================================

test('a non-sqlite test double (no .exec) is still accepted - documented contract', async () => {
  // sessionStore's _db() header states that a handle whose `open` is undefined is
  // "not a better-sqlite3 handle (a test double, or some other adapter). Reuse
  // it; refusing to would break every caller that injects a fake."
  // Creating the table needs .exec, so the store must SKIP the schema guarantee
  // for such a handle rather than throw "db.exec is not a function".
  const fake = {
    open: undefined,
    prepare() { throw new Error('fake handle: no SQL here'); },
  };
  const store = new SessionStore({ db: fake, sweepMs: 0 });
  // It must reach prepare() - proving _db() returned the double - and report the
  // failure through the callback instead of throwing at express-session.
  await assert.rejects(
    () => call(store, 'set', 'sidA', SESSION()),
    /fake handle/,
    'the store must reach the injected double and report its error via the callback'
  );
});

// ============================================================================
// 5. A CLOSED injected handle is re-resolved, never handed back
// ============================================================================

test('a closed injected handle is re-resolved, and the write lands on the live replacement', async () => {
  const dbmod = require(path.join(SRC, 'db', 'db.js'));
  const first = tableLessDb();
  const second = tableLessDb();
  try {
    // Proof the dead handle is genuinely dead: this is the exact condition
    // (handle.open === false) that _db() must treat as "re-resolve".
    first.close();
    assert.equal(first.open, false, 'precondition: the handle really is closed');

    // Install the replacement BEFORE the store runs, so the getDb() fallback
    // resolves to a throwaway file and never to data/clinic.db.
    dbmod.setDbForTests(second);

    const store = new SessionStore({ db: first, sweepMs: 0 });
    // The store was handed the CLOSED handle and is told nothing else, so the
    // only way this write can succeed is if _db() dropped the corpse and
    // re-resolved. This is the assertion that matches the test's name; the old
    // version of this case merely checked that `_db` was a function.
    await call(store, 'set', 'afterClose', SESSION());

    assert.notEqual(store._handle, first,
      '_db() returned the CLOSED handle - every later operation would fail with '
      + '"The database connection is not open", which is what broke admin login');
    assert.equal(store._handle, second,
      '_db() must re-resolve to the current live handle');
    assert.equal(
      second.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('afterClose').n, 1,
      'the write must land in the replacement database, not vanish'
    );

    // The re-resolved handle gets the schema guarantee too, so the replacement is
    // usable even though IT had no sessions table either.
    assert.equal(tableNames(second).includes('sessions'), true,
      'the schema guarantee must apply to the re-resolved handle, not only an injected one');

    // Round-trip through it, proving it is a usable handle and not merely a
    // different object.
    const got = await call(store, 'get', 'afterClose');
    assert.equal(got && got.admin.u, 'admin',
      'get() must read back through the re-resolved handle');
  } finally {
    // Always clear the override: a later case reaching getDb() would otherwise
    // inherit it, and the whole point is to keep data/clinic.db unreachable.
    dbmod.setDbForTests(null);
    try { dbmod.closeDb(); } catch (_) { /* nothing open */ }
    for (const h of [first, second]) {
      try { h.close(); } catch (_) { /* already closed */ }
    }
  }
});

// ============================================================================
// 6. The schema guarantee is IDEMPOTENT - no over-reach when the table exists
// ============================================================================

test('the schema guarantee is idempotent when the table already exists', async () => {
  const db = tableLessDb();
  try {
    // Build the table with the module's OWN exported DDL, twice, so this asserts
    // the real shape instead of a hand-written approximation that could drift
    // away from what the store prepares against.
    ensureSessionsTable(db);
    ensureSessionsTable(db);

    const store = new SessionStore({ db, sweepMs: 0 });
    await call(store, 'set', 'sidB', SESSION());
    // set() is an upsert keyed on sid, so writing twice must not create two rows.
    await call(store, 'set', 'sidB', SESSION());
    assert.equal(
      db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get('sidB').n, 1,
      'the existing table must be reused, not recreated or duplicated'
    );
    assert.equal(sweepExpired(db), 0, 'a freshly written session must not be swept');
  } finally {
    try { db.close(); } catch (_) { /* already closed */ }
  }
});
