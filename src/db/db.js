// ============================================================================
// clinic-automation — SQLite connection, schema apply + migrations (src/db/db.js)
// Purpose: open better-sqlite3 at DB_PATH, apply schema.sql, then bring an
//   EXISTING database up to the current schema. Consumed by db/repository.js,
//   which is the only module allowed to run SQL.
//
// Boot order inside getDb():
//   open -> foreign_keys=ON -> journal_mode=WAL -> ensureSchemaCurrent()
//        -> seedAdminUser()
// ensureSchemaCurrent() applies schema.sql and runs the pending migration
// steps ONCE PER OPENED HANDLE, so a handle returned by getDb() is always at
// the current schema version without re-reading the schema file on every call.
//
// --- HOW MIGRATIONS WORK, AND HOW TO ADD ONE --------------------------------
// PRAGMA user_version is the on-disk marker for "the newest migration that ran".
//   * A FRESH database is built entirely by db.exec(schema.sql), so it needs no
//     migration; runMigrations() finds every step already satisfied and only
//     stamps the version.
//   * An EXISTING database keeps its old shape, because schema.sql is all
//     CREATE … IF NOT EXISTS and SQLite has no `ALTER TABLE … ADD COLUMN IF NOT
//     EXISTS`. runMigrations() is what moves it forward: column by column for
//     new columns, and a full table rebuild when a CONSTRAINT itself changed
//     (SQLite cannot ALTER a foreign-key action).
// TO ADD A MIGRATION (the next free number is 003):
//   1. append an entry to MIGRATIONS:  { version: 3, name: '…', up(db, schema) }
//   2. bump SCHEMA_VERSION (the single place the version is declared) to 3
//   3. add the same statement to schema.sql, so a fresh install reaches the same
//      end state WITHOUT running the step (that is the point of schema.sql).
// Rules for a step: it must be idempotent (it re-runs on any database whose
//   version is behind), it must never destroy rows (count before and after and
//   throw on a mismatch), and it must not assume a column already exists.
// The version is written only AFTER every step succeeded, so a migration that
// throws is retried on the next boot instead of being silently marked done.
// ============================================================================
'use strict';

const fs = require('fs');
const path = require('path');

/**
 * The on-disk schema version this build expects. The ONLY place it is declared.
 * Version 1 = the schema.sql as originally shipped (fresh installs get it from
 * db.exec(schema.sql); no step exists because nothing needs upgrading).
 * Version 2 = migration 002, the step in MIGRATIONS below.
 */
const SCHEMA_VERSION = 4;

/**
 * Migration steps for databases that already exist, applied in ascending
 * `version` order and only when their version is below the stored user_version.
 */
/**
 * Columns that schema.sql's CREATE TABLE declares for `appointments` but that a
 * database created before they were declared will never receive from it.
 * They MUST exist before the foreign-key rebuild, because the rebuilt table is
 * derived from schema.sql and therefore expects every one of them (SYNC-21).
 */
const APPOINTMENT_COLUMNS = [
  ['status', "TEXT NOT NULL DEFAULT 'booked'"],
  ['service', "TEXT NOT NULL DEFAULT 'General consultation'"],
  // SQLite REFUSES `ALTER TABLE ... ADD COLUMN` with a non-constant default, so the
  // literal `(datetime('now'))` that schema.sql declares cannot be used here. The
  // column is added plain and stamped immediately afterwards by the backfill below.
  ['updated_at', 'TEXT'],
  // created_at is here for the SAME reason, and it MUST stay listed: the backfill
  // below writes to it, so if this entry is ever removed the UPDATE raises
  // "no such column: created_at" and the boot dies - which is exactly what
  // happened before it was added. Do not "tidy" it back out on the grounds that
  // schema.sql already declares it: schema.sql only reaches a FRESH database.
  // And do not copy schema.sql's `DEFAULT (datetime('now'))` in here to match the
  // schema - SQLite refuses a non-constant default in ALTER TABLE ... ADD COLUMN,
  // and the row is stamped by the backfill instead, same as updated_at.
  ['created_at', 'TEXT'],
];

function ensureAppointmentColumns(db) {
  for (const [column, definition] of APPOINTMENT_COLUMNS) {
    ensureColumn(db, 'appointments', column, definition);
  }
  // Give every pre-existing row the value schema.sql would have defaulted it to,
  // so the column is never observably NULL/empty to a reader.
  db.exec("UPDATE appointments SET updated_at = datetime('now') WHERE updated_at IS NULL OR updated_at = ''");
  db.exec("UPDATE appointments SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''");
}

/**
 * Columns migration 004 appends to `receipts`, declared once for the same reason
 * as APPOINTMENT_COLUMNS above.
 *
 * SYNC-21, second instance: `fixReceiptsForeignKey` rebuilds `receipts` from
 * schema.sql's CREATE TABLE, so the replacement table carries items_json,
 * file_path and created_at. A receipts table created before those were declared
 * never receives them (CREATE TABLE IF NOT EXISTS is a no-op on an existing
 * table), so copying into the rebuilt table failed with "no such column".
 * The same ordering rule therefore applies: ensure the columns BEFORE the
 * rebuild, not after it.
 *
 * `created_at` cannot use schema.sql's `DEFAULT (datetime('now'))` because SQLite
 * refuses a non-constant default in ALTER TABLE ... ADD COLUMN; it is added plain
 * and stamped by the backfill. `file_path` is NOT NULL with no default in
 * schema.sql, so it is added nullable and backfilled to '' rather than being
 * given a fake path - an empty value is visibly "unknown", whereas an invented
 * path would point an operator at a receipt that does not exist.
 */
const RECEIPT_COLUMNS = [
  ['items_json', "TEXT NOT NULL DEFAULT '[]'"],
  ['file_path', 'TEXT'],
  ['created_at', 'TEXT'],
];

function ensureReceiptColumns(db) {
  for (const [column, definition] of RECEIPT_COLUMNS) {
    ensureColumn(db, 'receipts', column, definition);
  }
  db.exec("UPDATE receipts SET created_at = datetime('now') WHERE created_at IS NULL OR created_at = ''");
  db.exec("UPDATE receipts SET file_path = '' WHERE file_path IS NULL");
  // items_json is NOT NULL in schema.sql, and the rebuild below copies it into a
  // NOT NULL column. If the column was ABSENT, ensureColumn added it with its
  // DEFAULT '[]' and SQLite filled every row - so only a table that already HAD a
  // nullable items_json can hold NULL here, and that is the case this line covers.
  // Without it the copy raises "NOT NULL constraint failed:
  // receipts_migrate_new.items_json" and the boot dies, which is the same omission
  // class as appointments.created_at. '[]' is not invented: it is exactly the
  // DEFAULT schema.sql declares, and a NULL items_json means "no items recorded".
  db.exec("UPDATE receipts SET items_json = '[]' WHERE items_json IS NULL");
}

const MIGRATIONS = [
  {
    version: 2,
    name: 'client-lifecycle-columns-and-appointments-fk-restrict',
    up(db, schema) {
      addClientLifecycleColumns(db);
      // BEFORE the rebuild: the replacement table is generated from schema.sql, so
      // it carries status/service/updated_at. Copying into it fails otherwise.
      ensureAppointmentColumns(db);
      fixAppointmentsForeignKey(db, schema);
    },
  },
  {
    version: 3,
    name: 'backfill-columns-that-schema-indexes-reference',
    up(db) {
      // SYNC-21 follow-up. These columns exist in schema.sql's CREATE TABLE, but a
      // database created BEFORE they were declared never receives them from it
      // (CREATE TABLE IF NOT EXISTS is a no-op on an existing table). They are
      // also referenced by idx_appointments_status and
      // idx_appointments_client_status, so without this step those indexes can
      // never be built on such a database and the app silently runs unindexed.
      // ensureColumn is idempotent, so this is a no-op on a current database.
      ensureColumn(db, 'appointments', 'status', "TEXT NOT NULL DEFAULT 'booked'");
      ensureColumn(db, 'appointments', 'service', "TEXT NOT NULL DEFAULT 'General consultation'");
      // `role` is written by the admin seed but was never in any CREATE TABLE
      // before, so an existing users table had no such column (SYNC-22).
      ensureColumn(db, 'users', 'role', "TEXT NOT NULL DEFAULT 'admin'");
    },
  },
  {
    version: 4,
    name: 'receipts-client-id-fk-restrict',
    up(db, schema) {
      // SYNC-RC1 / D4: closes the half-open case migration 002 left. A client
      // holding a RECEIPT but no appointment was still hard-deletable, and
      // receipts.client_id ON DELETE CASCADE took the invoice with them.
      // BEFORE the rebuild, for the same reason as appointments above: the
      // replacement table is generated from schema.sql, so it carries
      // items_json/file_path/created_at. Copying into it fails otherwise.
      ensureReceiptColumns(db);
      fixReceiptsForeignKey(db, schema);
    },
  },
];

/**
 * Columns migration 002 appends to `clients` (column -> column definition).
 * Declared once so ensureColumn() and the backfill below cannot drift apart.
 */
const CLIENT_LIFECYCLE_COLUMNS = [
  ['active', 'INTEGER NOT NULL DEFAULT 1'],
  ['deactivated_at', 'TEXT'],
  ['anonymized', 'INTEGER NOT NULL DEFAULT 0'],
];

// Name of the scratch table used while rebuilding `appointments`. Asserted
// against afterwards, so a stray leftover from an interrupted rebuild is loud.
const APPOINTMENTS_TEMP = 'appointments_migrate_new';

// Cached handle + a record of which handles are already at SCHEMA_VERSION, so
// the (very hot) second getDb() call is a WeakMap read instead of a re-migrate.
let db = null;
const migrated = new WeakMap();

// --- identifier / sql-text helpers -------------------------------------------

/** Quote an identifier for safe interpolation into DDL. */
function quoteIdent(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

/** Strip `--` line comments. Safe for schema.sql: no string literal in it
 *  contains `--`, so this cannot damage a value. */
function stripLineComments(sql) {
  return String(sql).split('\n').map((line) => line.replace(/--.*$/, '')).join('\n');
}

/** Split a .sql file into individual statements on `;`. */
function statementsOf(sql) {
  return stripLineComments(sql).split(';').map((s) => s.trim()).filter(Boolean);
}

/** The `CREATE INDEX` statements of a schema file (used to re-apply indexes
 *  after a table rebuild drops them with the old table). */
function indexStatementsOf(sql) {
  return statementsOf(sql).filter((s) => /^CREATE\s+(UNIQUE\s+)?INDEX\b/i.test(s));
}

/** The `CREATE TABLE` statements of a schema file (everything EXCEPT indexes).
 *  Splitting the file this way is what lets boot order the work correctly: a table
 *  must exist before an index can be added to it, and a COLUMN may still be added
 *  by a migration step after the table was created. Applying indexes in the same
 *  exec() as the tables is what crashed an upgrade (see applyIndexes). */
function tableStatementsOf(sql) {
  return statementsOf(sql).filter((s) => /^CREATE\s+TABLE\b/i.test(s));
}

/** The `CREATE TABLE` statement of a schema file for one table, or null. */
function createTableStatementOf(sql, table) {
  const re = new RegExp(
    '^CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?["\'`]?' + table + '["\'`]?\\s*\\(', 'i'
  );
  return statementsOf(sql).find((s) => re.test(s)) || null;
}

/** The table and columns an index statement targets, or null if unparseable. */
function indexTargetOf(ddl) {
  const m = /\bON\s+"?([A-Za-z_]\w*)"?\s*\(([^)]*)\)/i.exec(ddl || '');
  if (!m) return null;
  return {
    table: m[1],
    columns: m[2].split(',').map((c) => c.trim().replace(/^["'`]|["'`]$/g, '')).filter(Boolean),
  };
}

/**
 * Apply a schema file's CREATE INDEX statements, SKIPPING any whose table or
 * columns are not present yet.
 *
 * WHY THIS IS NEEDED (SYNC-21, P0 - boot used to crash-loop on upgrade):
 * `CREATE INDEX IF NOT EXISTS` guards the INDEX NAME, not the columns it
 * references. schema.sql declares
 *     CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
 * so on a database whose `appointments` table exists but predates the `status`
 * column, that statement throws "no such column: status". Because the schema
 * file was executed in one `exec()` BEFORE the migration steps ran, the column
 * that a migration is supposed to add had not been added yet, and getDb()
 * threw on every boot - a permanent crash loop that left a partially migrated
 * database (new tables created, user_version never advanced).
 *
 * Skipping an index that cannot be built is the safe direction: the next boot
 * retries it, and the alternative - a crash - is what took the clinic down.
 * A genuinely misspelled index in schema.sql surfaces in development because a
 * FRESH database has every column and therefore builds every index.
 *
 * @returns {number} how many indexes were applied
 */
function applyIndexes(handle, schema) {
  let applied = 0;
  for (const statement of indexStatementsOf(schema)) {
    const target = indexTargetOf(statement);
    if (target) {
      if (!tableExists(handle, target.table)) continue;
      const present = columnsOf(handle, target.table);
      if (target.columns.some((c) => !present.includes(c))) continue;
    }
    handle.exec(statement);
    applied += 1;
  }
  return applied;
}

// --- sqlite introspection ----------------------------------------------------

function tableExists(handle, table) {
  return !!handle
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
}

/** The stored CREATE TABLE text, or null when the table does not exist. */
function tableSql(handle, table) {
  const row = handle
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  return row ? row.sql || '' : null;
}

function columnsOf(handle, table) {
  return handle.pragma(`table_info(${quoteIdent(table)})`).map((c) => c.name);
}

// --- idempotent schema primitives --------------------------------------------

/**
 * Add a column if the table does not already have it. `ddl` may be either the
 * full `ALTER TABLE …` statement or just the column definition (the ALTER is
 * then composed for you). Returns true when the column was added.
 */
function ensureColumn(handle, table, column, ddl) {
  if (!tableExists(handle, table)) {
    throw new Error(
      `[db] cannot add column "${column}": table "${table}" does not exist. ` +
      'schema.sql must be applied before migrations run (getDb() does that).'
    );
  }
  if (columnsOf(handle, table).includes(column)) return false;
  const statement = /^\s*ALTER\b/i.test(ddl)
    ? ddl
    : `ALTER TABLE ${quoteIdent(table)} ADD COLUMN ${quoteIdent(column)} ${ddl}`;
  handle.exec(statement);
  return true;
}

/**
 * Create an index if it does not already exist. `ddl` is the full CREATE INDEX
 * statement. Returns true when the index was created.
 */
function ensureIndex(handle, name, ddl) {
  if (indexExists(handle, name, ddl)) return false;
  handle.exec(ddl);
  return true;
}

function indexExists(handle, name, ddl) {
  // PRAGMA index_list(<table>) is the documented way to enumerate an index, but
  // it needs the owning table, so take it from the DDL when one can be parsed and
  // fall back to sqlite_master otherwise.
  const owner = /\bON\s+"?([A-Za-z_]\w*)"?\s*\(/.exec(ddl || '');
  if (owner) {
    const listed = handle.pragma(`index_list(${quoteIdent(owner[1])})`) || [];
    if (listed.some((ix) => ix && ix.name === name)) return true;
  }
  return !!handle
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
    .get(name);
}

// --- migration 002 -----------------------------------------------------------

/** Append the client-lifecycle columns and backfill so no boolean reads NULL. */
function addClientLifecycleColumns(handle) {
  for (const [column, definition] of CLIENT_LIFECYCLE_COLUMNS) {
    ensureColumn(handle, 'clients', column, definition);
  }
  // Defensive backfill. `ALTER TABLE … ADD COLUMN … NOT NULL DEFAULT 1` already
  // fills existing rows, but a database that was hand-patched (or a column added
  // in a previous build without the default) could hold NULL, and every read
  // treats these as booleans. Cheap, and it makes the invariant explicit.
  handle.exec('UPDATE clients SET active = 1 WHERE active IS NULL');
  handle.exec('UPDATE clients SET anonymized = 0 WHERE anonymized IS NULL');
}

/**
 * Replace ON DELETE CASCADE on appointments.client_id with ON DELETE RESTRICT.
 * SQLite cannot ALTER a foreign-key action, so the documented procedure is to
 * build a new table, copy, drop, rename.
 *
 * HAZARD — this MUST NOT run inside a better-sqlite3 transaction. PRAGMA
 * foreign_keys is a no-op inside a transaction, so the OFF would silently not
 * apply, the DROP would cascade, and the checks below would throw AFTER the data
 * was already destroyed rather than preventing it.
 *
 * WHY foreign_keys must be OFF for the whole rebuild - and it is NOT about the
 * RENAME. The dangerous statement is `DROP TABLE appointments`. With
 * foreign_keys ON at that moment the DROP fires the inbound references:
 *   intake_responses.appointment_id ON DELETE CASCADE -> a patient's entire
 *     intake history is destroyed, and
 *   receipts.appointment_id        ON DELETE SET NULL -> every invoice loses its
 *     link to the visit it billed for.
 * MEASURED (SQLite 3.53.4) on a seeded table: foreign_keys=ON gives
 * intake_responses 1->0 and linked receipts 1->0; foreign_keys=OFF gives 1->1
 * and 1->1. The appointments table itself is restored by the rename either way,
 * which is exactly why a guard counting only appointments sees nothing wrong -
 * hence the intake/receipt counts in the post-rebuild check below.
 *
 * A widely-repeated myth says the RENAME also needs foreign_keys OFF, because
 * "SQLite rewrites REFERENCES clauses in other tables to follow the renamed
 * table". Measured here that does NOT happen: with foreign_keys=ON, with ON +
 * legacy_alter_table=ON, and with OFF, receipts/intake_responses still read
 * `REFERENCES appointments(id)`. The documented rewrite applies only to clauses
 * referring to the table BEING renamed, and nothing refers to the temp name.
 * Do not "restore" that rationale: it is wrong, and it would hide the reason
 * that actually matters. The no-temp-name assertion at the end is kept as a
 * cheap invariant check, not as protection against that rewrite.
 */
function fixAppointmentsForeignKey(handle, schema) {
  const current = tableSql(handle, 'appointments');
  if (current === null) {
    throw new Error(
      '[db] migration 002: table "appointments" does not exist, so its foreign key ' +
      'cannot be rebuilt. schema.sql must be applied before migrations run.'
    );
  }
    // Already correct (fresh install, or a previous run) -> nothing to do. A table
    // with NO foreign key at all is also "wrong" and gets rebuilt here, which is
    // strictly an improvement.
    if (/ON\s+DELETE\s+RESTRICT/i.test(current)) return false;

    // CRASH RECOVERY. This rebuild cannot run inside a transaction (see the HAZARD
    // note: `PRAGMA foreign_keys` is a no-op inside one), so an interrupted run can
    // leave the scratch table behind. The next boot would then fail its own
    // "already correct" check and die on "table appointments_migrate_new already
    // exists" - turning one bad boot into a permanent crash loop. The scratch table
    // is never referenced by anything, so discarding it is always safe; the real
    // `appointments` is untouched at this point.
    if (tableExists(handle, APPOINTMENTS_TEMP)) {
      handle.exec(`DROP TABLE ${quoteIdent(APPOINTMENTS_TEMP)}`);
    }


  const ddl = createTableStatementOf(schema, 'appointments');
  if (!ddl) {
    throw new Error(
      '[db] migration 002: schema.sql has no "CREATE TABLE … appointments" statement, ' +
      'so the rebuilt table cannot be derived from it.'
    );
  }
  // Derive the new table from schema.sql rather than duplicating the DDL here,
  // so a fresh install and a migrated one cannot drift apart.
  const tempDdl = ddl
    .replace(
      /(\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)["'`]?appointments["'`]?/i,
      `$1${quoteIdent(APPOINTMENTS_TEMP)}`
    )
    .replace(/ON\s+DELETE\s+CASCADE/gi, 'ON DELETE RESTRICT');
  if (/ON\s+DELETE\s+CASCADE/i.test(tempDdl) || !/ON\s+DELETE\s+RESTRICT/i.test(tempDdl)) {
    throw new Error(
      '[db] migration 002: could not rewrite appointments.client_id to ' +
      'ON DELETE RESTRICT — refusing to drop the existing table.'
    );
  }

  // Row counts of everything reachable FROM appointments. The rebuild drops the
  // appointments table and renames a copy back into place; if foreign_keys were
  // ON at that moment the DROP would fire
  //   intake_responses.appointment_id ON DELETE CASCADE  (history destroyed) and
  //   receipts.appointment_id        ON DELETE SET NULL  (invoice links lost).
  // Measured: FK ON -> intake 1->0, linked receipts 1->0; FK OFF -> 1->1 and 1->1.
  // Counting ONLY appointments - which is all the original guard did - cannot see
  // either loss, because appointments itself is restored by the rename. So these
  // three counts are captured before and compared after.
  const countAppointments = () =>
    handle.prepare('SELECT COUNT(*) AS n FROM appointments').get().n;
  const countIntake = () =>
    handle.prepare('SELECT COUNT(*) AS n FROM intake_responses').get().n;
  const countLinkedReceipts = () =>
    handle.prepare('SELECT COUNT(*) AS n FROM receipts WHERE appointment_id IS NOT NULL').get().n;

  const countBefore = countAppointments();
  const intakeBefore = countIntake();
  const linkedReceiptsBefore = countLinkedReceipts();
  const sourceColumns = columnsOf(handle, 'appointments');

  // See the HAZARD note above: no transaction, foreign_keys OFF throughout.
  handle.pragma('foreign_keys = OFF');
  try {
    handle.exec(tempDdl);
    const targetColumns = columnsOf(handle, APPOINTMENTS_TEMP);
    const unavailable = targetColumns.filter((c) => !sourceColumns.includes(c));
    if (unavailable.length) {
      // Never silently drop a column we cannot copy: that is data loss.
      throw new Error(
        `[db] migration 002: the rebuilt appointments table needs column(s) ` +
        `${unavailable.join(', ')} that the existing table does not have — ` +
        'add them before bumping SCHEMA_VERSION.'
      );
    }
    const list = targetColumns.map(quoteIdent).join(', ');
    handle.exec(
      `INSERT INTO ${quoteIdent(APPOINTMENTS_TEMP)} (${list}) SELECT ${list} FROM "appointments"`
    );
    const copied = handle
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(APPOINTMENTS_TEMP)}`)
      .get().n;
    if (copied !== countBefore) {
      throw new Error(
        `[db] migration 002: rebuilding appointments copied ${copied} of ` +
        `${countBefore} rows — aborting before the original table is dropped.`
      );
    }
    handle.exec('DROP TABLE "appointments"');
    handle.exec(
      `ALTER TABLE ${quoteIdent(APPOINTMENTS_TEMP)} RENAME TO "appointments"`
    );
  } finally {
    // Re-enable even on failure, and reset the cached handle so the next getDb()
    // retries instead of serving a half-migrated database.
    handle.pragma('foreign_keys = ON');
    migrated.delete(handle);
  }

  const countAfter = countAppointments();
  if (countAfter !== countBefore) {
    throw new Error(
      `[db] migration 002: appointments went from ${countBefore} to ${countAfter} rows ` +
      'during the foreign-key rebuild.'
    );
  }
  // The two that the DROP TABLE would silently destroy if foreign_keys were ON.
  // Failing loudly HERE is the whole point: by this line the damage is done, so
  // the message must name the table and both counts, because "intake_responses
  // went from 12 to 0" is the difference between a recoverable incident and
  // silent loss of a patient's medical history.
  const intakeAfter = countIntake();
  if (intakeAfter !== intakeBefore) {
    throw new Error(
      `[db] migration 002: intake_responses went from ${intakeBefore} to ` +
      `${intakeAfter} rows during the appointments rebuild. That means ` +
      'foreign_keys was ON when the old appointments table was dropped, so ' +
      'ON DELETE CASCADE fired. STOP - restore the database from backup.'
    );
  }
  const linkedReceiptsAfter = countLinkedReceipts();
  if (linkedReceiptsAfter !== linkedReceiptsBefore) {
    throw new Error(
      `[db] migration 002: receipts linked to an appointment went from ` +
      `${linkedReceiptsBefore} to ${linkedReceiptsAfter} during the appointments ` +
      'rebuild. That means foreign_keys was ON when the old appointments table ' +
      'was dropped, so ON DELETE SET NULL fired. STOP - restore from backup.'
    );
  }
  // The old table's indexes were dropped along with it; re-apply every index the
  // schema declares (IF NOT EXISTS makes the survivors no-ops).
  // Rebuilds every index the schema declares, but only the ones whose table and
  // columns exist (applyIndexes) - an older database can lack a column here too.
  applyIndexes(handle, schema);

  const dangling = handle
    .prepare("SELECT name FROM sqlite_master WHERE sql LIKE ? ESCAPE '\\'")
    .all('%' + APPOINTMENTS_TEMP + '%')
    .map((r) => r.name);
  if (dangling.length) {
    throw new Error(
      `[db] migration 002: the appointments rebuild left references to the temp ` +
      `table "${APPOINTMENTS_TEMP}" in: ${dangling.join(', ')} — data would be ` +
      'orphaned. Check PRAGMA foreign_keys handling before retrying.'
    );
  }
  return true;
}

/** Name of the scratch table used while rebuilding `receipts` (SYNC-RC1). */
const RECEIPTS_TEMP = 'receipts_migrate_new';

/**
 * Replace ON DELETE CASCADE on receipts.client_id with ON DELETE RESTRICT.
 *
 * WHY THIS EXISTS SEPARATELY: migration 002 only guarded appointments.client_id,
 * which left D4 half-closed. A client holding a RECEIPT but no appointment could
 * still be hard-deleted, and CASCADE took the invoice with them - the
 * appointments guard never fires because there is no appointment to restrict on.
 * REPRODUCED: receipts 1 -> 0 on `DELETE FROM clients`.
 *
 * Simpler and safer than the appointments rebuild because NOTHING references
 * `receipts`, so dropping it cannot cascade anywhere. foreign_keys is still
 * turned off for the copy, and the row count is still verified, because "simple"
 * is how silent data loss happens.
 */
function fixReceiptsForeignKey(handle, schema) {
  const current = tableSql(handle, 'receipts');
  if (current === null) {
    throw new Error(
      '[db] migration 004: table "receipts" does not exist, so its foreign key ' +
      'cannot be rebuilt. schema.sql must be applied before migrations run.'
    );
  }
  // Check the client_id clause SPECIFICALLY. receipts has two foreign keys
  // (appointment_id ON DELETE SET NULL, client_id ON DELETE CASCADE), so a naive
  // "does the table mention RESTRICT anywhere" test would be fooled by the first.
  const clientIdClause = current
    .split('\n')
    .find((line) => /client_id/.test(line) && /REFERENCES\s+"?clients"?/i.test(line));
  if (clientIdClause && /ON\s+DELETE\s+RESTRICT/i.test(clientIdClause)) return false;

  // Crash recovery: an interrupted run (this cannot run in a transaction) can
  // leave the scratch table behind, which would make every later boot die on
  // "table already exists". Nothing references it, so discarding is always safe.
  if (tableExists(handle, RECEIPTS_TEMP)) handle.exec(`DROP TABLE ${quoteIdent(RECEIPTS_TEMP)}`);

  const ddl = createTableStatementOf(schema, 'receipts');
  if (!ddl) {
    throw new Error(
      '[db] migration 004: schema.sql has no "CREATE TABLE ... receipts" statement, ' +
      'so the rebuilt table cannot be derived from it.'
    );
  }
  const tempDdl = ddl
    .replace(
      /(\bCREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?)["'`]?receipts["'`]?/i,
      `$1${quoteIdent(RECEIPTS_TEMP)}`
    )
    .replace(/ON\s+DELETE\s+CASCADE/gi, 'ON DELETE RESTRICT');
  if (!/ON\s+DELETE\s+RESTRICT/i.test(tempDdl)) {
    throw new Error(
      '[db] migration 004: could not rewrite receipts.client_id to ON DELETE ' +
      'RESTRICT - refusing to drop the existing table.'
    );
  }

  const countBefore = handle.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
  const sourceColumns = columnsOf(handle, 'receipts');

  handle.pragma('foreign_keys = OFF');
  try {
    handle.exec(tempDdl);
    const targetColumns = columnsOf(handle, RECEIPTS_TEMP);
    const unavailable = targetColumns.filter((c) => !sourceColumns.includes(c));
    if (unavailable.length) {
      throw new Error(
        `[db] migration 004: the rebuilt receipts table needs column(s) ` +
        `${unavailable.join(', ')} that the existing table does not have - ` +
        'add them before bumping SCHEMA_VERSION.'
      );
    }
    const list = targetColumns.map(quoteIdent).join(', ');
    handle.exec(
      `INSERT INTO ${quoteIdent(RECEIPTS_TEMP)} (${list}) ` +
      `SELECT ${list} FROM ${quoteIdent('receipts')}`
    );
    const copied = handle
      .prepare(`SELECT COUNT(*) AS n FROM ${quoteIdent(RECEIPTS_TEMP)}`)
      .get().n;
    if (copied !== countBefore) {
      throw new Error(
        `[db] migration 004: rebuilding receipts copied ${copied} of ` +
        `${countBefore} rows - aborting before the original table is dropped.`
      );
    }
    handle.exec(`DROP TABLE ${quoteIdent('receipts')}`);
    handle.exec(
      `ALTER TABLE ${quoteIdent(RECEIPTS_TEMP)} RENAME TO ${quoteIdent('receipts')}`
    );
  } finally {
    handle.pragma('foreign_keys = ON');
    migrated.delete(handle);
  }

  const countAfter = handle.prepare('SELECT COUNT(*) AS n FROM receipts').get().n;
  if (countAfter !== countBefore) {
    throw new Error(
      `[db] migration 004: receipts went from ${countBefore} to ${countAfter} ` +
      'rows during the foreign-key rebuild.'
    );
  }
  for (const statement of indexStatementsOf(schema)) handle.exec(statement);
  return true;
}

// --- migration runner --------------------------------------------------------

function readUserVersion(handle) {
  const value = handle.pragma('user_version', { simple: true });
  return Number(value) || 0;
}

/**
 * Run every MIGRATIONS entry newer than the stored user_version, then stamp the
 * version. Returns true when at least one step ran.
 */
function runMigrations(handle, getSchema) {
  const from = readUserVersion(handle);
  if (from > SCHEMA_VERSION) {
    // Do NOT write a lower version back: that would make the next boot re-run
    // steps the database has already outgrown.
    console.warn(
      `[db] database schema version ${from} is newer than this build ` +
      `(${SCHEMA_VERSION}); leaving it untouched. Run the newer build instead.`
    );
    return false;
  }
  const pending = MIGRATIONS.filter((m) => m.version > from);
  if (!pending.length) return false;
  for (const migration of pending) {
    migration.up(handle, getSchema());
  }
  // Only now: a step that throws leaves the old version, so it is retried, not
  // silently marked done.
  handle.pragma(`user_version = ${SCHEMA_VERSION}`);
  return true;
}

/**
 * Bring ONE handle up to the current schema: apply schema.sql, then run the
 * migration steps it still needs. Idempotent and memoised per handle, so the
 * hot path (a cached getDb() on every request that touches the database) costs
 * one WeakMap read instead of re-reading and re-executing the schema file.
 *
 * Why the memo matters: schema.sql is a ~8 KB file that is re-read and re-parsed
 * on a cold handle, and every statement in it is then either a no-op or already
 * satisfied — measured at
 * ~445us per call (disk read + parse + ~30 no-op DDL statements) before this
 * guard, versus ~0us after. That overhead is per getDb() call, not per process,
 * and getDb() is called by repository.js on essentially every query.
 *
 * The memo is keyed on handle IDENTITY, not on a module-level flag, so the
 * correctness guarantees are unchanged:
 *   * a handle opened by getDb() is applied exactly once, on open;
 *   * a handle injected with setDbForTests() has no entry, so it IS applied —
 *     which is how a legacy database is exercised;
 *   * closeDb() drops the entry, so a reopened file is applied again.
 * A handle can only be mutated by this module, so re-applying it later would
 * never find anything new to do.
 *
 * Returns true when THIS call did the work (i.e. the memo was cold), which is
 * the signal the caller uses to seed the admin user exactly once per handle —
 * seeding is a query, and it must not ride along on every cached call.
 */
function ensureSchemaCurrent(handle, getSchema) {
  if (migrated.get(handle) === SCHEMA_VERSION) return false;
  const schema = getSchema();
  // ORDER MATTERS (SYNC-21). Three phases, not one exec():
  //   1. tables  - idempotent (IF NOT EXISTS); gives a FRESH database its shape
  //               and an existing one any table declared since it was created.
  //   2. steps   - add COLUMNS and rebuild constraints on an EXISTING table,
  //               which no CREATE ... IF NOT EXISTS can ever do.
  //   3. indexes - only now, because an index needs its table AND all of its
  //               columns to exist. Applying them in step 1 made boot throw
  //               "no such column: status" on any database older than the
  //               status column, i.e. a crash loop on every clinic upgrade.
  // ATOMICITY, and exactly where it stops (SYNC-21, defect 3).
  //
  // A bare exec() autocommits per statement, so a failure part-way through a
  // phase used to leave a half-migrated file behind: the tables declared above
  // the failing index were already created, user_version was still the old
  // value, and the NEXT boot re-ran the whole chain on top of that debris. That
  // is the state that turned one bad schema file into a clinic that could not
  // start. SQLite rolls DDL back, so wrapping phases 1 and 3 makes each of them
  // all-or-nothing.
  handle.transaction(() => {
    handle.exec(tableStatementsOf(schema).join(';\n'));
  })();
  //
  // PHASE 2 IS NOT IN A TRANSACTION, AND MUST NEVER BE. PRAGMA foreign_keys is a
  // no-op inside one, so the `foreign_keys = OFF` that fixAppointmentsForeignKey
  // and fixReceiptsForeignKey depend on would silently not apply; the DROP TABLE
  // would then fire ON DELETE CASCADE and destroy the very rows just copied.
  // Wrapping this phase would trade a boot crash for data loss, which is worse.
  // That rebuild buys its safety the only other way available: it is idempotent,
  // it re-runs cleanly, and it verifies its own row counts before and after. The
  // version is stamped only once every step has succeeded, so a throw is retried
  // rather than silently marked done. tests/db-migration.test.js pins all of that
  // down, including that a failed run leaves the pre-existing row intact.
  runMigrations(handle, getSchema);
  handle.transaction(() => {
    applyIndexes(handle, schema);
  })();
  migrated.set(handle, SCHEMA_VERSION);
  return true;
}

// --- users accessors ---------------------------------------------------------
//
// S9.3.2 asks for `users` accessors here. The seed below is the only thing in
// this module that touches the users table, so these two are the whole surface
// db.js needs. They take an EXPLICIT handle (rather than calling getDb())
// because the seed runs while the handle is still being brought up — going
// back through getDb() from inside getDb() is how you get a re-entrant boot.
// Callers outside this module should use repository.js, which is the only layer
// allowed to run SQL; these are exported for the seed, for tests, and so a
// future bootstrap step does not have to hand-roll the same two statements.

/**
 * Look up one user row by username.
 * @returns {object|null} the row, or null when there is no such user
 */
function findUserByUsername(handle, username) {
  if (!tableExists(handle, 'users')) return null;
  return (
    handle.prepare('SELECT id, username, password_hash, role FROM users WHERE username = ?').get(username) ||
    null
  );
}

/**
 * Count the users in the database (null/0 when the table is absent).
 * Used by the seed's own tests and by an operator sanity check.
 */
function countUsers(handle) {
  if (!tableExists(handle, 'users')) return 0;
  return handle.prepare('SELECT COUNT(*) AS n FROM users').get().n;
}

/**
 * Insert a user. Throws on a duplicate username (users.username is UNIQUE) —
 * deliberately NOT swallowed: a silent no-op here means the operator cannot log
 * in and has no idea why.
 */
function insertUser(handle, { username, passwordHash, role }) {
  handle
    .prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
    .run(username, passwordHash, role || 'admin');
}

// --- admin bootstrap ---------------------------------------------------------

/**
 * Seed the default admin user if the username is absent. Returns true when it
 * inserted a row.
 *
 * This used to be wrapped in `catch (e) { /* ignore *\/ }`, which hid every
 * failure — including a bad ADMIN_PASSWORD_HASH and an unreadable users table —
 * behind "I simply cannot log in" with no clue as to why. Now only a genuinely
 * missing table is tolerated; anything else throws with the reason attached.
 */
function seedAdminUser(handle, cfg) {
  if (!tableExists(handle, 'users')) {
    return false; // older schema without a users table; nothing to bootstrap
  }
  // BOTH statements below must be inside the try. findUserByUsername selects
  // `role`, so on a users table that predates that column it raises
  // SQLITE_ERROR "no such column: role" — and if the guard sits outside the
  // try, that bare driver error escapes and the operator gets a SQLite
  // complaint instead of the admin credentials hint below.
  try {
    if (findUserByUsername(handle, cfg.adminUsername)) return false;
    insertUser(handle, {
      username: cfg.adminUsername,
      passwordHash: cfg.adminPasswordHash,
      role: 'admin',
    });
  } catch (e) {
    throw new Error(
      `[db] failed to seed the default admin user "${cfg.adminUsername}": ${e.message}. ` +
      'Check ADMIN_USERNAME and ADMIN_PASSWORD_HASH (see README "Environment").'
    );
  }
  return true;
}

// --- public API --------------------------------------------------------------

function resolveDbPath(dbPath) {
  // Resolve a relative DB_PATH against the project root (src/db -> root).
  return path.isAbsolute(dbPath) ? dbPath : path.join(__dirname, '..', '..', dbPath);
}

function readSchema() {
  return fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
}

function getDb() {
  const { getConfig } = require('../config');
  const cfg = getConfig();
  // Lazily required so merely requiring this file cannot open a database, and so
  // src/config.js (which validates the env) is read only on a real getDb() call.
  const getSchema = readSchema;

  if (!db) {
    const dbPath = resolveDbPath(cfg.dbPath);
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    const Database = require('better-sqlite3');
    db = new Database(dbPath);
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
  }

  // Migrate on boot. Applied once per OPENED handle (see ensureSchemaCurrent),
  // so a handle handed out by getDb() is always at the current schema version.
  const applied = ensureSchemaCurrent(db, getSchema);

  // SAY WHICH FILE WAS WRITTEN. Migrate-on-boot means ANY process that requires
  // this module without overriding DB_PATH silently MUTATES that database -
  // schema, and for an ad-hoc script, whatever rows it goes on to insert. A
  // one-line boot record is the cheapest guard against a test fixture landing
  // in real patient data unnoticed (it happened here), and it turns "who
  // changed my database" from archaeology into one grep of the logs.
  if (applied) {
    const main = (db.pragma('database_list') || []).find((r) => r && r.name === 'main');
    console.log(
      `[db] opened ${main ? main.file : '(unknown path)'}` +
        ` (schema v${readUserVersion(db)}/${SCHEMA_VERSION})`
    );
    if (!cfg.isProd && process.env.NODE_ENV !== 'test' && !process.env.DB_PATH) {
      console.warn(
        `[db] DB_PATH is unset in the environment, so the database location came ` +
        'from .env. Every write this process makes goes to that file.'
      );
    }
    // In test mode an unset DB_PATH used to fall through to .env and therefore to
    // the REAL ./data/clinic.db. Synthetic fixtures ("E2E Patient") then landed in
    // patient data, and a boot-time cron tick wrote rows there too. This happened
    // during M9 verification: data/clinic.db gained test clients, appointments and
    // messages, and `npm test` was silently mutating production state.
    //
    // So: fail CLOSED rather than guess. A test that means to touch the default
    // database has to say so out loud with DB_PATH; every real test already sets
    // it to a temp path before the first require, so this cannot fire spuriously.
    if (process.env.NODE_ENV === 'test' && !process.env.DB_PATH) {
      throw new Error(
        '[db] refusing to open the default database under NODE_ENV=test. '
        + 'Set DB_PATH to a throwaway file (tests/helpers.js freshDb() does this) '
        + 'BEFORE requiring this module — otherwise the suite writes to real patient data.'
      );
    }
  }

  // Seed only on the boot pass, as before this was explicit: the admin
  // user is configuration, not something that should be re-checked per query.
  if (applied) seedAdminUser(db, cfg);
  return db;
}

/** Close the cached handle and forget it, so a test can reopen. Returns true
 *  when there was something to close. */
function closeDb() {
  if (!db) return false;
  const handle = db;
  try {
    handle.close();
  } finally {
    // Reset even if close() threw, so the next getDb() opens a fresh handle
    // rather than handing back a closed one.
    db = null;
    migrated.delete(handle);
  }
  return true;
}

/** Install a handle to use instead of opening DB_PATH (test seam). Pass null to
 *  clear it. The handle is used AS GIVEN; getDb() will still apply schema.sql
 *  and run migrations on it, which is exactly how a legacy database is exercised. */
function setDbForTests(handle) {
  const previous = db;
  if (previous) migrated.delete(previous);
  db = handle || null;
  return db;
}

module.exports = {
  getDb,
  closeDb,
  setDbForTests,
  ensureColumn,
  ensureIndex,
  runMigrations,
  readUserVersion,
  // users accessors (S9.3.2) — see the section comment above. Explicit handle.
  findUserByUsername,
  countUsers,
  insertUser,
  SCHEMA_VERSION,
  MIGRATIONS,
};
