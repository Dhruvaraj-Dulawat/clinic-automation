# Clinic Automation

Client-management automation for a small clinic / service business: public
booking + intake + status lookup, client DB + CSV import + admin dashboard,
no-double-book scheduling, WhatsApp Cloud API automation (confirm / remind /
follow-up / re-engage + two-way cancel-reschedule), PDF receipts, and
daily/weekly reporting. Single Node.js process, SQLite file DB, plain
HTML/CSS/JS frontend (zero build step — a non-developer can operate it).

## Quick setup

```bash
npm install
cp .env.example .env   # then fill real values (see below)
npm start              # boots on http://localhost:3000
```

Health check:

```bash
curl http://localhost:3000/api/health
# {"ok":true,"sessions":"sqlite"}
```

`/api/health` is unauthenticated and is what the container `HEALTHCHECK`
probes. `sessions` reports which store is live — see
[Sessions](#sessions-are-stored-in-sqlite-not-memory).

## Environment (.env)

Every key below is read by the code; the "read by" column names the module
that reads it, so a setting can always be traced. `src/config.js` validates
the ones that drive the booking grid and fails the boot with a message that
names the offending key (e.g. `[config] SLOT_DURATION_MIN must be a whole
number, got "abc"`).

### Server and session

| Key | Required | Default | Read by | What it does |
|-----|----------|---------|---------|--------------|
| `PORT` | no | `3000` | `config.js` | HTTP listen port |
| `DB_PATH` | no | `./data/clinic.db` | `config.js` | SQLite file — this file *is* the backup |
| `NODE_ENV` | no | unset | `config.js`, `app.js` | `production` turns on secure cookies, HSTS and the strict session-store policy |
| `SESSION_SECRET` | **yes** (≥32 chars) | — | `config.js` | Signs admin session cookies. Generate: `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"` |
| `SESSION_TTL_HOURS` | no | `12` | `config.js` (passed to the store by `app.js`) | Admin session lifetime. Drives **both** the cookie `maxAge` and the store's expiry sweep, so the two cannot drift apart |
| `TRUST_PROXY` | no | `0` | `config.js`, `rateLimit.js` | Set to `1` **only** when really behind a proxy you control (nginx/Caddy/Cloudflare). Makes Express trust `X-Forwarded-For`, which is what the per-IP rate limiter buckets on. Leave unset locally — trusting the header with no proxy lets a client spoof its IP and walk past the rate limits |

### Admin bootstrap account

| Key | Required | Default | Read by | What it does |
|-----|----------|---------|---------|--------------|
| `ADMIN_USERNAME` | no | `admin` | `config.js` | Bootstrap admin login name |
| `ADMIN_PASSWORD_HASH` | **yes** | — | `config.js` | bcrypt hash of the admin password. Generate: `node -e "console.log(require('bcryptjs').hashSync('your-password', 10))"` |
| `ADMIN_PASSWORD_PLAIN` | dev only | — | `services/auth.js` | A one-shot plaintext bootstrap login, honoured **only when `NODE_ENV !== 'production'`** and compared with `crypto.timingSafeEqual`. It logs a loud warning on every use. Set it only to get the very first login, then remove it |

### WhatsApp Cloud API (Meta)

| Key | Required | Default | Read by | What it does |
|-----|----------|---------|---------|--------------|
| `WHATSAPP_MOCK_MODE` | no | `true` | `config.js` | Keep `true` locally: messages are logged, never sent |
| `WHATSAPP_TOKEN` | for live sends | — | `config.js` | Meta Cloud API token (never commit) |
| `WHATSAPP_PHONE_NUMBER_ID` | for live sends | — | `config.js` | Meta phone-number ID |
| `WHATSAPP_API_VERSION` | no | `v21.0` | `config.js` | Graph API version segment |
| `WHATSAPP_VERIFY_TOKEN` | for webhook | — | `config.js` | Must match the token entered in the Meta dashboard webhook config |
| `OWNER_PHONE` | no | — | `config.js` | Staff phone (E.164) for booking alerts + weekly digest |
| `PUBLIC_FILE_BASE_URL` | for sending PDFs | — | `routes/receipts.js` | Public base URL the Meta Cloud API can fetch a receipt PDF from. Sending a receipt without it returns `400 PUBLIC_FILE_BASE_URL is not configured` |

### Clinic identity and scheduling

| Key | Required | Default | Read by | What it does |
|-----|----------|---------|---------|--------------|
| `CLINIC_NAME` | no | `Your Clinic Name` | `config.js` | Shown in messages and receipts |
| `CLINIC_HOURS_JSON` | no | Mon–Sat, 09:00–19:00, 30 min | `config.js` | The slot grid. Accepts a bare day list `[1,2,3,4,5,6]` or a full object `{"days":[1,2,3,4,5,6],"open":"09:00","close":"19:00","slotMinutes":30,"maxAdvanceDays":30}`. Days are `0`=Sunday … `6`=Saturday. **Only** those five object keys are read — a typo is rejected by name, not ignored |
| `SLOT_DURATION_MIN` | no | `30` | `config.js` | Minutes per slot |
| `SLOT_START_HOUR` / `SLOT_END_HOUR` | no | `9` / `19` | `config.js` | Opening/closing hour as integers (`24` is accepted for a midnight close) |
| `SLOT_OPEN` / `SLOT_CLOSE` / `SLOT_MINUTES` | no | — | `config.js` | Older aliases for the same two settings. `SLOT_*` above win when both are set |

`config.js` also rejects two mistakes that would otherwise produce a
well-formed object with **zero** bookable slots: a `close` that is not after
`open`, and a `slotMinutes` longer than the whole open window.

### Receipts and PDF fonts

| Key | Required | Default | Read by | What it does |
|-----|----------|---------|---------|--------------|
| `RECEIPTS_DIR` | no | `./data/receipts` | `services/pdf.js` | Where generated receipt PDFs are written |
| `PDF_FONT_PATH` | no | auto-detected | `services/pdf.js` | A Unicode `.ttf` to print amounts with the real **₹ (U+20B9)** glyph |
| `PDF_FONT_REGULAR` | no | — | `services/pdf.js` | Spare alias for the same thing; `PDF_FONT_PATH` wins |

> These three are read by `src/services/pdf.js` and are **not** listed in
> `.env.example` yet. They work without being set — the defaults are correct
> for a standard install — so they are documented here rather than as
> required entries.

**Why the font key exists.** pdfkit's built-in fonts are WinAnsi, which has no
U+20B9, so the rupee sign used to be silently dropped from every receipt. With
no Unicode font available the renderer now prints `Rs. 500` instead of
printing a wrong or missing glyph. Point `PDF_FONT_PATH` at any `.ttf` that
actually contains U+20B9 to get `₹500` on the PDF. `pdf.js` verifies the glyph
is present in the font you named and falls back to `Rs.` with a warning if it
is not, so a bad path degrades to a readable receipt rather than a corrupt one.

### Rate limits (per client IP, in-memory, per process)

Only the request ceiling is tunable; the windows are fixed policy.

| Key | Default | Read by | Applies to |
|-----|---------|---------|------------|
| `RATE_LIMIT_STRICT_MAX` | `10` per 10 min | `config.js` | Admin login and other sensitive mutations |
| `RATE_LIMIT_STANDARD_MAX` | `30` per min | `config.js` | Public reads and writes (booking, intake, status) |
| `RATE_LIMIT_RELAXED_MAX` | `300` per min | `config.js` | The inbound webhook, which Meta calls in bursts |

> The pre-M9 keys `RATE_LIMIT_PUBLIC_MAX`, `RATE_LIMIT_BOOKING_MAX` and
> `RATE_LIMIT_STATUS_MAX` are **not read by any code** — they were documented
> in an earlier revision of this file and never implemented. Use the three
> keys above.

### CSRF

| Key | Required | Default | Read by | What it does |
|-----|----------|---------|---------|--------------|
| `CSRF_ENFORCE` | no | enforced | `app.js` | CSRF is enforced **by default** and is not opt-in. Setting `CSRF_ENFORCE=false` prints a loud `SECURITY` warning on every boot. It exists only as a debugging escape hatch and must never be set in the production `env_file` |

## Tests

There is a real automated test suite — it boots the real Express app in-process
against a throwaway SQLite database, so it never touches `data/clinic.db`. It
uses **Node's built-in test runner** (`node --test`) and adds **zero
dependencies**.

```bash
npm test          # exact command: node -e "console.log(require('./package.json').scripts.test)"
npm run test:watch
npm run sanity    # quick check that all expected source files exist
npm run check     # node --check syntax sweep of the entry points
```

**Print the real glob rather than trusting this file.** The `test` script has
been re-pointed several times during development, so the authoritative answer is
whatever `package.json` says right now:

```bash
node -e "console.log(require('./package.json').scripts.test)"
```

Two layouts are collected: `tests/**/*.test.js` for the integration suites, and
`__tests__/*.test.js` for co-located unit suites under `src/` and `public/`. Put
a new test in one of those two shapes and it runs automatically.

**Confirm nothing is being skipped** — anything matched on disk but absent from
the script's globs is dead weight:

```bash
# every test file on disk …
find . -name '*.test.js' -not -path './node_modules/*'
# … and the ones the script actually names
node -e "console.log(require('./package.json').scripts.test)"
```

A file listed by the first command whose path matches none of the script's
patterns is **silently skipped** — no failure, no warning, just no coverage.
There is no separate command that picks them up, so move such a file into
`tests/` if it is meant to be a gate.

| File | What it locks down |
|------|--------------------|
| `tests/unit.test.js` | phone normalization, slot grid, no-double-book, intake validation, template rendering, CSV dedupe |
| `tests/api.test.js` | auth (401/200), availability, booking 201 → 409, intake 201/400, status privacy, CSV import, CRUD/export, reporting |
| `tests/webhook.test.js` | Meta verification handshake, CONFIRM/CANCEL/RESCHEDULE intents, quick-reply buttons, message logging |
| `tests/repository.test.js` | repository contracts and status/slot semantics |
| `tests/security.test.js` | security headers, rate limiting, admin-only routes, status-lookup verification |
| `tests/config.test.js` | env validation — every malformed clinic-hours/slot value must fail loudly and name its own key |
| `tests/csrf.test.js` | double-submit token issue/verify, and that exempt paths stay exempt |
| `tests/intake-authz.test.js` | D11 — a caller must prove ownership (phone + last 4) before writing intake answers |
| `tests/reports.test.js` | daily/weekly rollups and follow-up flags |
| `tests/datetime.test.js` | D9 — local-time query bounds: `todays()` is half-open on both edges, `findUpcoming` windows on the local clock, `findInactiveSince` does not cut on SQLite's UTC `datetime()` |
| `tests/jobs.test.js` | `loadSchedule()` merges `src/config/schedule.json` over the built-in defaults, keeps all four jobs, validates every cron expression, and warns loudly on a corrupt or missing file |
| `tests/reminders.test.js` | the reminder window sends each in-window appointment exactly once (D16 per-appointment marker, not a global watermark); a cancelled slot is never messaged and a failed send is retried |
| `tests/session-store.test.js` | the store survives `closeDb()` between operations, detects a handle closed behind its back, always writes to the table on the handle it actually holds, and never answers synchronously |

Co-located unit suites live in `__tests__/` directories next to the code they
cover (`src/middleware/__tests__/`, `src/services/__tests__/`,
`public/js/__tests__/`).

`tests/helpers.js` boots each test file in a hermetic environment: it blanks
the `SLOT_*`/clinic-hour keys so your `.env` cannot change test behaviour,
raises the rate limits, and points `DB_PATH` at a temp file that is deleted
afterwards. Because `node --test` runs every file in its own process, each file
also gets a fresh module registry, so setting `DB_PATH` before the first
`require` is enough to isolate the database with no reset hook.

### `NODE_ENV=test` demands an explicit `DB_PATH`

`src/config.js` **refuses to start** when `NODE_ENV=test` and `DB_PATH` is
unset:

```
[config] NODE_ENV=test requires an explicit DB_PATH (e.g. a temp file);
refusing to fall back to ./data/clinic.db so tests can never write the real
clinic database
```

This is deliberate. The default `./data/clinic.db` used to be picked up
silently by any harness that booted without setting `DB_PATH`, which is how test
fixtures once landed in the production database. If you write a script or a test
that runs under `NODE_ENV=test`, set `DB_PATH` explicitly first — that is now
the difference between a temp database and a loud failure.

> **Caveat — a suite outside `tests/` is NOT run by `npm test`.**
> The script is `node --test "tests/**/*.test.js"`, and that glob is **anchored at
> `tests/`**. A file under `src/**/__tests__/` or `public/**/__tests__/` does not
> match it, so such a suite is **silently skipped** — no failure, no warning, just
> no coverage.
>
> Check for yourself whether anything is being skipped:
>
> ```bash
> # every *.test.js in the repo …
> find . -name '*.test.js' -not -path './node_modules/*'
> # … minus the ones npm test actually collects
> find . -path './tests/*' -name '*.test.js'
> ```
>
> Anything listed by the first command and not the second is not being run. (Both
> lists change as suites are added, which is why this is a command rather than a
> count — a number printed here is wrong the moment someone lands a test.)
>
> Run the out-of-tree ones explicitly:
>
> ```bash
> node --test "src/**/__tests__/*.isolated.test.js" "public/**/__tests__/*.isolated.test.js"
> ```
>
> **A green `npm test` is therefore not a claim that every test in the repository
> passes.** Anything that must keep running belongs in `tests/` proper; a suite
> outside it is documentation, not a gate.

## Database schema and migrations

All SQL lives in `src/db/`. `src/db/schema.sql` is the declarative schema and
`src/db/db.js` owns the connection, schema apply and migrations.

### How the version is tracked

`src/db/db.js` keeps a single constant, `SCHEMA_VERSION`, and stores the
applied version on disk with SQLite's built-in `PRAGMA user_version`. There is
no migration table and no migration framework — the version *is* the marker.

On every open, `getDb()` does:

```
open -> PRAGMA foreign_keys=ON -> journal_mode=WAL
     -> ensureSchemaCurrent() -> seedAdminUser()
```

`ensureSchemaCurrent()`:

1. runs `schema.sql` through `db.exec()` — this is what gives an existing
   database a newly declared **table**;
2. calls `runMigrations()`, which reads `user_version`, runs every `MIGRATIONS`
   entry whose `version` is greater than it, and **only then** writes
   `user_version = SCHEMA_VERSION`.

> **Known limitation — read this before you rely on an upgrade path.** Step 1
> runs *before* step 2, and `CREATE … IF NOT EXISTS` guards the object **name**,
> not the columns it references. `schema.sql` declares
> `CREATE INDEX IF NOT EXISTS idx_appointments_status ON appointments(status)`,
> so on an older database whose `appointments` table predates the `status`
> column, that statement throws `no such column: status` — and it throws
> *before* the migration that would add the column ever gets to run. Such a
> database will not boot. Verified: a `user_version = 0` database with a
> legacy `appointments` table lacking `status` fails in `ensureSchemaCurrent()`
> with exactly that error.
>
> What this means in practice:
>
> - A **fresh** install is always fine — `schema.sql` creates the columns first,
>   so the indexes resolve.
> - A database that is already at the current `SCHEMA_VERSION` is fine — the
>   tables match what `schema.sql` declares.
> - A database genuinely mid-history (older than the newest column) needs the
>   missing column added before boot, not after. Back up `data/` first, and
>   prefer restoring from a known-good backup over editing the file in place.
>
> The fix belongs in `db.js`: `ensureColumn()` for every column any index
> depends on must run *before* `schema.sql` is executed, or `schema.sql` must
> stop declaring indexes over columns that may not exist yet.

Two consequences worth knowing:

- **A fresh database runs every step too, but each one short-circuits.** A new
  file starts at `user_version = 0`, so `pending` is *every* entry in
  `MIGRATIONS` — the filter is `version > stored`, not "is this needed". What
  makes that safe is that `schema.sql` has already created the tables and
  columns, so every step finds its work done: `ensureColumn()` returns `false`
  because the column is present, and the foreign-key rebuild returns early
  because `schema.sql` already declares `ON DELETE RESTRICT`. The end state is
  identical either way; a fresh install just pays for a few no-op lookups.
  This is exactly why the "be idempotent" rule below is not optional.
- **A failed migration is retried, never marked done.** The version is written
  only after every step returned, so a step that throws leaves the old version
  on disk and is retried on the next boot.
- If the stored version is **newer** than the running build's `SCHEMA_VERSION`,
  the database is left completely untouched and a warning is logged — the app
  will not "downgrade" a database by re-running steps it has outgrown.

The per-handle memo that skips the work on subsequent `getDb()` calls is keyed
on handle *identity*, so a handle injected by the test harness still gets
migrated (that is how a legacy database is exercised in tests), and reopening
a file re-applies it.

### Why migrations exist at all

SQLite has no `ALTER TABLE … ADD COLUMN IF NOT EXISTS`, and it cannot `ALTER`
a foreign-key action at all. So `schema.sql` alone can never bring an *existing*
database forward: new columns need a per-column check, and a changed
constraint needs a full table rebuild (create temp table → copy → drop → rename).
That is what the migration steps are for.

**Every migration must be additive and idempotent.** Additive means it only ever
adds: a new column, a new index, a new table. It must never drop or rewrite a
column that already holds data, because a clinic's appointment history is not
recoverable. Idempotent means running it twice is a no-op — which is what
`ensureColumn`'s `PRAGMA table_info` pre-check buys, since SQLite has no
`ADD COLUMN IF NOT EXISTS`. A migration that would destroy data needs a
different mechanism (export → transform → re-import), documented as such, not a
line in `MIGRATIONS`.

### How to add the next migration

`SCHEMA_VERSION` is the single source of truth for the current version — read it
from `src/db/db.js` rather than trusting any number copied here, because it moves
as the schema grows. Three edits, all in `src/db/db.js` plus the schema file,
using **005** as the worked example (002–004 are taken):

1. **Append an entry to `MIGRATIONS`:**

   ```js
   const MIGRATIONS = [
     { version: 2, name: '…', up(db, schema) { /* … */ } },
     { version: 3, name: '…', up(db, schema) { /* … */ } },
     { version: 4, name: '…', up(db, schema) { /* … */ } },
     { version: 5, name: 'add-client-timezone', up(db, schema) {
       ensureColumn(db, 'clients', 'timezone', 'TEXT');
     } },
   ];
   ```

   `ensureColumn(handle, table, column, ddl)` is exported from `src/db/db.js`:
   pass either a bare column definition (it composes the `ALTER TABLE` for you)
   or a full `ALTER TABLE …` statement. It returns `true` when it added the
   column and `false` when the column was already there.

2. **Bump `SCHEMA_VERSION`** by one. It is the only place the version is declared.

3. **Add the same statement to `src/db/schema.sql`**, so a *fresh* install
   reaches the identical end state without ever running the step. That is the
   whole point of keeping the two in step.

   **But do not add an index over the new column in the same commit.** Step 1 of
   `ensureSchemaCurrent()` execs `schema.sql` *before* the migration step runs,
   so a database that does not yet have the column fails on the index — see the
   [known limitation](#how-the-version-is-tracked) above, which is exactly how
   `idx_appointments_status ON appointments(status)` breaks an older database.
   Either create the index inside the migration's `up()` after
   `ensureColumn()`, or add it to `schema.sql` only once every supported
   database is guaranteed to have the column.

Rules for a step:

- **It must be idempotent.** It re-runs against any database whose version is
  behind, and re-runs after a crash mid-migration. Use the two exported
  helpers — `ensureColumn(handle, table, column, ddl)` and
  `ensureIndex(handle, name, ddl)` — rather than a bare `ALTER TABLE`. Both
  check for existence first and return `true` only if they changed something.
  (`tableExists()` also exists but is **module-private**, so a migration step
  cannot call it.)
- **It must never destroy rows.** Count before and after and throw on a
  mismatch — a rebuild that silently loses data is the worst outcome here.
- **It must not assume a column already exists.**
- **A table rebuild must run outside a transaction.** `PRAGMA foreign_keys` is
  a no-op inside one, so `DROP TABLE` would CASCADE-delete the rows you just
  copied and the count check would only fire *after* the data was already gone.
  Keep `foreign_keys` off across the `RENAME` too, and afterwards assert that
  no stored schema still mentions the temp table name.

## Local-time invariant (important)

`appointments.slot_start` is stored as a **local-naive** string,
`"YYYY-MM-DD HH:mm"` — the clinic's own wall clock, with **no** timezone
suffix and no UTC conversion. `schema.sql` and `src/services/datetime.js` are
the single source of this format.

Never compare `slot_start` against `new Date().toISOString()`. That produces
`"2026-10-03T00:00:00.000Z"`, which is both UTC and a different string shape,
and the comparison silently fails:

```js
'2026-10-03 09:00' >= '2026-10-03T00:00:00.000Z'   // false  ← same day, still "excluded"
```

The space (`0x20`) sorts before `T` (`0x54`), so **every same-day row is
dropped** from the range. That bug produced a wrong "Today" card on the admin
dashboard, a wrong 24-hour reminder window, and a WhatsApp `CANCEL` that could
still cancel a visit that had already happened.

Use `src/services/datetime.js` instead — it is the only module allowed to
format a datetime:

```js
const dt = require('../services/datetime');
dt.nowStr();                       // local 'YYYY-MM-DD HH:mm'  (minutes, no seconds)
dt.todayStr();                     // local 'YYYY-MM-DD'
dt.dayBounds(dateStr);             // { from, to } half-open, on the clinic's clock
dt.fmtSlot(dateStr, hour, minute); // the canonical slot_start formatter
```

Those cover day-to-day use. Anything else — e.g. a `slot_start` some minutes
ahead — is built from the same two helpers. This is the construction
`src/db/repository.js` itself uses:

```js
const dt = require('../services/datetime');
const n = new Date(Date.now() + 30 * 60000);           // +30 min
const slot = dt.fmtSlot(
  `${n.getFullYear()}-${dt.pad(n.getMonth() + 1)}-${dt.pad(n.getDate())}`,
  n.getHours(), n.getMinutes()
);                                                      // -> "YYYY-MM-DD HH:mm"
```

> Note there is **no** `dt.fmtDate` and **no** `dt.slotFromNow` — neither is
> exported. `repository.js` has its own module-local `slotFromInstant()` /
> `slotFromNow()`, which are deliberately not public. Use `dt.fmtSlot` +
> `dt.pad`, as above.

Bounds passed into SQL must be built the same way. `dayBounds()` is **half-open**
(`to` = next day `00:00`), which matches `slot_start >= ? AND slot_start < ?`
exactly — do not hand-write a `23:59:59` end bound.

### The server clock must be the clinic clock

`src/config/schedule.json` holds the cron expressions for the four background
jobs (`reminders`, `followups`, `reengagement`, `digest`). Cron runs in **server
local time**, so if the VPS is on UTC while the clinic is on IST, every job fires
at the wrong hour — reminders land 5½ hours early, the weekly digest goes out on
the wrong day.

```bash
timedatectl                 # confirm the host timezone
sudo timedatectl set-timezone Asia/Kolkata
```

This is the same invariant one level up: `slot_start` is local-naive, so local
time *is* the data model. Keep the host timezone on the clinic's timezone and the
whole system stays consistent.

## Status lookup requires phone **and** last 4

`GET /api/status?phone=+9198…&last4=3210` needs **both** the phone number and
the last 4 digits of that number. `last4` is compared with
`crypto.timingSafeEqual` (no early exit on the first wrong character).

The lookup is deliberately **anti-enumeration**: an unknown phone, a wrong
`last4`, a missing `last4`, a malformed `last4`, and a phone that normalises to
a bare `+` all return one **byte-identical** response. You cannot use the status
endpoint to discover which phone numbers are registered, and you cannot tell a
"wrong code" apart from "no such patient".

> **Note for the front-end:** this second factor is enforced in
> `src/routes/status.js`, so the public booking page's status form must ask for
> both fields. `tests/intake-authz.test.js` is the reference implementation of
> the same rule for intake writes.

## Client retention: deactivate and anonymize, never hard delete

**A client with history can never be hard-deleted.** *Both* foreign keys that
point at `clients` are `ON DELETE RESTRICT`:

```
appointments.client_id  INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT
receipts.client_id      INTEGER NOT NULL REFERENCES clients(id) ON DELETE RESTRICT
```

So a raw `DELETE FROM clients` fails at the database level with a
`SQLITE_CONSTRAINT_*` error for any client who has **either** an appointment or a
receipt, and their rows survive untouched. (SQLite implements `RESTRICT` through
an implicit trigger, so the reported code is `SQLITE_CONSTRAINT_TRIGGER`, not
`SQLITE_CONSTRAINT_FOREIGNKEY`.) On top of that, messages, intake answers and
reports must stay auditable, and a clinic's records cannot simply vanish on a
delete request.

The only rows still cascading away with a client are *derived* ones that carry no
independent audit value: `intake_responses` is `ON DELETE CASCADE` off
`appointments`, and `receipts.appointment_id` is `ON DELETE SET NULL`. Both are
downstream of the two `RESTRICT` edges above, so in practice neither can fire
while the client row survives.

This is exactly why the supported path is `DELETE /api/clients/:id` below — a
deactivate, never a raw `DELETE`.

The lifecycle is therefore:

| Action | Endpoint | Effect |
|--------|----------|--------|
| Deactivate | `DELETE /api/clients/:id` | Sets `active = 0` and stamps `deactivated_at`. The row **stays**. The client disappears from the active list but every appointment, receipt and message is untouched. Returns `{ "client": …, "deactivated": true }` |
| Restore | `POST /api/clients/:id/restore` | Sets `active = 1` again. Undoes a mistaken deactivation. Returns `{ "client": …, "restored": true }` |
| Anonymize | `POST /api/clients/:id/anonymize` | Scrubs name, phone, email, notes and tags for a data-erasure request but **keeps the row** (and sets `anonymized = 1`) so financial records stay auditable. Never touches appointments |

`GET /api/clients` keeps returning inactive rows, each carrying an `active`
flag, so the admin can still see and restore them.

**Deactivating a client with an upcoming visit returns `409`**, not a silent
failure:

```json
{
  "error": "client_has_upcoming_appointment",
  "message": "This client still has a booked appointment on 2026-10-05 09:00. Cancel or complete it first, or anonymize the client instead.",
  "appointment": { "id": 12, "slot_start": "2026-10-05 09:00", "status": "booked" }
}
```

Only a `booked` or `confirmed` appointment in the future blocks a
deactivation — a `completed` or `cancelled` one does not, so historical
clients can always be archived. Deactivating an already-inactive client is an
idempotent success, and the check runs *before* any write, so a refused
deactivation leaves the row untouched.

## Sessions are stored in SQLite, not memory

Admin sessions use `express-session` with a **SQLite-backed store**
(`src/services/sessionStore.js`), not the default `MemoryStore`. The default
store is unbounded (it leaks and never reclaims abandoned sessions) and it drops
every session on restart, which logs all staff out on each deploy.

- The `sessions` table is created by the store itself on first use — it is
  session data, not clinic data, so it is deliberately **not** in
  `schema.sql`. Creation is idempotent, so calling it on every boot is free.
- Every row carries an absolute expiry taken from `SESSION_TTL_HOURS`, and a
  sweep (every 15 min by default) deletes rows that are past it. Because the
  cookie `maxAge` and the sweep read the same `SESSION_TTL_HOURS`, they cannot
  drift apart.
- Sessions therefore live in the same `data/` directory as the clinic data —
  **so they are part of your backup** (see below).
- `GET /api/health` reports `sessions: "sqlite"`, or `"memory"` if the store
  could not be loaded. In production the app **refuses to boot** in that case
  rather than silently signing every user out on the next deploy; outside
  production it falls back to `MemoryStore` with a loud warning.

## CSV import format

Admin → Import tab, or `POST /api/import/csv` (admin session). Columns:

```csv
name,phone,email,tags,notes
Priya Sharma,+919876543210,priya@example.com,vip,Prefers mornings
```

- `phone` is the dedupe key (stored normalized: digits with leading `+`).
- Existing phones are **skipped** and reported (`imported / skipped / duplicates / errors`).
- Keep the header row exactly as above.

## WhatsApp setup (Meta Cloud API)

1. Create a Meta app → add WhatsApp → copy the **token** and **phone-number ID** into `.env`.
2. Set `WHATSAPP_MOCK_MODE=false` only when ready to send real messages.
3. Webhooks: point `GET/POST /webhook` at the public URL; the dashboard sends
   `hub.verify_token` + `hub.challenge` (verified in `src/routes/webhook.js`).
   Reply keywords: `CANCEL`, `CONFIRM`, `RESCHEDULE YYYY-MM-DD HH:mm`.
4. Every outbound send (real or mocked) is logged in the `messages` table.

### Webhook slot matching is local-time

The webhook matches inbound keywords against appointment slots, so it is bound
by the [local-time invariant](#local-time-invariant-important) above. It also
refuses to act on an appointment whose slot has already passed — a `CANCEL`
arriving late must not silently cancel a completed visit.

## Deploy (VPS with docker compose)

```bash
cp .env.example .env   # fill production values on the server
sudo chown -R 1000:1000 ./data   # see "running as non-root" below
docker compose up -d --build
docker compose logs -f app
```

The container image:

- runs as **`USER node`** (uid 1000), not root;
- installs with **`npm ci --omit=dev` only** — there is deliberately no
  `|| npm install` fallback, because that silently masks lockfile drift and can
  produce an image built from different versions than the committed lockfile. A
  broken lockfile must fail the build loudly;
- sets `NODE_ENV=production` and exposes port `3000`;
- has a `HEALTHCHECK` that GETs `/api/health` using `node` itself (the slim
  image ships neither `curl` nor `wget`).

### Running as non-root — the one manual step

The image drops to uid 1000, and `docker-compose.yml` **bind-mounts** the
host's `./data` over `/app/data`. A bind mount takes the **host's** ownership,
so if that directory is not writable by uid 1000 SQLite cannot create
`clinic.db` and the container will fail to start. On the VPS:

```bash
sudo chown -R 1000:1000 ./data
docker compose run --rm app id -u    # must print 1000
```

(Inside the image `/app/data` is already created and `chown`ed to `node`, so
this only matters for the bind-mounted host path.)

### What persists

`docker-compose.yml` mounts exactly one volume:

```yaml
volumes:
  - ./data:/app/data
```

So `./data` on the host — `clinic.db` **and** `data/receipts/*.pdf` — survives
`--build`, and rebuilding the image never deletes clinic data. There is no
`./logs` volume: the app logs to stdout/stderr, which `docker compose logs`
already captures, so **do not** look for a `logs/` directory. Use:

```bash
docker compose logs -f app        # live
docker compose logs --tail=200 app
```

## Backup and restore

Back up **one directory**: `./data`. It holds everything:

| Path | What it is | Why it matters |
|------|-----------|----------------|
| `data/clinic.db` | The SQLite database | Clients, appointments, messages, receipts, intake answers, settings |
| `data/clinic.db-wal`, `data/clinic.db-shm` | WAL sidecars | Present whenever the DB is in WAL mode (the default). **A `clinic.db` copied while the app is running is incomplete without them** |
| `data/receipts/*.pdf` | Generated PDFs | The customer-facing artefacts; not reproducible from the DB alone |

Sessions also live in `data/` (see
[Sessions](#sessions-are-stored-in-sqlite-not-memory)), so a restore signs
staff back in — that is the desired behaviour, not a leak.

**Recommended nightly backup** — copying all three consistently while the app
runs, without needing the app to stop:

```bash
mkdir -p data/backup        # VACUUM INTO will NOT create the directory itself
docker compose exec app node -e "
  const D=require('better-sqlite3'); const db=new D(process.env.DB_PATH||'/app/data/clinic.db');
  db.exec(\"VACUUM INTO '/app/data/backup/clinic.db'\"); db.close();
"
cp -a data/receipts data/backup/
```

`VACUUM INTO` writes a consistent snapshot online — no downtime, and the
`-wal`/`-shm` files are folded in, so the single output file is complete. (It
fails with "unable to open database file" if `data/backup/` is missing, which
is why the `mkdir -p` is part of the command.) Note the whole thing runs as uid
1000 inside the container, so `data/backup` must be writable by that uid —
`sudo chown -R 1000:1000 ./data` from the deploy step above covers it.

**Restore**

```bash
docker compose down
cp -a data/backup/clinic.db data/clinic.db
rm -f data/clinic.db-wal data/clinic.db-shm      # stale sidecars must NOT survive
cp -a data/backup/receipts/. data/receipts/
sudo chown -R 1000:1000 ./data
docker compose up -d
```

Deleting the stale `-wal`/`-shm` is essential: leaving a `-wal` from the
database you just replaced would replay it over your restored file.

Verify a restore with `docker compose exec app node -e "
const D=require('better-sqlite3');const db=new D(process.env.DB_PATH||'/app/data/clinic.db',{readonly:true});
console.log(db.pragma('integrity_check'), db.pragma('foreign_key_check'));"`
— you want `ok` and `[]`.

## Troubleshooting

| Symptom | Cause |
|---------|-------|
| Boots with `[config] Missing required env var …` | A required key is unset. The message names it |
| Boots with `[config] CLINIC_HOURS_JSON is invalid: …` | The value is neither a JSON object nor a bare `[1,2,…]` day list. The message shows a copy-pasteable example |
| Clinic shows as open on a day it should be closed | `CLINIC_HOURS_JSON` was a bare day list that got silently ignored before M9; it is now honoured. Remember `0`=Sunday |
| Calendar is empty but the clinic is open | `close` is not after `open`, or `slotMinutes` is longer than the whole window. `config.js` now rejects both at boot |
| Admin "Today" card or reminders look wrong | Something is comparing `slot_start` to a `toISOString()` string. Use `src/services/datetime.js` |
| Boot dies with `no such column: <name>` in `ensureSchemaCurrent()` | Your database is older than the newest column, and `schema.sql` declares an index over that column — it is exec'd *before* the migration that adds it. See [known limitation](#how-the-version-is-tracked). Back up `data/` first; a current-schema database and a fresh install both boot fine |
| Boot dies with `migration 00N: the rebuilt appointments table needs column(s) …` | Working as intended: the rebuild refused to drop a column it could not copy. Add the named columns before bumping `SCHEMA_VERSION`. Nothing was dropped |
| `SQLITE_CONSTRAINT` on deleting a client | Expected — a client with an appointment **or** a receipt cannot be hard-deleted (`ON DELETE RESTRICT` on both). Use `DELETE /api/clients/:id`, which deactivates instead |
| Container exits immediately, no permission errors in `docker logs` | `./data` is not writable by uid 1000. `sudo chown -R 1000:1000 ./data` |
| Amounts print as `Rs. 500` instead of `₹500` | No Unicode font resolved. Set `PDF_FONT_PATH` to a `.ttf` containing U+20B9 |
| Every admin mutation returns `403 csrf_token_missing` | The client is not sending the double-submit token. Fetch one from `GET /csrf` first |
| Rate limit trips for every request from one IP | `TRUST_PROXY` is unset behind a proxy (all clients look like one IP), or set when there is no proxy (clients can spoof `X-Forwarded-For`) |
