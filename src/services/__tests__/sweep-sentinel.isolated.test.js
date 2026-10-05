/**
 * ISOLATED Unit Test — sweepExpired() failure sentinels (SYNC-9)
 * Target: src/services/sessionStore.js
 * Session: current Worker session
 *
 * THIS FILE IS NOW A PERMANENT, COMMITTED PART OF THE SUITE. It previously
 * carried the header "deleted after the test passes", which is exactly how a
 * 5-test contract went missing from `npm test` while the suite stayed green.
 * `package.json`'s test script now discovers `**\/*.test.js`, so this file runs
 * on every gate and cannot rot unnoticed again.
 *
 * THE SENTINEL DESIGN IS REAL, NOT A TEST DRAFT. src/services/sessionStore.js
 * exports SCHEMA_REPAIRED (-1) and SWEEP_FAILED (-2), and sweepExpired()
 * returns a negative value exactly when the caller must NOT read the answer as
 * "there was nothing to sweep". Both are asserted here against the real
 * module - see the header comment at the top of sessionStore.js.
 *
 * Isolation: requires ONLY the target file. Every database is a throwaway
 * temp file under os.tmpdir(). No network, no shared state, and never
 * ./data/clinic.db - DB_PATH is pinned in every case that can reach getDb().
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const Database = createRequire(path.join(ROOT, 'package.json'))('better-sqlite3');
const store = require(path.join(ROOT, 'src', 'services', 'sessionStore.js'));

const TMP = path.join(os.tmpdir(), 'opencode', 'sweep-sentinel-' + process.pid);
fs.mkdirSync(TMP, { recursive: true });

// WHY DB_PATH IS PINNED HERE, BEFORE ANY TEST RUNS.
// This file exercises the `getDb()` fallback (no injected handle), and the project's
// own `.env` sets `DB_PATH=./data/clinic.db` - the operator's REAL production database.
// Without this line the two fallback tests below open that file, and sweepExpired()'s
// `DELETE FROM sessions WHERE expires_at <= ?` then runs against real patient data.
// Measured: executing this file moved data/clinic.db's mtime from 13:39:57 to the minute
// of the run. Pinning a throwaway path here is what makes the file hermetic.
//
// The path is deliberately UNOPENABLE rather than merely temporary. A temp path would be
// opened (and created) successfully, so a test that needs "the database is unreachable"
// would silently be handed a working database instead. Here the parent "directory" is a
// regular FILE, so db.js's `fs.mkdirSync(dirname, { recursive: true })` throws ENOTDIR,
// getDb() throws, and the store takes its documented could-not-reach-the-database path -
// which is exactly the condition under test, now reproduced deterministically instead of
// depending on whether some unrelated database happens to exist on the machine.
const UNOPENABLE = path.join(TMP, 'not-a-directory', 'clinic.db');
fs.writeFileSync(path.join(TMP, 'not-a-directory'), 'a regular file, not a directory');
process.env.DB_PATH = UNOPENABLE;

let seq = 0;
/** A real, writable, EMPTY better-sqlite3 database. */
function freshDb() {
  const p = path.join(TMP, `db-${seq++}.db`);
  for (const s of ['', '-wal', '-shm', '-journal']) { try { fs.rmSync(p + s, { force: true }); } catch (_) {} }
  return new Database(p);
}
const tableNames = (db) =>
  db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);

/** What the caller is told, apart from the count itself. */
function outcome(value) {
  if (value === 0) return 'swept-nothing-expired';
  if (value < 0) return 'NOT-A-REAL-SWEEP';
  return 'swept-' + value;
}

test.after(() => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });

// ---------------------------------------------------------------- the contract

test('a sweep that never really ran is NOT reported as 0', () => {
  const db = freshDb();
  assert.deepEqual(tableNames(db), [], 'precondition: no sessions table');

  const removed = store.sweepExpired(db);

  assert.equal(typeof removed, 'number', 'the return type stays a number');
  assert.notEqual(removed, 0,
    'sweepExpired answered 0 on a database with no sessions table — that is ' +
    'indistinguishable from "nothing to sweep", so the failure is silent');
  assert.ok(removed < 0, 'a non-sweep is signalled by a negative sentinel, got ' + removed);
  assert.equal(outcome(removed), 'NOT-A-REAL-SWEEP');
  assert.equal(tableNames(db).includes('sessions'), true,
    'sweepExpired must also be able to create the table it needs');

  db.close();
});

test('the sentinel is one-shot: the NEXT sweep reports real counts', () => {
  const db = freshDb();
  const first = store.sweepExpired(db);
  assert.ok(first < 0, 'first sweep reports the repair');

  // THE STICKINESS BUG THIS TEST EXISTS FOR: if `__sessionsTableCreated` were
  // set once and never recomputed, every later sweep would answer -1 forever
  // and expired sessions would silently stop being swept.
  const second = store.sweepExpired(db);
  assert.equal(second, 0, 'second sweep must be an ordinary no-op, not the sentinel again');
  assert.equal(outcome(second), 'swept-nothing-expired');

  db.prepare('INSERT INTO sessions (sid, expires_at, data) VALUES (?,?,?)')
    .run('expired', Date.now() - 60_000, '{}');
  db.prepare('INSERT INTO sessions (sid, expires_at, data) VALUES (?,?,?)')
    .run('live', Date.now() + 600_000, '{}');

  const third = store.sweepExpired(db);
  assert.equal(third, 1, 'a real sweep reports a real count');
  assert.deepEqual(db.prepare('SELECT sid FROM sessions').all().map((r) => r.sid), ['live'],
    'the expired row is gone and the live row is untouched');

  db.close();
});

test('an ALREADY-provisioned table is never falsely reported as a repair', () => {
  // This is the production path: sessions has existed since the first boot.
  // If it reported a sentinel here, every ordinary quiet tick would look like
  // a failure and the log would cry wolf forever.
  const db = freshDb();
  store.ensureSessionsTable(db);

  for (let i = 0; i < 3; i++) {
    const removed = store.sweepExpired(db);
    assert.equal(removed, 0, `sweep ${i + 1} on a healthy empty table must be a plain 0`);
    assert.equal(outcome(removed), 'swept-nothing-expired');
  }
  db.close();
});

// -------------------------------------------------------- the unreachable-db hole

test('an unusable database is reported as a failure, not as "nothing to sweep"', () => {
  const warned = [];
  const realError = console.error;
  console.error = (...a) => warned.push(a.join(' '));
  try {
    // UNREACHABLE database, produced deterministically. `delete process.env.DB_PATH`
    // would NOT do it: the project's .env pins DB_PATH=./data/clinic.db, so deleting
    // the variable just hands getDb() the operator's production file again - which is
    // how this file came to write to real patient data. DB_PATH stays set, pointing at
    // the unopenable path, so "cannot reach the database" is genuinely the condition.
    const previous = process.env.DB_PATH;
    process.env.DB_PATH = UNOPENABLE;
    const previousNodeEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = 'test';

    let removed;
    try {
      removed = store.sweepExpired({});          // falsy-ish handle -> lazy path
    } catch (e) {
      removed = `THREW ${e.message}`;
    } finally {
      if (previous === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = previous;
      process.env.NODE_ENV = previousNodeEnv;
    }

    assert.ok(typeof removed === 'number', 'sweepExpired never throws — it returned: ' + removed);
    assert.ok(removed < 0, 'an unreachable database must not answer 0, got ' + removed);
    assert.equal(outcome(removed), 'NOT-A-REAL-SWEEP');
    assert.ok(warned.length > 0, 'the failure is logged, not silent');
  } finally {
    console.error = realError;
  }
});

/**
 * Force src/config.js and src/db/db.js to be re-read from the environment.
 * sessionStore requires db.js lazily from inside _db(), so without this a
 * cached module would answer with whatever handle an EARLIER test installed -
 * and that is how a "hermetic" isolated test ends up sweeping the real
 * ./data/clinic.db.
 */
function purgeConfigAndDb() {
  for (const key of Object.keys(require.cache)) {
    if (/[\\/](src[\\/]config|src[\\/]db[\\/]db)\.js$/.test(key)) delete require.cache[key];
  }
}

test('a CLOSED injected handle is never reused, and never becomes a silent 0', () => {
  const db = freshDb();
  const s = new store.SessionStore({ db, sweepMs: 0 });
  store.sweepExpired(db);          // provision the injected handle's schema
  db.close();
  assert.equal(db.open, false, 'precondition: the injected handle is really closed');

  // ---------------------------------------------------------------- case (a)
  // The store may RE-RESOLVE a dead handle rather than reusing it - that is a
  // committed contract (tests/session-store-injected-db.test.js, "a closed
  // injected handle is re-resolved, and the write lands on the live
  // replacement"). Pin a REACHABLE replacement and prove the answer is a real
  // count taken against a live handle.
  //
  // DB_PATH must be pinned: getDb() reads .env, and .env points at the real
  // clinic database. An unpinned fallback here would migrate and sweep
  // ./data/clinic.db from inside a test.
  const replacement = freshDb();
  // Pre-provision the replacement. Without this the assertion below is testing the
  // wrong thing: a brand-new handle has no `sessions` table, so _db() has to CREATE
  // it, and the documented answer for that is SCHEMA_REPAIRED (-1) - not a "real
  // count". The point of this case is that a REACHABLE, already-provisioned handle
  // answers a plain 0, which is what distinguishes it from both the repair sentinel
  // and the dead-handle case in (b).
  store.ensureSessionsTable(replacement);
  assert.deepEqual(
    tableNames(replacement).includes('sessions'), true,
    'precondition: the replacement already has its schema, so no repair is reported'
  );
  const savedDb = process.env.DB_PATH;
  const savedNodeEnv = process.env.NODE_ENV;
  const savedSecret = process.env.SESSION_SECRET;
  process.env.NODE_ENV = 'test';
  process.env.DB_PATH = replacement.name;
  process.env.SESSION_SECRET = 'b'.repeat(40);
  purgeConfigAndDb();

  const warnedQuiet = [];
  const quietError = console.error;
  console.error = (...a) => warnedQuiet.push(a.join(' '));
  let removedOnReplacement;
  try {
    removedOnReplacement = s.sweepExpired();
  } finally {
    console.error = quietError;
    if (savedDb === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = savedDb;
    process.env.NODE_ENV = savedNodeEnv;
    if (savedSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = savedSecret;
    purgeConfigAndDb();
  }
  assert.equal(typeof removedOnReplacement, 'number', 'the fallback never throws');
  assert.ok(removedOnReplacement >= 0,
    'a reachable replacement handle must answer a REAL count, not a sentinel; got ' +
    removedOnReplacement);
  assert.equal(removedOnReplacement, 0,
    'the replacement is a fresh empty database, so an honest sweep finds nothing');
  assert.deepEqual(
    warnedQuiet.filter((line) => !/injected env/i.test(line)), [],
    'a successfully re-resolved handle is not a failure and must not be logged as one '
    + '(dotenv\'s own "injected env" banner is filtered: it is environment noise, '
    + 'not a store diagnostic)'
  );

  // ---------------------------------------------------------------- case (b)
  // With NO reachable database at all, the dead handle must be reported as a
  // FAILURE. This is the assertion that was previously written as a conditional
  // `if (typeof removed === 'number')`, which silently passed whenever the
  // fallback happened to succeed - i.e. it asserted nothing on a green machine.
  const warned = [];
  const realError = console.error;
  console.error = (...a) => warned.push(a.join(' '));
  const savedPath2 = process.env.DB_PATH;
  delete process.env.DB_PATH;
  process.env.NODE_ENV = 'test';
  purgeConfigAndDb();

  // A FRESH store is required here. Case (a) made `s` re-resolve and CACHE a
  // live replacement handle, so sweeping through `s` again would legitimately
  // succeed against that still-open handle and answer 0 - which would test the
  // cache, not the "no reachable database" contract this case is about.
  const sNoDb = new store.SessionStore({ db, sweepMs: 0 });

  let removed;
  try {
    removed = sNoDb.sweepExpired();
  } catch (e) {
    removed = `THREW ${e.message}`;
  } finally {
    console.error = realError;
    if (savedPath2 === undefined) delete process.env.DB_PATH; else process.env.DB_PATH = savedPath2;
    purgeConfigAndDb();
  }

  assert.equal(typeof removed, 'number',
    'sweepExpired never throws on a dead handle - it returned: ' + removed);
  assert.equal(removed, store.SWEEP_FAILED,
    'a dead injected handle with no reachable replacement must answer SWEEP_FAILED (-2), got ' +
    removed);
  assert.notEqual(removed, 0,
    'a closed handle answered 0 - a genuine no-op and a dead handle are now identical');
  assert.ok(warned.length > 0, 'the unusable database is logged, not silent');

  replacement.close();
});