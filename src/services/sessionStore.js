// ============================================================================
// clinic-automation — SQLite-backed express-session store (src/services/sessionStore.js)
// Purpose: replace express-session's default MemoryStore, which (a) grows without
//   any bound in the Node process and (b) loses every session on restart, so a
//   deploy logs all staff out and abandoned sessions are never reclaimed.
// Deps: express-session's Store base class + the better-sqlite3 handle from
//   src/db/db.js. Installed as `store:` in the session() options in src/app.js.
// Deps: see .env.example — none; TTL is configured here, not through the env.
//
// --- WHY THIS FILE IS EXEMPT FROM THE "zero SQL outside src/db" GATE (SYNC-6) ---
// The purity rule exists so that CLINICAL data access has exactly one interface
// to swap for Postgres. This file is not clinical data access: it is a driver
// for a third-party interface. express-session's Store contract is literally
// get(sid, cb) / set(sid, session, cb) / destroy / touch, and the only way to
// implement that contract on SQLite is to write those four statements
// somewhere. Relocating them behind src/db/ would not remove the SQL, it would
// only give it a different filename, while dragging session-lifetime policy
// (TTL, sweeping, the unref()'d timer) into the clinical data layer where it
// does not belong. A session store legitimately IS a caller of the driver; the
// repository's own header scopes that rule to clinic tables. So: exempt by
// name, with every statement confined to _prepare() so the Postgres swap point
// stays a single function.
//
// --- WHY THIS IS A SEPARATE MODULE, AND WHY THE BASE CLASS MATTERS ------------
// express-session builds its middleware and, *during construction*, calls
// `store.on('connect')` and `store.on('disconnect')` (express-session 1.19.0
// index.js). A plain object with get/set/destroy therefore throws
// "store.on is not a function" before the server serves a single request. That
// is exactly why MemoryStore does `util.inherits(MemoryStore, Store)` — so this
// class must inherit from Store too, not merely duck-type it.
//
// --- THE ASYNC CALLBACK RULE (the classic bug in this file) -------------------
// EVERY callback here fires from setImmediate, never synchronously. The store
// methods are called from inside express-session's own request flow; answering
// synchronously re-enters express-session while its per-request state is still
// mid-update and deadlocks it. Each callback is additionally wrapped in `once`
// so a throw inside the consumer cannot turn into a second (err, value) call.
//
// --- WHY THE DB HANDLE IS RESOLVED LAZILY -------------------------------------
// getDb() calls getConfig(), which THROWS unless SESSION_SECRET and
// ADMIN_PASSWORD_HASH are present (see src/config.js). Requiring this file at
// module load would therefore crash anything that requires it before the env is
// set up, so '../db/db' is required inside a function on first real use, and a
// failure to open is reported through the callback instead of thrown.
//
// --- WHY THE HANDLE IS RE-VALIDATED, NOT CACHED FOREVER ----------------------
// This store outlives individual database connections. src/db/db.js hands out a
// singleton handle but also exposes closeDb(), and any caller may close a handle
// directly; when that happens getDb() returns a DIFFERENT object next time. A
// store that froze its handle on first use would be permanently bound to a dead
// connection, and every set/touch/destroy would fail — express-session touches
// the session on EVERY request for a rolling cookie, so the visible symptom is
// "the admin login is broken" while /api/health (which touches no session) keeps
// passing. _db() therefore re-resolves the current handle on every use and only
// reuses the last known one while it is still open. The per-handle statement
// cache is a WeakMap keyed by handle identity, so a swapped handle automatically
// gets fresh statements and the dead handle's statements are collectable.
// ============================================================================
'use strict';

const { Store } = require('express-session');

// A session cookie with no maxAge would otherwise live forever in the table
// (nobody can sweep a row that has no expiry). 12h matches the cookie maxAge
// configured in src/app.js.
const DEFAULT_TTL_MS = 12 * 60 * 60 * 1000;

// How often expired rows are deleted. Rows are also deleted lazily on read
// (see get()), so this only bounds the table size — a session is never handed
// out because the sweep has not run yet.
const DEFAULT_SWEEP_MS = 15 * 60 * 1000;

// --- sweepExpired() result sentinels (SYNC-9) ---------------------------------
// sweepExpired() returns a COUNT of deleted rows, which is always >= 0, so 0
// must mean exactly one thing: "the sweep ran and nothing was expired". Two
// failure-ish outcomes therefore need values that cannot be mistaken for a
// count, so both are NEGATIVE and distinct from each other and from 0:
//
//   SCHEMA_REPAIRED (-1) - the `sessions` table did not exist; _db() created it,
//                          so there was provably nothing to sweep. NOT an error.
//   SWEEP_FAILED     (-2) - the database could not be reached at all, so the
//                          sweep did not run. This is the case that used to
//                          answer 0, which was indistinguishable from "swept,
//                          nothing was expired" and made a dead sweep silent.
//
// A caller can therefore tell all three apart without magic numbers:
//   n >= 0  -> really swept, n rows expired
//   -1      -> schema repaired, nothing to sweep
//   -2      -> sweep did not run
//
// Both sentinels are EXPORTED so a caller never has to hard-code a magic number.
const SCHEMA_REPAIRED = -1;
const SWEEP_FAILED = -2;

// The sessions table. Created here rather than in src/db/schema.sql on purpose:
// it is session data, not clinic data, and adding a second CREATE TABLE to the
// clinical schema would make the two databases' shapes interdependent.
// ensureSessionsTable() is idempotent, so calling it on every boot is free.
const SESSIONS_TABLE_SQL =
  'CREATE TABLE IF NOT EXISTS sessions (' +
  'sid TEXT PRIMARY KEY, ' +
  'expires_at INTEGER NOT NULL, ' +
  'data TEXT NOT NULL)';
const SESSIONS_INDEX_SQL =
  'CREATE INDEX IF NOT EXISTS idx_sessions_expires ON sessions(expires_at)';

/**
 * Every key a complete statement bag must have. Used to re-validate the
 * per-handle cache in SessionStore#_prepare — see the note there. Kept as data
 * so adding a statement cannot be forgotten here: a name that is prepared but
 * absent from this list would never be completeness-checked.
 */
const STATEMENT_NAMES = Object.freeze([
  'stmtGet',
  'stmtUpsert',
  'stmtDel',
  'stmtTouch',
  'stmtLive',
  'stmtSweep',
  'stmtAll',
  'stmtClear',
]);

/**
 * Create the sessions table and its expiry index if they are missing.
 *
 * Takes the handle as an argument (rather than opening one) so it is testable
 * and so the lazy-require contract above stays in one place. Returns the handle.
 */
/**
 * Does this handle already have a `sessions` table?
 *
 * Used only to decide whether sweepExpired() should report SCHEMA_REPAIRED, so
 * the failure mode matters more than the answer: if the probe itself throws
 * (a test double with no usable prepare(), an adapter that is not SQLite) we
 * answer `true`, i.e. "do not claim to have repaired anything". Claiming a repair
 * that did not happen would be worse than staying quiet.
 */
function sessionsTableExists(db) {
  try {
    return !!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='sessions'").get();
  } catch (_) {
    return true;
  }
}

function ensureSessionsTable(db) {
  if (!db) throw new Error('[sessionStore] ensureSessionsTable() needs a database handle');
  // Sampled BEFORE the DDL, and recomputed on EVERY call rather than latched.
  // Latching it is the more natural optimisation and it is wrong: the very next
  // sweep on the same handle would keep answering SCHEMA_REPAIRED forever and
  // expired sessions would silently stop being reclaimed. Recomputing costs one
  // indexed sqlite_master lookup, which is why sessionsTableExists() exists at all.
  const created = !sessionsTableExists(db);
  db.exec(SESSIONS_TABLE_SQL);
  db.exec(SESSIONS_INDEX_SQL);
  db.__sessionsTableCreated = created;
  return db;
}

/** No-op used when a caller passes no callback, so we never throw on undefined. */
function noop() {}

/**
 * Wrap a callback so it can only ever fire once. body() below runs inside a
 * try/catch that reports failures through the same callback; without this, a
 * consumer that throws would be called twice (once with the throw's error, once
 * with the real result).
 */
function once(fn) {
  let called = false;
  return function guarded(...args) {
    if (called) return undefined;
    called = true;
    return (typeof fn === 'function' ? fn : noop).apply(this, args);
  };
}

/**
 * Recursively strip `undefined` OBJECT properties, in place, before serializing.
 *
 * Why this exists at all: JSON.stringify already drops undefined object
 * properties at any depth, so for objects it changes nothing. It is kept because
 * it is what guarantees we never hand a session object to stringify while it still
 * carries `undefined` values that a DIFFERENT serializer (or a future switch away
 * from JSON) might treat differently.
 *
 * ARRAYS ARE A DIFFERENT STORY, and this comment used to get it wrong. It claimed
 * that stripping "keeps the round-trip exact". Measured, that is false:
 *
 *     [1, undefined, 3]  ->  stored and read back as  [1, null, 3]   (length 3)
 *
 * The array branch below deliberately does NOT splice the hole out, because
 * JSON.stringify renders an undefined element as `null` no matter what, and
 * splicing would change the array's LENGTH — turning "a value that became null"
 * into "a value that silently disappeared", which is strictly worse for a session
 * payload (positional data would shift under every later index). JSON has no
 * `undefined`, so an array hole cannot survive a round-trip; preserving length is
 * the best available behaviour, and it is asserted by the test suite.
 *
 * The WeakSet makes a cyclic object terminate here instead of at JSON.stringify;
 * that value is handed to stringify anyway, which reports it as the error it is.
 */
function stripUndefined(value, seen) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) {
      if (value[i] !== undefined) value[i] = stripUndefined(value[i], seen);
    }
    return value;
  }
  for (const key of Object.keys(value)) {
    if (value[key] === undefined) delete value[key];
    else value[key] = stripUndefined(value[key], seen);
  }
  return value;
}

// Serialization failures are reported through the store callback every time they
// happen, but logging on every request would flood the console, so the warning
// is emitted once per process. resetSerializationWarning() exists for tests.
let warnedOnSerialization = false;

/** Serialize a session. Returns the string, or throws (the caller reports it). */
function serialize(session) {
  return JSON.stringify(stripUndefined(session, new WeakSet()));
}

/** Parse a stored session. Throws on malformed JSON; the caller reports it. */
function parse(data) {
  const value = JSON.parse(data);
  return value && typeof value === 'object' ? value : null;
}

/**
 * An express-session Store backed by the `sessions` table.
 *
 * Not exported as the default way to build one — use createSessionStore().
 * It is exported so tests can construct a store against a throwaway handle.
 */
class SessionStore extends Store {
  /**
   * @param {object} [options]
   * @param {object} [options.db]       handle to use instead of opening DB_PATH
   * @param {number} [options.ttlMs]    fallback lifetime when a session has no
   *                                    usable cookie.maxAge (default 12h)
   * @param {number} [options.ttlHours] the same lifetime in HOURS. Accepted
   *                                    because src/app.js passes it (it reads
   *                                    SESSION_TTL_HOURS from config.js); the
   *                                    finer `ttlMs` wins if both are given.
   * @param {number} [options.sweepMs]  expired-row sweep interval; 0 disables it
   */
  constructor(options = {}) {
    super();
    // Two spellings of the lifetime are accepted on purpose. `ttlMs` is this
    // module's documented option; `ttlHours` is what src/app.js:118 actually
    // passes. Honouring only `ttlMs` left SESSION_TTL_HOURS silently inert --
    // every store fell back to the 12h default, so an operator who shortened it
    // (SESSION_TTL_HOURS=1) still got 12h with no warning anywhere. A config key
    // that parses, validates and is then ignored is worse than a missing one.
    const ttlHours = Number.isFinite(options.ttlHours) && options.ttlHours > 0
      ? options.ttlHours * 60 * 60 * 1000
      : 0;
    const ttlMs = Number.isFinite(options.ttlMs) && options.ttlMs > 0
      ? options.ttlMs
      : ttlHours;
    this.ttlMs = ttlMs || DEFAULT_TTL_MS;
    this.sweepMs = Number.isFinite(options.sweepMs) && options.sweepMs >= 0
      ? options.sweepMs
      : DEFAULT_SWEEP_MS;
    this._handle = options.db || null;
    // The handle whose schema ensureSessionsTable() has already run for, and
    // whether that run had to CREATE the table. Read by sweepExpired() to answer
    // SCHEMA_REPAIRED instead of a misleading 0.
    this._ensured = null;
    this._schemaRepaired = false;
    // Prepared statements cached per handle, so the hot path is not re-preparing
    // SQL on every request, and switching DB_PATH invalidates the cache for free
    // (the old handle is only referenced by the WeakMap).
    this._stmts = new WeakMap();
    this._sweeper = null;
  }

  // --- internals -------------------------------------------------------------

  /**
   * Whether `handle` already carries the `sessions` table.
   *
   * Asked BEFORE ensureSessionsTable() runs, so sweepExpired() can tell "the
   * table was missing and I just created it" (SCHEMA_REPAIRED) from "the table
   * was there and nothing had expired" (0).
   *
   * A handle that cannot answer - a test double, or an adapter whose prepare()
   * throws - is reported as HAVING the table. Assuming "already present" is the
   * safe direction: it can only suppress the SCHEMA_REPAIRED report, whereas
   * assuming "missing" would have a real database claim a repair that never
   * happened.
   */
  _hasSessionsTable(handle) {
    try {
      return !!handle
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'sessions'")
        .get();
    } catch (_) {
      return true;
    }
  }

  /**
   * The database handle to use for the next operation, opening it if needed.
   *
   * The require is INSIDE this function on purpose: src/db/db.js calls
   * getConfig(), which throws when the env is incomplete, so requiring it at
   * module load would make this file un-requirable on a fresh checkout.
   *
   * WHY THIS IS NOT A PLAIN `if (this._handle) return this._handle` CACHE
   * ---------------------------------------------------------------
   * This store outlives individual database connections. src/db/db.js hands out
   * a singleton handle but also exposes closeDb(), and a caller may close a
   * handle directly; afterwards getDb() returns a DIFFERENT object. A store
   * that froze its handle on first use would be permanently bound to a dead
   * connection and every set/touch/destroy would fail with "The database
   * connection is not open". express-session calls touch() on EVERY request for
   * a rolling cookie, so the visible symptom is "the admin login is broken"
   * while /api/health — which touches no session — keeps passing.
   *
   * getDb() is itself a cheap singleton, so re-resolving it costs nothing; the
   * only reason to hold a handle is to skip that call, and that is only safe
   * while the handle is still OPEN:
   *
   *   handle.open === true   -> reuse it.
   *   handle.open === false  -> it was closed (directly or via closeDb());
   *                              drop it and re-resolve the current handle.
   *   handle.open undefined  -> not a better-sqlite3 handle (a test double, or
   *                              some other adapter). Reuse it; refusing to
   *                              would break every caller that injects a fake.
   *
   * A handle injected with { db } that was later closed also falls back to
   * getDb(), which honours setDbForTests() — so in a test harness that is the
   * harness's CURRENT handle, i.e. the right answer — and against a closed
   * handle there is nothing worth preserving in the first place.
   */
  _db() {
    const handle = this._handle;
    if (handle && handle.open !== false) {
      // AN INJECTED HANDLE NEEDS THE SAME SCHEMA GUARANTEE AS A getDb() ONE.
      // ensureSessionsTable() used to sit only on the branch below, so
      // `new SessionStore({ db })` returned the handle here and skipped the
      // schema entirely. Against a database that has no `sessions` table yet,
      // EVERY operation then failed with "no such table: sessions" - and
      // sweepExpired(db), which is documented as "accepts a handle so a test can
      // sweep a throwaway database", logged the failure and answered 0, which is
      // indistinguishable from "nothing to sweep", so a caller could not detect
      // it. ensureSessionsTable() is idempotent, so once the table exists this is
      // just two no-op exec() calls and the hot path is unaffected.
      //
      // It survived a green suite because every store built with `{ db }` was
      // preceded by an explicit ensureSessionsTable() call in the test helper, so
      // the broken branch was structurally unreachable rather than untested.
      //
      // A handle that is NOT a better-sqlite3 handle (a test double, or some
      // other adapter) has no exec(), and the contract documented above says such
      // a handle must still be reused as-is - so a missing exec() is not an error
      // here. The double owns its own schema.
      if (typeof handle.exec !== 'function') return handle;
      // Ensure the schema ONCE PER HANDLE, not once per operation. _db() is on
      // the hot path (express-session calls touch() on every request for a
      // rolling cookie), and re-running CREATE ... IF NOT EXISTS plus a
      // sqlite_master probe each time is pure overhead - it is also what made
      // the closeDb()/reopen cycle tests run for tens of seconds. Identity
      // comparison against the last-ensured handle means a swapped or reopened
      // handle is re-ensured automatically.
      if (this._ensured !== handle) {
        this._schemaRepaired = !this._hasSessionsTable(handle);
        ensureSessionsTable(handle);
        this._ensured = handle;
      }
      return handle;
    }

    // Forget the dead handle BEFORE re-resolving, so a getDb() that throws does
    // not leave a known-dead handle behind for the next call to reuse.
    this._handle = null;

    const resolved = require('../db/db').getDb();
    // getDb() is NOT guaranteed to return an OPEN handle: it caches its own
    // singleton, so a caller that closed that handle directly instead of going
    // through closeDb() leaves db.js handing the corpse straight back. Building a
    // statement bag on top of that produces "no such table: sessions" — a
    // message that points at the schema instead of at the real cause — so the
    // closed handle is rejected here, by name, and reported through the
    // callback like every other store failure.
    if (!resolved || resolved.open === false) {
      throw new Error(
        '[sessionStore] src/db/db.js returned a database handle that is not open. ' +
        'The connection was closed without going through closeDb(); reopen it ' +
        '(closeDb() then a normal getDb()) before the next session write.'
      );
    }

    // Ask BEFORE creating: once ensureSessionsTable() has run the table is present,
    // so checking afterwards would always answer "present" and a genuine repair
    // would never be reported as SCHEMA_REPAIRED.
    const created = !this._hasSessionsTable(resolved);
    const fresh = ensureSessionsTable(resolved);
    this._handle = fresh;
    // This branch only runs when the previous handle was missing or dead, so the
    // freshly-resolved handle always needs its own ensure - hence the explicit
    // _ensured assignment rather than relying on the identity check above.
    this._ensured = fresh;
    this._schemaRepaired = created;
    return fresh;
  }

  /**
   * Prepared statements for `handle`, built once per handle.
   *
   * The keys are prefixed `stmt` because a better-sqlite3 Statement is an OBJECT
   * that must be called through one of its own methods (`.get()`, `.run()`,
   * `.all()`) — it is not itself callable. Naming a cached statement `get` and
   * then writing `cache.get(sid)` therefore fails with "cache.get is not a
   * function"; `stmtGet.get(sid)` cannot be misread that way.
   *
   * The cache is keyed on HANDLE IDENTITY, which is what makes a swapped handle
   * free: the new handle simply misses the WeakMap and gets its own statements,
   * and the dead handle's bag becomes collectable with it.
   *
   * The cache is re-validated for COMPLETENESS, not merely presence. A bag is
   * only published after every statement in it has been prepared, but a bag that
   * is missing a key is exactly what turns a store error into "TypeError: Cannot
   * read properties of undefined (reading 'run')" — a message that points at the
   * caller instead of at the cache. Rebuilding on a gap makes that failure mode
   * unreachable, and costs one array scan per operation.
   */
  _prepare(handle) {
    const cached = this._stmts.get(handle);
    if (cached && STATEMENT_NAMES.every((name) => cached[name])) return cached;

    const fresh = {
      stmtGet: handle.prepare('SELECT expires_at, data FROM sessions WHERE sid = ?'),
      stmtUpsert: handle.prepare(
        'INSERT INTO sessions (sid, expires_at, data) VALUES (?, ?, ?) ' +
        'ON CONFLICT(sid) DO UPDATE SET expires_at = excluded.expires_at, data = excluded.data'
      ),
      stmtDel: handle.prepare('DELETE FROM sessions WHERE sid = ?'),
      stmtTouch: handle.prepare('UPDATE sessions SET expires_at = ? WHERE sid = ?'),
      stmtLive: handle.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ?'),
      stmtSweep: handle.prepare('DELETE FROM sessions WHERE expires_at <= ?'),
      stmtAll: handle.prepare('SELECT sid, data FROM sessions WHERE expires_at > ?'),
      stmtClear: handle.prepare('DELETE FROM sessions'),
    };
    this._stmts.set(handle, fresh);
    return fresh;
  }

  /**
   * Defer `body(handle, cb)` to the next tick with the handle already resolved,
   * converting any throw into `cb(err)` so no store method ever throws
   * synchronously at express-session.
   */
  _run(body, callback) {
    const cb = once(callback || noop);
    setImmediate(() => {
      let handle;
      try {
        handle = this._db();
      } catch (e) {
        return cb(e);
      }
      try {
        body(handle, cb);
      } catch (e) {
        cb(e);
      }
    });
  }

  /**
   * Absolute expiry for a session: the cookie's own maxAge when it has a
   * positive one, otherwise this store's ttlMs. A maxAge of 0 means "until the
   * browser closes" — unenforceable here (nobody would ever tell us), so it falls
   * back to the TTL to guarantee the row is eventually sweepable.
   */
  _expiresAt(session) {
    const maxAge = session && session.cookie ? session.cookie.maxAge : null;
    const ms = Number.isFinite(maxAge) && maxAge > 0 ? maxAge : this.ttlMs;
    return Date.now() + ms;
  }

  // --- Store contract ---------------------------------------------------------

  /**
   * Look a session up. Reports `cb(null, null)` when it is absent, expired, or
   * unreadable — express-session treats any falsy value as "no session" and
   * mints a fresh one. An expired row is deleted on the way out so a client that
   * never comes back does not keep it alive.
   */
  get(sid, callback) {
    this._run((db, cb) => {
      const stmts = this._prepare(db);
      const row = stmts.stmtGet.get(String(sid));
      if (!row) return cb(null, null);
      if (row.expires_at <= Date.now()) {
        stmts.stmtDel.run(String(sid));
        return cb(null, null);
      }
      cb(null, parse(row.data));
    }, callback);
  }

  /**
   * Write a session.
   *
   * Keyed on `sid`, NOT on `session.id`. MemoryStore does the same, and it is the
   * safer choice: express-session guarantees they agree (Store#createSession
   * assigns `sess.id = sid`), but only `sid` is the argument it actually owns, so
   * a session object that has not been through createSession still round-trips.
   */
  set(sid, session, callback) {
    this._run((db, cb) => {
      const key = String(sid);
      if (!key || key === 'undefined') {
        return cb(new Error('[sessionStore] cannot store a session without a session id'));
      }
      let data;
      try {
        data = serialize(session);
      } catch (e) {
        if (!warnedOnSerialization) {
          warnedOnSerialization = true;
          console.error('[sessionStore] a session could not be serialized:', e.message);
        }
        return cb(e);
      }
      this._prepare(db).stmtUpsert.run(key, this._expiresAt(session), data);
      cb(null);
    }, callback);
  }

  /** Delete a session. Succeeds whether or not the row was there. */
  destroy(sid, callback) {
    this._run((db, cb) => {
      this._prepare(db).stmtDel.run(String(sid));
      cb(null);
    }, callback);
  }

  /** Push the expiry out without rewriting the payload (express-session calls
   *  this on every request for a rolling cookie). */
  touch(sid, session, callback) {
    this._run((db, cb) => {
      this._prepare(db).stmtTouch.run(this._expiresAt(session), String(sid));
      cb(null);
    }, callback);
  }

  /** Number of live sessions. Uses the error-first signature for consistency
   *  with every other method here; express-session never calls it itself. */
  length(callback) {
    this._run((db, cb) => {
      cb(null, this._prepare(db).stmtLive.get(Date.now()).n);
    }, callback);
  }

  /** Every live session, as `{ sid, session }` (MemoryStore-compatible shape). */
  all(callback) {
    this._run((db, cb) => {
      const rows = this._prepare(db).stmtAll.all(Date.now());
      const out = [];
      for (const row of rows) {
        let session = null;
        try {
          session = parse(row.data);
        } catch (e) {
          session = null; // unreadable row: skip it rather than fail the whole read
        }
        if (session) out.push({ sid: row.sid, session });
      }
      cb(null, out);
    }, callback);
  }

  /** Delete every session, expired or not. */
  clear(callback) {
    this._run((db, cb) => {
      this._prepare(db).stmtClear.run();
      cb(null);
    }, callback);
  }

  // --- expiry sweep -----------------------------------------------------------

  /**
   * Delete expired rows and return how many went. Never throws: a failed sweep
   * must not take down a request, and the rows are still correctly treated as
   * absent by get(), so the next tick simply tries again.
   *
   * THE RETURN VALUE IS A THREE-WAY ANSWER, and the three cases must never be
   * confused with one another. That confusion IS the defect this exists to kill:
   * "there was nothing to sweep" and "the sweep never ran" used to both answer 0,
   * so a store that had silently stopped reclaiming rows looked perfectly healthy.
   *
   *   >= 0              a real count. 0 means "swept, nothing was expired".
   *   SCHEMA_REPAIRED   the `sessions` table did not exist and _db() created it,
   *                     so there was provably nothing to sweep. A 0 here would be
   *                     indistinguishable from a healthy quiet tick.
   *   SWEEP_FAILED      the sweep could not run at all. Also never 0.
   *
   * WHY A SENTINEL RATHER THAN A THROW (the engineering decision): the contract
   * documented above is "never throws", and the reason given for it is that a
   * failed sweep must not take down a REQUEST. startSweeper() already runs this
   * from an unref'd setInterval inside a try/catch, so a throw would survive there
   * -- but this method is also reachable through the exported sweepExpired(db)
   * helper, whose callers wrap nothing at all. A throw would convert a silent
   * mis-report into an unhandled rejection at somebody else's call site. A
   * negative marker is loud to a direct caller (it is not a count, and BOTH
   * sentinels are exported so nobody has to hardcode them) while remaining inert
   * for the background timer. It also keeps `typeof result === 'number'`, so any
   * consumer doing arithmetic on the count keeps working unchanged.
   */
  sweepExpired() {
    let handle;
    try {
      handle = this._db();
    } catch (e) {
      if (!warnedOnSerialization) {
        warnedOnSerialization = true;
        console.error('[sessionStore] expiry sweep skipped, database unavailable:', e.message);
      }
      return SWEEP_FAILED;
    }
    try {
      const removed = this._prepare(handle).stmtSweep.run(Date.now()).changes;
      // _db() has already created the `sessions` table if it was missing, so this
      // DELETE really did run against a table that exists -- but the caller still
      // cannot tell a repair from a quiet tick unless we say so, and on the tick
      // that performs the repair "removed" is 0 for a reason that is not "quiet".
      return handle.__sessionsTableCreated ? SCHEMA_REPAIRED : removed;
    } catch (e) {
      // SWEEP_FAILED, NOT 0. This is the second way a sweep can fail to run, and
      // answering 0 here would reintroduce exactly the ambiguity the sentinels
      // exist to remove: a dead sweep would be indistinguishable from a healthy
      // one, and it would do so silently, forever.
      console.error('[sessionStore] expiry sweep failed:', e.message);
      return SWEEP_FAILED;
    }
  }

  /**
   * Start the periodic sweep. Idempotent.
   *
   * `.unref()` IS LOAD-BEARING: without it this interval is a live handle and
   * `npm start` — and every `npm test` run — hangs forever instead of exiting.
   */
  startSweeper() {
    if (this._sweeper || !this.sweepMs) return this._sweeper;
    this._sweeper = setInterval(() => {
      try {
        this.sweepExpired();
      } catch (e) {
        // Belt and braces: sweepExpired already swallows its own errors, but an
        // interval callback must never be the thing that kills the process.
        console.error('[sessionStore] expiry sweep error:', e.message);
      }
    }, this.sweepMs);
    if (typeof this._sweeper.unref === 'function') this._sweeper.unref();
    return this._sweeper;
  }

  /** Stop the sweep. Not part of the Store contract; useful in tests. */
  stopSweeper() {
    if (!this._sweeper) return false;
    clearInterval(this._sweeper);
    this._sweeper = null;
    return true;
  }
}

/**
 * Build a session store and start its sweep.
 *
 * @param {object} [options] see the SessionStore constructor
 * @returns {SessionStore}
 */
function createSessionStore(options = {}) {
  const store = new SessionStore(options);
  store.startSweeper();
  return store;
}

module.exports = {
  createSessionStore,
  SessionStore,
  ensureSessionsTable,
  sweepExpired: function sweepExpired(db) {
    // Accepts a handle so a test can sweep a throwaway database; without one the
    // store opens DB_PATH lazily, exactly as a store method would.
    const store = new SessionStore(db ? { db } : {});
    return store.sweepExpired();
  },
  DEFAULT_TTL_MS,
  SESSIONS_TABLE_SQL,
  // Exported so a caller can tell a real count from a sentinel without magic numbers.
  SCHEMA_REPAIRED,
  SWEEP_FAILED,
  // Re-arms the once-per-process warning flags. Exported because the module's
  // own header documents it as existing for tests, and a documented-but-absent
  // export is a trap for whoever writes the next test.
  resetSerializationWarning() { warnedOnSerialization = false; },
};
