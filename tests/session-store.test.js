// ============================================================================
// clinic-automation — SQLite session store: handle rebinding (tests/session-store.test.js)
// Why this file exists: the store used to cache its better-sqlite3 handle
// FOREVER (`if (this._handle) return this._handle`). src/db/db.js exposes
// closeDb(), and any caller may close a handle directly, so the store ended up
// permanently bound to a dead connection. Every set/touch/destroy then failed
// with "The database connection is not open" - and because express-session calls
// touch() on EVERY request for a rolling cookie, the visible symptom was "the
// admin login is broken" while GET /api/health (which touches no session) kept
// passing.
//
// These tests live in tests/ (not an isolated __tests__ folder) ON PURPOSE: they
// must run under `npm test`, otherwise the regression can come back silently.
// See SYNC-23 for the same failure mode on a sibling module.
//
// Hermetic: its own temp SQLite file under os.tmpdir(), created before any
// db-coupled module is required. Zero new dependencies (node core only).
// Deps: node core + the module under test + src/db/db.js through its public API.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'src');
const TARGET = path.join(SRC, 'services', 'sessionStore.js');
const DB_PATH_TO = path.join(SRC, 'db', 'db.js');
const CONFIG_PATH_TO = path.join(SRC, 'config.js');

const TMP_ROOT = path.join(os.tmpdir(), 'opencode', 'clinic-automation-tests');
fs.mkdirSync(TMP_ROOT, { recursive: true });

let counter = 0;
function nextDbPath() {
  counter += 1;
  // Random component on purpose: a pid+counter name collides with a previous
  // run's leftover file when the OS reuses a pid, and this suite then fails with
  // UNIQUE(clients.phone)-style contamination. See the note in work-log.
  return path.join(
    TMP_ROOT,
    `sess-${process.pid}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}.db`
  );
}

// --- env must be set BEFORE anything db-coupled is required ------------------
process.env.NODE_ENV = 'test';
process.env.DB_PATH = nextDbPath();
process.env.SESSION_SECRET = 'session-store-test-secret-0123456789';
process.env.ADMIN_USERNAME = 'admin';
process.env.ADMIN_PASSWORD_HASH = '$2a$04$abcdefghijklmnopqrstuvABCDEFGHIJKLMNOPQRSTUVWXYZ012345';
// The sweep interval is unref'd, but keep it out of the way of these assertions.
process.env.WHATSAPP_MOCK_MODE = 'true';

const {
  createSessionStore,
  SessionStore,
  ensureSessionsTable,
  DEFAULT_TTL_MS,
} = require(TARGET);

const files = [];
process.on('exit', () => {
  for (const f of files) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.rmSync(f + suffix, { force: true }); } catch (_) { /* best effort */ }
    }
  }
});

/** The db.js module currently in the require cache — i.e. the one the store resolves. */
const dbm = () => require(DB_PATH_TO);

/**
 * A store on a brand-new database with no sweeper.
 *
 * Closing the handle AND dropping db.js + config.js from the require cache is
 * required, not decorative: db.js caches its handle and config.js caches the
 * resolved DB_PATH, so merely reassigning process.env.DB_PATH after the first
 * getDb() changes nothing and every test would share one file.
 */
function freshStore(options = {}) {
  try { dbm().closeDb(); } catch (_) { /* nothing open */ }
  delete require.cache[require.resolve(DB_PATH_TO)];
  delete require.cache[require.resolve(CONFIG_PATH_TO)];
  const dbPath = nextDbPath();
  files.push(dbPath);
  process.env.DB_PATH = dbPath;
  dbm().getDb();
  return new SessionStore(Object.assign({ sweepMs: 0 }, options));
}

/** Promisified store call that FAILS if the callback fires synchronously. */
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

/** Write a row that is already expired — _expiresAt() will not produce one. */
function insertExpired(sid) {
  ensureSessionsTable(dbm().getDb()); // the table is created lazily on first use
  dbm().getDb()
    .prepare('INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?)')
    .run(sid, Date.now() - 60_000, JSON.stringify({ admin: { u: 'expired' } }));
}
const countRows = (sid) =>
  dbm().getDb().prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ?').get(sid).n;

// ============================================================================
// THE REGRESSION
// ============================================================================

test('the store survives closeDb() between operations', async () => {
  const store = freshStore();

  await call(store, 'set', 'sid-a', SESSION());
  const before = dbm().getDb();
  assert.equal(dbm().closeDb(), true, 'closeDb() reported it closed something');
  assert.equal(before.open, false, 'the handle really is closed now');
  assert.notEqual(dbm().getDb(), before, 'db.js handed out a different handle');

  // upsert, select, update, count and delete all go through a rebuilt statement bag.
  await call(store, 'set', 'sid-b', SESSION());
  assert.equal((await call(store, 'get', 'sid-b')).admin.u, 'admin',
    'the row written AFTER the close is readable');
  await call(store, 'touch', 'sid-b', { cookie: { maxAge: 60_000 } });
  assert.equal(await call(store, 'length'), 2);
  assert.equal((await call(store, 'all')).length, 2);
  await call(store, 'destroy', 'sid-b');
  assert.equal(await call(store, 'get', 'sid-b'), null, 'destroy after close really deleted');
  await call(store, 'clear');
  assert.equal(await call(store, 'length'), 0);
});

test('repeated closeDb()/reopen cycles never poison the store', async () => {
  const store = freshStore();
  for (let i = 0; i < 5; i += 1) {
    dbm().closeDb();
    const sid = `cycle-${i}`;
    await call(store, 'set', sid, SESSION());
    await call(store, 'touch', sid, { cookie: { maxAge: 60_000 } });
    assert.equal((await call(store, 'get', sid)).admin.u, 'admin', `cycle ${i}: row survived`);
  }
  assert.equal(await call(store, 'length'), 5, 'one session per cycle, all still on disk');
});

test('a handle closed DIRECTLY (never via closeDb) is detected and re-resolved', async () => {
  // This is the harness path: tests/helpers.js closeActiveDb() calls
  // activeDb.close() itself, and purgeSrc() then drops every src/ module. The
  // store's last-known handle is now dead AND the module it would resolve is a
  // different instance of db.js.
  const store = freshStore();
  await call(store, 'set', 'direct-1', SESSION());

  const stale = dbm().getDb();
  stale.close();
  assert.equal(stale.open, false);
  delete require.cache[require.resolve(DB_PATH_TO)];
  delete require.cache[require.resolve(CONFIG_PATH_TO)];

  await call(store, 'set', 'direct-2', SESSION());
  assert.equal((await call(store, 'get', 'direct-2')).admin.u, 'admin');
  await call(store, 'touch', 'direct-2', { cookie: { maxAge: 60_000 } });
  await call(store, 'destroy', 'direct-2');
  assert.equal(await call(store, 'get', 'direct-2'), null);
});

test('a dead handle is never silently reused: the cause is named', async () => {
  const store = freshStore();
  await call(store, 'set', 'inj-1', SESSION());

  // Close db.js's OWN cached handle without telling db.js and without purging the
  // require cache, so getDb() now returns that same corpse. That is a db.js defect
  // rather than this store's, but the store must not disguise it as a schema
  // error - "no such table: sessions" sends an operator to the wrong file.
  const corpse = dbm().getDb();
  corpse.close();
  assert.equal(corpse.open, false);

  const err = await call(store, 'set', 'inj-2', SESSION()).then(() => null, (e) => e);
  assert.ok(err instanceof Error, 'reported through the callback, never thrown');
  assert.match(err.message, /handle that is not open/);
  assert.match(err.message, /closeDb/, 'names the API that would have done it right');
  assert.doesNotMatch(err.message, /no such table/);
});

test('the sessions table follows the handle it is actually writing to', async () => {
  const store = freshStore();
  await call(store, 'set', 'tbl-1', SESSION());

  // Force a handle swap with no table on it: the store must re-apply the DDL.
  dbm().closeDb();
  const reopened = dbm().getDb();
  reopened.exec('DROP TABLE IF EXISTS sessions');
  assert.equal(
    reopened.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all().length,
    0, 'precondition: the sessions table really is gone');

  await call(store, 'set', 'tbl-2', SESSION());
  assert.equal(
    dbm().getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").all().length,
    1, 'the store re-created sessions on the swapped-in handle');

  assert.equal(ensureSessionsTable(dbm().getDb()), dbm().getDb(),
    'ensureSessionsTable is idempotent and returns the handle');
});

test('ensureSessionsTable rejects a missing handle instead of throwing deep', () => {
  assert.throws(() => ensureSessionsTable(null), /needs a database handle/);
});

// ============================================================================
// CONTRACTS THAT MUST NOT REGRESS
// ============================================================================

test('no store method ever answers synchronously', async () => {
  const store = freshStore();
  // call() rejects if the callback fires before the method returns.
  await call(store, 'set', 'async-1', SESSION());
  await call(store, 'get', 'async-1');
  await call(store, 'touch', 'async-1', { cookie: { maxAge: 60_000 } });
  await call(store, 'length');
  await call(store, 'all');
  await call(store, 'destroy', 'async-1');
  await call(store, 'clear');
});

test('a failure is reported through the callback, never thrown', async () => {
  const broken = { open: true, prepare() { throw new Error('nope'); }, exec() {} };
  const s = new SessionStore({ db: broken, sweepMs: 0 });
  const err = await new Promise((res) => s.set('x', SESSION(), res));
  assert.ok(err instanceof Error);
  assert.match(err.message, /nope/);
});

test('a missing sid is an error, not a row keyed "undefined"', async () => {
  const store = freshStore();
  await assert.rejects(() => call(store, 'set', undefined, SESSION()), /without a session id/);
  assert.equal(await call(store, 'length'), 0, 'and nothing was written');
});

test('an expired row reads as absent and is deleted on the way out', async () => {
  const store = freshStore();
  insertExpired('exp-1');
  assert.equal(await call(store, 'get', 'exp-1'), null);
  assert.equal(countRows('exp-1'), 0, 'deleted, not merely hidden');
});

test('a live row survives a read untouched', async () => {
  const store = freshStore();
  await call(store, 'set', 'live-1', SESSION());
  assert.equal((await call(store, 'get', 'live-1')).admin.u, 'admin');
  assert.equal(countRows('live-1'), 1, 'a read must not delete a live row');
});

test('an undefined ARRAY element becomes null but keeps its position', async () => {
  // Guards the documented behaviour of stripUndefined(): holes are NOT spliced
  // out, because that would change the length and shift every later index.
  const store = freshStore();
  await call(store, 'set', 'arr-1', { cookie: { maxAge: 60_000 }, arr: [1, undefined, 3] });
  const read = await call(store, 'get', 'arr-1');
  assert.equal(read.arr.length, 3, 'length preserved');
  assert.equal(read.arr[0], 1);
  assert.equal(read.arr[1], null, 'JSON has no undefined; the hole reads back as null');
  assert.equal(read.arr[2], 3);
});

test('ttlHours is honoured — src/app.js passes ttlHours, not ttlMs', () => {
  assert.equal(new SessionStore({ ttlHours: 1 }).ttlMs, 3600 * 1000);
  assert.equal(new SessionStore({ ttlHours: 2, ttlMs: 500 }).ttlMs, 500, 'ttlMs wins');
  assert.equal(new SessionStore({}).ttlMs, DEFAULT_TTL_MS);
  assert.equal(new SessionStore({ ttlHours: 0 }).ttlMs, DEFAULT_TTL_MS, '0 is not a lifetime');
  assert.equal(new SessionStore({ ttlHours: -3 }).ttlMs, DEFAULT_TTL_MS);
  assert.equal(new SessionStore({ ttlHours: 'abc' }).ttlMs, DEFAULT_TTL_MS);
});

test('a cookie maxAge overrides the store TTL, and 0 falls back to it', async () => {
  const store = freshStore({ ttlMs: 60_000 });
  await call(store, 'set', 'm-1', { cookie: { maxAge: 5000 } });
  const first = dbm().getDb().prepare('SELECT expires_at FROM sessions WHERE sid=?').get('m-1');
  assert.ok(first.expires_at - Date.now() > 3000 && first.expires_at - Date.now() <= 5000,
    'cookie maxAge wins');

  await call(store, 'set', 'm-2', { cookie: { maxAge: 0 } });
  const second = dbm().getDb().prepare('SELECT expires_at FROM sessions WHERE sid=?').get('m-2');
  assert.ok(second.expires_at - Date.now() > 55_000, 'maxAge 0 means "until the browser closes", so the store TTL is used');
});

test('sweepExpired deletes expired rows on the current handle', async () => {
  const store = freshStore();
  insertExpired('sw-1');
  insertExpired('sw-2');
  await call(store, 'set', 'sw-live', SESSION());
  assert.equal(await call(store, 'length'), 1, 'expired rows are not live');
  assert.equal(store.sweepExpired(), 2);
  assert.equal(countRows('sw-live'), 1, 'the live row survived');
});

test('sweepExpired reports 0 and never throws when the database is unavailable', () => {
  assert.equal(new SessionStore({ db: { open: false }, sweepMs: 0 }).sweepExpired(), 0);
});

test('the sweeper is unref()d, so requiring this module never pins the process open', () => {
  // Without .unref() this interval is a live handle and `npm start` — and every
  // `npm test` run — hangs forever instead of exiting.
  const script = `
    require(${JSON.stringify(TARGET)});
    require(${JSON.stringify(TARGET)}).createSessionStore();
    process.stdout.write('armed');
  `;
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 10_000, encoding: 'utf8' });
  const elapsed = Date.now() - t0;
  assert.equal(r.status, 0, `child exited cleanly (status=${r.status}, err=${r.stderr})`);
  assert.equal(r.stdout, 'armed');
  assert.ok(elapsed < 8000, `child exited on its own in ${elapsed}ms (not held by a timer)`);
});

test('createSessionStore returns a started sweeper, not the interval', () => {
  const store = createSessionStore({ sweepMs: 60_000 });
  assert.ok(store instanceof SessionStore);
  assert.equal(typeof store.stopSweeper, 'function');
  store.stopSweeper();
});