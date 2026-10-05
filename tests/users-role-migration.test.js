// ============================================================================
// clinic-automation — SYNC-22 regression: the `users.role` upgrade path
// (tests/users-role-migration.test.js)
//
// THE DEFECT THIS FILE EXISTS TO KILL
// -----------------------------------
// src/db/schema.sql declares `role TEXT NOT NULL DEFAULT 'admin'` INSIDE
// `CREATE TABLE IF NOT EXISTS users`. On a database that already has a `users`
// table that statement is a NO-OP - SQLite has no `ALTER TABLE ... ADD COLUMN IF
// NOT EXISTS`, so schema.sql can never add the column to an existing table.
// ensureColumn() was wired for `clients` only, and MIGRATIONS had a single step
// (002, client lifecycle). NOTHING anywhere added `users.role`.
//
// The blast radius is the LOGIN PATH, not just the seed:
//   repository.js  users.identityFor()  -> `SELECT id, role FROM users ...`
//   auth.js:111    calls it immediately AFTER a successful password check.
// users.passwordHashFor() (`SELECT password_hash`) succeeds first, so on a
// pre-`role` database the password verifies, the identity lookup then throws
// "no such column: role", and EVERY admin login 500s while the error text
// blames the admin credentials instead of the schema.
//
// Fresh installs were always fine - schema.sql builds them correctly. This is
// purely an UPGRADE-PATH defect, which is why it can sit unnoticed until an
// operator upgrades an existing install.
//
// THE FIX: migration 003 adds the column via ensureColumn() (idempotent, and it
// runs inside ensureSchemaCurrent() which getDb() calls BEFORE seedAdminUser(),
// so the seed and the login both find the column).
//
// Hermetic: each case builds a throwaway database under os.tmpdir() and boots a
// CHILD process, because the bug is an ordering/env/caching question that an
// in-process test would contaminate (db.js caches its handle; config.js caches
// the resolved env). Zero new dependencies.
// ============================================================================
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const projectRequire = createRequire(path.join(ROOT, 'package.json'));
const Database = projectRequire('better-sqlite3');
const bcrypt = projectRequire('bcryptjs');

const TMP_ROOT = path.join(os.tmpdir(), 'opencode', 'clinic-automation-tests');
fs.mkdirSync(TMP_ROOT, { recursive: true });

let counter = 0;
function nextDbPath() {
  counter += 1;
  return path.join(
    TMP_ROOT,
    `usersrole-${process.pid}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}.db`
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

const ADMIN_PASSWORD = 'LegacyUpgrade1!';
const ADMIN_HASH = bcrypt.hashSync(ADMIN_PASSWORD, 4);

/** Column names on `table`, via the documented PRAGMA. */
function columnsOf(db, table) {
  return db.pragma(`table_info(${table})`).map((c) => c.name);
}

/**
 * A PRE-`role` database: the `users` table exactly as it shipped in v1, with
 * user_version already stamped to 2 so the boot believes migrations are current.
 * Every other table is left absent on purpose - db.js applies schema.sql, which
 * creates them, so their absence is exactly the upgrade situation.
 */
function legacyDb() {
  const dbPath = nextDbPath();
  files.push(dbPath);
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    PRAGMA user_version = 2;
  `);
  db.close();
  return dbPath;
}

/**
 * Boot the real src/db/db.js in a child process with DB_PATH pointed at
 * `dbPath`, then report what the schema looks like afterwards.
 */
function bootAndInspect(dbPath) {
  const script = `
    const out = (k, v) => console.log(k + '=' + JSON.stringify(v));
    const dbPath = process.env.DB_PATH;
    const rc = { errors: [], columns: null, identity: null, users: null, version: null, schemaVersion: null };
    try {
      const db = require(${JSON.stringify(path.join(ROOT, 'src', 'db', 'db.js'))});
      const handle = db.getDb();
      rc.schemaVersion = db.SCHEMA_VERSION;
      rc.columns = handle.pragma('table_info(users)').map((c) => c.name);
      rc.version = handle.pragma('user_version', { simple: true });
      const repo = require(${JSON.stringify(path.join(ROOT, 'src', 'db', 'repository.js'))});
      try { rc.identity = repo.users.identityFor('admin'); }
      catch (e) { rc.errors.push('identityFor: ' + e.message); }
      try { rc.users = repo.users.count ? repo.users.count() : handle
        .prepare('SELECT COUNT(*) AS n FROM users').get().n; }
      catch (e) { rc.errors.push('count: ' + e.message); }
    } catch (e) {
      rc.errors.push('getDb: ' + e.message);
    }
    for (const [k, v] of Object.entries(rc)) out(k, v);
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: dbPath,
      SESSION_SECRET: 'users-role-test-secret-0123456789ab',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD_HASH: ADMIN_HASH,
      ADMIN_PASSWORD_PLAIN: '',
      WHATSAPP_MOCK_MODE: 'true',
    },
  });
  const report = {};
  for (const line of String(res.stdout || '').split(/\r?\n/)) {
    const m = /^(\w+)=([\s\S]*)$/.exec(line);
    if (m) { try { report[m[1]] = JSON.parse(m[2]); } catch (_) { report[m[1]] = m[2]; } }
  }
  return {
    report,
    schemaVersion: report.schemaVersion,
    stderr: String(res.stderr || ''),
    status: res.status,
  };
}

// ============================================================================
// THE REGRESSION
// ============================================================================

test('SYNC-22: a pre-`role` database gains users.role on boot (self-heals)', () => {
  const dbPath = legacyDb();

  // Precondition, asserted: the fixture must really lack the column, or this
  // test would silently stop testing the upgrade path it was written for.
  const before = new Database(dbPath);
  assert.equal(columnsOf(before, 'users').includes('role'), false,
    'fixture precondition: the legacy database must NOT have users.role');
  assert.equal(before.pragma('user_version', { simple: true }), 2,
    'fixture precondition: it must look like a current v2 database');
  before.close();

  const { report, stderr } = bootAndInspect(dbPath);

  assert.deepEqual(report.errors, [],
    'booting a pre-role database must not throw. stderr:\n' + stderr);
  assert.ok(Array.isArray(report.columns), 'the child must report the users columns');
  assert.equal(report.columns.includes('role'), true,
    'users.role was never added, so every admin login on this database 500s. '
    + 'columns were: ' + JSON.stringify(report.columns));
});

test('SYNC-22: the admin is seeded and identityFor() works after the upgrade', () => {
  // The login path proper: auth.js calls identityFor() right after the password
  // check, so this is the call that turned a valid password into a 500.
  const dbPath = legacyDb();
  const { report, stderr } = bootAndInspect(dbPath);

  assert.deepEqual(report.errors, [], 'no error expected. stderr:\n' + stderr);
  assert.ok(report.identity, 'identityFor("admin") returned nothing - the admin was never seeded');

  // This used to read
  //     assert.equal(report.identity.username === undefined ? true : true, true);
  // which is a tautology: `x === undefined ? true : true` is `true` for EVERY x,
  // so the assertion could never fail and verified nothing. It was also aimed at
  // the wrong field - identityFor() projects `id, role` and NOT `username`
  // (repository.js:721), so even a correct check on `username` was meaningless.
  // These are the real contract: the seed wrote a row, and it carries the role
  // that auth.js:111 copies into the session.
  assert.deepEqual(Object.keys(report.identity).sort(), ['id', 'role'],
    'identityFor() must project exactly the two non-secret session fields');
  assert.equal(report.identity.role, 'admin',
    'the seeded admin must carry role "admin" - this is the value auth.js reads');
  assert.equal(report.users, 1, 'exactly one admin user must exist after the upgrade');
});

test('SYNC-22: the upgraded column is stamped with the schema version', () => {
  // The version is written only AFTER every step succeeded, so a current stamp on
  // a database that started at v2 is the proof the migration is recorded, not
  // merely applied by luck.
  const dbPath = legacyDb();
  const { report, schemaVersion } = bootAndInspect(dbPath);
  // SCHEMA_VERSION is read from the CHILD, not from a `require()` here. This line
  // used to do `require(path.join(ROOT, 'src', 'db', 'db.js'))` in the test
  // process, which is a latent escape from this file's hermeticity: db.js caches
  // its handle, so if ANY later code in this process reached getDb() it would open
  // and MIGRATE THE REAL ./data/clinic.db (config.js:316 resolves the unset
  // DB_PATH against the repo root). It survives today only because nothing in
  // this file calls getDb() - the same "green by accident" shape as the defect
  // this suite exists to catch. The child already loads db.js, so it can report
  // the constant directly and this process never has to.
  assert.equal(typeof schemaVersion, 'number',
    'the child must report SCHEMA_VERSION from the db.js it actually booted');
  assert.equal(report.version, schemaVersion,
    'user_version must be stamped to SCHEMA_VERSION once the upgrade completes');
});

test('a FRESH database still reaches the same end state without the migration', () => {
  // schema.sql is the point of a fresh install: it must build the same shape on
  // its own. If migration 003 were the only thing adding `role`, a fresh install
  // would depend on the upgrade path - which is the opposite of the design.
  const dbPath = nextDbPath();
  files.push(dbPath);
  const { report, stderr } = bootAndInspect(dbPath);
  assert.deepEqual(report.errors, [], 'a fresh install must boot cleanly. stderr:\n' + stderr);
  assert.equal(report.columns.includes('role'), true,
    'a fresh install must get users.role from schema.sql');
  assert.equal(report.users, 1, 'the admin must be seeded on a fresh install');
});

test('the migration is idempotent - a second boot changes nothing', () => {
  const dbPath = legacyDb();
  const first = bootAndInspect(dbPath);
  assert.deepEqual(first.report.errors, [], 'first boot must succeed');
  const second = bootAndInspect(dbPath);
  assert.deepEqual(second.report.errors, [],
    'a second boot on the same (now upgraded) database must also succeed');
  assert.equal(second.report.columns.includes('role'), true);
  assert.equal(second.report.users, 1, 're-running must not duplicate the admin row');
});
