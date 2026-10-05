// ============================================================================
// clinic-automation — SYNC-21 regression: a pre-migration database must BOOT
// (tests/db-migration.test.js)
//
// THE DEFECT THIS FILE EXISTS TO KILL
// -----------------------------------
// src/db/schema.sql is executed on every boot, before the migration steps that
// are supposed to bring an OLD database forward. It ends with
//
//     CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
//
// and `IF NOT EXISTS` guards the INDEX NAME, not the COLUMN it references. So on
// any database whose `appointments` table predates the `status` column:
//
//     SqliteError: no such column: status
//         at Database.exec (better-sqlite3/lib/methods/wrappers.js:9:14)
//         at ensureSchemaCurrent (src/db/db.js)
//         at Object.getDb (src/db/db.js)
//
// i.e. getDb() threw on EVERY boot. Worse, `exec()` autocommits per statement, so
// the tables declared above those indexes had already been created and
// `user_version` was still 0: the next boot re-ran everything against a
// half-migrated database. A clinic that had been live for a year could not start.
//
// WHAT THIS FILE ASSERTS, AND WHY EACH ONE MATTERS
//   1. it boots at all, and reaches SCHEMA_VERSION;
//   2. the columns the indexes reference now exist;
//   3. THE PRE-EXISTING ROW SURVIVES - the part that actually matters. A
//      "fix" that made boot succeed by recreating an empty table would pass a
//      columns-only test and destroy a real patient record, so the row's COUNT
//      and its slot_start are both asserted;
//   4. the appointments foreign key still ends up ON DELETE RESTRICT, proving
//      the upgrade still goes through the table rebuild (see the HAZARD note in
//      db.js: that rebuild is why the migration must NOT be wrapped in a
//      transaction, and this test is what catches a well-meaning "just make it
//      atomic" change that trades a boot crash for data loss);
//   5. a FRESH database still reaches the same end state from schema.sql alone;
//   6. re-running changes nothing (idempotence);
//   7. a FAILING step leaves user_version untouched and no stray scratch table,
//      and the next boot converges - the atomicity guarantee.
//
// Hermetic: every case builds a throwaway database under os.tmpdir() and boots a
// CHILD process, because the bug is an ordering/env/caching question that an
// in-process test would contaminate (db.js caches its handle; config.js caches
// the resolved env). data/clinic.db is never opened. Zero new dependencies.
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

const dbModule = require(path.join(ROOT, 'src', 'db', 'db.js'));
const SCHEMA_VERSION = dbModule.SCHEMA_VERSION;

const TMP_ROOT = path.join(os.tmpdir(), 'opencode', 'clinic-automation-tests');
fs.mkdirSync(TMP_ROOT, { recursive: true });

let counter = 0;
function nextDbPath() {
  counter += 1;
  return path.join(
    TMP_ROOT,
    `dbmig-${process.pid}-${Date.now().toString(36)}-${counter}-${Math.random().toString(36).slice(2, 8)}.db`
  );
}

const files = [];
function track(dbPath) {
  files.push(dbPath);
  return dbPath;
}

process.on('exit', () => {
  for (const f of files) {
    for (const suffix of ['', '-wal', '-shm', '-journal']) {
      try { fs.rmSync(f + suffix, { force: true }); } catch (_) { /* best effort */ }
    }
  }
});

const ADMIN_HASH = bcrypt.hashSync('LegacyBoot1!', 4);

/** Every table schema.sql declares. A fresh install must end up with exactly these. */
const EXPECTED_TABLES = [
  'appointments',
  'clients',
  'intake_responses',
  'messages',
  'receipts',
  'settings',
  'users',
];

/** Scratch tables the rebuilds use. One left behind means an interrupted rebuild. */
const SCRATCH_TABLES = ['appointments_migrate_new', 'receipts_migrate_new'];

const LEGACY_SLOT = '2026-08-01 09:00';
const LEGACY_PHONE = '919999900042';

/** Column names on `table`, via the documented PRAGMA. */
function columnsOf(db, table) {
  return db.pragma(`table_info(${table})`).map((c) => c.name);
}

/** Index names on `table`. */
function indexesOf(db, table) {
  return db.pragma(`index_list(${table})`).map((i) => i.name);
}

/**
 * A PRE-MIGRATION database, as an older build would have left it:
 *   * `appointments` with NO `status`, NO `service`, NO `updated_at`;
 *   * `appointments.client_id` still ON DELETE CASCADE (pre-002);
 *   * `users` with NO `role` (pre-003);
 *   * user_version 0, so every pending step is selected;
 *   * ONE REAL ROW, because "it boots" is worthless if the row is destroyed.
 * Every other table is left absent on purpose - db.js applies schema.sql, which
 * creates them, so their absence is exactly the upgrade situation.
 */
function legacyDb() {
  const dbPath = track(nextDbPath());
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE clients (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      name        TEXT NOT NULL,
      phone       TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE appointments (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
      slot_start  TEXT NOT NULL UNIQUE,
      slot_end    TEXT NOT NULL,
      created_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE users (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_appointments_slot_start ON appointments(slot_start);
    PRAGMA user_version = 0;
  `);
  const client = db
    .prepare('INSERT INTO clients (name, phone) VALUES (?, ?)')
    .run('Legacy Patient', LEGACY_PHONE);
  db.prepare('INSERT INTO appointments (client_id, slot_start, slot_end) VALUES (?, ?, ?)')
    .run(Number(client.lastInsertRowid), LEGACY_SLOT, '2026-08-01 09:30');
  db.prepare('INSERT INTO users (username, password_hash) VALUES (?, ?)')
    .run('legacyadmin', 'not-a-real-hash');
  db.close();
  return dbPath;
}

/**
 * Boot the real src/db/db.js in a child process with DB_PATH pointed at
 * `dbPath`, then report what the database looks like afterwards.
 *
 * `injectFailure` pushes a deliberately-throwing step onto the SAME MIGRATIONS
 * array runMigrations() reads (db.js exports the array itself, not a copy), which
 * is the only way to make a migration fail from outside the module.
 */
function bootAndInspect(dbPath, { injectFailure = false } = {}) {
  const script = `
    const out = (k, v) => console.log(k + '=' + JSON.stringify(v));
    const dbPath = process.env.DB_PATH;
    const rc = {
      errors: [], appointmentsColumns: null, appointmentsIndexes: null,
      appointmentsSql: null, tables: null, version: null,
      appointmentRows: null, legacyRow: null,
    };
    const dbModule = require(${JSON.stringify(path.join(ROOT, 'src', 'db', 'db.js'))});
    if (${JSON.stringify(injectFailure)}) {
      dbModule.MIGRATIONS.push({
        version: 999999,
        name: 'forced-failure-probe',
        up() { throw new Error('forced failure injected by tests/db-migration.test.js'); },
      });
    }
    try {
      const handle = dbModule.getDb();
      rc.appointmentsColumns = handle.pragma('table_info(appointments)').map((c) => c.name);
      rc.appointmentsIndexes = handle.pragma('index_list(appointments)').map((i) => i.name);
      rc.appointmentsSql = handle
        .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='appointments'").get().sql || '';
      rc.tables = handle
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all()
        .map((r) => r.name);
      rc.version = handle.pragma('user_version', { simple: true });
      rc.appointmentRows = handle.prepare('SELECT COUNT(*) AS n FROM appointments').get().n;
      const row = handle.prepare('SELECT slot_start, slot_end FROM appointments ORDER BY id').get();
      rc.legacyRow = row ? { slot_start: row.slot_start, slot_end: row.slot_end } : null;
    } catch (e) {
      rc.errors.push(e && e.message ? e.message : String(e));
    }
    for (const [k, v] of Object.entries(rc)) out(k, v);
  `;
  const res = spawnSync(process.execPath, ['-e', script], {
    encoding: 'utf8',
    timeout: 120_000,
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: dbPath,
      SESSION_SECRET: 'db-migration-test-secret-0123456789',
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
  return { report, stderr: String(res.stderr || ''), status: res.status };
}

/**
 * Read the ON-DISK state of `dbPath` through a fresh, independent connection.
 *
 * This is deliberately not the booting process's own handle: when a boot FAILS
 * that process never got a usable handle, and the question that matters is what
 * the NEXT boot will find. Asserting on the file is also what makes the
 * atomicity test meaningful - a version stamp that survives in memory but not on
 * disk would still be a bug.
 */
function inspectOnDisk(dbPath) {
  const db = new Database(dbPath, { readonly: true });
  try {
    return {
      version: db.pragma('user_version', { simple: true }),
      tables: db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
        .all()
        .map((r) => r.name),
      indexes: db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name")
        .all()
        .map((r) => r.name),
      appointmentRows: db.pragma('table_info(appointments)').length
        ? db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n
        : null,
      appointmentsColumns: db.pragma('table_info(appointments)').map((c) => c.name),
    };
  } finally {
    db.close();
  }
}

/** Strip sqlite's own bookkeeping from a table list. */
function applicationTables(tables) {
  return (tables || []).filter((t) => !t.startsWith('sqlite_'));
}

// ============================================================================
// 1. THE REGRESSION: a pre-migration database must boot
// ============================================================================

test('SYNC-21: a pre-`status` database boots instead of throwing "no such column"', () => {
  const dbPath = legacyDb();

  // Precondition, asserted: the fixture must really be pre-migration, or this
  // test would silently stop testing the upgrade path it was written for.
  const before = new Database(dbPath);
  assert.equal(columnsOf(before, 'appointments').includes('status'), false,
    'fixture precondition: the legacy appointments table must NOT have `status`');
  assert.equal(before.pragma('user_version', { simple: true }), 0,
    'fixture precondition: it must look like a database no step has run on');
  before.close();

  const { report, stderr } = bootAndInspect(dbPath);

  assert.deepEqual(report.errors, [],
    'booting a pre-migration database must not throw. This was a P0 boot crash '
    + 'loop. stderr:\n' + stderr);
  assert.ok(Array.isArray(report.appointmentsColumns), 'the child must report the columns');
  assert.equal(report.appointmentsColumns.includes('status'), true,
    'appointments.status was never added, so the two status indexes cannot exist. '
    + 'columns were: ' + JSON.stringify(report.appointmentsColumns));
  assert.equal(report.appointmentsColumns.includes('service'), true,
    'appointments.service was never added, so the foreign-key rebuild (which derives '
    + 'the replacement table from schema.sql) cannot copy into it. columns were: '
    + JSON.stringify(report.appointmentsColumns));
});

test('SYNC-21: the indexes schema.sql declares now actually get built', () => {
  // The symptom that motivated the "skip an index whose columns are missing"
  // workaround: a database that boots while silently running UNINDEXED. Both
  // status indexes must exist once the column they reference does.
  const dbPath = legacyDb();
  const { report, stderr } = bootAndInspect(dbPath);
  assert.deepEqual(report.errors, [], 'boot must succeed. stderr:\n' + stderr);
  for (const index of ['idx_appointments_status', 'idx_appointments_client_status']) {
    assert.ok(report.appointmentsIndexes.includes(index),
      index + ' was never created, so status lookups are a full table scan. '
      + 'indexes were: ' + JSON.stringify(report.appointmentsIndexes));
  }
});

test('SYNC-21: the PRE-EXISTING ROW survives - count and identity both', () => {
  // The assertion that matters most. Making boot succeed is easy; making it
  // succeed without destroying a booked appointment is the actual requirement.
  const dbPath = legacyDb();
  const { report, stderr } = bootAndInspect(dbPath);

  assert.deepEqual(report.errors, [], 'boot must succeed. stderr:\n' + stderr);
  assert.equal(report.appointmentRows, 1,
    'the legacy appointment was DESTROYED by the upgrade. The table rebuild drops '
    + 'and recreates `appointments`; if foreign_keys was ON at the DROP, '
    + 'ON DELETE CASCADE takes the rows with it.');
  assert.ok(report.legacyRow, 'the legacy appointment row is gone entirely');
  assert.equal(report.legacyRow.slot_start, LEGACY_SLOT,
    'the surviving row is not the one that was there before the upgrade');
  assert.equal(report.legacyRow.slot_end, '2026-08-01 09:30',
    'the surviving row lost its slot_end');
});

test('SYNC-21: the rebuild still ends at ON DELETE RESTRICT, not CASCADE', () => {
  // Also the guard on over-eager "atomicity" changes. db.js rebuilds
  // `appointments` with foreign_keys OFF because PRAGMA foreign_keys is a no-op
  // inside a transaction; wrapping the whole boot in one transaction would let
  // CASCADE fire and destroy exactly the row asserted above.
  const dbPath = legacyDb();
  const { report, stderr } = bootAndInspect(dbPath);

  assert.deepEqual(report.errors, [], 'boot must succeed. stderr:\n' + stderr);
  assert.ok(/ON\s+DELETE\s+RESTRICT/i.test(report.appointmentsSql || ''),
    'appointments.client_id must end up ON DELETE RESTRICT. The stored DDL was:\n'
    + report.appointmentsSql);
  assert.ok(!/ON\s+DELETE\s+CASCADE/i.test(report.appointmentsSql || ''),
    'appointments.client_id is still ON DELETE CASCADE - the rebuild did not run:\n'
    + report.appointmentsSql);
});

// ============================================================================
// 2. A fresh install must not depend on the upgrade path
// ============================================================================

test('a FRESH database reaches the full expected table set from schema.sql alone', () => {
  const dbPath = track(nextDbPath());
  const { report, stderr } = bootAndInspect(dbPath);

  assert.deepEqual(report.errors, [], 'a fresh install must boot cleanly. stderr:\n' + stderr);
  assert.deepEqual(applicationTables(report.tables).sort(), EXPECTED_TABLES,
    'schema.sql is the single source of truth for a fresh install; if a table only '
    + 'appeared because a migration created it, fresh and upgraded installs would '
    + 'have different schemas');
  assert.equal(report.version, SCHEMA_VERSION,
    'a fresh install must still be stamped with the current version');
  assert.ok(report.appointmentsIndexes.includes('idx_appointments_status'),
    'a fresh install must get the status index directly from schema.sql');
});

// ============================================================================
// 3. Idempotence - boot is a hot path and must be safe to repeat
// ============================================================================

test('the migration is idempotent - a second boot changes nothing', () => {
  const dbPath = legacyDb();
  const first = bootAndInspect(dbPath);
  assert.deepEqual(first.report.errors, [], 'first boot must succeed');

  const second = bootAndInspect(dbPath);
  assert.deepEqual(second.report.errors, [],
    'a second boot on the same (now upgraded) database must also succeed. '
    + 'stderr:\n' + second.stderr);
  assert.equal(second.report.version, SCHEMA_VERSION, 'the version must not drift');
  assert.equal(second.report.appointmentRows, 1,
    're-running must not duplicate the legacy appointment');
  assert.deepEqual(second.report.appointmentsColumns, first.report.appointmentsColumns,
    're-running must not add columns again');
});

// ============================================================================
// 4. Atomicity - a failure must not leave a half-migrated database
// ============================================================================

test('a FAILING step leaves user_version untouched and no stray scratch table', () => {
  // A migration that throws must leave the database exactly as re-runnable as it
  // found it: the version is written only after every step succeeded, so the next
  // boot retries instead of serving a half-migrated file. Asserted against the
  // FILE, through a separate connection, because that is what the next boot sees.
  const dbPath = legacyDb();
  const { report } = bootAndInspect(dbPath, { injectFailure: true });

  assert.ok(report.errors.some((e) => /forced failure injected/.test(e)),
    'the injected failure must actually surface. errors were: '
    + JSON.stringify(report.errors));

  const onDisk = inspectOnDisk(dbPath);
  assert.equal(onDisk.version, 0,
    'user_version must still be the value it had before the failed run, so the next '
    + 'boot retries the whole chain. On disk it was: ' + JSON.stringify(onDisk.version));
  assert.equal(onDisk.appointmentRows, 1,
    'the legacy appointment must survive a failed run - it is the same row the '
    + 'rebuild rebuilds around');
  for (const scratch of SCRATCH_TABLES) {
    assert.ok(!onDisk.tables.includes(scratch),
      'an interrupted rebuild left the scratch table `' + scratch + '` behind: '
      + JSON.stringify(onDisk.tables));
  }
});

test('after a failed step the next boot CONVERGES (the chain is re-runnable)', () => {
  // The other half of the atomicity guarantee. The rebuild cannot run inside a
  // transaction (db.js HAZARD), so its price is that it is not rolled back - which
  // is only acceptable if running it again is a no-op and reaches the same end
  // state. This asserts exactly that, rather than assuming it.
  const dbPath = legacyDb();
  const failed = bootAndInspect(dbPath, { injectFailure: true });
  assert.ok(failed.report.errors.some((e) => /forced failure injected/.test(e)),
    'precondition: the injected failure must surface');

  const retry = bootAndInspect(dbPath);
  assert.deepEqual(retry.report.errors, [],
    'the boot after a failure must succeed. stderr:\n' + retry.stderr);
  assert.equal(retry.report.version, SCHEMA_VERSION,
    'the retry must reach the current version');
  assert.equal(retry.report.appointmentRows, 1,
    'the legacy appointment must still be there after a failed run and a retry - '
    + 'this is the row a non-re-runnable rebuild would destroy');
  assert.deepEqual(applicationTables(retry.report.tables).sort(), EXPECTED_TABLES,
    'the retry must end at the same table set a clean upgrade produces');
  assert.ok(/ON\s+DELETE\s+RESTRICT/i.test(retry.report.appointmentsSql || ''),
    'the retry must still leave the foreign key RESTRICT');
});