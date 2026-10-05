-- ============================================================================
-- clinic-automation — SQLite schema (src/db/schema.sql)
-- Applied on boot by src/db/db.js (migrate-on-boot: executes this file).
-- Phone numbers are stored NORMALIZED (E.164-ish digits, see csvImport.js);
--   clients.phone is UNIQUE so CSV import can dedupe on it.
-- NO-DOUBLE-BOOK: appointments.slot_start is UNIQUE. The repository books
--   inside a better-sqlite3 transaction (INSERT …; on UNIQUE violation the
--   whole transaction rolls back and the API returns 409). Never remove the
--   UNIQUE constraint — the transaction alone cannot prevent races without it.
--
-- DATETIME FORMAT (do not "fix" this): every *_at column and every slot is a
--   LOCAL-NAIVE 'YYYY-MM-DD HH:mm' string — the clinic's own wall clock, with no
--   timezone and no 'T'/'Z'. It is produced by services/datetime.js
--   (nowStr/fmtSlot) and compared with plain string comparison, which is only
--   correct because the format is fixed-width and zero-padded. NEVER compare a
--   slot_start with toISOString() output (that is UTC and carries a 'T'/'Z'):
--   doing so silently compares two different time bases and mis-selects every
--   row on the wrong day — the bug that datetime.dayBounds() now fixes.
--
-- THIS FILE ONLY DESCRIBES FRESH DATABASES. Every statement is
--   CREATE … IF NOT EXISTS, so on an EXISTING database this file is a no-op:
--   adding a column here does NOT add it to a clinic that was created last year.
--   Existing databases are brought forward by the migration step in
--   src/db/db.js (PRAGMA user_version + ensureColumn + a table rebuild for the
--   foreign-key change). So: change this file AND add a db.js migration, or a
--   fresh install and a live install end up with different schemas.
--
-- FOREIGN KEYS ARE ON DELETE RESTRICT, NEVER CASCADE (appointments.client_id).
--   The tables reachable from a client row are their medical record:
--   appointments, intake_responses (the intake questionnaire they filled in) and
--   receipts. With ON DELETE CASCADE a single `DELETE FROM clients WHERE id = ?`
--   destroys all of it with no undo, no archive and no way to prove what was
--   removed — unacceptable for patient records. RESTRICT makes the deletion fail
--   loudly instead, and deactivating a client (clients.active = 0) is the
--   supported way to stop serving someone while keeping their history.
--   DO NOT change this back to CASCADE.
-- ============================================================================

PRAGMA journal_mode = WAL;

-- --- Clients ---------------------------------------------------------------
CREATE TABLE IF NOT EXISTS clients (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  phone       TEXT NOT NULL UNIQUE,   -- normalized, dedupe key
  email       TEXT,
  tags        TEXT NOT NULL DEFAULT '',
  notes       TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  -- Client lifecycle (migration 002). Appended last so a fresh table and a
  -- migrated one end up with the same column order.
  active          INTEGER NOT NULL DEFAULT 1,   -- 1 = active, 0 = soft-deleted
  deactivated_at  TEXT,                         -- local 'YYYY-MM-DD HH:mm', NULL while active
  anonymized      INTEGER NOT NULL DEFAULT 0    -- 1 = PII replaced by a placeholder
);

-- --- Appointments ----------------------------------------------------------
CREATE TABLE IF NOT EXISTS appointments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  -- RESTRICT, not CASCADE: see the header. Deleting a client that has
  -- appointments must fail, not silently take the appointments with it.
  client_id   INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  slot_start  TEXT NOT NULL UNIQUE,   -- local-naive 'YYYY-MM-DD HH:mm'; UNIQUE = no double-book
  slot_end    TEXT NOT NULL,
  service     TEXT NOT NULL DEFAULT 'General consultation',
  status      TEXT NOT NULL DEFAULT 'booked'
              CHECK (status IN ('booked','confirmed','cancelled','completed','no_show')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --- Intake responses (one per appointment) --------------------------------
CREATE TABLE IF NOT EXISTS intake_responses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id  INTEGER NOT NULL UNIQUE REFERENCES appointments(id) ON DELETE CASCADE,
  answers_json    TEXT NOT NULL,      -- validated against intake-questions.json
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --- Message log (every outbound WhatsApp send logged win or fail) ---------
CREATE TABLE IF NOT EXISTS messages (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  to_phone      TEXT,
  from_phone    TEXT,
  direction     TEXT NOT NULL DEFAULT 'outbound' CHECK (direction IN ('inbound','outbound')),
  template      TEXT,                 -- template name or 'freeform'
  body          TEXT,
  status        TEXT NOT NULL DEFAULT 'queued',  -- queued|sent|failed|mocked|delivered
  wa_message_id TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --- Receipts / invoices ---------------------------------------------------
CREATE TABLE IF NOT EXISTS receipts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  appointment_id  INTEGER REFERENCES appointments(id) ON DELETE SET NULL,
  -- RESTRICT for the same reason as appointments.client_id: a receipt is a
  -- billing/medical record, and CASCADE here would let `DELETE FROM clients`
  -- erase invoices for a client who has no appointment row to restrict on.
  client_id       INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT,
  amount          REAL NOT NULL,
  items_json      TEXT NOT NULL DEFAULT '[]',
  file_path       TEXT NOT NULL,      -- under data/receipts/
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- --- Admin users -----------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,        -- bcrypt
  role          TEXT NOT NULL DEFAULT 'admin'
);

-- --- Key/value settings (onboarding flags, counters) -----------------------
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- --- Indexes ---------------------------------------------------------------
-- The queries below are the ones the app actually runs per request; without
-- these every one is a full table scan on a growing patient table.
CREATE INDEX IF NOT EXISTS idx_clients_phone ON clients(phone);
CREATE INDEX IF NOT EXISTS idx_appointments_slot_start ON appointments(slot_start);
CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status);
CREATE INDEX IF NOT EXISTS idx_appointments_client ON appointments(client_id);
-- The per-client timeline: "this patient's visits, newest first" (routes/status).
CREATE INDEX IF NOT EXISTS idx_appointments_client_status ON appointments(client_id, status);
CREATE INDEX IF NOT EXISTS idx_messages_to_phone ON messages(to_phone);
-- The follow-up / re-engagement jobs read the log by direction over a time
-- window; without this every job run scans every message ever sent.
CREATE INDEX IF NOT EXISTS idx_messages_direction_created ON messages(direction, created_at);
-- REDUNDANT BY DESIGN: appointment_id is already UNIQUE above, so SQLite
-- maintains an implicit index for it. Kept explicit because the repository
-- looks this column up directly and the plan should not depend on SQLite
-- deciding to emit an autoindex. Drop it if a write-throughput problem ever
-- actually shows up in EXPLAIN QUERY PLAN.
CREATE INDEX IF NOT EXISTS idx_intake_appointment ON intake_responses(appointment_id);
CREATE INDEX IF NOT EXISTS idx_receipts_client ON receipts(client_id);